import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { indexFreshness } from "../../src/index-freshness";
import type { Worker } from "../../src/repository-store";
import type { RepositoryIndex } from "@inkspect/core/lib/repository-types";
const makeWorker = (): Worker => ({ organization_id:randomUUID(),repository_id:'17',connection_id:'connection',installation_id:'44',full_name:'team/repo',queue_database:'app',queue_schema:'test',app_id:'1',private_key_file:'/never-read',size_bytes:'1024',access_verified_at:new Date(),access_error:null });
const saved = (revision: string): RepositoryIndex => ({id:'saved',status:'completed',created_at:'',updated_at:'',progress:{stage:'completed',revision,indexed:true,scan:{stage:'',total:0,processed:0,read:0,chunks:0,skipped:0},chunks:1,embedded:1,reused:0,logs:[]}});

test('same SHA is current, changed SHA is allowed, and admission bypasses the polling cache',async()=>{
 const worker=makeWorker(),signal=new AbortController().signal;
 let head='a'.repeat(40),calls=0;
 const dependencies={lastIndexed:async()=>saved('a'.repeat(40)),fetchRepositoryRevision:async()=>{calls++;return head;}};
 assert.equal((await indexFreshness(worker,signal,false,dependencies)).up_to_date,true);
 head='b'.repeat(40);
 assert.equal((await indexFreshness(worker,signal,false,dependencies)).up_to_date,true);
 assert.equal(calls,1);
 assert.deepEqual(await indexFreshness(worker,signal,true,dependencies),{up_to_date:false,revision:head});
 assert.equal(calls,2);
 // A new connection must never borrow the previous connection's HEAD cache.
 await indexFreshness({...worker,connection_id:'new-connection'},signal,false,dependencies);
 assert.equal(calls,3);
});

test('missing committed index permits retry, while upstream errors fail closed at admission',async()=>{
 const worker=makeWorker(),signal=new AbortController().signal;
 const failure=async()=>{throw new Error('GitHub unavailable');};
 assert.deepEqual(await indexFreshness(worker,signal,true,{lastIndexed:async()=>null,fetchRepositoryRevision:failure}),{up_to_date:false});
 await assert.rejects(indexFreshness(worker,signal,true,{lastIndexed:async()=>saved('a'.repeat(40)),fetchRepositoryRevision:failure}),/unavailable/);
});
