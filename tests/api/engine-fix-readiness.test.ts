import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFixPull, fixPullReadiness} from '../../src/engine-fix-core';
import type {Worker} from '../../src/repository-store';
import type {EngineJob} from '../../src/engine-store';
const worker={repository_id:'2',full_name:'team/repo'} as Worker;
const source={request:{number:3},snapshot:{base_ref:'main',head:'a'.repeat(40),base_tip:'b'.repeat(40)}} as unknown as EngineJob;
const pull=()=>({number:3,state:'open',draft:false,head:{sha:source.snapshot.head,ref:'feature/fix',repo:{id:2,full_name:'team/repo'}},base:{sha:source.snapshot.base_tip,ref:'main',repo:{id:2,default_branch:'main'}}});
test('fix readiness explains the actual blocker without treating every rejection as a closed PR',()=>{
 assert.equal(validateFixPull(pull(),worker,source),'feature/fix');
 const advanced=pull();advanced.base.sha='d'.repeat(40);assert.equal(validateFixPull(advanced,worker,source),'feature/fix');
 for(const [mutate,message] of [
  [(p:any)=>p.base.ref='release',/target branch changed/],
  [(p:any)=>p.state='closed',/closed or merged/],
  [(p:any)=>p.draft=true,/is a draft/],
  [(p:any)=>p.head.sha='c'.repeat(40),/open, but its commits changed/],
 ] as const){const p=pull();mutate(p);assert.throws(()=>validateFixPull(p,worker,source),message);}
});

test('live readiness depends on PR head, not target branch advances or review age',()=>{
 const live={baseRef:'main',open:true,draft:false,head:source.snapshot.head,base:source.snapshot.base_tip};
 assert.equal(fixPullReadiness(source.snapshot,live).pr_ready,true);
 for(const changed of [{head:'c'.repeat(40)}, {baseRef:'release'}]) {
  const state=fixPullReadiness(source.snapshot,{...live,...changed});
  assert.equal(state.pr_open,true);assert.equal(state.pr_ready,false);assert.equal(state.review_stale,true);
 }
 assert.equal(fixPullReadiness(source.snapshot,{...live,draft:true}).pr_ready,false);
 assert.equal(fixPullReadiness(source.snapshot,{...live,open:false}).pr_ready,false);
 assert.equal(fixPullReadiness({head:live.head},live).pr_ready,false);
 const advanced={...live,base:'d'.repeat(40)};
 assert.equal(fixPullReadiness(source.snapshot,advanced).pr_ready,true);
});
