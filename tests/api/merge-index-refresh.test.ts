import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { enqueuePullEvent } from '../../src/pull-request-events';
import { processMergeRefresh, type WorkflowServices } from '../../src/pull-request-workflow-core';

test('concurrent merges, redelivery and a manual refresh share one repository deadline', {
  skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL,
}, async () => {
  const schema = 'merge_' + randomUUID().replaceAll('-','');
  const pool = new Pool({connectionString:process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL,options:'-c search_path='+schema});
  try {
    await pool.query('CREATE SCHEMA '+schema);
    for (const file of ['001_repository_api','002_pull_request_workflows','008_ignored_pr_authors','009_check_threshold','012_merge_index_refresh']) {
      await pool.query(await readFile(new URL('../../migrations/'+file+'.sql',import.meta.url),'utf8'));
    }
    await pool.query(`CREATE TABLE "githubConnection"(id text,"organizationId" text,"installationId" text,repositories jsonb);
      CREATE TABLE "githubRepositoryClaim"("organizationId" text,"repositoryId" text,"accountId" text);
      CREATE TABLE member("organizationId" text,"userId" text);
      INSERT INTO "githubConnection" VALUES('c','org','7','[{"id":17,"fullName":"org/repo"}]');
      INSERT INTO "githubRepositoryClaim" VALUES('org','17','owner');
      INSERT INTO member VALUES('org','owner');
      INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file)
      VALUES('org','17','c',7,'org/repo','app','queue',1,'unused')`);
    const start = Date.now();
    const event = (number:number,time:number) => enqueuePullEvent({installation:7,repository:17,fullName:'org/repo',number,mergedAt:new Date(time).toISOString()},pool);
    const rows = async () => (await pool.query('SELECT * FROM api_merge_index_refresh')).rows;
    await Promise.all([1,2,3].map(n=>event(n,start)));
    const [first] = await rows();
    assert.equal((await rows()).length,1);
    assert.equal(first.due_at.getTime(),start+3_600_000);
    const last=start+600_000;
    await Promise.all([event(4,last),event(2,start)]);
    const [latest]=await rows();
    assert.equal(latest.due_at.getTime(),last+3_600_000);
    assert.notEqual(first.request_id,latest.request_id);
    let enqueued=0, fresh=false;
    const services={eligibility:()=>({allowed:true}),latestIndex:async()=>null,admitIndex:async()=>{},
      enqueueIndex:async (_worker:unknown,id:string)=>{enqueued++;return {id};}} as unknown as WorkflowServices;
    const checks={storedIndex:async()=>({id:'existing',status:'completed' as const,created_at:'',updated_at:'',
      progress:{indexed:true,stage:'completed',chunks:1,reused:0,embedded:1,logs:[],scan:{stage:'completed',total:1,processed:1,read:1,chunks:1,skipped:0}}}),
      indexFreshness:async()=>({up_to_date:fresh})};
    const tick=()=>processMergeRefresh(new AbortController().signal,services,pool,checks);
    assert.equal(await tick(),false);
    await pool.query("UPDATE api_merge_index_refresh SET due_at=now()-interval '1 second'");
    await Promise.all([tick(),tick(),tick()]);
    assert.equal(enqueued,1);
    await event(4,last);
    assert.equal((await rows())[0].due_at,null);
    await event(5,last+1);
    fresh=true;
    await pool.query("UPDATE api_merge_index_refresh SET due_at=now()-interval '1 second'");
    assert.equal(await tick(),true);
    assert.equal(enqueued,1);
    assert.equal((await rows())[0].due_at,null);
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
    await pool.end();
  }
});
