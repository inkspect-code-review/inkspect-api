import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { enqueueCheckRerequest, matchingGithubReview } from '../../src/github-check-reconciliation';
import type { Workflow } from '../../src/pull-request-workflow-core';

test('completed dashboard jobs and matching GitHub receipts wake only their PR', {
  skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL,
}, async () => {
  const schema = 'check_' + randomUUID().replaceAll('-', '');
  const pool = new Pool({connectionString:process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL, options:'-c search_path=' + schema});
  const tx = await pool.connect();
  try {
    await tx.query(`CREATE SCHEMA ${schema}`);
    const migrate = (file: string) => readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8').then(sql => tx.query(sql));
    for (const file of ['001_repository_api.sql','002_pull_request_workflows.sql','004_rust_engine.sql']) await migrate(file);
    const head = 'b'.repeat(40), base = 'a'.repeat(40);
    const old = 'J-' + '1'.repeat(32), retry = 'J-' + '2'.repeat(32);
    const state = {head,base,job:old,check:{id:24,job:old,head,phase:'failed'}};
    const row = (await tx.query<Workflow>(`INSERT INTO api_pull_request_workflow(id,organization_id,repository_id,connection_id,installation_id,number,state,next_run_at)
      VALUES($1,'org','7','c',9,1,$2,NULL) RETURNING *`,[randomUUID(),state])).rows[0];
    await tx.query("INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file) VALUES('org','7','c',9,'org/repo','app','queue',5,'unused')");
    const insert = (id: string, status: string, extra = {}) => tx.query(`INSERT INTO api_engine_job(id,request_id,organization_id,repository_id,connection_id,installation_id,subject,request,snapshot,host_config,status)
      VALUES($1,$1,'org','7','c',9,'user',$2,$3,'{}',$4)`,[id,{number:1,...extra},{head,base_tip:base,base_ref:'main'},status]);
    await insert(old,'failed'); await insert(retry,'completed');
    await migrate('010_github_check_reconciliation.sql');
    const workflow = async () => (await tx.query('SELECT next_run_at,github_rerequest FROM api_pull_request_workflow WHERE id=$1',[row.id])).rows[0];
    assert.ok((await workflow()).next_run_at);
    await tx.query('UPDATE api_pull_request_workflow SET next_run_at=NULL');
    await migrate('010_github_check_reconciliation.sql');
    assert.equal((await workflow()).next_run_at,null);
    const lookup = (rerequest: boolean) => matchingGithubReview(tx,row,head,base,'main',rerequest);
    assert.equal(await lookup(false),retry);
    const pending = 'J-' + '3'.repeat(32);
    await insert(pending,'running'); assert.equal(await lookup(true),pending);
    await tx.query("UPDATE api_engine_job SET status='completed' WHERE id=$1",[pending]);
    assert.ok((await workflow()).next_run_at);
    assert.equal(await lookup(false),pending);
    await insert('J-' + '4'.repeat(32),'completed',{fix_of:old});
    await insert('J-' + '5'.repeat(32),'completed',{number:2});
    assert.equal(await lookup(false),pending);
    assert.equal(await matchingGithubReview(tx,row,head,base,'release',true),undefined);
    const event = {action:'rerequested',installation:{id:9},repository:{id:7},sender:{type:'User',login:'tester'},
      check_run:{id:24,name:'Inkspect',app:{id:5},external_id:old,head_sha:head,pull_requests:[]}};
    for(const invalid of [{...event,installation:{id:10}},{...event,check_run:{...event.check_run,app:{id:10}}},
      {...event,check_run:{...event.check_run,external_id:retry}}, {...event,check_run:{...event.check_run,head_sha:base}}]) {
      await enqueueCheckRerequest(invalid,'delivery',pool);
      assert.equal((await workflow()).github_rerequest,null);
    }
    await enqueueCheckRerequest(event,'delivery',pool);
    assert.deepEqual((await workflow()).github_rerequest,{delivery:'delivery',check:24,base,head,sender:'tester'});
  } finally {
    await tx.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); tx.release(); await pool.end();
  }
});
