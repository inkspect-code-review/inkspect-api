import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { backfillIndexStats } from "../../src/engine-index-stats";
import type { HostConfig } from "../../src/engine-contract";
import type { Worker } from "../../src/repository-store";

test('background repair scans the pinned revision without changing the durable index or description', async () => {
  const worker = { organization_id: 'tenant', repository_id: '7', connection_id: 'connection', installation_id: '11',
    full_name: 'team/repo', queue_database: 'app', queue_schema: 'rust_repo_test' } as Worker;
  for (const outcome of ['completed', 'failed', 'missing-report', 'wrong-revision', 'disconnected', 'already-measured', 'revoked'] as const) {
    const row = { id: 'original-job', subject: 'user', connection_id: 'connection', installation_id: '11',
      status: outcome === 'failed' ? 'failed' : 'completed', updated_at: new Date('2026-11-03T16:37:00Z'),
      progress: { indexed: true, revision: 'a'.repeat(40), stage: outcome === 'failed' ? 'failed' : 'completed', chunks: 929, embedded: 929,
        error: outcome === 'failed' ? 'Description failed.' : undefined,
        scan: { measured: outcome === 'already-measured', total: 0 }, logs: [{ at: '2026-11-03T16:34:00Z', message: 'Index queued.' }], summary: { purpose: 'CMS' } } };
    if (outcome === 'disconnected') row.connection_id = 'old-connection';
    const queries: { sql: string; values?: any[] }[] = [];
    let scans = 0, authorizations = 0, released = false;
    const lock = {
      on() {}, removeListener() {}, release() { released = true; },
      async query(sql: string, values?: any[]) {
        queries.push({ sql, values });
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (sql.startsWith('SELECT *')) return { rows: [row] };
        return { rows: [], rowCount: 1 };
      },
    };
    const run = () => backfillIndexStats(worker, {} as HostConfig, {
      database: () => ({ connect: async () => lock } as unknown as Pool),
      authorizedWorker: async claims => {
        authorizations++;
        assert.equal(claims.tenant, 'tenant'); assert.equal(claims.subject, 'user');
        if (outcome === 'revoked') throw new Error('access revoked');
        return worker;
      },
      repositoryToken: async (_worker, _signal, contents) => { assert.equal(contents, true); return 'scoped-test-token'; },
      runRust: async (mode, _host, job, _request, token) => {
        scans++;
        assert.equal(mode, 'index-stats');
        assert.equal(token, 'scoped-test-token');
        assert.equal(job.base_sha, row.progress.revision);
        assert.equal(job.head_sha, row.progress.revision);
        return { events: [], report: outcome === 'missing-report' ? undefined : {
          revision: outcome === 'wrong-revision' ? 'b'.repeat(40) : row.progress.revision,
          scan: { measured: true, stage: 'completed', total: 300, read: 286, processed: 300, skipped: 14, chunks: 929 },
        } };
      },
    });
    if (outcome === 'revoked') await assert.rejects(run(), /access revoked/); else await run();
    const writes = queries.filter(q => q.sql.startsWith('UPDATE'));
    if (outcome === 'completed' || outcome === 'failed') {
      assert.equal(writes.length, 1);
      const [tenant, repository, id, progress, status] = writes[0].values!;
      assert.deepEqual([tenant, repository, id, status], ['tenant', '7', 'original-job', row.status]);
      assert.equal(progress.scan.total, 300); assert.equal(progress.scan.read, 286);
      assert.equal(progress.summary, row.progress.summary);
      assert.equal(progress.chunks, 929); assert.equal(progress.embedded, 929);
      assert.equal(progress.stage, row.progress.stage); assert.equal(progress.error, row.progress.error);
      assert.equal(authorizations, 2, 'access is checked again before writing');
    } else assert.equal(writes.length, 0, 'failed or unnecessary repairs never modify the index');
    if (['disconnected', 'already-measured', 'revoked'].includes(outcome)) assert.equal(scans, 0);
    assert.equal(released, true);
    assert.match(queries.at(-1)!.sql, /pg_advisory_unlock/);
  }
});
