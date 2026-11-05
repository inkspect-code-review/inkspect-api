import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePull, type Workflow, type WorkflowServices } from '../../src/pull-request-workflow-core';
import type { PullGitHub } from '../../src/pull-request-github';

function fixture() {
  const row: Workflow = {id:'workflow',organization_id:'org',repository_id:'17',connection_id:'c',installation_id:'44',number:1,state:{}};
  const worker = {organization_id:'org',repository_id:'17',connection_id:'c',installation_id:'44',full_name:'team/repo',queue_database:'app',queue_schema:'queue',app_id:'1',private_key_file:'unused',size_bytes:'100',access_verified_at:new Date(),access_error:null,subject:'owner',automatic:true,ignored_authors:['dependabot[bot]']};
  const live = {head:'b'.repeat(40),base:'a'.repeat(40),open:true,draft:false,author:'Dependabot[bot]'};
  const calls: string[] = [];
  let status = 'running', cancellationPending = false;
  const job = () => ({job:{id:'J-'+'1'.repeat(32),status}});
  const github = {
    snapshot: async () => ({...live}),
    eyes: async () => { calls.push('eyes'); },
    deliver: async (delivery: {id?:number}, _marker:string, _body:string, _kind:string, _save:unknown, guard:() => Promise<void>) => {await guard(); delivery.id=1; calls.push('comment');},
  } as unknown as PullGitHub;
  const services = {
    engineRequest:async (path:string) => {calls.push(path); if(path.endsWith('/cancel') && !cancellationPending) status='cancelled'; return job();},
    reviewLifecycle:{start:async () => {calls.push('start'); status='running'; return job();},settle:async () => {calls.push('settle');}},
    lastIndexed:async () => {calls.push('index'); return {progress:{indexed:true}};},
  } as unknown as WorkflowServices;
  const messages: Parameters<typeof advancePull>[5] = [];
  const step = (guard = async () => {}) => advancePull(row,worker,github,async()=>{},guard,messages,async()=>{},services);
  return {row,worker,live,calls,messages,step,services,set cancellationPending(value:boolean){cancellationPending=value;}};
}

test('ignored PRs produce no review, index, reaction or reply, even with a human review request', async () => {
  const f=fixture();
  f.messages.push({comment_id:'1',kind:'issue',sender:'maintainer',intent:'review',reply_to:null,state:{}});
  assert.equal(await f.step(),null);
  assert.deepEqual(f.calls,[]);
  assert.equal(f.messages[0].state.ignored,true);
  assert.equal(f.row.state.stopped,true);
});

test('removing an author resumes automatic reviews and other authors remain eligible', async () => {
  const f=fixture(); await f.step(); f.worker.ignored_authors=[];
  await f.step(); assert.ok(f.calls.includes('start'));
  assert.equal(f.row.state.stopped,undefined);
  const human=fixture(); human.live.author='dependabot';
  await human.step(); assert.ok(human.calls.includes('start'));
});

test('adding an author cancels existing work, settles it and resumes a cancelled run after removal', async () => {
  const f=fixture(); f.worker.ignored_authors=[];
  await f.step(); const id=f.row.state.job;
  f.calls.length=0; f.worker.ignored_authors=['dependabot[bot]']; f.cancellationPending=true;
  assert.equal(await f.step(),10_000);
  assert.deepEqual(f.calls,[`/jobs/${id}`,`/jobs/${id}/cancel`,'settle']);
  f.calls.length=0; f.cancellationPending=false;
  assert.equal(await f.step(),null);
  assert.deepEqual(f.calls,[`/jobs/${id}`,`/jobs/${id}/cancel`,'settle']);
  f.worker.ignored_authors=[]; f.calls.length=0;
  await f.step(); assert.ok(f.calls.includes('start')); assert.equal(f.row.state.rerun,id);
});

test('fresh settings stop a queued workflow and block writes when the list changes mid-pass', async () => {
  const f=fixture(); f.worker.ignored_authors=[];
  await f.step(async()=>{f.worker.ignored_authors=['dependabot[bot]'];});
  assert.deepEqual(f.calls,[]);
  const late=fixture(); late.worker.ignored_authors=[];
  let checks=0;
  await assert.rejects(late.step(async()=>{if(++checks===2) late.worker.ignored_authors=['dependabot[bot]'];}),/author is ignored/);
  assert.deepEqual(late.calls,[]);
});

test('a list change before admission cannot start a review', async () => {
  const f=fixture(); f.worker.ignored_authors=[];
  f.services.lastIndexed=async()=>{f.worker.ignored_authors=['dependabot[bot]']; return {progress:{indexed:true}} as never;};
  await assert.rejects(f.step(),/author is ignored/);
  assert.equal(f.calls.includes('start'),false);
});

test('a list change while preparing repository context cannot admit indexing', async () => {
  const f=fixture(); f.worker.ignored_authors=[];
  f.services.lastIndexed=async()=>null;
  f.services.latestIndex=async()=>{f.worker.ignored_authors=['dependabot[bot]']; return null;};
  f.services.eligibility=()=>({allowed:true,size_bytes:100,limit_bytes:1000,support_required:false,reason:undefined});
  f.services.admitIndex=async()=>{throw new Error('Index admission must not run');};
  await assert.rejects(f.step(),/author is ignored/);
  assert.equal(f.calls.includes('start'),false);
});
