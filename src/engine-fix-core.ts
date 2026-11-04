import { database } from "./database";
import { authorizedWorker, jobClaims, loadJob, present, type EngineJob } from "./engine-store";
import { PullGitHub } from "./pull-request-github";
import { repositoryToken, MetadataFailure } from "./metadata";
import type { Worker } from "./repository-store";
import type { HostConfig } from "./engine-contract";
import { jobID } from "./engine-contract";
import { requestIdentity } from "@inkspect/core/lib/review-identity";
import type { FixPolicy } from "./engine-fix-policy";
import type { EngineClaims } from "@inkspect/core/lib/engine-client";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { automaticFix } from "./review-settings";
import { runRust } from "./engine-process";
import { CommitFailure, commitReceipt, commitRejectionMessage } from "./engine-fix-receipt";
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FIX_NO_SAFE_REPAIR, FIX_VERIFICATION_FAILED, FIX_VERIFICATION_MESSAGE, validateFixVerification } from "./engine-fix-verification";
import { diagnosticMessage } from "./engine-diagnostics";

type Claims = Omit<EngineClaims, 'expires'>;
export const isFix = (job: EngineJob) => typeof job.request.fix_of === 'string';

// Only the Findings banner requests live PR state. History and progress stay local.
export async function fixPullOpen(worker: Worker, sourceId: string, signal: AbortSignal) {
  const source = await loadJob(worker, sourceId);
  if (!source || isFix(source) || source.status !== 'completed' || !source.report?.findings?.length) return false;
  const github = await PullGitHub.open(worker, source.request.number, signal);
  return (await github.snapshot()).open;
}

// The connection owner or a workspace administrator may authorize code writes.
// Ordinary membership is enough to view progress, but never to use app write credentials.
export async function authorizeFix(claims: Claims) {
  await authorizedWorker(claims);
  const allowed = await database().query(`SELECT 1 FROM member m JOIN "githubRepositoryClaim" c
    ON c."organizationId"=m."organizationId" AND c."repositoryId"=$3
    WHERE m."organizationId"=$1 AND m."userId"=$2 AND (regexp_split_to_array(trim(m.role),'\\s*,\\s*') && ARRAY['owner','admin'] OR c."accountId"=m."userId")`,
  [claims.tenant, claims.subject, String(claims.repository)]);
  if (!allowed.rowCount) throw new ReviewError(403, 'A workspace admin or the repository connection owner must start AI fixes.');
}

export async function autoFixGuard(job: EngineJob) {
  if (job.request.auto_fix_version === undefined) return;
  const settings = await automaticFix(job.organization_id);
  const manager=(await database().query(`SELECT 1 FROM member WHERE "organizationId"=$1 AND "userId"=$2 AND regexp_split_to_array(trim(role),'\\s*,\\s*') && ARRAY['owner','admin']`,[job.organization_id,job.subject])).rowCount;
  if (!manager || !settings.auto_fix || String(settings.auto_fix_version)!==String(job.request.auto_fix_version) || settings.auto_fix_by!==job.subject)
    throw new ReviewError(403,'Automatic fixes are no longer enabled for this job.');
}
async function fixGitHub(worker: Worker, number: number, signal: AbortSignal) {
  try { return await PullGitHub.open(worker, number, signal, 'write'); }
  catch (error) {
    if (error instanceof MetadataFailure && [403, 422].includes(error.status))
      throw new ReviewError(403, 'AI fixes need GitHub App Contents: read and write permission. Update the app permissions and approve the installation update.');
    throw error;
  }
}

export function validateFixPull(pull: any, worker: Worker, source: EngineJob, branch?: string) {
  if (pull.number !== source.request.number || String(pull.base?.repo?.id) !== worker.repository_id
    || String(pull.head?.repo?.id) !== worker.repository_id || pull.head?.repo?.full_name?.toLowerCase() !== worker.full_name.toLowerCase())
    throw new ReviewError(409, 'AI fixes require a PR branch in the connected repository. Fork PRs are not supported.');
  if (pull.state !== 'open' || pull.draft || pull.head?.sha !== source.snapshot.head || pull.base?.sha !== source.snapshot.base_tip)
    throw new ReviewError(409, 'This PR changed or is no longer ready. Run a new review before fixing it.');
  const ref = pull.head.ref;
  if (typeof ref !== 'string' || !ref || ref.length > 255 || /[\x00-\x20~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')
    || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')
    || ref.split('/').some((s: string) => !s || s.startsWith('.')) || (branch && ref !== branch)
    || ref === pull.base.ref || ref === pull.base.repo.default_branch)
    throw new ReviewError(409, 'AI fixes can only update the original PR feature branch.');
  return ref;
}

export function fixStatus(job?: EngineJob) {
  if (!job) return null;
  return { ...present(job).job, commit: job.snapshot.fix_commit || null, retryable: canRetryFix(job),
    error: job.error_code === 'fix.commit_uncertain' || (job.error_code === 'engine.interrupted' && job.snapshot.fix_publishing)
      ? 'GitHub did not confirm the commit. Check the PR before starting another review or fix.'
      : job.status==='failed' && !job.snapshot.fix_publishing && !job.snapshot.fix_commit && diagnosticMessage(job.snapshot.failure)
        ? `${diagnosticMessage(job.snapshot.failure)} No commit was sent.`
      : job.error_code === FIX_NO_SAFE_REPAIR ? 'The model could not propose a complete safe fix. No commit was sent.'
      : job.error_code === FIX_VERIFICATION_FAILED ? FIX_VERIFICATION_MESSAGE
      : job.error_code === 'fix.commit_rejected' ? commitRejectionMessage(job.snapshot.fix_commit_failure?.category)
      : job.error_code === 'fix.stale' ? 'The PR changed. Run a new review before fixing it.'
      : job.error_code === 'fix.permission' ? 'Repository write access is unavailable. Check the GitHub App permissions.'
      : job.status === 'failed' ? 'The fix could not finish safely. No automatic retry will run. Check the PR and start a new review to try again.' : null };
}

export function canRetryFix(job: EngineJob) {
  return job.status === 'failed' && !job.snapshot.fix_commit && !job.snapshot.fix_publishing
    && [FIX_VERIFICATION_FAILED, FIX_NO_SAFE_REPAIR].includes(job.error_code || '')
    && job.billing_usage?.complete === true;
}

export class FixAdmissionBusy extends ReviewError {
  constructor() { super(409, "A fix is already being started. Try again shortly."); }
}
let admitting = false;
export async function handleFix(policy: FixPolicy, worker: Worker, claims: Claims, sourceId: string, method: string, host: HostConfig, signal: AbortSignal, automatic?: {version:string}, retryOf?: string) {
  if (retryOf !== undefined && (method !== 'POST' || automatic || !/^J-[a-f0-9]{32}$/.test(retryOf))) throw new ReviewError(400, 'Invalid fix retry.');
  if (method === 'POST') {
    if (admitting) throw new FixAdmissionBusy();
    admitting = true;
    try {
    const lock=await database().connect(), key=`fix-admit:${claims.tenant}:${claims.repository}:${sourceId}`;
    try {
      if (!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[key])).rows[0].ok) throw new FixAdmissionBusy();
      return await admitFix(policy,worker,claims,sourceId,host,signal,automatic,false,retryOf);
    } finally {await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});lock.release(true);}
    } finally {admitting = false;}
  }
  return admitFix(policy,worker,claims,sourceId,host,signal,undefined,true);
}
async function admitFix(policy: FixPolicy, worker:Worker, claims:Claims, sourceId:string, host:HostConfig, signal:AbortSignal, automatic?:{version:string}, read=false, retryOf?:string) {
  const source = await loadJob(worker, sourceId);
  if (!source || isFix(source) || source.status !== 'completed' || !source.report?.findings?.length) {
    if (read) return { available: false, reason: 'AI fixes are available for completed reviews with findings from the current engine.', fix: null };
    throw new ReviewError(409, 'A completed review with findings is required.');
  }
  const body: Record<string, any> = { repository_id: Number(worker.repository_id), number: source.request.number,
    base_tip: source.snapshot.base_tip, head: source.snapshot.head, fix_of: source.id };
  const input = { organization: claims.tenant, user: claims.subject, repository: claims.repository, connection: claims.connection, installation: claims.installation, repositoryName: worker.full_name, body };
  const existing = (await database().query<EngineJob>(`SELECT * FROM api_engine_job WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4 AND request->>'fix_of'=$5 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [claims.tenant,worker.repository_id,claims.connection,claims.installation,sourceId])).rows[0];
  if (read) {
    try { await authorizeFix(claims); await policy.provider(claims); }
    catch (error) { if (!(error instanceof ReviewError)) throw error; return { available: false, reason: error.message, fix: fixStatus(existing) }; }
    return { available: true, reason: !existing ? source.snapshot.auto_fix_outcome?.reason : undefined, billing_mode: (await policy.provider(claims)) ? "byok" : policy.managedMode, fix: fixStatus(existing) };
  }
  await authorizeFix(claims);
  if (retryOf) {
    // Explicit retry of a definite pre-publication failure, on the same saved
    // review. Duplicate/replayed requests return the same paid operation.
    const replay = (await database().query<EngineJob>(`SELECT * FROM api_engine_job WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4 AND request->>'fix_of'=$5 AND request->>'retry_of'=$6 LIMIT 1`,
      [claims.tenant,worker.repository_id,claims.connection,claims.installation,sourceId,retryOf])).rows[0];
    if (replay) return {available:true,fix:fixStatus(replay)};
    if (!existing || existing.id !== retryOf || !canRetryFix(existing)) throw new ReviewError(409,'This fix cannot be retried safely. Check its latest status.');
    body.retry_of = retryOf;
  } else if (existing) return { available: true, fix: fixStatus(existing) };
  const selection=await policy.provider(claims);
  if (selection) body.byok=selection;
  if (automatic) {body.auto_fix_version=automatic.version; await autoFixGuard({organization_id:claims.tenant,subject:claims.subject,request:body} as EngineJob);}
  const identity=requestIdentity(input), id=jobID(identity);
  // Validate contents:write before buying model work. Never pass this token to Rust.
  const gh = await fixGitHub(worker, body.number, signal);
  const pull = await gh.request(`${gh.root}/pulls/${body.number}`);
  const branch = validateFixPull(pull, worker, source);
  // Admission is idempotent and shares the review credit gate and settlement.
  // BYOK selection is bound to the reservation and checked again at execution.
  await policy.reserve(input, host);
  const tx = await database().connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`engine-admit:${identity}`]);
    await tx.query(`INSERT INTO api_engine_job(id,request_id,organization_id,repository_id,connection_id,installation_id,subject,request,snapshot,host_config)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_id) DO NOTHING`,
    [id, identity, claims.tenant, worker.repository_id, claims.connection, claims.installation, claims.subject, body, { ...source.snapshot, fix_branch:branch }, host]);
    await policy.attach(input, id, tx);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  return { available:true, fix:fixStatus((await loadJob(worker, id))!) };
}

export function validateRepair(value: any, job: EngineJob): { path: string; content: string }[] {
  if (value?.head !== job.snapshot.head || value?.run_id !== job.id || value?.tests_run !== false
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 40) throw new Error('Invalid repair');
  const paths = new Set(); let bytes = 0;
  for (const file of value.files) {
    if (typeof file.path !== 'string' || file.path.length > 512 || /[\\:\x00-\x1f\x7f]/.test(file.path)
      || file.path.split('/').some((s: string) => !s || s.startsWith('.')) || paths.has(file.path)
      || typeof file.content !== 'string' || file.content.includes('\0') || Buffer.byteLength(file.content) > 256_000) throw new Error('Invalid repair file');
    bytes += Buffer.byteLength(file.content); paths.add(file.path);
  }
  if (bytes > 512_000) throw new Error('Repair too large');
  return value.files;
}

export async function commitRepair(worker: Worker, job: EngineJob, files: {path:string;content:string}[], token: string, signal: AbortSignal,
  retainReceipt?: (receipt: {status:number;request_id:string|null;body:string}) => Promise<void>) {
  // expectedHeadOid is GitHub's atomic compare-and-swap. Never force-update a
  // ref, rebase generated edits or retry an ambiguous mutation.
  const response = await fetch('https://api.github.com/graphql', { method:'POST', redirect:'error', signal:AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'User-Agent':'Inkspect-API' },
    body:JSON.stringify({ query:'mutation Fix($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }', variables:{ input:{
      branch:{ repositoryNameWithOwner:worker.full_name, branchName:job.snapshot.fix_branch }, expectedHeadOid:job.snapshot.head,
      message:{ headline:'fix: address Inkspect review findings', body:`Inkspect-Fix: ${job.id}\nSource-Review: ${job.request.fix_of}\n\nGenerated from the reviewed commit. Repository tests were not executed by the fix engine; verify with CI and review.` },
      fileChanges:{ additions:files.map(file => ({ path:file.path, contents:Buffer.from(file.content).toString('base64') })) },
    } } }) });
  // A small bounded receipt is all that is expected from this mutation.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing commit receipt');
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const {done,value} = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 64_000) { await reader.cancel(); throw new Error('Oversized commit receipt'); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const requestId = response.headers.get('x-github-request-id');
  // A diagnostic storage failure must not turn a confirmed commit into failure.
  await retainReceipt?.({status:response.status,request_id:requestId,body:text}).catch(() => {});
  return commitReceipt(response.status, requestId, text);
}

export async function runFix(policy: FixPolicy, job: EngineJob, worker: Worker, signal: AbortSignal) {
  await authorizeFix(jobClaims(job));
  await autoFixGuard(job);
  const source = await loadJob(worker, job.request.fix_of);
  if (!source || source.status !== 'completed' || source.snapshot.head !== job.snapshot.head) throw new Error('Source review unavailable');
  const gh = await fixGitHub(worker, job.request.number, signal);
  validateFixPull(await gh.request(`${gh.root}/pulls/${job.request.number}`), worker, source, job.snapshot.fix_branch);
  const token = await repositoryToken(worker, signal, true);
  if(!job.request.byok && policy.managedFix) {
    try { return await policy.managedFix(job,worker,source,token,signal,async verification=>{
      await authorizeFix(jobClaims(job));await autoFixGuard(job);
      validateFixPull(await gh.request(`${gh.root}/pulls/${job.request.number}`),worker,source,job.snapshot.fix_branch);
      signal.throwIfAborted();const writeToken=await repositoryToken(worker,signal,'write');
      const intent=await database().query(`UPDATE api_engine_job SET snapshot=snapshot || $2::jsonb WHERE id=$1 AND NOT cancel_requested AND status='running' RETURNING id`,[job.id,{fix_publishing:true,fix_verification:verification,fix_engine:'claude_code'}]);
      if(!intent.rowCount)throw new Error('Fix cancelled');return writeToken;
    },async oid=>{await database().query('UPDATE api_engine_job SET snapshot=snapshot || $2::jsonb WHERE id=$1',[job.id,{fix_commit:oid,fix_publishing:false}]);}); }
    catch(error){await database().query("UPDATE api_engine_job SET error_code=CASE WHEN snapshot->>'fix_publishing'='true' THEN 'fix.commit_uncertain' ELSE 'fix.verification_failed' END WHERE id=$1",[job.id]);throw error;}
  }
  const [owner, repo] = worker.full_name.split('/');
  const credential=await policy.credential(job);
  const result = await runRust('fix', job.host_config, { run_id:job.id, tenant_id:job.organization_id, repository_id:job.repository_id,
    owner, repo, pull_number:job.request.number, base_sha:job.snapshot.base, head_sha:job.snapshot.head }, { report:source.report }, token, job.id, signal, credential);
  if (!result.report) return result;
  const files = validateRepair(result.report, job);
  let verification;
  try { verification = validateFixVerification(result.report, files, job, source, result.events); }
  catch (error) {
    await database().query('UPDATE api_engine_job SET error_code=$2 WHERE id=$1', [job.id,FIX_VERIFICATION_FAILED]);
    throw error;
  }
  await database().query('UPDATE api_engine_job SET snapshot=snapshot || $2::jsonb WHERE id=$1', [job.id,{fix_verification:verification}]);
  await authorizeFix(jobClaims(job));
  await autoFixGuard(job);
  await policy.revalidate(job);
  validateFixPull(await gh.request(`${gh.root}/pulls/${job.request.number}`), worker, source, job.snapshot.fix_branch);
  signal.throwIfAborted();
  const writeToken = await repositoryToken(worker, signal, 'write');
  // Persist send intent before the only external write. A crash remains
  // uncertain, never silently repeats model work or a commit.
  const intent = await database().query(`UPDATE api_engine_job SET snapshot=snapshot || '{"fix_publishing":true}'::jsonb
    WHERE id=$1 AND NOT cancel_requested AND status='running' RETURNING id`, [job.id]);
  if (!intent.rowCount) throw new Error('Fix cancelled');
  try {
    const oid = await commitRepair(worker, job, files, writeToken, signal, async receipt => {
      if (!/^J-[a-f0-9]{32}$/.test(job.id)) return;
      // Same owner-only run directory as source/model context, never the public
      // job snapshot. Responses may echo input files; never save request headers or tokens.
      await writeFile(resolve(process.env.INKSPECT_RUST_STATE || '/var/lib/inkspect/rust', job.id, 'commit-receipt.json'),
        JSON.stringify(receipt), {mode:0o600,flag:'wx'});
    });
    await database().query(`UPDATE api_engine_job SET snapshot=snapshot || $2::jsonb WHERE id=$1`, [job.id, { fix_commit:oid, fix_publishing:false }]);
    // Do not persist file contents in the public report. No extra review is
    // enqueued: the synchronize webhook honors the repository's auto-review setting.
    return { events:result.events, report:{ commit:oid, tests_run:false, verification } };
  } catch (error) {
    const definitive = error instanceof CommitFailure && error.definitive;
    await database().query('UPDATE api_engine_job SET error_code=$2,snapshot=snapshot || $3::jsonb WHERE id=$1',
      [job.id, definitive ? 'fix.commit_rejected' : 'fix.commit_uncertain', {
        fix_publishing: !definitive,
        ...(error instanceof CommitFailure ? {fix_commit_failure:error.diagnostic} : {}),
      }]);
    throw error;
  }
}
