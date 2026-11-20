import type { Pool } from 'pg';
import { selfHostedReviews } from "./review-store";
import { selfHostedProviders } from "./provider-store";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { byokReady, openProviderCredential } from "../engine-credentials";
import type { EngineJob } from "../engine-store";
import type { EngineHttpPolicy } from "../engine-http-policy";

export function selfHostedEnginePolicy(pool: Pool, services: Pick<EngineHttpPolicy, 'fix' | 'fixPullOpen' | 'fixPullState' | 'retrieval'>): EngineHttpPolicy {
  const reviews = selfHostedReviews(pool);
  return {
    ...services,
    configuration: host => ({ edition: 'self-hosted', billable: false, billing_mode: 'self-hosted', byok_available: byokReady(), review_budget_nano_usd: String(host.budget_nano_usd) }),
    admission: input => reviews.authorize(input),
    attach: (input, id, tx) => reviews.attach(input, id, tx),
    async chatAccess(claims, messageId) {
      if (typeof messageId !== 'string' || !messageId || messageId.length > 200) throw new ReviewError(400, 'Choose an active chat question.');
      const allowed = await pool.query(`SELECT 1 FROM workspace_chat_turn t
        JOIN member m ON m."organizationId"=t.organization_id AND m."userId"=t.user_id
        JOIN "chatConversation" c ON c.id=t.conversation_id AND c."organizationId"=t.organization_id AND c."userId"=t.user_id
        WHERE t.message_id=$1 AND t.organization_id=$2 AND t.user_id=$3 AND t.state='pending' AND NOT t.redacted`, [messageId, claims.tenant, claims.subject]);
      if (!allowed.rowCount) throw new ReviewError(403, 'This chat question is no longer active.');
    },
  };
}

export async function selfHostedProviderCredential(pool: Pool, job: EngineJob) {
  const reviews = selfHostedReviews(pool);
  const row = await reviews.authorize({ organization: job.organization_id, user: job.subject, connection: job.connection_id,
    installation: Number(job.installation_id), repository: Number(job.repository_id), body: job.request });
  if (row.request_id !== job.request_id || row.job_id !== job.id) throw new ReviewError(403, 'Review admission no longer matches this job.');
  if (!job.request.byok) return;
  const { selection, envelope } = await selfHostedProviders(pool).credentials(job.organization_id, job.subject, job.request.byok);
  return openProviderCredential(job.organization_id, selection, envelope);
}
