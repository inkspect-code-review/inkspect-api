import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pools } from "../../src/database";
import { readRepositoryFindings } from "@inkspect/core/lib/findings-store";
import { loadFindings, parseFindingsQuery, type FindingRow, type FindingsTarget } from "@inkspect/core/lib/findings";

const enabled = process.env.RUN_FINDINGS_POSTGRES_TEST === '1';
test('findings query all stored history, filter before pagination, isolate scope and include legacy reports', { skip: !enabled }, async () => {
  const schema = `findings_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL || process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
  pools.set('app', pool);
  const target = (repositoryId: number): FindingsTarget => ({ repositoryId, repository: `team/repo-${repositoryId}`, claims: { tenant: 'tenant', subject: 'member', connection: 'connection', installation: 44, repository: repositoryId } });
  const opts = (params: Record<string, string> = {}) => parseFindingsQuery(new URLSearchParams(params));
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE api_repository_worker (organization_id text,repository_id text,connection_id text,installation_id bigint,full_name text,queue_database text,queue_schema text,access_error text);
      CREATE TABLE member ("organizationId" text,"userId" text);
      CREATE TABLE "githubConnection" (id text,"organizationId" text,"installationId" text,repositories jsonb);
      CREATE TABLE "githubRepositoryClaim" ("organizationId" text,"repositoryId" text);
      CREATE TABLE api_engine_job (id text PRIMARY KEY,organization_id text,repository_id text,connection_id text,installation_id bigint,status text,created_at timestamptz,request jsonb,snapshot jsonb,report jsonb);
      CREATE TABLE jobs (id text,tenant_id text,status text,created_at timestamptz,request jsonb,scope jsonb);
      CREATE TABLE runs (id text,tenant_id text,report jsonb);
      INSERT INTO member VALUES ('tenant','member');
      INSERT INTO "githubConnection" VALUES ('connection','tenant','44','[{"id":17,"fullName":"team/repo-17"},{"id":18,"fullName":"team/repo-18"}]');
      INSERT INTO "githubRepositoryClaim" VALUES ('tenant','17'),('tenant','18');`);
    await pool.query(`INSERT INTO api_repository_worker SELECT 'tenant',r::text,'connection',44,'team/repo-'||r,'app',$1,NULL FROM unnest(ARRAY[17,18]) r`, [schema]);
    const id = (n: number) => `J-${n.toString(16).padStart(32, '0')}`;
    const report = (n: number, repo = 17, count = 2) => ({ run: { id: id(n), target: { tenant_id: 'tenant', repository_id: String(repo) } }, findings: Array.from({ length: count }, (_, index) => ({ id: `F-${index}`, title: n === 1 ? 'Old authorization check' : 'Current finding', severity: n === 2 ? (index === 0 ? 'P3' : 'medium') : index === 0 ? 'P0' : 'high', location: { path: n === 1 ? 'src/OLD_%.ts' : 'src/current.ts', start_line: index + 1 } })) });
    const insert = async (n: number, repo: number, date: string, value = report(n, repo)) => pool.query(`INSERT INTO api_engine_job VALUES ($1,'tenant',$2,'connection',44,'completed',$3,'{}',$4,$5)`, [id(n), String(repo), date, { url: `https://github.com/team/repo-${repo}/pull/7` }, value]);
    for (let n = 1; n <= 72; n++) await insert(n, 17, n === 1 ? '2026-10-01T23:59:59.999999Z' : '2026-10-30T12:00:00.123456Z');
    await insert(101, 18, '2026-10-30T12:00:00.123457Z', report(101, 18, 1));
    await insert(102, 18, '2026-10-30T12:00:00.123455Z', report(102, 18, 1));
    const legacy = async (n: number) => {
      await pool.query(`INSERT INTO jobs VALUES ($1,'tenant','completed','2026-09-01T00:00:00Z',$2,'{"repository_id":"17"}')`, [id(n), { connection_id: 'connection', installation_id: '44', url: 'https://github.com/team/repo-17/pull/6' }]);
      await pool.query('INSERT INTO runs VALUES ($1,$2,$3)', [id(n), 'tenant', report(n, 17, 1)]);
    };
    await legacy(201);
    await legacy(1); // Migrated duplicate: the current store wins.
    assert.equal((await readRepositoryFindings(target(17), opts())).total, 145);
    const targets = [target(17), target(18)];
    const seen: FindingRow[] = [];
    let options = opts();
    for (;;) {
      const page = await loadFindings(targets, options);
      assert.equal(page.unavailableRepositories, 0);
      assert.equal(page.total, 147);
      assert.ok(page.findings.length <= 25);
      seen.push(...page.findings);
      if (!page.nextCursor) break;
      options = opts({ cursor: page.nextCursor });
    }
    assert.equal(seen.length, 147);
    assert.equal(new Set(seen.map(row => `${row.repositoryId}:${row.jobId}:${row.ordinal}`)).size, 147);
    assert.equal(seen[0].jobId, id(101)); // Microsecond precision survives the cursor.
    assert.equal(seen.at(-1)?.jobId, id(201));
    assert.equal(seen.at(-1)?.pullNumber, 6);
    const ranks: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    const sortCases: Record<string, string>[] = [
      { sort: 'date', direction: 'asc' }, { sort: 'date', direction: 'desc' },
      { sort: 'severity', direction: 'asc' }, { sort: 'severity', direction: 'desc' },
      { sort: 'severity', direction: 'desc', query: 'current', severity: 'high', from: '2026-10-30T00:00:00.000Z' },
    ];
    const key = (row: FindingRow) => `${row.repositoryId}:${row.jobId}:${row.ordinal}`;
    for (const params of sortCases) {
      const expected = seen.filter(row => !params.query || (row.title.toLowerCase().includes(params.query) && row.severity === params.severity && row.createdAt >= params.from)).sort((a, b) => {
        const date = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        const primary = params.sort === 'severity' ? ranks[a.severity] - ranks[b.severity] : date;
        return primary * (params.direction === 'asc' ? 1 : -1) || -date
          || (a.jobId < b.jobId ? 1 : a.jobId > b.jobId ? -1 : 0) || a.ordinal - b.ordinal || b.repositoryId - a.repositoryId;
      });
      const collected: FindingRow[] = [];
      let cursor: string | null = null;
      do {
        const page = await loadFindings(targets, opts({ ...params, ...(cursor ? { cursor } : {}) }));
        assert.equal(page.total, expected.length);
        collected.push(...page.findings);
        cursor = page.nextCursor;
        assert.ok(collected.length <= expected.length, 'Pagination must not repeat findings');
      } while (cursor);
      assert.deepEqual(collected.map(key), expected.map(key), `Global ordering and pagination: ${JSON.stringify(params)}`);
    }
    const firstPage = await loadFindings(targets, opts());
    assert.throws(() => opts({ cursor: firstPage.nextCursor!, sort: 'severity', direction: 'desc' }), /Invalid findings page/);
    assert.throws(() => opts({ cursor: firstPage.nextCursor!, sort: 'date', direction: 'asc' }), /Invalid findings page/);
    const old = await loadFindings(targets, opts({ query: ' old authorization ', severity: 'critical' }));
    assert.equal(old.total, 1);
    assert.equal(old.findings[0].jobId, id(1));
    const file = await loadFindings(targets, opts({ query: 'old_%.TS' }));
    assert.equal(file.total, 2);
    const wildcard = await loadFindings(targets, opts({ query: '%' }));
    assert.equal(wildcard.total, 2);
    const date = await loadFindings(targets, opts({ from: '2026-10-01T00:00:00.000Z', before: '2026-10-02T00:00:00.000Z' }));
    assert.equal(date.total, 2);
    const excludedDay = await loadFindings(targets, opts({ before: '2026-10-01T00:00:00.000Z' }));
    assert.equal(excludedDay.total, 1);
    assert.equal((await loadFindings([target(18)], opts())).total, 2);
    assert.equal((await loadFindings(targets, opts({ query: 'missing literal' }))).total, 0);
    // Neither foreign job metadata nor a mismatched report can escape its workspace scope.
    await insert(301, 17, '2026-10-30T12:00:00Z', { ...report(301), run: { id: id(301), target: { tenant_id: 'foreign', repository_id: '17' } } });
    await insert(302, 17, '2026-10-30T12:00:00Z');
    await pool.query("UPDATE api_engine_job SET organization_id='foreign' WHERE id=$1", [id(302)]);
    await insert(303, 17, '2026-10-30T12:00:00Z');
    await pool.query("UPDATE api_engine_job SET request='{\"fix_of\":\"source\"}' WHERE id=$1", [id(303)]);
    const scoped = await loadFindings(targets, opts());
    assert.equal(scoped.total, 147);
    assert.equal(scoped.unavailableReports, 1);
    await pool.query("UPDATE api_repository_worker SET access_error='revoked' WHERE repository_id='18'");
    const revoked = await loadFindings(targets, opts());
    assert.equal(revoked.total, 147);
    assert.equal(revoked.unavailableRepositories, 0);
    await pool.query(`UPDATE "githubConnection" SET repositories='[]'`);
    assert.equal((await loadFindings(targets, opts())).total, 147, "stored data survives GitHub selection refresh");
    await pool.query('DELETE FROM member');
    await assert.rejects(loadFindings(targets, opts()), /temporarily unavailable/);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    pools.delete('app');
    await pool.end();
  }
});
