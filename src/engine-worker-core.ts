import { enqueueAutomaticFixes } from "./engine-auto-fix-core";
import { isFix, runFix, handleFix } from "./engine-fix-core";
import type { EngineWorkerPolicy } from "./engine-worker-policy";
import { engineDiagnostic } from "./engine-diagnostics";
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { database, closeDatabases } from "./database";
import { createEngineHandler } from "./engine-http-core";
import { validateHost, schemaName, engineFailure, INVALID_IGNORE } from "./engine-contract";
import { authorizedWorker, jobClaims, event, type EngineJob } from "./engine-store";
import { runRust, readJournal } from "./engine-process";
import { repositoryToken, fetchRepositoryRevision } from "./metadata";
import type { Worker } from "./repository-store";
import { connectedRepositories, repositoryIdentity } from "./connected-repositories";
import { saveReviewModels } from "@inkspect/core/lib/review-models";
import { verifyIndexAccess, indexOperation } from "@inkspect/core/lib/repository-store";
import { claimReview, recoverReview } from "./engine-queue";
import { describeRepository } from "./engine-description";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { indexStage, mergeIndexProgress, needsIndexStats } from "./engine-index-progress";
import { backfillIndexStats } from "./engine-index-stats";

export async function runEngineWorker(policy: EngineWorkerPolicy) {
process.umask(0o077);
const host = validateHost(JSON.parse(await readFile(process.env.INKSPECT_RUST_HOST_CONFIG || '/etc/inkspect/rust-host.json', 'utf8')));
const generation = process.env.INKSPECT_GENERATION || '';
if (!generation || !/^[\w.-]{1,100}$/.test(generation)) throw new Error('A deployment generation is required');
const port = Number(process.env.PORT || 8091), origin = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid engine port');
const state = process.env.INKSPECT_RUST_STATE || '/var/lib/inkspect/rust';
if ((process.env.INKSPECT_ENGINE_SECRET?.trim().length || 0) < 32 || !/^[1-9]\d*$/.test(process.env.GITHUB_APP_ID || '')) throw new Error('Missing engine service identity');
await readFile(process.env.GITHUB_APP_PRIVATE_KEY_FILE || '/etc/inkspect/github-app.pem');
await mkdir(state, { recursive: true, mode: 0o700 });
await promisify(execFile)(process.env.INKSPECT_RUST_BINARY || '/usr/local/bin/inkspect-engine', ['--version'], { timeout: 10000, maxBuffer: 4096 });
await database().query('SELECT generation FROM api_engine_runtime WHERE id');
let draining = false, active = 0, healthy = 0;
const controllers = new Set<AbortController>();
const track = async <T>(work: () => Promise<T>) => {
  if (active >= 2) throw new ReviewError(503, 'The engine is busy. Please retry shortly.');
  active++; try { return await work(); } finally { active--; }
};
const server = createServer(createEngineHandler(host, () => Date.now() - healthy < 30000 ?
  { status: draining ? 'draining' : 'ready', engine: 'rust', generation, version: process.env.INKSPECT_VERSION, active } : null, track, policy.http));
server.listen(port, '127.0.0.1');
// Deployments stop claims only. In-flight reviews, index writes and HTTP work
// keep their contexts, advisory locks and children until completion.
process.on('SIGUSR2', () => { draining = true; });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { draining = true; stopping = true; server.close(); });

async function provision(register: boolean) {
  for (const repo of await connectedRepositories(database())) {
    let worker = (await database().query<Worker>('SELECT * FROM api_repository_worker WHERE organization_id=$1 AND repository_id=$2', [repo.organization, String(repo.repository)])).rows[0];
    if (register && (!worker || worker.connection_id !== repo.connection || String(worker.installation_id) !== String(repo.installation) || worker.full_name !== repo.fullName)) {
      const schema = `rust_repo_${repositoryIdentity(repo)}`, table = schemaName(schema);
      await database().query(`CREATE SCHEMA IF NOT EXISTS ${table}`);
      await database().query(`CREATE TABLE IF NOT EXISTS ${table}.repository_indexes (
        tenant_id text NOT NULL, repository_id text NOT NULL,id text NOT NULL,subject text NOT NULL,connection_id text NOT NULL,installation_id bigint NOT NULL,
        status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),progress jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,repository_id,id))`);
      await database().query(`CREATE UNIQUE INDEX IF NOT EXISTS repository_index_active ON ${table}.repository_indexes(tenant_id,repository_id) WHERE status IN ('queued','running')`);
      await database().query(`INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file)
        VALUES($1,$2,$3,$4,$5,'app',$6,$7,$8) ON CONFLICT(organization_id,repository_id) DO UPDATE SET
        connection_id=excluded.connection_id,installation_id=excluded.installation_id,full_name=excluded.full_name,queue_database='app',queue_schema=excluded.queue_schema,
        app_id=excluded.app_id,private_key_file=excluded.private_key_file,access_error=NULL,access_verified_at=NULL,metadata_due_at=now()`,
      [repo.organization, String(repo.repository), repo.connection, repo.installation, repo.fullName, schema, process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY_FILE || '/etc/inkspect/github-app.pem']);
    }
    await saveReviewModels({ tenant: repo.organization, connection: repo.connection, installation: repo.installation, repository: repo.repository }, origin,
      { default_model_id: host.model_id, region: host.model_region, checked_at: new Date().toISOString(), models: [{ id: host.model_id, name: host.model_id,
        provider: 'bedrock', routing: 'global', available: true, input_nano_usd: host.input_nano_usd, output_nano_usd: host.output_nano_usd, budget_nano_usd: host.budget_nano_usd }] }, database());
  }
}
async function runReview(job: EngineJob) {
  const lock = await database().connect(), controller = new AbortController();
  controllers.add(controller);
  const lost = () => controller.abort(); lock.on('error', lost);
  let heartbeat: NodeJS.Timeout | undefined;
  const lockKey = `rust-review:${job.id}`;
  try {
    if (!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [lockKey])).rows[0].ok) return;
    const runtime = (await lock.query('SELECT generation FROM api_engine_runtime WHERE id')).rows[0];
    if (draining || runtime.generation !== generation) return;
    if (!await claimReview(lock, job, generation)) return;
    await event(job.id, 'review.started');
    let watching = false;
    heartbeat = setInterval(async () => {
      if (watching) return; watching = true;
      try {
        await authorizedWorker(jobClaims(job));
        const live = (await lock.query('SELECT cancel_requested FROM api_engine_job WHERE id=$1', [job.id])).rows[0];
        if (!live || live.cancel_requested) controller.abort();
      } catch { controller.abort(); } finally { watching = false; }
    }, 3000);
    const worker = await authorizedWorker(jobClaims(job));
    while (!(await policy.allowed(job)).allowed) {
      await database().query("UPDATE api_engine_job SET status='paused' WHERE id=$1", [job.id]);
      await delay(2000, undefined, { signal: controller.signal });
    }
    await database().query("UPDATE api_engine_job SET status='running' WHERE id=$1", [job.id]);
    const token = isFix(job) ? '' : await repositoryToken(worker, controller.signal, true, true);
    const [owner, repo] = worker.full_name.split('/');
    const credential = !isFix(job) ? await policy.credential(job) : undefined;
    const result = isFix(job) ? await runFix(policy.fix, job, worker, controller.signal) : await runRust('review', job.host_config, { run_id: job.id, tenant_id: job.organization_id, repository_id: job.repository_id,
      owner, repo, pull_number: job.request.number, base_sha: job.snapshot.base, head_sha: job.snapshot.head,
      review_notes: job.request.review_notes || [], auto_review: false, publish_inline_comments: false }, {}, token, job.id, controller.signal, credential);
    await authorizedWorker(jobClaims(job));
    const report = result.report;
    if (!isFix(job) && report && (report.run?.id !== job.id || report.run?.target?.tenant_id !== job.organization_id || report.run.target.repository_id !== job.repository_id
      || report.run.target.revision_id !== job.snapshot.head || report.run.base?.revision_id !== job.snapshot.base || !Array.isArray(report.findings))) throw new Error('Report identity mismatch');
    if (report && !isFix(job)) {
      // Legacy consumers still expect these empty compatibility arrays.
      report.evidence ??= []; report.assessments ??= [];
    }
    const receipt = policy.receipt(job, result.events);
    await policy.retrieval(job, result.events);
    const row = (await database().query<EngineJob>(`UPDATE api_engine_job SET status=CASE WHEN $2::jsonb->>'commit' IS NOT NULL THEN 'completed' WHEN cancel_requested THEN 'cancelled' WHEN $2::jsonb IS NOT NULL THEN 'completed' ELSE 'failed' END,
      report=$2,billing_usage=$3,error_code=$4,snapshot=snapshot || $5::jsonb,finished_at=now() WHERE id=$1 RETURNING *`, [job.id, report || null, receipt, report ? null : engineFailure(result.events) ?? null,
      report?{}:{failure:engineDiagnostic(job.id,result.events)??null}])).rows[0];
    await event(job.id, `review.${row.status}`);
    await policy.settle(row);
  } catch (error) {
    // Unknown provider outcomes remain explicitly unmeasured, never retried.
    const events = await readJournal(resolve(state, job.id)).catch(() => [{ kind: 'journal.unavailable' }]);
    await database().query(`UPDATE api_engine_job SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
      billing_usage=$2,error_code=coalesce(error_code,$4),snapshot=snapshot || $5::jsonb,finished_at=now() WHERE id=$1 AND owner=$3 AND status IN ('running','paused')`,
    [job.id, policy.receipt(job, events), generation, isFix(job) && error instanceof ReviewError ? error.status === 409 ? 'fix.stale' : 'fix.permission' : 'engine.failed',
      {failure:engineDiagnostic(job.id,events)??null}]);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    controllers.delete(controller); lock.removeListener('error', lost);
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]).catch(() => {}); lock.release(true);
  }
}
async function runIndex(worker: Worker) {
  const pool = database(worker.queue_database), lock = await pool.connect();
  const key = `repository-index:${worker.queue_schema}:${worker.organization_id}:${worker.repository_id}`;
  const table = `${schemaName(worker.queue_schema)}.repository_indexes`;
  const abort = new AbortController(); let watch: NodeJS.Timeout | undefined;
  const lost = () => abort.abort(); lock.on('error', lost);
  let row: any;
  let failure: { message: string; code: string | null } = { message: 'Indexing did not complete. Start a new index to retry.', code: null };
  try {
    if (!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [key])).rows[0].ok) return;
    row = (await lock.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND repository_id=$2 AND status IN ('queued','running') ORDER BY created_at LIMIT 1`, [worker.organization_id, worker.repository_id])).rows[0];
    if (!row || draining) return;
    // Same session lock as the old Go indexer. An orphan is not replayed.
    if (row.status === 'running') throw new Error('Interrupted index');
    const claims = { tenant: worker.organization_id, repository: Number(worker.repository_id), connection: row.connection_id, installation: Number(row.installation_id), subject: row.subject };
    await authorizedWorker(claims);
    await indexOperation(worker.organization_id, row.subject, row.id, worker.repository_id);
    await verifyIndexAccess(worker.organization_id, row.subject, worker.repository_id);
    row.progress = indexStage(row.progress, 'resolving', 'Resolving repository access and the selected revision.');
    await lock.query(`UPDATE ${table} SET status='running',progress=$4,updated_at=now() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status='queued'`, [worker.organization_id, worker.repository_id, row.id, row.progress]);
    let watching = false;
    watch = setInterval(async () => {
      if (watching) return; watching = true;
      try {
        await authorizedWorker(claims);
        if (!(await lock.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status='running'`, [worker.organization_id, worker.repository_id, row.id])).rowCount) abort.abort();
      } catch { abort.abort(); } finally { watching = false; }
    }, 3000);
    const revision = row.progress.analyze_only ? row.progress.revision : await fetchRepositoryRevision(worker, abort.signal);
    row.progress.revision = revision;
    const token = await repositoryToken(worker, abort.signal, true);
    const [owner, repo] = worker.full_name.split('/');
    const result = await runRust(row.progress.analyze_only ? 'describe' : 'index', host, { run_id: row.id, tenant_id: worker.organization_id, repository_id: worker.repository_id,
      owner, repo, pull_number: 1, base_sha: revision, head_sha: revision }, {}, token, `index-${randomUUID()}`, abort.signal, undefined,
      row.progress.analyze_only ? undefined : async update => {
        if (abort.signal.aborted) return;
        row.progress = mergeIndexProgress(row.progress, update);
        const saved = await lock.query(`UPDATE ${table} SET progress=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status='running'`,
          [worker.organization_id, worker.repository_id, row.id, row.progress]);
        if (!saved.rowCount) abort.abort();
      });
    if (!result.report || (!row.progress.analyze_only && !result.report.indexed) || abort.signal.aborted) {
      if (engineFailure(result.events) === INVALID_IGNORE) failure = { code: INVALID_IGNORE, message: 'The .inkspectignore file on the default branch is invalid, so the repository was not indexed. Fix it, then start a new index.' };
      throw new Error('Index failed');
    }
    const { description_sources: sources, ...indexed } = result.report;
    let progress = indexStage(mergeIndexProgress(row.progress, indexed), 'summarizing', 'Index saved. Generating the repository description.');
    await lock.query(`UPDATE ${table} SET progress=$4,updated_at=now() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status='running'`, [worker.organization_id, worker.repository_id, row.id, progress]);
    await authorizedWorker(claims);
    const description = await describeRepository(worker.full_name, sources);
    if (abort.signal.aborted) throw new Error('Index cancelled');
    progress.summary = description.summary;
    progress = indexStage(progress, 'completed', `Index ready: ${progress.chunks} chunks saved.`);
    await policy.indexUsage({ organization: worker.organization_id, user: row.subject, repository: worker.repository_id, operation: row.id }, result.events, result.report.chunks, description.usage, host);
    await lock.query(`UPDATE ${table} SET status='completed',progress=$4,updated_at=now() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status='running'`, [worker.organization_id, worker.repository_id, row.id, progress]);
  } catch {
    if (row) await lock.query(`UPDATE ${table} SET status='failed',progress=progress || jsonb_strip_nulls(jsonb_build_object('stage','failed','error',$4::text,'error_code',$5::text))
      || jsonb_build_object('logs',coalesce(progress->'logs','[]'::jsonb) || $6::jsonb),updated_at=clock_timestamp() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status IN ('queued','running')`,
      [worker.organization_id, worker.repository_id, row.id, failure.message, failure.code,
        JSON.stringify([{ key: 'progress:failed', at: new Date().toISOString(), message: failure.message }])]).catch(() => {});
  } finally { if (watch) clearInterval(watch); lock.removeListener('error', lost); await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => {}); lock.release(true); }
}

// Recovery uses advisory ownership, never an elapsed-time guess. Live old
// generations retain their locks while draining. No paid attempt is replayed.
async function recover() {
  const rows = (await database().query<EngineJob>("SELECT * FROM api_engine_job WHERE status IN ('running','paused') ORDER BY created_at LIMIT 100")).rows;
  for (const job of rows) {
    const tx = await database().connect();
    try {
      const events = await readJournal(resolve(state, job.id)).catch(() => [{ kind: 'journal.unavailable' }]);
      await recoverReview(tx, job.id, policy.receipt(job, events));
    } finally { tx.release(true); }
  }
}
async function settleCompleted() {
  for (const job of await policy.pending()) {
    try {
      const events = await readJournal(resolve(state, job.id));
      await policy.retrieval(job, events);
      await policy.settle(job);
    } finally { await policy.checked(job); }
  }
}
let lastProvision = 0, indexCursor = 0, autoScanning = false;
const statsRetryAt = new Map<string, number>();
while (!stopping || active) {
  try {
    const runtime = (await database().query('SELECT * FROM api_engine_runtime WHERE id')).rows[0];
    if (Date.now() - lastProvision > 15000 && !draining) {
      // Standby catalogs are necessary for atomic traffic cutover; registry
      // changes are only made by the active generation after legacy handoff.
      await provision(!runtime.legacy_draining && runtime.generation === generation);
      await recover();
      if (runtime.generation === generation) { await settleCompleted();
        if (!autoScanning && active < 2) {autoScanning=true; void track(() => enqueueAutomaticFixes(host, (worker, claims, id, method, host, signal, retry, automatic) => handleFix(policy.fix, worker, claims, id, method, host, signal, automatic, retry))).catch(()=>{}).finally(()=>{autoScanning=false;});} }
      lastProvision = Date.now();
    }
    healthy = Date.now();
    if (!draining && runtime.generation === generation && active < 2) {
      const job = (await database().query<EngineJob>("SELECT j.* FROM api_engine_job j WHERE j.status='queued' AND NOT j.cancel_requested AND NOT EXISTS(SELECT 1 FROM api_engine_job a WHERE a.organization_id=j.organization_id AND a.repository_id=j.repository_id AND a.status IN ('running','paused')) AND (NOT(j.request ? 'fix_of') OR j.request ? 'byok' OR NOT EXISTS(SELECT 1 FROM api_engine_job f WHERE f.status IN ('running','paused') AND f.request ? 'fix_of' AND NOT(f.request ? 'byok'))) ORDER BY j.created_at LIMIT 1")).rows[0];
      if (job) void track(() => runReview(job)).catch(() => {});
      if (!runtime.legacy_draining && active < 2) {
        const workers = (await database().query<Worker>('SELECT * FROM api_repository_worker ORDER BY metadata_due_at')).rows;
        const start = workers.length ? indexCursor % workers.length : 0;
        for (const worker of [...workers.slice(start), ...workers.slice(0, start)]) {
          if (active >= 2) break;
          indexCursor++;
          const latest = (await database(worker.queue_database).query(`SELECT status,progress FROM ${schemaName(worker.queue_schema)}.repository_indexes WHERE tenant_id=$1 AND repository_id=$2 ORDER BY (status IN ('queued','running')) DESC,created_at DESC LIMIT 1`, [worker.organization_id, worker.repository_id])).rows[0];
          if (latest && ['queued', 'running'].includes(latest.status)) void track(() => runIndex(worker)).catch(() => {});
          else if (latest && needsIndexStats(latest)) {
            const key = `${worker.organization_id}:${worker.repository_id}`;
            if (Date.now() >= (statsRetryAt.get(key) ?? 0)) {
              statsRetryAt.set(key, Date.now() + 15 * 60_000);
              void track(() => backfillIndexStats(worker, host)).catch(() => {});
            }
          }
        }
      }
    }
  } catch { healthy = 0; }
  await delay(1000);
}
await closeDatabases();
process.exit(0);

}
