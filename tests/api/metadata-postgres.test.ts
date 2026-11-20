import assert from 'node:assert/strict';import test from 'node:test';import {randomUUID,createHmac} from 'node:crypto';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Pool} from 'pg';
import {pools} from "../../src/database";import {refreshOne} from "../../src/metadata";import {githubWebhook} from "../../src/github-webhook";
test('metadata refresh uses a lease, and signed revocation wins over in-flight refresh and cancels indexing',{skip:process.env.RUN_API_POSTGRES_TEST!=='1'},async()=>{
 const schema=`api_metadata_${randomUUID().replaceAll('-','')}`;const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:6});const directory=await mkdtemp(join(tmpdir(),'inkspect-webhook-test-'));const secret='test-secret-for-verified-delivery';const previous=process.env.API_GITHUB_WEBHOOK_SECRET_FILE;
 pools.set('app',pool);process.env.API_GITHUB_WEBHOOK_SECRET_FILE=join(directory,'secret');
 try{
  await writeFile(process.env.API_GITHUB_WEBHOOK_SECRET_FILE,secret,{mode:0o600});await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(await readFile(new URL(import.meta.resolve('@inkspect/api/migrations/001_repository_api.sql')),'utf8'));await pool.query(await readFile(new URL('../fixtures/repository-index-queue.sql', import.meta.url),'utf8'));
  await pool.query(`INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file) VALUES('org','17','c',44,'team/repo','app',$1,1,'unused')`,[schema]);
  let calls=0;let release:()=>void=()=>{};let started:()=>void=()=>{};const ready=new Promise<void>(r=>{started=r;});const pause=new Promise<void>(r=>{release=r;});
  const refreshing=refreshOne(new AbortController().signal,async()=>{calls++;started();await pause;return 1024;});await ready;
  assert.equal(await refreshOne(new AbortController().signal,async()=>{calls++;return 2048;}),false);assert.equal(calls,1);
  await pool.query(`INSERT INTO repository_indexes(tenant_id,repository_id,id,subject,connection_id,installation_id,status,progress) VALUES('org','17','job','user','c',44,'queued','{"logs":[]}')`);
  const body=JSON.stringify({action:'removed',installation:{id:44},repositories_removed:[{id:17}]});
  const request=(signature:string)=>new Request('http://localhost/api/webhooks/github',{method:'POST',headers:{'x-hub-signature-256':signature,'x-github-event':'installation_repositories'},body});
  assert.equal((await githubWebhook(request('sha256='+'0'.repeat(64)))).status,401);
  assert.equal((await githubWebhook(request('sha256='+createHmac('sha256',secret).update(body).digest('hex')))).status,202);
  release();await refreshing;
  const worker=(await pool.query('SELECT * FROM api_repository_worker')).rows[0];assert.equal(worker.access_error,'revoked');assert.equal(worker.access_verified_at,null);
  assert.equal((await pool.query('SELECT progress FROM repository_indexes')).rows[0].progress.stage,'cancelled');
 }finally{pools.delete('app');if(previous===undefined)delete process.env.API_GITHUB_WEBHOOK_SECRET_FILE;else process.env.API_GITHUB_WEBHOOK_SECRET_FILE=previous;await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();await rm(directory,{recursive:true,force:true});}
});
