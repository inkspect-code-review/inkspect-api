import type { Pool } from 'pg';
import { database } from "./database";
import { ReviewError } from "@inkspect/core/lib/review-access";
import type { RepositoryIndex } from "@inkspect/core/lib/repository-types";
import type { Worker } from "@inkspect/core/lib/worker-type";
export type { Worker } from "@inkspect/core/lib/worker-type";
export const indexLimit = 500 * 1024 * 1024;
export const preparingRepository = 'Preparing repository for indexing…';
export function eligibility(worker: Worker | null, now = Date.now()) {
  const size = worker?.size_bytes != null ? Number(worker.size_bytes) : null;
  const verified = !!worker?.access_verified_at && now - new Date(worker.access_verified_at).getTime() < 15 * 60_000 && !worker.access_error;
  const support = size !== null && size > indexLimit;
  return { size_bytes: size, limit_bytes: indexLimit, allowed: verified && size !== null && size >= 0 && !support, support_required: support, reason: support ? 'Repositories over 500 MB require support assistance.' : !worker ? preparingRepository : !verified || size === null ? 'Checking repository access and size…' : undefined };
}
export async function workerFor(organization: string, repository: number, connection: string, installation: string, pool = database()): Promise<Worker | null> {
  return (await pool.query<Worker>('SELECT * FROM api_repository_worker WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4', [organization, String(repository), connection, installation])).rows[0] ?? null;
}
function table(worker: Pick<Worker, "queue_schema">) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(worker.queue_schema)) throw new Error('Invalid queue registration');
  return `"${worker.queue_schema}".repository_indexes`;
}
const columns = 'id,status,progress,created_at,updated_at';
export async function latestIndex(worker: Worker, pool = database(worker.queue_database)): Promise<RepositoryIndex | null> {
  return (await pool.query<RepositoryIndex>(`SELECT ${columns} FROM ${table(worker)} WHERE tenant_id=$1 AND repository_id=$2 ORDER BY created_at DESC LIMIT 1`, [worker.organization_id, worker.repository_id])).rows[0] ?? null;
}
export async function enqueueIndex(worker: Worker, id: string, subject: string, analyze: boolean, pool: Pool = database(worker.queue_database)) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`index-admission:${worker.organization_id}:${worker.repository_id}`]);
    const scope = [worker.organization_id, worker.repository_id];
    const old = (await tx.query<RepositoryIndex & { subject: string; connection_id: string; installation_id: string }>(`SELECT ${columns},subject,connection_id,installation_id FROM ${table(worker)} WHERE tenant_id=$1 AND repository_id=$2 AND (id=$3 OR status IN ('queued','running')) ORDER BY created_at DESC LIMIT 1`, [...scope, id])).rows[0];
    if (old) {
      if (old.id === id && old.subject !== subject) throw new ReviewError(409, 'This request number is already in use.');
      if (old.connection_id !== worker.connection_id || String(old.installation_id) !== String(worker.installation_id)) throw new ReviewError(409, 'The repository connection changed. Stop the old operation first.');
      await tx.query('COMMIT');
      const { subject: _subject, connection_id: _connection, installation_id: _installation, ...index } = old;
      return index;
    }
    let progress: RepositoryIndex['progress'] = { stage: 'queued', scan: { stage: '', total: 0, processed: 0, read: 0, skipped: 0, chunks: 0 }, chunks: 0, embedded: 0, reused: 0, indexed: false, logs: [{ at: new Date().toISOString(), message: 'Index queued.' }] };
    if (analyze) {
      const previous = (await tx.query<RepositoryIndex & { connection_id: string; installation_id: string }>(`SELECT ${columns},connection_id,installation_id FROM ${table(worker)} WHERE tenant_id=$1 AND repository_id=$2 ORDER BY created_at DESC LIMIT 1`, scope)).rows[0];
      if (!previous?.progress.indexed || !previous.progress.revision || previous.progress.summary || previous.connection_id !== worker.connection_id || String(previous.installation_id) !== String(worker.installation_id)) throw new ReviewError(409, 'An indexed repository without a description is required.');
      progress = { ...previous.progress, analyze_only: true, stage: 'queued', error: undefined, logs: [...previous.progress.logs, { at: new Date().toISOString(), message: 'Analysis queued. Using the existing index.' }] };
    }
    const result = await tx.query<RepositoryIndex>(`INSERT INTO ${table(worker)}(tenant_id,repository_id,id,subject,connection_id,installation_id,status,progress) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING ${columns}`, [...scope, id, subject, worker.connection_id, worker.installation_id, JSON.stringify(progress)]);
    await tx.query('COMMIT'); return result.rows[0];
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function cancelIndex(worker: Worker, id: string, pool = database(worker.queue_database)) {
  const event = JSON.stringify({ at: new Date().toISOString(), message: 'Indexing stopped by user.' });
  await pool.query(`UPDATE ${table(worker)} SET status='failed', progress=jsonb_set((progress-'error') || jsonb_build_object('stage','cancelled'),'{logs}',coalesce(progress->'logs','[]'::jsonb) || jsonb_build_array($4::jsonb)),updated_at=clock_timestamp() WHERE tenant_id=$1 AND repository_id=$2 AND id=$3 AND status IN ('queued','running')`, [worker.organization_id,worker.repository_id,id,event]);
  const index = (await pool.query<RepositoryIndex>(`SELECT ${columns} FROM ${table(worker)} WHERE tenant_id=$1 AND repository_id=$2 AND id=$3`, [worker.organization_id,worker.repository_id,id])).rows[0];
  if (!index) throw new ReviewError(404, 'Index operation not found.');
  return index;
}

export async function lastIndexed(worker: Worker, pool = database(worker.queue_database)): Promise<RepositoryIndex | null> {
  // A newer interrupted job may already have published a different manifest.
  // Only the latest durable job can suppress admission; otherwise the worker
  // resolves the authoritative manifest without re-embedding an unchanged SHA.
  const row = (await pool.query<RepositoryIndex & { connection_id: string; installation_id: string }>(`SELECT ${columns},connection_id,installation_id FROM ${table(worker)} WHERE tenant_id=$1 AND repository_id=$2 ORDER BY created_at DESC LIMIT 1`, [worker.organization_id, worker.repository_id])).rows[0];
  if (!row?.progress.indexed || row.connection_id !== worker.connection_id || String(row.installation_id) !== String(worker.installation_id)) return null;
  const { connection_id: _connection, installation_id: _installation, ...index } = row;
  return index;
}

// A failed later reindex does not discard a previously published snapshot.
type IndexScope = Pick<Worker, "organization_id" | "repository_id" | "connection_id" | "installation_id" | "queue_schema">;
function savedIndexQuery(worker: IndexScope, fields: string, offset = 0) {
  const values = [worker.organization_id, worker.repository_id, worker.connection_id, worker.installation_id];
  const [tenant, repo, connection, installation] = values.map((_, i) => `$${offset + i + 1}`);
  return {
    text: `SELECT ${fields} FROM ${table(worker)}
      WHERE tenant_id=${tenant} AND repository_id=${repo} AND connection_id=${connection} AND installation_id=${installation}
        AND progress->>'indexed'='true' AND progress->>'revision' ~ '^[a-f0-9]{40}$'
      ORDER BY created_at DESC LIMIT 1`,
    values,
  };
}
export async function storedIndex(worker: Worker, pool = database(worker.queue_database)): Promise<RepositoryIndex | null> {
  return (await pool.query<RepositoryIndex>(savedIndexQuery(worker, columns))).rows[0] ?? null;
}

type ConnectedIndexScope = Pick<IndexScope, "repository_id" | "connection_id" | "installation_id">;
export async function repositoryIndexCoverage(organization: string, scopes: ConnectedIndexScope[], getPool = database) {
  const coverage: Record<string, "indexed" | "partial"> = {};
  if (!scopes.length) return coverage;
  const workers = await getPool().query<IndexScope & { queue_database: string }>(`
    SELECT w.organization_id, w.repository_id, w.connection_id, w.installation_id, w.queue_schema, w.queue_database
    FROM api_repository_worker w
    JOIN unnest($2::text[], $3::text[], $4::bigint[]) AS allowed(repository_id, connection_id, installation_id)
      USING (repository_id, connection_id, installation_id)
    WHERE w.organization_id=$1 AND (w.access_error IS NULL OR w.access_error NOT IN ('revoked', 'access_unavailable'))`,
    [organization, scopes.map(s => s.repository_id), scopes.map(s => s.connection_id), scopes.map(s => s.installation_id)]);
  // Each repository has its own queue schema. Read the visible page in one query per database.
  for (const db of new Set(workers.rows.map(w => w.queue_database))) {
    const queries: string[] = [];
    const values: string[] = [];
    for (const worker of workers.rows.filter(w => w.queue_database === db)) {
      const fields = `repository_id, progress->'partial' AS partial, coalesce(progress->>'skipped', progress#>>'{scan,skipped}') AS skipped`;
      const query = savedIndexQuery(worker, fields, values.length);
      queries.push(`(${query.text})`);
      values.push(...query.values);
    }
    const saved = await getPool(db).query<{ repository_id: string; partial: boolean | null; skipped: string | null }>(queries.join(" UNION ALL "), values);
    for (const row of saved.rows) coverage[row.repository_id] = row.partial || Number(row.skipped) > 0 ? "partial" : "indexed";
  }
  return coverage;
}
