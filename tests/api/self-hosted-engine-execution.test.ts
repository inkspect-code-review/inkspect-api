import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { pools } from "../../src/database";
import { selfHostedEngineWorkerPolicy } from "../../src/self-hosted/engine-worker-policy";
import { selfHostedProviders } from "../../src/self-hosted/provider-store";
import { runFix } from "../../src/engine-fix-core";
import { loadJob } from "../../src/engine-store";
import { claimReview } from "../../src/engine-queue";
import type { HostConfig } from "../../src/engine-contract";
import type { Worker } from "../../src/repository-store";

test('self-hosted execution uses instance or encrypted organization providers and retains measured costs without payments', { skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL }, async t => {
  const schema = `self_execution_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  const directory = await mkdtemp(join(tmpdir(), 'inkspect-self-execution-'));
  const saved = Object.fromEntries(['INKSPECT_RUST_BINARY', 'INKSPECT_RUST_STATE', 'INKSPECT_BYOK_PUBLIC_KEY_FILE', 'INKSPECT_BYOK_PRIVATE_KEY_FILE'].map(key => [key, process.env[key]]));
  pools.set('app', pool);
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/installation')) return Response.json({ id: 1, app_id: 7 });
    if (url.endsWith('/access_tokens')) return Response.json({ token: JSON.parse(String(init.body)).permissions.contents === 'write' ? 'write-token' : 'read-token', repositories: [{ id: 2 }] });
    if (url.endsWith('/pulls/3')) return Response.json({ number: 3, state: 'open', draft: false, base: { sha: 'a'.repeat(40), ref: 'main', repo: { id: 2, full_name: 'team/repo', default_branch: 'main' } }, head: { sha: 'b'.repeat(40), ref: 'feature', repo: { id: 2, full_name: 'team/repo' } } });
    if (url.endsWith('/graphql')) {
      writes++;
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.variables.input.expectedHeadOid, 'b'.repeat(40));
      assert.equal(payload.variables.input.branch.branchName, 'feature');
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer write-token');
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: 'c'.repeat(40) } } } });
    }
    throw new Error('Unexpected external call');
  });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE organization(id text PRIMARY KEY);
      CREATE TABLE member("organizationId" text,"userId" text,role text);
      CREATE TABLE "githubRepositoryClaim"("organizationId" text,"repositoryId" text,"accountId" text);
      CREATE TABLE "githubConnection"(id text,"organizationId" text,"installationId" text,repositories jsonb);
      INSERT INTO "user" VALUES('owner'),('viewer'); INSERT INTO organization VALUES('org');
      INSERT INTO member VALUES('org','owner','owner'),('org','viewer','member');
      INSERT INTO "githubRepositoryClaim" VALUES('org','2','owner');
      INSERT INTO "githubConnection" VALUES('connection','org','1','[{"id":2,"fullName":"team/repo"}]');`);
    for (const name of ['001_repository_api.sql', '002_pull_request_workflows.sql', '004_rust_engine.sql', '005_auto_fix.sql']) await pool.query(await readFile(new URL(import.meta.resolve(`@inkspect/api/migrations/${name}`)), 'utf8'));
    for (const name of ['003_provider_settings.sql', '004_review_execution.sql', '005_provider_usage.sql']) await pool.query(await readFile(new URL(import.meta.resolve(`@inkspect/api/migrations/self-hosted/${name}`)), 'utf8'));
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const keyFile = join(directory, 'private.pem');
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(join(directory, 'public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.INKSPECT_BYOK_PRIVATE_KEY_FILE = keyFile; process.env.INKSPECT_BYOK_PUBLIC_KEY_FILE = join(directory, 'public.pem');
    await pool.query(`INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file)
      VALUES('org','2','connection',1,'team/repo','app',$1,7,$2)`, [schema, keyFile]);
    await pool.query("UPDATE api_engine_runtime SET generation='test'");
    const worker = (await pool.query<Worker>('SELECT * FROM api_repository_worker')).rows[0];
    const host = { model_id: 'configured', model_region: 'eu-west-2', timeout_seconds: 30, input_nano_usd: 10, output_nano_usd: 20, budget_nano_usd: 10000,
      model_max_output_tokens: 100, model_input_allowance: 100, model_max_request_bytes: 10000, sandbox: { containerize: false, clone_mib: 50 },
      retrieval: { embed_model: 'eu.cohere.embed-v4:0', region: 'eu-west-2', rerank_model: 'cohere.rerank-v3-5:0', rerank_region: 'eu-central-1' } } satisfies HostConfig;
    const claims = { tenant: 'org', subject: 'owner', repository: 2, installation: 1, connection: 'connection' };
    const policy = selfHostedEngineWorkerPolicy(pool), providers = selfHostedProviders(pool);
    const source = async (digit: string) => {
      const id = 'J-' + digit.repeat(32);
      await pool.query(`INSERT INTO api_engine_job(id,request_id,organization_id,repository_id,connection_id,installation_id,subject,request,snapshot,host_config,status,report)
        VALUES($1,$1,'org','2','connection',1,'owner','{"number":3}',$2,$3,'completed',$4)`, [id, { base_ref: 'main', base: 'a'.repeat(40), base_tip: 'a'.repeat(40), head: 'b'.repeat(40) }, host, { run: { id }, findings: [{ id: 'F1' }] }]);
      return id;
    };
    const binary = join(directory, 'engine');
    await writeFile(binary, `#!${process.execPath}\n` + await readFile(new URL('./fixtures/fix-engine.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
    process.env.INKSPECT_RUST_BINARY = binary; process.env.INKSPECT_RUST_STATE = directory;
    const sourceId = await source('a');
    await assert.rejects(policy.http.fix(worker, { ...claims, subject: 'viewer' }, sourceId, 'POST', host, new AbortController().signal), /admin/);
    const admitted = await policy.http.fix(worker, claims, sourceId, 'POST', host, new AbortController().signal);
    const id = (admitted.fix as { id: string }).id;
    const job = (await loadJob(worker, id))!;
    const connection = await pool.connect();
    try { assert.equal(await claimReview(connection, job, 'test'), true); } finally { connection.release(); }
    assert.equal((await policy.allowed(job)).allowed, true);
    assert.equal(await policy.credential(job), undefined);
    const result = await runFix(policy.fix, job, worker, new AbortController().signal);
    assert.equal(result.report.commit, 'c'.repeat(40)); assert.equal(writes, 1);
    await pool.query("UPDATE api_engine_job SET status='completed',billing_usage=$2 WHERE id=$1", [id, policy.receipt(job, result.events)]);
    assert.equal((await policy.pending()).length, 1);
    await policy.settle((await loadJob(worker, id))!);
    assert.equal((await policy.pending()).length, 0);
    const measured = (await pool.query('SELECT state,measurement FROM workspace_review_execution WHERE job_id=$1', [id])).rows[0];
    assert.equal(measured.state, 'completed'); assert.equal(measured.measurement.calls, 2);
    assert.equal(measured.measurement.provider_cost_nano_usd, undefined, 'unknown provider pricing must not use the admission ceiling as cost');
    await policy.http.fix(worker, claims, sourceId, 'POST', host, new AbortController().signal);
    assert.equal(writes, 1);

    const secret = 'synthetic-self-hosted-provider-key-123456';
    await providers.save('org', 'owner', 'openai', 'gpt-6.1-sol', secret);
    const byokSource = await source('d');
    const byok = await policy.http.fix(worker, claims, byokSource, 'POST', host, new AbortController().signal);
    const byokJob = (await loadJob(worker, (byok.fix as { id: string }).id))!;
    const opened = await policy.credential(byokJob); assert.equal(opened?.api_key, secret); opened!.api_key = '';
    await pool.query("UPDATE api_engine_job SET status='running' WHERE id=$1", [byokJob.id]);
    await writeFile(join(directory, 'control.json'), JSON.stringify({ credential_length: secret.length }));
    const fixed = await runFix(policy.fix, byokJob, worker, new AbortController().signal);
    assert.equal(fixed.report.commit, 'c'.repeat(40)); assert.equal(writes, 2);
    for (const file of ['job.json', 'host.json', 'request.json', 'report.json', 'usage.jsonl']) assert.ok(!(await readFile(join(directory, byokJob.id, file), 'utf8')).includes(secret));
    await providers.save('org', 'owner', 'openai', 'gpt-6.1-sol', 'synthetic-rotated-provider-key-789');
    await assert.rejects(policy.credential(byokJob), /provider key or model changed/);

    const scope = { organization: 'org', user: 'owner', repository: '2', operation: 'index' };
    const events = [{ kind: 'embedding.started', id: 'embed' }, { kind: 'embedding.usage', id: 'embed', input_tokens: 100 }, { kind: 'rerank.started', id: 'rank', units: 10 }];
    const description = { content: 'private description', model: 'operator-chat', inputTokens: 5, outputTokens: 2, totalTokens: 7, durationMs: 10, chargedNanoUSD: '35' };
    await policy.indexUsage(scope, events, 20, description, host);
    await policy.indexUsage(scope, events, 20, description, host);
    const usage = (await pool.query('SELECT * FROM workspace_provider_usage ORDER BY operation_id')).rows;
    assert.equal(usage.length, 4, 'reconciliation must not duplicate provider measurements');
    assert.equal(usage.find(row => row.operation_id.endsWith(':embedding:embed')).measurement.provider_cost_nano_usd, '12000');
    assert.equal(usage.find(row => row.operation_id.endsWith(':rerank:rank')).measurement.provider_cost_nano_usd, undefined);
    assert.doesNotMatch(JSON.stringify(usage), /private description|chargedNanoUSD/);
    await pool.query('DELETE FROM member WHERE "userId"=$1', ['owner']);
    await assert.rejects(policy.allowed(byokJob), /access is no longer/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    pools.delete('app'); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); await rm(directory, { recursive: true, force: true });
  }
});
