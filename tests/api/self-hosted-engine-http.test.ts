import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pools } from "../../src/database";
import { createEngineHandler } from "../../src/engine-http-core";
import { selfHostedEnginePolicy } from "../../src/self-hosted/engine-policy";
import { selfHostedReviewLifecycle } from "../../src/self-hosted/review-lifecycle";
import { signEngineRequest } from "@inkspect/core/lib/engine-client";
import { ReviewError } from "@inkspect/core/lib/review-access";
import type { ReviewLifecycle } from "@inkspect/core/lib/review-lifecycle";
import type { HostConfig } from "../../src/engine-contract";

test('self-hosted signed gateway admits one review and scopes retrieval without any billing tables', { skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL }, async () => {
  const schema = `self_engine_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  const directory = await mkdtemp(join(tmpdir(), 'inkspect-self-engine-'));
  const originalFetch = globalThis.fetch, previousSecret = process.env.INKSPECT_ENGINE_SECRET;
  const secret = 'synthetic-engine-test-key-'.repeat(2);
  process.env.INKSPECT_ENGINE_SECRET = secret;
  pools.set('app', pool);
  let retrievals = 0, measurements = 0;
  const host = { model_id: 'operator-model', budget_nano_usd: 1000 } as HostConfig;
  const policy = selfHostedEnginePolicy(pool, {
    fix: async () => { throw new Error('Fix is outside this gateway test'); },
    fixPullOpen: async () => { throw new Error('Fix is outside this gateway test'); },
    retrieval: async () => { measurements++; },
  });
  const server = createServer(createEngineHandler(host, () => ({ status: 'ready' }), fn => fn(), policy, {
    runRust: async () => { retrievals++; return { events: [], report: { saved: true } }; },
  }));
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const name of ['001_repository_api.sql', '004_rust_engine.sql']) await pool.query(await readFile(new URL(import.meta.resolve(`@inkspect/api/migrations/${name}`)), 'utf8'));
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE organization(id text PRIMARY KEY);
      CREATE TABLE member("organizationId" text,"userId" text,role text);
      CREATE TABLE "githubConnection"(id text,"organizationId" text,"installationId" text,repositories jsonb);
      CREATE TABLE "githubRepositoryClaim"("organizationId" text,"repositoryId" text);
      CREATE TABLE "chatConversation"(id text PRIMARY KEY,"organizationId" text,"userId" text);
      CREATE TABLE repository_indexes(id text,tenant_id text,repository_id text,subject text,connection_id text,installation_id bigint,status text,progress jsonb,created_at timestamptz,updated_at timestamptz);
      INSERT INTO "user" VALUES('person'),('other'); INSERT INTO organization VALUES('tenant');
      INSERT INTO member VALUES('tenant','person','owner'),('tenant','other','member');
      INSERT INTO "githubConnection" VALUES('connection','tenant','1','[{"id":2,"fullName":"team/repo"}]');
      INSERT INTO "githubRepositoryClaim" VALUES('tenant','2');
      INSERT INTO "chatConversation" VALUES('chat','tenant','person');`);
    for (const name of ['002_chat_execution.sql', '003_provider_settings.sql', '004_review_execution.sql']) await pool.query(await readFile(new URL(import.meta.resolve(`@inkspect/api/migrations/self-hosted/${name}`)), 'utf8'));
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), keyFile = join(directory, 'github.pem');
    await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await pool.query(`INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file)
      VALUES('tenant','2','connection',1,'team/repo','app',$1,7,$2)`, [schema, keyFile]);
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (!address.startsWith('https://api.github.com/')) return originalFetch(url, init);
      if (address.endsWith('/installation')) return Response.json({ id: 1, app_id: 7 });
      if (address.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token', repositories: [{ id: 2 }] });
      if (address.endsWith('/pulls/3')) return Response.json({ number: 3, title: 'Update dependencies', state: 'open', draft: false, base: { sha: 'a'.repeat(40), repo: { id: 2, full_name: 'team/repo' } }, head: { sha: 'b'.repeat(40) } });
      if (address.includes('/compare/')) return Response.json({ merge_base_commit: { sha: 'c'.repeat(40) } });
      throw new Error('Unexpected upstream call');
    };
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const claims = { tenant: 'tenant', subject: 'person', connection: 'connection', installation: 1, repository: 2 };
    const send: Parameters<ReviewLifecycle['start']>[3] = async (path, method, body, scope) => {
      const raw = body ? JSON.stringify(body) : '';
      const response = await originalFetch(`http://127.0.0.1:${address.port}${path}`, { method, ...(body ? { body: raw } : {}),
        headers: signEngineRequest(method, path, raw, { ...scope, expires: Math.floor(Date.now() / 1000) + 30 }, secret) });
      const value = await response.json();
      if (!response.ok) throw new ReviewError(response.status, value.error);
      return value;
    };
    const configuration = await send('/github/repositories', 'GET', undefined, claims);
    assert.equal(configuration.edition, 'self-hosted'); assert.equal(configuration.billable, false);
    const body = { repository_id: 2, number: 3, base_tip: 'a'.repeat(40), head: 'b'.repeat(40) };
    await assert.rejects(send('/github/reviews', 'POST', body, claims), /active review admission/);
    const lifecycle = selfHostedReviewLifecycle(pool, async () => ({ default_model_id: 'operator-model', models: [{ id: 'operator-model', name: 'Operator', provider: 'bedrock', routing: 'instance', available: true }], region: 'test', checked_at: new Date().toISOString() }));
    const access = { organizationId: 'tenant', userId: 'person', member: { role: 'owner' }, connections: [] } as Parameters<ReviewLifecycle['start']>[0];
    const jobs = await Promise.all([lifecycle.start(access, body, claims, send), lifecycle.start(access, body, claims, send)]);
    assert.equal(jobs[0].job.id, jobs[1].job.id);
    assert.equal(jobs[0].snapshot.title, 'Update dependencies');
    await pool.query("UPDATE api_engine_job SET snapshot=snapshot-'title' WHERE id=$1", [jobs[0].job.id]);
    const resolved = await send('/github/pulls/3/title', 'GET', undefined, claims);
    assert.equal(resolved.title, 'Update dependencies');
    assert.equal((await send(`/jobs/${jobs[0].job.id}`, 'GET', undefined, claims)).snapshot.title, resolved.title);
    assert.equal((await pool.query('SELECT count(*)::int n FROM api_engine_job')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT job_id FROM workspace_review_execution')).rows[0].job_id, jobs[0].job.id);
    await assert.rejects(send('/jobs', 'GET', undefined, { ...claims, tenant: 'other' }), /access is no longer/);
    const cancelled = await send(`/jobs/${jobs[0].job.id}/cancel`, 'POST', {}, claims);
    await lifecycle.settle('tenant', cancelled);
    assert.equal((await pool.query('SELECT state FROM workspace_review_execution')).rows[0].state, 'cancelled');
    await pool.query(`INSERT INTO repository_indexes VALUES('index','tenant','2','person','connection',1,'completed',$1,now(),now())`, [{ indexed: true, revision: 'd'.repeat(40) }]);
    await assert.rejects(send('/chat/context', 'POST', { message_id: 'missing' }, claims), /no longer active/);
    await pool.query("INSERT INTO workspace_chat_turn(message_id,organization_id,user_id,conversation_id,model) VALUES('message','tenant','person','chat','operator-model')");
    await assert.rejects(send('/chat/context', 'POST', { message_id: 'message' }, { ...claims, subject: 'other' }), /no longer active/);
    await send('/chat/context', 'POST', { message_id: 'message' }, claims);
    assert.equal(retrievals, 1); assert.equal(measurements, 1);
    await pool.query("UPDATE workspace_chat_turn SET redacted=true");
    await assert.rejects(send('/chat/context', 'POST', { message_id: 'message' }, claims), /no longer active/);
    assert.equal(retrievals, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = originalFetch; pools.delete('app');
    if (previousSecret === undefined) delete process.env.INKSPECT_ENGINE_SECRET; else process.env.INKSPECT_ENGINE_SECRET = previousSecret;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); await rm(directory, { recursive: true, force: true });
  }
});
