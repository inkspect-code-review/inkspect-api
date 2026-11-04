import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {database} from "./database";
import {cancelIndex,type Worker} from "./repository-store";
import { enqueuePullEvent, parsePullEvent } from "./pull-request-events";
export async function githubWebhook(request:Request){
 if(request.method!=='POST')return Response.json({error:'Method not allowed.'},{status:405});
 const file=process.env.API_GITHUB_WEBHOOK_SECRET_FILE;
 if(!file)return Response.json({error:'Webhook is not configured.'},{status:503});
 const signature=request.headers.get('x-hub-signature-256')||'';
 if(!/^sha256=[a-f0-9]{64}$/.test(signature))return Response.json({error:'Invalid signature.'},{status:401});
 const reader=request.body?.getReader();if(!reader)return Response.json({error:'Missing body.'},{status:400});
 const chunks:Uint8Array[]=[];let size=0;
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();return Response.json({error:'Payload too large.'},{status:413});}chunks.push(value);}
 const body=Buffer.concat(chunks);const secret=(await readFile(file,'utf8')).trim();
 if(secret.length<16)return Response.json({error:'Webhook is not configured.'},{status:503});
 if(!timingSafeEqual(Buffer.from(signature.slice(7),'hex'),createHmac('sha256',secret).update(body).digest()))return Response.json({error:'Invalid signature.'},{status:401});
 let data;try{data=JSON.parse(body.toString('utf8'));}catch{return Response.json({error:'Invalid payload.'},{status:400});}
 const event=request.headers.get('x-github-event');
 if(!data || !Number.isSafeInteger(data.installation?.id))return Response.json({accepted:true}, {status:202});
 const pull = parsePullEvent(event || '', data);
 if(pull)await enqueuePullEvent(pull);
 const removed=event==='installation'&&['deleted','suspend'].includes(data.action);
 const restored=event==='installation'&&['created','unsuspend'].includes(data.action);
 const ids=(value:unknown)=>Array.isArray(value)?value.flatMap(item=>item&&Number.isSafeInteger(item.id)?[String(item.id)]:[]):[];
 const removedIds=event==='installation_repositories'?ids(data.repositories_removed):[];
 const addedIds=event==='installation_repositories'?ids(data.repositories_added):[];
 const pool=database();
 if(removed||removedIds.length){
  const rows=(await pool.query<Worker>(`UPDATE api_repository_worker SET access_error='revoked',access_verified_at=NULL WHERE installation_id=$1 AND ($2::boolean OR repository_id=ANY($3::text[])) RETURNING *`,[data.installation.id,removed,removedIds])).rows;
  for(const worker of rows){
   if(!/^[a-z][a-z0-9_]{0,62}$/.test(worker.queue_schema))throw new Error('Invalid registration');
   const queue=database(worker.queue_database);
   const jobs=(await queue.query(`SELECT id FROM "${worker.queue_schema}".repository_indexes WHERE tenant_id=$1 AND repository_id=$2 AND status IN ('queued','running')`,[worker.organization_id,worker.repository_id])).rows;
   for(const job of jobs)await cancelIndex(worker,job.id,queue);
  }
 }
 if(restored||addedIds.length)await pool.query(`UPDATE api_repository_worker SET access_error=NULL,access_verified_at=NULL,metadata_due_at=now() WHERE installation_id=$1 AND ($2::boolean OR repository_id=ANY($3::text[]))`,[data.installation.id,restored,addedIds]);
 return Response.json({accepted:true},{status:202});
}
