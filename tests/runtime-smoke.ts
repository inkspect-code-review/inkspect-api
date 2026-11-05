import {checkEmptyIndex} from './fixtures/empty-index-runtime';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {ensureWorkspace} from '@inkspect/core/lib/workspace';
import {createSelfHostedAuth} from '@inkspect/core/self-hosted/auth';
const database=process.env.SMOKE_TEST_DATABASE_URL;
if(!database)throw new Error('SMOKE_TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
const schema='runtime_'+randomUUID().replaceAll('-',''),url=new URL(database);url.searchParams.set('options','-c search_path='+schema);
const pool=new Pool({connectionString:url.toString()});
const origin='https://self-hosted.example',organizationName='Synthetic self-hosted QA';
const env={PATH:process.env.PATH!,NODE_ENV:'production',INKSPECT_DEV_LOGS:'false',NEXT_TELEMETRY_DISABLED:'1',DATABASE_URL:url.toString(),BETTER_AUTH_URL:origin,BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),INKSPECT_ACCOUNT_ONBOARDING_ENABLED:'false',API_HOST:'127.0.0.1',PORT:'3003',...(process.env.INKSPECT_SMOKE_INDEX==='1'?{AWS_BEARER_TOKEN_BEDROCK:'synthetic-index-model-token',AWS_REGION:'eu-west-2'}:{})};
Object.assign(process.env,env);
const children:ChildProcess[]=[];let childOutput='';
function start(args:string[],cwd=process.cwd(),extra:Record<string,string>={}){const c=spawn(process.execPath,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});children.push(c);c.stdout!.on('data',b=>{childOutput+=b.toString();});c.stderr!.on('data',b=>{childOutput+=b.toString();});return c;}
async function ready(c:ChildProcess,address:string){for(let n=0;n<150;n++){if(c.exitCode!==null)throw new Error('Service exited: '+childOutput);try{const r=await fetch(address);if(r.ok)return r;}catch{}await delay(100);}throw new Error('Service did not become ready: '+address+' '+childOutput);}
async function stop(){for(const c of children.reverse()){if(c.exitCode!==null)continue;const done=once(c,'exit');c.kill('SIGTERM');await Promise.race([done,delay(5000).then(()=>{if(c.exitCode===null)c.kill('SIGKILL');})]);}}
try{
 await pool.query(`CREATE SCHEMA ${schema}`);
 for(let n=0;n<2;n++)execFileSync(process.execPath,['--import','tsx','scripts/migrate.ts'],{env,stdio:'pipe',timeout:30000});
 let magic='';const auth=createSelfHostedAuth(pool,async({url}:{url:string})=>{magic=url;});
 const ctx=await auth.$context;
 const user=await ctx.adapter.create<{id:string;email:string;name:string;emailVerified:boolean;createdAt:Date;updatedAt:Date}>({model:'user',data:{email:'owner@example.test',name:'Synthetic Owner',emailVerified:true,createdAt:new Date(),updatedAt:new Date()}});
 const org=await ensureWorkspace(ctx.adapter,user.id);
 await pool.query('UPDATE organization SET name=$1 WHERE id=$2',[organizationName,org]);
 await pool.query('INSERT INTO "workspaceSetup"(id,"organizationId","dismissedAt") VALUES($1,$2,now())',[randomUUID(),org]);

 const login=await auth.handler(new Request(origin+'/api/auth/sign-in/magic-link',{method:'POST',headers:{origin,'content-type':'application/json','x-real-ip':'192.0.2.9'},body:JSON.stringify({email:user.email,callbackURL:'/dashboard'})}));assert.equal(login.status,200);assert.ok(magic);
 const verify=await auth.handler(new Request(magic,{headers:{"x-real-ip":"192.0.2.9"}}));assert.equal(verify.status,302);
 const cookie=verify.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
 const server=start(['dist/server.mjs']);await ready(server,'http://127.0.0.1:3003/ready');
 const request=(path:string,body?:object)=>fetch('http://127.0.0.1:3003'+path,{headers:{cookie,origin,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 const reviewSettingsPath='/api/review-settings?organizationId='+org;
 assert.deepEqual((await (await request(reviewSettingsPath)).json()).ignored_authors,[]);
 const ignoredResponse=await request(reviewSettingsPath,{ignored_authors:['@Dependabot[bot]','dependabot[bot]']});assert.equal(ignoredResponse.status,200);
 assert.deepEqual((await ignoredResponse.json()).ignored_authors,['dependabot[bot]']);
 assert.equal((await request(reviewSettingsPath,{ignored_authors:['*']})).status,400);
 assert.equal((await request('/api/review-settings?organizationId=another-workspace',{ignored_authors:[]})).status,409);
 const members='/api/members?organizationId='+org;
 const invite=await request(members,{action:'invite',email:'teammate@example.test',role:'member'});assert.equal(invite.status,200);const invitation=await invite.json();assert.ok(invitation.id);
 assert.equal((await request(members)).status,200);
 const cancelled=await request(members,{action:'cancel',id:invitation.id});assert.equal(cancelled.status,200);
 assert.equal((await request('/api/usage?organizationId='+org)).status,200);
 assert.equal((await request('/api/members?organizationId=another-workspace')).status,409);
 for(const path of ['/api/billing','/api/internal/review-billing','/api/billing/webhook']){assert.equal((await request(path)).status,404);assert.equal((await request(path,{})).status,404);} const tables=(await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1',[schema])).rows;assert.equal(tables.some(r=>/^(billing_|support_)/.test(r.table_name)),false);
 const emptyIndex=process.env.INKSPECT_SMOKE_INDEX==='1'?await checkEmptyIndex({pool,org,userId:user.id,request,start}):undefined;
 const ui=process.env.INKSPECT_SMOKE_UI;
 if(ui){
  const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const require=createRequire(resolve(ui,'package.json'));
  const web=start([require.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],ui,{PORT:String(port)});
  const first=await ready(web,`http://127.0.0.1:${port}/login`);assert.match(await first.text(),/Welcome to Inkspect/);
  const page=await fetch(`http://127.0.0.1:${port}/dashboard?view=members`,{headers:{cookie}});assert.equal(page.status,200);const html=await page.text();assert.match(html,/Synthetic Owner/);assert.match(html,/owner@example.test/);
  const settingsPage=await fetch(`http://127.0.0.1:${port}/dashboard?view=settings`,{headers:{cookie}});assert.equal(settingsPage.status,200);assert.match(await settingsPage.text(),/Ignored PR authors/);
  const settingsProxy=await fetch(`http://127.0.0.1:${port}${reviewSettingsPath}`,{headers:{cookie}});assert.equal(settingsProxy.status,200);assert.deepEqual((await settingsProxy.json()).ignored_authors,['dependabot[bot]']);
  const proxy=await fetch(`http://127.0.0.1:${port}${members}`,{headers:{cookie}});assert.equal(proxy.status,200);
  const billing=await fetch(`http://127.0.0.1:${port}/dashboard?view=billing`,{headers:{cookie}});const view=await billing.text();assert.match(view,/>Dashboard</);assert.doesNotMatch(html,/Add seats|Seat plan|Add AI Credits/);for(const path of ['/api/billing','/api/billing/webhook'])assert.equal((await fetch(`http://127.0.0.1:${port}${path}`,{headers:{cookie}})).status,404);
 }
 console.log(JSON.stringify({edition:'self-hosted',migrations:'twice',auth:'passed',membership:'passed',usage:'passed',scope:'passed',http:'passed',ui:!!ui,emptyIndex}));
}finally{await stop();await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
