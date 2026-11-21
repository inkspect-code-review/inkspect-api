import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pools } from '../../src/database';
import { priorFindings } from '../../src/finding-followup';
import type { EngineJob } from '../../src/engine-store';
import type { Worker } from '../../src/repository-store';
import { PullGitHub } from '../../src/pull-request-github';

test('follow-up inputs come only from matching saved PR findings and their open bot threads',
  { skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL }, async t => {
    const schema = 'followup_' + randomUUID().replaceAll('-', '');
    const pool = new Pool({ connectionString: process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL, options: '-c search_path=' + schema });
    pools.set('app', pool);
    const originalHead = 'a'.repeat(40);
    const worker = { organization_id: 'org', repository_id: '2', connection_id: 'c', installation_id: '1' } as Worker;
    const job = { ...worker, request: { number: 7 }, snapshot: { base_ref: 'main', head: 'b'.repeat(40) } } as unknown as EngineJob;
    const finding = { id: 'f', location: { path: 'a.ts' }, title: 'Title', reason: 'Original issue', suggestion: 'Repair' };
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query('CREATE TABLE api_pull_request_workflow(id text,organization_id text,repository_id text,connection_id text,installation_id text,number int)');
      await pool.query("INSERT INTO api_pull_request_workflow VALUES ('wf','org','2','c','1',7)");
      await pool.query('CREATE TABLE api_engine_job(id text,organization_id text,repository_id text,connection_id text,installation_id text,status text,request jsonb,snapshot jsonb,report jsonb)');
      const variants = [['correct','org',7,'main'], ['other-pr','org',8,'main'], ['other-org','other',7,'main'], ['other-target','org',7,'release']] as const;
      for (const [id, org, number, base] of variants) {
        await pool.query("INSERT INTO api_engine_job VALUES($1,$2,'2','c','1','completed',$3,$4,$5)",
          [id,org,{number},{head:originalHead,base_ref:base},{findings:[finding]}]);
      }
      t.mock.method(PullGitHub, 'open', async () => ({
        findingThreads: async (workflow: string, outdated: boolean) => {
          assert.equal(workflow, 'wf'); assert.equal(outdated, true);
          return variants.map(([id], i) => ({ id: i+1, job: id, finding: 'f', path: 'a.ts', body: 'Edited comment text', originalHead }));
        },
      }));
      assert.deepEqual(await priorFindings(job, worker, new AbortController().signal), [
        { thread:'1', path:'a.ts', title:'Title', reason:'Original issue', suggestion:'Repair' },
      ]);
    } finally {
      pools.delete('app');
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });
