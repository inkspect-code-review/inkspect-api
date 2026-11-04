import type { PoolClient } from 'pg';
import type { EngineJob } from "./engine-store";

// Caller holds the job's session lock for the entire execution. A shared lock
// on runtime serializes admission with deployment activation, without touching
// the contexts or ownership of reviews that already started.
export async function claimReview(tx: PoolClient, job: EngineJob, generation: string) {
  await tx.query('BEGIN');
  try {
    const runtime = (await tx.query('SELECT generation FROM api_engine_runtime WHERE id FOR SHARE')).rows[0];
    if (runtime.generation !== generation) { await tx.query('ROLLBACK'); return false; }
    const managedFix=typeof job.request.fix_of==='string'&&!job.request.byok;
    if(managedFix)await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('claude-runner-admission',0))");
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`rust-repository:${job.organization_id}:${job.repository_id}`]);
    const result = await tx.query(`UPDATE api_engine_job SET status='running',owner=$2 WHERE id=$1 AND status='queued' AND NOT cancel_requested
      AND NOT EXISTS(SELECT 1 FROM api_engine_job WHERE organization_id=$3 AND repository_id=$4 AND status IN ('running','paused'))
      AND (NOT $5::boolean OR NOT EXISTS(SELECT 1 FROM api_engine_job WHERE status IN ('running','paused') AND request ? 'fix_of' AND NOT(request ? 'byok'))) RETURNING id`,
    [job.id, generation, job.organization_id, job.repository_id,managedFix]);
    await tx.query('COMMIT'); return result.rowCount === 1;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
}

export async function recoverReview(tx: PoolClient, id: string, usage: object) {
  await tx.query('BEGIN');
  try {
    const owned = (await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', [`rust-review:${id}`])).rows[0].ok;
    const updated = owned ? await tx.query("UPDATE api_engine_job SET status='failed',billing_usage=$2,error_code='engine.interrupted',finished_at=now() WHERE id=$1 AND status IN ('running','paused') RETURNING id", [id, usage]) : undefined;
    await tx.query('COMMIT'); return updated?.rowCount === 1;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
}
