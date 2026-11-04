import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('the shared reader selects correlated Go failures and tolerates incomplete records',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'inkspect-log-reader-'));
 try{
  const record={timestamp:'2026-10-26T13:51:52Z',id:'diagnostic-1',source:'engine',level:'error',event:'bedrock.request_failed',context:{jobId:'job-1'},error:{providerCode:'ThrottlingException'}};
  await writeFile(join(directory,'events-123.jsonl'),JSON.stringify(record)+'\n'+JSON.stringify({...record,id:'other',context:{jobId:'job-2'}})+'\n{"partial":');
  const output=execFileSync(process.execPath,['--import','tsx',new URL(import.meta.resolve('@inkspect/core/cli/dev-logs')).pathname,'--directory',directory,'--job','job-1','--json'],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(output),record);
 }finally{await rm(directory,{recursive:true,force:true});}
});
