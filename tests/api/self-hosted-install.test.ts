import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Pool } from 'pg';

test('self-hosted installer, API and workers start without payment configuration', { skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL, timeout: 30000 }, async () => {
  const schema = `install_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString() });
  const temporary = await mkdtemp(join(tmpdir(), 'inkspect-install-'));
  let child: ChildProcess | undefined;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    // An allowlist prevents accidental use of developer/payment/provider credentials.
    const env = { PATH: process.env.PATH, NODE_ENV: 'development', INKSPECT_DEV_LOGS: 'false', DATABASE_URL: url.toString(),
      BETTER_AUTH_URL: 'http://localhost:3002', BETTER_AUTH_SECRET: 'synthetic-self-hosted-install-secret-'.repeat(2), PORT: String(port) };
    for (let attempt = 0; attempt < 2; attempt++) {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), env, timeout: 12000,
      });
    }
    const tables = (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [schema])).rows.map(r => r.table_name);
    for (const name of ['user', 'organization', 'member', 'githubConnection', 'chatConversation', 'workspace_invitation', 'workspace_review_execution', 'workspace_provider_usage', 'review_model_catalog', 'api_engine_job']) assert.ok(tables.includes(name), name);
    assert.equal(tables.filter(name => /^(billing_|support_)/.test(name)).length, 0);
    child = spawn(process.execPath, ['dist/server.mjs'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env, stdio: 'pipe' });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      assert.equal(child.exitCode, null, 'API must remain running');
      try { if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) { ready = true; break; } } catch { /* Wait for local listener. */ }
      await delay(50);
    }
    assert.equal(ready, true);
    const request = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal((await request('/api/billing')).status, 404);
    assert.equal((await request('/api/members?organizationId=org')).status, 401);
    assert.equal((await request('/api/usage?organizationId=org')).status, 401);
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    assert.deepEqual(await stopped, [0, null]); child = undefined;

    async function waitFor(path: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child?.exitCode, null, 'service must remain running');
        try { const response = await request(path); if (response.ok) return response; } catch { /* Wait for listener. */ }
        await delay(50);
      }
      throw new Error(`Service did not become ready: ${path}`);
    }
    async function stop(allowedCodes = [0]) {
      const exited = once(child!, 'exit'); child!.kill('SIGTERM');
      const [code] = await exited; assert.ok(allowedCodes.includes(code), `Unexpected shutdown status: ${code}`); child = undefined;
    }
    for (const entry of ['metadata-worker', 'pull-request-worker']) {
      child = spawn(process.execPath, [`dist/${entry}.mjs`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...env, INKSPECT_HEALTH_PORT: String(port) }, stdio: 'pipe' });
      await waitFor('/ready'); await stop();
    }
    // The daemon uses a version-only executable; unexpected model work fails.
    // Actual execution/admission is covered by the scoped engine integration tests.
    const binary = join(temporary, 'engine'), key = join(temporary, 'github.pem'), config = join(temporary, 'host.json');
    await writeFile(binary, `#!${process.execPath}\nif(process.argv[2]!=='--version')process.exit(99);console.log('synthetic-engine');\n`, { mode: 0o700 });
    await writeFile(key, 'synthetic-file-for-startup-only', { mode: 0o600 });
    await writeFile(config, JSON.stringify({ model_id: 'test-model', model_region: 'eu-west-2', model_max_output_tokens: 10,
      timeout_seconds: 60, input_nano_usd: 1, output_nano_usd: 1, budget_nano_usd: 1000, model_input_allowance: 10, model_max_request_bytes: 1000,
      retrieval: { region: 'eu-west-2', embed_model: 'test-embed', rerank_region: 'eu-west-2', rerank_model: 'test-rerank', dimensions: 1, candidates: 1, top_n: 1, queries: 1, content_bytes: 1, max_files: 1 },
      sandbox: { containerize: false, clone_mib: 1 } }));
    await promisify(execFile)(process.execPath, ['dist/engine-admin.mjs', 'activate', 'test-generation', `http://127.0.0.1:${port}`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env });
    child = spawn(process.execPath, ['dist/engine-worker.mjs'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: {
      ...env, INKSPECT_RUST_BINARY: binary, INKSPECT_RUST_HOST_CONFIG: config, INKSPECT_RUST_STATE: temporary,
      GITHUB_APP_PRIVATE_KEY_FILE: key, GITHUB_APP_ID: '1', INKSPECT_GENERATION: 'test-generation', INKSPECT_ENGINE_SECRET: 'synthetic-service-secret-'.repeat(2),
    }, stdio: 'pipe' });
    const engine = await (await waitFor('/ready')).json();
    assert.equal(engine.generation, 'test-generation');
    await stop();
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
