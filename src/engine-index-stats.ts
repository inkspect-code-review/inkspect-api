import { randomUUID } from 'node:crypto';
import { database } from "./database";
import { schemaName, type HostConfig } from "./engine-contract";
import { authorizedWorker } from "./engine-store";
import { repositoryToken } from "./metadata";
import { runRust } from "./engine-process";
import { mergeIndexProgress, needsIndexStats } from "./engine-index-progress";
import type { Worker } from "./repository-store";
import type { RepositoryIndex } from "@inkspect/core/lib/repository-types";

const defaults = { database, authorizedWorker, repositoryToken, runRust };

// Repair the original terminal job at its pinned revision. No new index,
// embedding, summary generation, or billing operation is created.
export async function backfillIndexStats(worker: Worker, host: HostConfig, services = defaults) {
  const lock = await services.database(worker.queue_database).connect();
  const key = `repository-index:${worker.queue_schema}:${worker.organization_id}:${worker.repository_id}`;
  const table = `${schemaName(worker.queue_schema)}.repository_indexes`;
  const controller = new AbortController();
  const lost = () => controller.abort();
  lock.on('error', lost);
  try {
    if (!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [key])).rows[0].ok) return;
    const row = (await lock.query<RepositoryIndex & { subject: string; connection_id: string; installation_id: string }>(
      `SELECT * FROM ${table} WHERE tenant_id=$1 AND repository_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [worker.organization_id, worker.repository_id])).rows[0];
    if (!row || !needsIndexStats(row) || !/^[a-f0-9]{40}$/.test(row.progress.revision ?? '')
      || row.connection_id !== worker.connection_id || String(row.installation_id) !== String(worker.installation_id)) return;
    const claims = { tenant: worker.organization_id, repository: Number(worker.repository_id), connection: row.connection_id,
      installation: Number(row.installation_id), subject: row.subject };
    await services.authorizedWorker(claims);
    const token = await services.repositoryToken(worker, controller.signal, true);
    const [owner, repo] = worker.full_name.split('/');
    const revision = row.progress.revision;
    const result = await services.runRust('index-stats', host, { run_id: row.id, tenant_id: worker.organization_id, repository_id: worker.repository_id,
      owner, repo, pull_number: 1, base_sha: revision, head_sha: revision }, {}, token, `stats-${randomUUID()}`, controller.signal);
    if (!result.report?.scan?.measured || result.report.revision !== revision || controller.signal.aborted) return;
    await services.authorizedWorker(claims);
    const logs = [
      { key: 'progress:indexed', at: new Date(row.updated_at).toISOString(), message: `Index saved: ${row.progress.chunks} chunks.` },
      { key: 'progress:stats', at: new Date().toISOString(), message: `File counts refreshed: ${result.report.scan.read} read, ${result.report.scan.total} found, ${result.report.scan.skipped} skipped.` },
    ];
    const progress = mergeIndexProgress(row.progress, { scan: result.report.scan, logs });
    await lock.query(`UPDATE ${table} SET progress=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status=$5`,
      [worker.organization_id, worker.repository_id, row.id, progress, row.status]);
  } finally {
    lock.removeListener('error', lost);
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => {});
    lock.release(true);
  }
}
