import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';

// Real API + worker + PostgreSQL; only external GitHub/model/engine inputs are synthetic.
export async function checkEmptyIndex({ pool, org, userId, request, start }: {
  pool: Pool; org: string; userId: string;
  request: (path: string, body?: object) => Promise<Response>;
  start: (args: string[], cwd?: string, extra?: Record<string, string>) => ChildProcess;
}) {
  const temporary = await mkdtemp(join(tmpdir(), 'inkspect-empty-index-'));
  const connection = randomUUID(), repository = 17, installation = '44';
  const schema: string = (await pool.query('SELECT current_schema() AS name')).rows[0].name;
  assert.match(schema, /^runtime_[a-f0-9]{32}$/);
  let worker: ChildProcess | undefined;
  try {
    const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
    const key = join(temporary, 'github.pem'), binary = join(temporary, 'engine'), host = join(temporary, 'host.json');
    const mode = join(temporary, 'mode'), engineCalls = join(temporary, 'engine-calls'), upstreamCalls = join(temporary, 'upstream-calls');
    const preload = join(temporary, 'upstream.mjs');
    await writeFile(mode, 'empty'); await writeFile(engineCalls, ''); await writeFile(upstreamCalls, '');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(host, JSON.stringify({ model_id: 'test-model', model_region: 'eu-west-2', model_max_output_tokens: 10, timeout_seconds: 60,
      input_nano_usd: 1, output_nano_usd: 1, budget_nano_usd: 1000, model_input_allowance: 10, model_max_request_bytes: 1000,
      retrieval: { region: 'eu-west-2', embed_model: 'test-embed', rerank_region: 'eu-west-2', rerank_model: 'test-rerank', dimensions: 1, candidates: 1, top_n: 1, queries: 1, content_bytes: 1000, max_files: 1 },
      sandbox: { containerize: false, clone_mib: 1 } }));
    await writeFile(binary, `#!${process.execPath}\nimport{appendFileSync,readFileSync,writeFileSync}from'node:fs';
appendFileSync(${JSON.stringify(engineCalls)},process.argv[2]+'\\n');
if(process.argv[2]==='--version'){console.log('synthetic-engine');process.exit(0);}
if(readFileSync(${JSON.stringify(mode)},'utf8')!=='commit')process.exit(91);
const args=process.argv.slice(2),job=JSON.parse(readFileSync(args[args.indexOf('--job')+1],'utf8'));
writeFileSync(args[args.indexOf('--out')+1],JSON.stringify({revision:job.head_sha,indexed:true,chunks:1,embedded:1,reused:0,scan:{measured:true,stage:'reading',total:1,processed:1,read:1,chunks:1,skipped:0},description_sources:[{path:'README.md',content:'# Synthetic repository'}]}));
`, { mode: 0o700 });
    await writeFile(preload, `import{readFile,appendFile}from'node:fs/promises';
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input.url);await appendFile(${JSON.stringify(upstreamCalls)},url.hostname+url.pathname+'\\n');
 const mode=await readFile(${JSON.stringify(mode)},'utf8');
 if(url.hostname==='api.github.com'){
  if(url.pathname==='/repos/fixture/empty/installation')return Response.json({id:44,app_id:1});
  if(url.pathname==='/app/installations/44/access_tokens')return Response.json({token:'synthetic-test-token',repositories:[{id:17}]});
  if(url.pathname==='/repos/fixture/empty')return Response.json({id:17,full_name:'fixture/empty',default_branch:'main',size:0});
  if(url.pathname==='/repos/fixture/empty/commits')return mode==='empty'?Response.json({message:'Git Repository is empty.'},{status:409}):mode==='denied'?Response.json({message:'Forbidden'},{status:403}):Response.json([{sha:'a'.repeat(40)}]);
 }
 if(url.hostname==='bedrock-runtime.eu-west-2.amazonaws.com'&&mode==='commit')return Response.json({output:{message:{role:'assistant',content:[{text:JSON.stringify({purpose:'Synthetic repository',architecture:[],technologies:[],evidence:['README.md']})}]}},usage:{inputTokens:5,outputTokens:5,totalTokens:10},metrics:{latencyMs:1},stopReason:'end_turn'});
 throw new Error('Unexpected external request in fixture');
};
`);
    await pool.query('INSERT INTO "githubConnection"(id,"organizationId","installationId","accountLogin",repositories,"updatedAt") VALUES($1,$2,$3,$4,$5,now())',
      [connection, org, installation, 'fixture', JSON.stringify([{ id: repository, fullName: 'fixture/empty', private: true }])]);
    await pool.query('INSERT INTO "githubRepositoryClaim"(id,"repositoryId","organizationId","accountId","createdAt") VALUES($1,$2,$3,$4,now())', [randomUUID(), String(repository), org, userId]);
    await pool.query(`CREATE TABLE repository_indexes(tenant_id text NOT NULL,repository_id text NOT NULL,id text NOT NULL,subject text NOT NULL,connection_id text NOT NULL,installation_id bigint NOT NULL,status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),progress jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,repository_id,id))`);
    await pool.query(`INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file,size_bytes,access_verified_at,metadata_due_at)
      VALUES($1,'17',$2,44,'fixture/empty','app',$3,'1',$4,0,now(),now()+interval '1 hour')`, [org, connection, schema, key]);
    await pool.query("UPDATE api_engine_runtime SET generation='empty-index-test',origin=$1 WHERE id", [`http://127.0.0.1:${port}`]);
    worker = start(['--import', preload, 'dist/engine-worker.mjs'], undefined, { PORT: String(port), INKSPECT_GENERATION: 'empty-index-test',
      GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_FILE: key, INKSPECT_ENGINE_SECRET: 'synthetic-engine-service-secret-'.repeat(2),
      INKSPECT_RUST_BINARY: binary, INKSPECT_RUST_HOST_CONFIG: host, INKSPECT_RUST_STATE: temporary });
    const endpoint = (action: string) => '/api/repositories?' + new URLSearchParams({ organizationId: org, repository: '17', action });
    async function run(expected: 'empty' | 'failed' | 'completed') {
      const response = await request(endpoint('index'), { requestId: randomUUID() });
      assert.equal(response.status, 202, await response.clone().text());
      const id = (await response.json()).index.id;
      for (let attempt = 0; attempt < 200; attempt++) {
        assert.equal(worker!.exitCode, null, 'engine worker remains alive');
        const result = await request(endpoint('detail')); assert.equal(result.status, 200);
        const { index, eligibility } = await result.json();
        if (index?.id === id && !['queued', 'running'].includes(index.status)) {
          if (expected === 'empty') {
            assert.equal(index.status, 'completed'); assert.equal(index.progress.stage, 'empty'); assert.equal(index.progress.indexed, false);
            assert.equal(index.progress.error, undefined); assert.equal(index.progress.summary, undefined);
            assert.equal(index.progress.scan.measured, true); assert.equal(index.progress.scan.total, 0);
            assert.match(index.progress.logs.at(-1).message, /This repository is empty/);
            assert.equal(eligibility.allowed, true, 'first-commit retry stays enabled');
          } else { assert.equal(index.status, expected, JSON.stringify(index.progress)); assert.equal(index.progress.stage, expected); }
          return index;
        }
        await delay(100);
      }
      throw new Error('Index operation did not reach a terminal state');
    }
    await run('empty');
    assert.deepEqual((await readFile(engineCalls, 'utf8')).trim().split('\n'), ['--version'], 'empty repository never starts the indexer');
    assert.doesNotMatch(await readFile(upstreamCalls, 'utf8'), /bedrock/, 'empty repository never calls the model');
    await writeFile(mode, 'denied'); await run('failed');
    assert.doesNotMatch(await readFile(upstreamCalls, 'utf8'), /bedrock/);
    await writeFile(mode, 'commit'); const populated = await run('completed');
    assert.equal(populated.progress.indexed, true); assert.equal(populated.progress.revision, 'a'.repeat(40));
    assert.equal(populated.progress.summary.purpose, 'Synthetic repository');
    assert.match(await readFile(engineCalls, 'utf8'), /service/);
    return { empty: 'passed', accessFailure: 'passed', firstCommitRetry: 'passed' };
  } finally {
    if (worker && worker.exitCode === null) { const stopped = once(worker, 'exit'); worker.kill('SIGTERM'); await Promise.race([stopped, delay(5000).then(() => { if (worker?.exitCode === null) worker.kill('SIGKILL'); })]); }
    await rm(temporary, { recursive: true, force: true });
  }
}
