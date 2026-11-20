import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pools } from '../../src/database';
import { latestFixReview, fixReviewBlocker } from '../../src/engine-fix-core';
import type { EngineJob } from '../../src/engine-store';

test('latest fix review is pinned to the same tenant, installation, repository, PR and current head', {skip:!process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL}, async()=>{
 const schema='fix_latest_'+randomUUID().replaceAll('-','');
 const pool=new Pool({connectionString:process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL,options:'-c search_path='+schema});
 pools.set('app',pool);
 const source={organization_id:'org',repository_id:'2',connection_id:'connection',installation_id:3,request:{number:4}} as unknown as EngineJob;
 try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query('CREATE TABLE api_engine_job(id text,status text,organization_id text,repository_id text,connection_id text,installation_id bigint,request jsonb,snapshot jsonb,created_at timestamptz)');
  await pool.query('CREATE TABLE api_review_settings(organization_id text,automatic boolean,ignored_authors jsonb); CREATE TABLE api_pull_request_workflow(organization_id text,repository_id text,connection_id text,installation_id bigint,number integer,next_run_at timestamptz)');
  const live={draft:false,author:'automation[bot]'};
  assert.equal(await fixReviewBlocker(source,live),'not_scheduled');
  await pool.query(`INSERT INTO api_pull_request_workflow VALUES('other','2','connection',3,4,now())`);
  assert.equal(await fixReviewBlocker(source,live),'not_scheduled','another tenant cannot imply a scheduled review');
  await pool.query(`INSERT INTO api_pull_request_workflow VALUES('org','2','connection',3,4,now())`);
  assert.equal(await fixReviewBlocker(source,live),null);
  await pool.query(`INSERT INTO api_review_settings VALUES('org',true,'["automation[bot]"]')`);
  assert.equal(await fixReviewBlocker(source,live),'ignored_author');
  assert.equal(await fixReviewBlocker(source,{...live,author:'Automation[bot]'}),'ignored_author');
  await pool.query(`UPDATE api_review_settings SET ignored_authors='[]',automatic=false`);
  assert.equal(await fixReviewBlocker(source,live),'automatic_disabled');
  assert.equal(await fixReviewBlocker(source,{...live,draft:true}),'draft');
  await pool.query('UPDATE api_review_settings SET automatic=true');
  assert.equal(await fixReviewBlocker(source,live),null,'changing settings can resume waiting');
  await pool.query('UPDATE api_pull_request_workflow SET next_run_at=null');
  assert.equal(await fixReviewBlocker(source,live),'not_scheduled');
  assert.equal(await latestFixReview(source,'current'),null);
  const insert=async(id:string,patch:Partial<EngineJob>={},status='running')=>{
   const row={...source,snapshot:{head:'current'},...patch};
   await pool.query('INSERT INTO api_engine_job VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())',[id,status,row.organization_id,row.repository_id,row.connection_id,row.installation_id,row.request,row.snapshot]);
  };
  await insert('correct');
  for(const [i,patch] of [{organization_id:'other'},{repository_id:'5'},{connection_id:'other'},{installation_id:6},{request:{number:7}},{snapshot:{head:'old'}},{request:{number:4,fix_of:'source'}}].entries()) await insert('wrong'+i,patch as Partial<EngineJob>);
  assert.deepEqual(await latestFixReview(source,'current'),{id:'correct',status:'running'});
  await insert('newest',{},'completed');
  assert.deepEqual(await latestFixReview(source,'current'),{id:'newest',status:'completed'});
  assert.equal(await latestFixReview(source,'not-reviewed'),null);
 } finally {pools.delete('app');await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}
});
