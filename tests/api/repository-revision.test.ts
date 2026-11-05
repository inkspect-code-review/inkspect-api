import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fetchRepositoryRevision } from "../../src/metadata";
import type { Worker } from "../../src/repository-store";

test('fresh HEAD lookup verifies repository identity and safely handles branch names',async(t)=>{
 const directory=await mkdtemp(join(tmpdir(),'inkspect-revision-'));
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const keyFile=join(directory,'test-only.pem');
 await writeFile(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const worker:Worker={organization_id:'org',repository_id:'17',connection_id:'connection',installation_id:'44',full_name:'team/repo',queue_database:'app',queue_schema:'test',app_id:'1',private_key_file:keyFile,size_bytes:'1024',access_verified_at:new Date(),access_error:null};
 let repoId=17;let responseStatus=200;let responseBody: unknown;let branch: string | null='release/v1+next';let sha='a'.repeat(40);let calls=0;
 t.mock.method(globalThis,'fetch',async(input:string,init:RequestInit)=>{
  calls++;
  const url=new URL(input);
  assert.equal(url.origin,'https://api.github.com');
  if(url.pathname==='/repos/team/repo/installation')return Response.json({id:44,app_id:1});
  if(url.pathname==='/app/installations/44/access_tokens'){
   const body=JSON.parse(String(init.body));assert.deepEqual(body.repository_ids,[17]);assert.equal(body.permissions.contents,'read');
   return Response.json({token:'synthetic-test-token',repositories:[{id:17}]});
  }
  if(url.pathname==='/repos/team/repo')return Response.json({id:repoId,full_name:'team/repo',default_branch:branch,size:0});
  assert.equal(url.pathname,'/repos/team/repo/commits');assert.equal(url.searchParams.get('sha'),branch);assert.equal(url.searchParams.get('per_page'),'1');
  return Response.json(responseBody ?? [{sha}],{status:responseStatus});
 });
 try{
  assert.equal(await fetchRepositoryRevision(worker,new AbortController().signal),sha);assert.equal(calls,4);
  repoId=999;await assert.rejects(fetchRepositoryRevision(worker,new AbortController().signal),/invalid_metadata/);
  responseStatus=409;responseBody={message:'Git Repository is empty.'};
  repoId=17;await assert.rejects(fetchRepositoryRevision(worker,new AbortController().signal),error=>error instanceof Error && error.message==='repository_empty');
  branch=null;await assert.rejects(fetchRepositoryRevision(worker,new AbortController().signal),error=>error instanceof Error && error.message==='repository_empty');
  branch='release/v1+next';
  for(const status of [401,403,404,409,429,502]){
   responseStatus=status;responseBody={message:status===409?'Unrelated conflict':'Git Repository is empty.'};
   await assert.rejects(fetchRepositoryRevision(worker,new AbortController().signal),error=>error instanceof Error && error.message!=='repository_empty');
  }
  responseStatus=200;responseBody=[];
  await assert.rejects(fetchRepositoryRevision(worker,new AbortController().signal),error=>error instanceof Error && error.message==='repository_empty');
  responseBody=undefined;sha='b'.repeat(40);
  assert.equal(await fetchRepositoryRevision(worker,new AbortController().signal),sha,'first commit is discovered even while metadata size is still zero');
  repoId=17;sha='not-a-commit';await assert.rejects(fetchRepositoryRevision(worker,new AbortController().signal),/invalid_metadata/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
