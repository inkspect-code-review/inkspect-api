import { database } from "./database";
import { authorizedWorker, jobClaims, type EngineJob } from "./engine-store";
import { automaticFix } from "./review-settings";
import { FixAdmissionBusy } from "./engine-fix-core";
import type { EngineHttpPolicy } from "./engine-http-policy";
import { PullGitHub } from "./pull-request-github";
import type { HostConfig } from "./engine-contract";
import { ReviewError } from "@inkspect/core/lib/review-access";

// One pass is bounded. A restart picks up unfinished admissions, while the
// normal fix identity/lock prevents replaying paid work or publishing twice.
export async function enqueueAutomaticFixes(host:HostConfig, handleFix: (...args: [...Parameters<EngineHttpPolicy['fix']>, automatic?: {version:string}]) => Promise<unknown>) {
  const jobs=(await database().query<EngineJob & {finished_at:Date}>(`SELECT j.* FROM api_engine_job j JOIN api_review_settings s ON s.organization_id=j.organization_id
    WHERE s.auto_fix AND j.status='completed' AND j.finished_at>=s.auto_fix_since
      AND NOT(j.request ? 'fix_of') AND NOT(j.snapshot ? 'auto_fix_outcome')
    ORDER BY j.finished_at LIMIT 5`)).rows;
  for(const source of jobs) {
    const lock=await database().connect(), key=`auto-fix:${source.organization_id}:${source.repository_id}`;
    try {
      if(!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[key])).rows[0].ok) continue;
      const current=(await lock.query('SELECT snapshot FROM api_engine_job WHERE id=$1',[source.id])).rows[0];
      if(current?.snapshot.auto_fix_outcome) continue;
      const settings=await automaticFix(source.organization_id);
      if(!settings.auto_fix || !settings.auto_fix_by || new Date(source.finished_at!).getTime()<new Date(settings.auto_fix_since).getTime()) continue;
      if(!source.report?.findings?.length) {await finish(source,'skipped','No findings to fix.');continue;}
      const prior=(await lock.query(`SELECT 1 FROM api_engine_job WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4
        AND request ? 'fix_of' AND (snapshot->>'fix_commit'=$5 OR (request->>'head'=$5 AND request->>'fix_of'<>$6)) LIMIT 1`,
        [source.organization_id,source.repository_id,source.connection_id,source.installation_id,source.snapshot.head,source.id])).rowCount;
      if(prior) {await finish(source,'skipped','Automatic fixes stop after one attempt per reviewed commit.');continue;}
      const claims={...jobClaims(source),subject:settings.auto_fix_by};
      const worker=await authorizedWorker(claims);
      const signal=AbortSignal.timeout(25_000);
      const gh=await PullGitHub.open(worker,source.request.number,signal,true);
      const commit=await gh.request(`${gh.root}/commits/${source.snapshot.head}`);
      // Also handles a lost publication receipt: the durable GitHub marker
      // breaks the cycle even if our local job never stored the resulting SHA.
      if(/^Inkspect-Fix: J-[a-f0-9]{32}$/m.test(commit.commit?.message || '')) {
        await finish(source,'skipped','This Inkspect fix commit is reviewed without another automatic fix.');continue;
      }
      await handleFix(worker,claims,source.id,'POST',host,signal,undefined,{version:String(settings.auto_fix_version)});
      await finish(source,'submitted','Automatic fix started.');
    } catch(error) {
      if(error instanceof FixAdmissionBusy) continue;
      await finish(source,'failed',error instanceof ReviewError ? error.message : 'Automatic fix could not start. You can start a fix manually.');
    } finally {await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});lock.release(true);}
  }
}
async function finish(source:EngineJob,state:string,reason:string) {
  await database().query('UPDATE api_engine_job SET snapshot=snapshot || $2::jsonb WHERE id=$1',[source.id,{auto_fix_outcome:{state,reason}}]);
}
