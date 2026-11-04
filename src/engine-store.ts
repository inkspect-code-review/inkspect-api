import { database } from "./database";
import type { Worker } from "./repository-store";
import { INVALID_IGNORE, schemaName } from "./engine-contract";
import { diagnosticMessage } from "./engine-diagnostics";

// Failures users can fix themselves; every other code stays a generic failure.
const failureMessages: Record<string, string> = {
  [INVALID_IGNORE]: 'The .inkspectignore file on the base branch is invalid, so the review did not run. Fix it on the base branch, then update the pull request from that branch.',
};

export { authorizedWorker, authorizedStoredWorker } from "@inkspect/core/lib/engine-access";
export type EngineJob = {
  id: string; request_id: string; organization_id: string; repository_id: string; connection_id: string; installation_id: string;
  subject: string; request: Record<string, any>; snapshot: any; host_config: import('@inkspect/api/engine-contract').HostConfig;
  status: string; cancel_requested: boolean; report?: any; billing_usage?: any; error_code?: string; created_at: Date;
};
export function jobClaims(job: EngineJob) {
  return { tenant: job.organization_id, repository: Number(job.repository_id), connection: job.connection_id, installation: Number(job.installation_id), subject: job.subject };
}
export function present(job: EngineJob) {
  const message = (job.error_code && Object.hasOwn(failureMessages, job.error_code) ? failureMessages[job.error_code] : undefined)
    || (job.status==='failed'?diagnosticMessage(job.snapshot?.failure):undefined);
  return { ...(message ? { error_message: message } : {}), job: { id: job.id, status: job.status, attempts: job.status === 'queued' ? 0 : 1, cancel_requested: job.cancel_requested,
    created_at: job.created_at, error_code: job.error_code }, snapshot: job.snapshot, billing_usage: job.billing_usage };
}
export async function loadJob(worker: Worker, id: string): Promise<EngineJob | undefined> {
  return (await database().query<EngineJob>('SELECT * FROM api_engine_job WHERE id=$1 AND organization_id=$2 AND repository_id=$3 AND connection_id=$4 AND installation_id=$5',
    [id, worker.organization_id, worker.repository_id, worker.connection_id, worker.installation_id])).rows[0];
}
export async function legacyJobs(worker: Worker, id?: string) {
  const pool = database(worker.queue_database), schema = schemaName(worker.queue_schema);
  if (!(await pool.query('SELECT to_regclass($1) AS name', [`${worker.queue_schema}.jobs`])).rows[0].name) return [];
  return (await pool.query(`SELECT j.id,j.status,j.attempts,j.cancel_requested,j.error_code,j.created_at,j.request AS snapshot,
    CASE WHEN j.status='completed' AND u.body IS NOT NULL THEN jsonb_build_object('complete',true,'charged_nano_usd',u.body->>'charged_nano_usd',
      'input_tokens',u.body->'input_tokens','output_tokens',u.body->'output_tokens','total_tokens',u.body->'charged_tokens','calls',u.body->'calls') END AS billing_usage
    FROM ${schema}.jobs j LEFT JOIN ${schema}.usage u ON u.tenant_id=j.tenant_id AND u.run_id=j.id
    WHERE j.tenant_id=$1 AND j.scope->>'repository_id'=$2 AND j.request->>'connection_id'=$3 AND j.request->>'installation_id'=$4
    ${id ? 'AND j.id=$5' : ''} ORDER BY j.created_at DESC LIMIT 30`,
  [worker.organization_id, worker.repository_id, worker.connection_id, String(worker.installation_id), ...(id ? [id] : [])])).rows;
}
export function presentLegacy(row: any) {
  const { snapshot, billing_usage, ...job } = row;
  return { job, snapshot, billing_usage };
}
export async function event(id: string, kind: string) {
  await database().query('INSERT INTO api_engine_event(job_id,event) VALUES($1,$2)', [id, { kind, at: new Date().toISOString() }]);
}
