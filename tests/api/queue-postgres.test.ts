import assert from 'node:assert/strict';import test from 'node:test';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {Pool} from 'pg';
import {enqueueIndex,cancelIndex,latestIndex,lastIndexed,type Worker} from "../../src/repository-store";
test('durable index queue deduplicates concurrent requests, scopes cancel, and preserves analysis source', {skip:process.env.RUN_API_POSTGRES_TEST!=='1'},async()=>{
 const schema=`api_test_${randomUUID().replaceAll('-','')}`;const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:6});
 const worker:Worker={organization_id:'org',repository_id:'17',connection_id:'c',installation_id:'44',full_name:'team/repo',queue_database:'app',queue_schema:schema,app_id:'1',private_key_file:'/unused',size_bytes:'100',access_verified_at:new Date(),access_error:null};
 try{
  await pool.query(`CREATE SCHEMA "${schema}"`);await pool.query(await readFile(new URL(import.meta.resolve('@inkspect/api/migrations/012_repository_indexes.sql')),'utf8'));
  const id=randomUUID();const results=await Promise.all([enqueueIndex(worker,id,'user',false,pool),enqueueIndex(worker,id,'user',false,pool)]);assert.equal(results[0].id,results[1].id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM repository_indexes')).rows[0].n,1);
  await assert.rejects(enqueueIndex(worker,id,'other',false,pool),/already in use/);
  await assert.rejects(cancelIndex({...worker,organization_id:'foreign'},id,pool),/not found/);
  const cancelled=await cancelIndex(worker,id,pool);assert.equal(cancelled.progress.stage,'cancelled');assert.equal((await cancelIndex(worker,id,pool)).progress.logs.length,2);
  await pool.query(`UPDATE repository_indexes SET status='completed',progress=progress||$1::jsonb WHERE id=$2`,[JSON.stringify({indexed:true,stage:'completed',revision:'a'.repeat(40),partial:true,skipped:3}),id]);
  assert.equal((await lastIndexed(worker,pool))?.progress.revision,'a'.repeat(40));
  assert.equal(await lastIndexed({...worker,connection_id:'foreign'},pool),null);
  const analysis=await enqueueIndex(worker,randomUUID(),'user',true,pool);assert.equal(analysis.progress.analyze_only,true);assert.equal(analysis.progress.partial,true);assert.equal(analysis.progress.revision,'a'.repeat(40));
  assert.equal((await latestIndex(worker,pool))?.id,analysis.id);
  await cancelIndex(worker,analysis.id,pool);
  const retry=await enqueueIndex(worker,randomUUID(),'user',false,pool);
  assert.equal(retry.progress.indexed,false);
  assert.equal(await lastIndexed(worker,pool),null);

 }finally{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
});
