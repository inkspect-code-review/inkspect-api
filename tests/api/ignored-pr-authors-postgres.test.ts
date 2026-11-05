import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { pools } from '../../src/database';
import { ignoredAuthors, saveIgnoredAuthors, saveAutomaticReviews, automaticReviews } from '../../src/review-settings';
import { processPullRequest, type WorkflowServices } from '../../src/pull-request-workflow-core';
import { PullGitHub } from '../../src/pull-request-github';

test('author settings migrate idempotently, persist per workspace and recheck durable PRs', {skip:!process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL}, async t => {
  const schema='ignored_authors_'+randomUUID().replaceAll('-','');
  const pool=new Pool({connectionString:process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for(const name of ['001_repository_api.sql','002_pull_request_workflows.sql','008_ignored_pr_authors.sql','008_ignored_pr_authors.sql'])
      await pool.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
    pools.set('app',pool);
    await pool.query(`CREATE TABLE "githubConnection"(id text,"organizationId" text,"installationId" text,repositories jsonb);
      CREATE TABLE "githubRepositoryClaim"("organizationId" text,"repositoryId" text,"accountId" text);
      CREATE TABLE member("organizationId" text,"userId" text);
      INSERT INTO "githubConnection" VALUES('c','org','44','[{"id":17,"fullName":"team/repo"}]');
      INSERT INTO "githubRepositoryClaim" VALUES('org','17','owner'); INSERT INTO member VALUES('org','owner');
      INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file)
        VALUES('org','17','c',44,'team/repo','app','queue',1,'unused');`);
    const id=randomUUID(),other=randomUUID();
    for (const [workflow,org] of [[id,'org'],[other,'other']]) await pool.query(`INSERT INTO api_pull_request_workflow(id,organization_id,repository_id,connection_id,installation_id,number,next_run_at) VALUES($1,$2,'17','c',44,1,NULL)`,[workflow,org]);
    assert.deepEqual(await ignoredAuthors('org'),[]);
    await saveIgnoredAuthors('org','owner',['@Dependabot[bot]','dependabot[bot]']);
    assert.deepEqual(await ignoredAuthors('org'),['dependabot[bot]']);
    assert.deepEqual(await ignoredAuthors('other'),[]);
    assert.equal(await automaticReviews('org'),true);
    assert.ok((await pool.query('SELECT next_run_at FROM api_pull_request_workflow WHERE id=$1',[id])).rows[0].next_run_at);
    assert.equal((await pool.query('SELECT next_run_at FROM api_pull_request_workflow WHERE id=$1',[other])).rows[0].next_run_at,null);
    let starts=0;
    t.mock.method(PullGitHub,'open',async()=>({snapshot:async()=>({author:'Dependabot[bot]',head:'b'.repeat(40),base:'a'.repeat(40),open:true,draft:false})}) as PullGitHub);
    const services={reviewLifecycle:{start:async()=>{starts++; throw new Error('Unexpected admission');}}} as unknown as WorkflowServices;
    assert.equal(await processPullRequest(new AbortController().signal,services,pool),true);
    const stopped=(await pool.query('SELECT state,next_run_at FROM api_pull_request_workflow WHERE id=$1',[id])).rows[0];
    assert.equal(stopped.state.stopped,true); assert.equal(stopped.next_run_at,null); assert.equal(starts,0);
    await saveAutomaticReviews('org','owner',false);
    await saveIgnoredAuthors('org','owner',[]);
    assert.deepEqual(await ignoredAuthors('org'),[]); assert.equal(await automaticReviews('org'),false);
    assert.ok((await pool.query('SELECT next_run_at FROM api_pull_request_workflow WHERE id=$1',[id])).rows[0].next_run_at);
  } finally {pools.delete('app');await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
});
