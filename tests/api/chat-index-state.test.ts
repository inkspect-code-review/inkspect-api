import assert from "node:assert/strict";
import test from "node:test";
import { chatIndexRequirement } from "../../src/chat-index-state";
import type { Worker } from "../../src/repository-store";
import type { RepositoryIndex } from "@inkspect/core/lib/repository-types";
const worker={organization_id:"tenant",repository_id:"17"} as Worker;
const allowed={size_bytes:100,limit_bytes:1000,allowed:true,support_required:false,reason:undefined};
test("chat distinguishes a missing index, active work, failed work and inaccessible indexing",async()=>{
 const store={storedIndex:async()=>null,latestIndex:async()=>null as RepositoryIndex|null,eligibility:()=>allowed};
 assert.deepEqual(await chatIndexRequirement(worker,store),{kind:"index_required",tenant_id:"tenant",repository_id:"17",state:"not_indexed",can_index:true});
 for(const status of ["queued","running","failed"] as const) {
  const result=await chatIndexRequirement(worker,{...store,latestIndex:async()=>({status} as RepositoryIndex)});
  assert.equal(result?.state,status==="failed"?"index_failed":"indexing");assert.equal(result?.can_index,status==="failed");
 }
 assert.equal((await chatIndexRequirement(worker,{...store,eligibility:()=>({...allowed,allowed:false})}))?.can_index,false);
 assert.equal(await chatIndexRequirement(worker,{...store,storedIndex:async()=>({} as RepositoryIndex),latestIndex:async()=>assert.fail("committed index is usable")}),null);
 await assert.rejects(chatIndexRequirement(worker,{...store,storedIndex:async()=>{throw new Error("database unavailable");}}),/database unavailable/);
});
