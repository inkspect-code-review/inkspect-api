import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runRust} from "../../src/engine-process";
import type {HostConfig} from "../../src/engine-contract";
test("engine process routes review, fixes and retrieval to the selected instance provider without forwarding AWS credentials",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"provider-engine-"));
 const names=["INKSPECT_AI_PROVIDER","INKSPECT_API_KEY","INKSPECT_RUST_STATE","INKSPECT_RUST_BINARY","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_BEARER_TOKEN_BEDROCK"];
 const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 try {
  const binary=join(dir,"engine.cjs");
  await writeFile(binary,'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),args=process.argv.slice(2),out=args[args.indexOf('--out')+1];
fs.writeFileSync(out,JSON.stringify({endpoint:process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
 validKey:process.env.AWS_BEARER_TOKEN_BEDROCK==='isk_live_'+'a'.repeat(64),
 leakedAws:!!(process.env.AWS_ACCESS_KEY_ID||process.env.AWS_SECRET_ACCESS_KEY||process.env.AWS_SESSION_TOKEN),
 leakedAppKey:!!process.env.INKSPECT_API_KEY,metadataDisabled:process.env.AWS_EC2_METADATA_DISABLED}));
`,{mode:0o700});
  Object.assign(process.env,{INKSPECT_AI_PROVIDER:"inkspect",INKSPECT_API_KEY:"isk_live_"+"a".repeat(64),INKSPECT_RUST_STATE:dir,INKSPECT_RUST_BINARY:binary,
   AWS_ACCESS_KEY_ID:"synthetic-aws-id",AWS_SECRET_ACCESS_KEY:"synthetic-aws-secret",AWS_SESSION_TOKEN:"synthetic-aws-session",AWS_BEARER_TOKEN_BEDROCK:"synthetic-aws-bearer"});
  for(const mode of ["review","fix","verify-fix","index","context","describe"] as const) {
   const result=await runRust(mode,{timeout_seconds:5} as HostConfig,{}, {},"synthetic-github-token","operation-"+mode,new AbortController().signal);
   assert.deepEqual(result.report,{endpoint:"https://app.inkspect.si/api/provider",validKey:true,leakedAws:false,leakedAppKey:false,metadataDisabled:"true"});
   assert.deepEqual(result.events,[]);
  }
 } finally {for(const name of names)if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];await rm(dir,{recursive:true,force:true});}
});

test('a host-provided loopback transport isolates credentials and requires explicit retrieval scope alongside a customer key', async () => {
 const dir=await mkdtemp(join(tmpdir(),'local-model-transport-'));
 const names=['INKSPECT_AI_PROVIDER','INKSPECT_RUST_STATE','INKSPECT_RUST_BINARY','AWS_BEARER_TOKEN_BEDROCK','AWS_SECRET_ACCESS_KEY'];
 const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 try {
  const binary=join(dir,'engine.cjs');
  await writeFile(binary,'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),args=process.argv.slice(2);
if(process.env.INKSPECT_BYOK_STDIN)process.stdin.resume();
fs.writeFileSync(args[args.indexOf('--out')+1],JSON.stringify({endpoint:process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
localToken:process.env.AWS_BEARER_TOKEN_BEDROCK==='local-transport-token',awsSecret:!!process.env.AWS_SECRET_ACCESS_KEY}));
`,{mode:0o700});
  Object.assign(process.env,{INKSPECT_AI_PROVIDER:'bedrock',INKSPECT_RUST_STATE:dir,INKSPECT_RUST_BINARY:binary,
   AWS_BEARER_TOKEN_BEDROCK:'synthetic-upstream-token',AWS_SECRET_ACCESS_KEY:'synthetic-secret'});
  const host={timeout_seconds:5} as HostConfig, transport={endpoint:'http://127.0.0.1:12345',bearerToken:'local-transport-token'};
  const result=await runRust('review',host,{}, {},'test','local',new AbortController().signal,undefined,undefined,transport);
  assert.deepEqual(result.report,{endpoint:transport.endpoint,localToken:true,awsSecret:false});
  const byok=await runRust('review',host,{}, {},'test','byok',new AbortController().signal,
   {provider:'openai',model:'example-model',api_key:'synthetic-customer-key',max_output_tokens:10},undefined,transport);
  assert.deepEqual(byok.report,{localToken:false,awsSecret:true});
  const retrieval=await runRust('review',host,{}, {},'test','byok-retrieval',new AbortController().signal,
   {provider:'openai',model:'example-model',api_key:'synthetic-customer-key',max_output_tokens:10},undefined,{...transport,retrievalOnly:true});
  assert.deepEqual(retrieval.report,{endpoint:transport.endpoint,localToken:true,awsSecret:false});
  await assert.rejects(runRust('review',host,{}, {},'test','invalid',new AbortController().signal,undefined,undefined,
   {...transport,endpoint:'https://untrusted.example'}),/Invalid local model transport/);
 } finally {for(const name of names)if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];await rm(dir,{recursive:true,force:true});}
});
