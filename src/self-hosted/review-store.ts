import type { Pool, PoolClient } from "pg";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { requestIdentity, engineJobId, type ReviewIdentityInput } from "@inkspect/core/lib/review-identity";
import { supportedModel } from "@inkspect/core/lib/byok/catalog";

export type ReviewExecution = {
  request_id: string; organization_id: string; user_id: string; repository_id: string;
  connection_id: string; installation_id: string; request: Record<string, unknown>;
  job_id: string | null; state: string;
};
export type ReviewReceipt = { job: { id: string; status: string }; billing_usage?: Record<string, unknown> };
const terminal = new Set(["completed", "failed", "cancelled"]);

// The self-hosted ledger records execution identity and measurements only.
// Admission still checks live membership, repository ownership and provider scope.
export function selfHostedReviews(pool: Pool) {
  async function transaction<T>(run: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try { await tx.query("BEGIN"); const result = await run(tx); await tx.query("COMMIT"); return result; }
    catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  async function scope(tx: PoolClient, input: ReviewIdentityInput) {
    if (!(await tx.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [input.organization])).rowCount) throw new ReviewError(403, "Workspace access is no longer available.");
    const allowed = await tx.query(`SELECT m."userId" FROM member m
      JOIN "githubConnection" c ON c."organizationId"=m."organizationId" AND c.id=$3 AND c."installationId"=$4
      JOIN "githubRepositoryClaim" r ON r."organizationId"=c."organizationId" AND r."repositoryId"=$5
      WHERE m."organizationId"=$1 AND m."userId"=$2
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.repositories::jsonb) x WHERE x->>'id'=$5)
      FOR SHARE OF m,c,r`, [input.organization, input.user, input.connection, String(input.installation), String(input.repository)]);
    if (!allowed.rowCount) throw new ReviewError(403, "Repository access is no longer available.");
    const mode = (await tx.query("SELECT review_provider FROM workspace_provider_settings WHERE organization_id=$1", [input.organization])).rows[0]?.review_provider || "managed";
    const selected = input.body.byok as { credential_id?: string; provider?: string; model?: string } | undefined;
    if (mode === "byok") {
      const credential = (await tx.query("SELECT id,provider,model FROM workspace_provider_credential WHERE organization_id=$1 FOR SHARE", [input.organization])).rows[0];
      if (!selected || !credential || credential.id !== selected.credential_id || credential.provider !== selected.provider || credential.model !== selected.model || !supportedModel(credential.provider, credential.model)) throw new ReviewError(403, "The provider key or model changed. Start a new review.");
    } else if (selected) throw new ReviewError(403, "Provider scope mismatch.");
  }
  function matches(row: ReviewExecution, input: ReviewIdentityInput) {
    return row.organization_id === input.organization && row.user_id === input.user && row.repository_id === String(input.repository)
      && row.connection_id === input.connection && row.installation_id === String(input.installation);
  }
  async function reserve(input: ReviewIdentityInput): Promise<ReviewExecution> {
    if (!Number.isSafeInteger(input.repository) || input.repository < 1 || !Number.isSafeInteger(input.installation) || input.installation < 1
      || input.body.repository_id !== input.repository || !Number.isSafeInteger(input.body.number) || Number(input.body.number) < 1
      || ![input.body.base_tip, input.body.head].every(value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value))) throw new ReviewError(400, "Select a current pull request snapshot.");
    const identity = requestIdentity(input);
    return transaction(async tx => {
      await scope(tx, input);
      const old = (await tx.query<ReviewExecution>("SELECT * FROM workspace_review_execution WHERE request_id=$1 FOR UPDATE", [identity])).rows[0];
      if (old) {
        if (!matches(old, input)) throw new ReviewError(409, "This review was already started by another workspace member.");
        // Only a confirmed rejection without an attached job may be re-admitted.
        if (old.state === "rejected" && old.job_id === null) {
          return (await tx.query<ReviewExecution>("UPDATE workspace_review_execution SET state='pending',finished_at=NULL,measurement=NULL WHERE request_id=$1 RETURNING *", [identity])).rows[0];
        }
        return old;
      }
      return (await tx.query<ReviewExecution>(`INSERT INTO workspace_review_execution(request_id,organization_id,user_id,repository_id,connection_id,installation_id,request)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [identity,input.organization,input.user,String(input.repository),input.connection,String(input.installation),input.body])).rows[0];
    });
  }
  async function authorize(input: ReviewIdentityInput, tx?: PoolClient): Promise<ReviewExecution> {
    const run = async (client: PoolClient) => {
      await scope(client, input);
      const row = (await client.query<ReviewExecution>("SELECT * FROM workspace_review_execution WHERE request_id=$1 FOR UPDATE", [requestIdentity(input)])).rows[0];
      if (!row || !matches(row, input) || row.state !== "pending") throw new ReviewError(409, "An active review admission is required.");
      return row;
    };
    return tx ? run(tx) : transaction(run);
  }
  async function attach(input: ReviewIdentityInput, jobId: string, tx?: PoolClient) {
    const run = async (client: PoolClient) => {
      await scope(client, input);
      const row = (await client.query<ReviewExecution>("SELECT * FROM workspace_review_execution WHERE request_id=$1 FOR UPDATE", [requestIdentity(input)])).rows[0];
      if (!row || !matches(row, input) || jobId !== engineJobId(row.request_id) || (row.job_id && row.job_id !== jobId)
        || (row.state !== "pending" && row.job_id !== jobId)) throw new ReviewError(409, "This admission belongs to another run.");
      await client.query("UPDATE workspace_review_execution SET job_id=$2 WHERE request_id=$1", [row.request_id, jobId]);
    };
    return tx ? run(tx) : transaction(run);
  }
  async function reject(input: ReviewIdentityInput) {
    await pool.query("UPDATE workspace_review_execution SET state='rejected',finished_at=now() WHERE request_id=$1 AND organization_id=$2 AND user_id=$3 AND state='pending' AND job_id IS NULL", [requestIdentity(input), input.organization, input.user]);
  }
  async function settle(organization: string, receipt: ReviewReceipt) {
    if (!receipt?.job || !terminal.has(receipt.job.status) || !/^J-[a-f0-9]{32}$/.test(receipt.job.id)) return;
    const usage = receipt.billing_usage;
    const measurement: Record<string, unknown> = { complete: usage?.complete === true };
    for (const field of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_input_tokens", "calls", "duration_ms"]) {
      if (Number.isSafeInteger(usage?.[field]) && Number(usage?.[field]) >= 0) measurement[field] = usage![field];
    }
    for (const field of ["provider", "model"]) if (typeof usage?.[field] === "string" && usage[field].length <= 200) measurement[field] = usage[field];
    // Admission ceilings and credit charges are not provider cost. Only the
    // engine's measured model-cost component (or no calls) can supply this amount.
    const cost = usage?.provider_cost as { components?: { category: string; complete: boolean; cost_nano_usd: unknown }[] } | undefined;
    const modelCost = Array.isArray(cost?.components) ? cost.components.find(item => item.category === "model" && item.complete)?.cost_nano_usd : undefined;
    if (typeof modelCost === "string" && /^\d{1,24}$/.test(modelCost)) measurement.provider_cost_nano_usd = modelCost;
    else if (usage?.complete === true && usage.calls === 0) measurement.provider_cost_nano_usd = "0";
    await pool.query("UPDATE workspace_review_execution SET state=$3,measurement=CASE WHEN request ? 'byok' THEN $4::jsonb - 'provider_cost_nano_usd' ELSE $4::jsonb END,finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND state='pending'", [organization, receipt.job.id, receipt.job.status, measurement]);
  }
  return { reserve, authorize, attach, reject, settle };
}
