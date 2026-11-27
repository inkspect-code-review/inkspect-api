import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { diagramDirection } from "./review-settings";
import { database } from "./database";
import { authorizedWorker, authorizedStoredWorker, loadJob, legacyJobs, present, presentLegacy, type EngineJob } from "./engine-store";
import { verifyRequest, validateReview, jobID, schemaName, type HostConfig } from "./engine-contract";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { requestIdentity } from "@inkspect/core/lib/review-identity";
import type { EngineHttpPolicy } from "./engine-http-policy";
import { PullGitHub } from "./pull-request-github";
import { repositoryToken } from "./metadata";
import { runRust, renderStoredReport } from "./engine-process";
import { storedIndex } from "./repository-store";
import { chatIndexRequirement } from "./chat-index-state";

export function createEngineHandler(host: HostConfig, ready: () => object | null, track: <T>(work: () => Promise<T>) => Promise<T>,
  policy: EngineHttpPolicy, dependencies = { runRust }) {
  const reviewHost = policy.reviewBudgetNanoUsd === undefined ? host : { ...host, budget_nano_usd: policy.reviewBudgetNanoUsd };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && ['/ready', '/health'].includes(url.pathname)) {
        const value = ready(); return json(value || { status: 'starting' }, value ? 200 : 503);
      }
      const parts: Buffer[] = []; let length = 0;
      for await (const part of req) { length += part.length; if (length > 64 * 1024) throw new ReviewError(413, 'Request too large.'); parts.push(part); }
      const raw = Buffer.concat(parts).toString();
      const claims = verifyRequest(req.method || '', req.url || '', raw, String(req.headers['x-inkspect-claims'] || ''), String(req.headers['x-inkspect-signature'] || ''), process.env.INKSPECT_ENGINE_SECRET || '');
      const body = raw ? JSON.parse(raw) : {};
      const signal = AbortSignal.timeout(85_000);
      if (req.method === 'POST' && (url.pathname === '/chat/context' || url.pathname === '/chat/source') && policy.additionalChat?.accepts(claims)) {
        const reader = policy.additionalChat;
        return await track(async () => {
          const mode = url.pathname === '/chat/context' ? 'context' : 'source';
          if (mode === 'context') await policy.chatAccess(claims, body.message_id);
          return json(await reader.read(claims, mode, body, host, signal));
        });
      }
      const storedOperation = (req.method === 'GET' && (url.pathname === '/github/repositories' || url.pathname === '/jobs' || url.pathname.startsWith('/jobs/'))
        && !url.searchParams.has('check_pull'))
        || (req.method === 'POST' && (['/chat/context', '/chat/source'].includes(url.pathname) || /^\/jobs\/J-[a-f0-9]{32}\/cancel$/.test(url.pathname)));
      const worker = await (storedOperation ? authorizedStoredWorker : authorizedWorker)(claims);
      if (!storedOperation) await repositoryToken(worker, signal);
      const fixMatch = /^\/jobs\/(J-[a-f0-9]{32})\/fix$/.exec(url.pathname);
      if (fixMatch && ['GET', 'POST'].includes(req.method || '')) {
        if (req.method === 'POST' && (body === null || Array.isArray(body) || typeof body !== 'object'
          || (!policy.fixWithOptions && Object.keys(body).some(k => k !== 'retry_of')) || (body.retry_of !== undefined && typeof body.retry_of !== 'string'))) throw new ReviewError(400,'Invalid fix request.');
        const state = policy.fixWithOptions
          ? await policy.fixWithOptions(worker, claims, fixMatch[1], req.method!, host, signal, req.method === 'POST' ? body : {})
          : await policy.fix(worker, claims, fixMatch[1], req.method!, host, signal, req.method === 'POST' ? body.retry_of : undefined);
        if (req.method === 'GET' && url.searchParams.get('check_pull') === '1') {
          if (policy.fixPullState) {
            const readiness = await policy.fixPullState(worker, fixMatch[1], signal);
            return json({ ...state, ...readiness, available: readiness.pr_ready && state.available });
          }
          const open = await policy.fixPullOpen(worker, fixMatch[1], signal);
          return json({ ...state, available: open && state.available, pr_open: open });
        }
        return json(state);
      }
      if (url.pathname === '/github/repositories' && req.method === 'GET') {
        return json({ repositories: [{ id: claims.repository, full_name: worker.full_name, private: true }],
          ...policy.configuration(reviewHost), execution_mode: 'api', engine: 'rust' });
      }
      const pullTitle = /^\/github\/pulls\/([1-9]\d*)\/title$/.exec(url.pathname);
      if (pullTitle && req.method === 'GET') {
        const number = Number(pullTitle[1]);
        if (!Number.isSafeInteger(number)) throw new ReviewError(400, 'Invalid pull request number.');
        const gh = await PullGitHub.open(worker, number, signal);
        const { title } = await gh.snapshot();
        if (title) {
          await database().query(`UPDATE api_engine_job SET snapshot=jsonb_set(snapshot,'{title}',to_jsonb($5::text))
            WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4
              AND request->>'number'=$6 AND NULLIF(snapshot->>'title','') IS NULL`,
          [claims.tenant, worker.repository_id, claims.connection, claims.installation, title, String(number)]);
        }
        return json({ title });
      }
      if (url.pathname === '/github/pulls' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        if (!Number.isInteger(page) || page < 1 || page > 100) throw new ReviewError(400, 'Invalid page.');
        const gh = await PullGitHub.open(worker, 1, signal);
        const pulls = await gh.request(`${gh.root}/pulls?state=open&per_page=30&page=${page}`);
        return json({ pulls: pulls.map((p: any) => ({ number: p.number, title: p.title, url: p.html_url, draft: p.draft, base_tip: p.base.sha, head: p.head.sha })), has_more: pulls.length === 30 });
      }
      if (url.pathname === '/github/reviews' && req.method === 'POST') {
        validateReview(body, host);
        if (body.repository_id !== claims.repository) throw new ReviewError(403, 'Repository scope mismatch.');
        const admission = { organization: claims.tenant, user: claims.subject, repository: claims.repository, connection: claims.connection, installation: claims.installation, body };
        const identity = requestIdentity(admission);
        const existing = (await database().query<EngineJob>('SELECT * FROM api_engine_job WHERE request_id=$1', [identity])).rows[0];
        if (existing) return json(present(existing));
        const reservation = await policy.admission(admission);
        // A retry of an older engine's uncertain admission must never buy a second run.
        if (reservation.job_id) {
          // Another request may attach its job between our initial lookup and
          // reservation read. Return that run instead of rejecting the retry.
          const concurrent = await loadJob(worker, reservation.job_id);
          if (concurrent?.request_id === identity) return json(present(concurrent));
          const old = (await legacyJobs(worker, reservation.job_id))[0];
          if (old) return json(presentLegacy(old));
          throw new ReviewError(409, 'This admission already belongs to another run.');
        }
        for (const previous of [body.retry_of, body.rerun_of].filter(Boolean)) {
          const old = await loadJob(worker, previous) || (await legacyJobs(worker, previous))[0];
          if (!old || !['completed', 'failed', 'cancelled'].includes(old.status) || (body.retry_of && old.status === 'completed')) throw new ReviewError(409, 'The previous review is not eligible for another attempt.');
        }
        const gh = await PullGitHub.open(worker, body.number, signal, true);
        const live = await gh.snapshot();
        if (!live.open || live.draft || live.base !== body.base_tip || live.head !== body.head) throw new ReviewError(409, 'The pull request changed.');
        const compare = await gh.request(`${gh.root}/compare/${live.base}...${live.head}`);
        const base = compare.merge_base_commit?.sha;
        if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid merge base');
        const id = jobID(identity);
        const snapshot = { title: live.title, url: `https://github.com/${worker.full_name}/pull/${body.number}`, repository_id: worker.repository_id, base_tip: live.base, base_ref: live.baseRef, base, head: live.head, review_model_id: body.byok?.model || host.model_id };
        const tx = await database().connect();
        try {
          await tx.query('BEGIN');
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`engine-admit:${identity}`]);
          const jobHost = { ...(body.byok ? host : reviewHost), diagram_direction: await diagramDirection(claims.tenant, tx) };
          await tx.query(`INSERT INTO api_engine_job(id,request_id,organization_id,repository_id,connection_id,installation_id,subject,request,snapshot,host_config)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_id) DO NOTHING`,
          [id, identity, claims.tenant, worker.repository_id, claims.connection, claims.installation, claims.subject, body, snapshot, jobHost]);
          await policy.attach(admission, id, tx);
          await tx.query('COMMIT');
        } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
        return json(present((await loadJob(worker, id))!), 202);
      }
      if (url.pathname === '/jobs' && req.method === 'GET') {
        const rows = (await database().query<EngineJob>(`SELECT * FROM api_engine_job WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4 AND NOT (request ? 'fix_of') ORDER BY created_at DESC LIMIT 30`, [claims.tenant, worker.repository_id, claims.connection, claims.installation])).rows;
        return json({ reviews: [...rows.map(present), ...(await legacyJobs(worker)).map(presentLegacy)].sort((a, b) => new Date(b.job.created_at).getTime() - new Date(a.job.created_at).getTime()).slice(0, 30) });
      }
      const match = /^\/jobs\/(J-[a-f0-9]{32})(?:\/(report|cancel|activity))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        const job = await loadJob(worker, id);
        const old = job ? undefined : (await legacyJobs(worker, id))[0];
        if (!job && !old) throw new ReviewError(404, 'Review not found.');
        if (action === 'cancel' && req.method === 'POST') {
          if (job) await database().query(`UPDATE api_engine_job SET cancel_requested=true,
            billing_usage=CASE WHEN status='queued' THEN '{"complete":true,"charged_nano_usd":"0","input_tokens":0,"output_tokens":0,"total_tokens":0,"calls":0}'::jsonb ELSE billing_usage END,
            status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
            finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=$1 AND status IN ('queued','running','paused')`, [id]);
          else await database(worker.queue_database).query(`UPDATE ${schemaName(worker.queue_schema)}.jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','leased','running','paused')`, [claims.tenant, id]);
          return json(job ? present((await loadJob(worker, id))!) : presentLegacy((await legacyJobs(worker, id))[0]));
        }
        if (req.method !== 'GET') throw new ReviewError(405, 'Method not allowed.');
        if (!action) return json(job ? present(job) : presentLegacy(old));
        if (action === 'activity') {
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new ReviewError(400, 'Invalid cursor.');
          const rows = job
            ? (await database().query('SELECT * FROM (SELECT row_number() OVER (ORDER BY id) AS sequence,event,created_at FROM api_engine_event WHERE job_id=$1) activity WHERE sequence>$2 ORDER BY sequence LIMIT 100', [id, after])).rows
            : (await database(worker.queue_database).query(`SELECT sequence,event,created_at FROM ${schemaName(worker.queue_schema)}.job_activity WHERE tenant_id=$1 AND job_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100`, [claims.tenant, id, after])).rows;
          return json({ events: rows.map(r => ({ event: r.event, created_at: r.created_at, sequence: Number(r.sequence) })), next_cursor: rows.length ? Number(rows.at(-1)!.sequence) : after, has_more: rows.length === 100 });
        }
        if (job && typeof job.request.fix_of === 'string') throw new ReviewError(409, 'Use the source review to view fix progress.');
        const report = job ? job.report : (await database(worker.queue_database).query(`SELECT report FROM ${schemaName(worker.queue_schema)}.runs WHERE tenant_id=$1 AND id=$2`, [claims.tenant, id])).rows[0]?.report;
        if (!report) throw new ReviewError(409, 'The report is not ready yet.');
        if (report.run?.id !== id || report.run?.target?.tenant_id !== claims.tenant || report.run.target.repository_id !== worker.repository_id) throw new ReviewError(403, 'Report scope mismatch.');
        report.presentation ??= await renderStoredReport(report);
        return json({ report, fix_prompt: report.presentation.fix_prompt, finding_prompts: report.presentation.finding_prompts, freshness_check: 'not_checked' });
      }
      if (['/chat/context', '/chat/source'].includes(url.pathname) && req.method === 'POST') {
        return await track(async () => {
          if (url.pathname === '/chat/context') {
            await policy.chatAccess(claims, body.message_id);
            const requirement = await chatIndexRequirement(worker);
            if (requirement) return json(requirement);
          }
          const revision = url.pathname === '/chat/source' ? body.revision : (await storedIndex(worker))?.progress.revision;
          if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new ReviewError(400, 'Invalid revision.');
          const [owner, repo] = worker.full_name.split('/');
          const operation = randomUUID();
          const result = await dependencies.runRust(url.pathname === '/chat/source' ? 'source' : 'context', { ...host, timeout_seconds: 80 },
            { run_id: operation, owner, repo, repository_id: worker.repository_id, tenant_id: claims.tenant, pull_number: 1, base_sha: revision, head_sha: revision }, body, '', operation, signal);
          await policy.retrieval(result.events, host, { organization: claims.tenant, user: claims.subject, repository: worker.repository_id, operation });
          await authorizedStoredWorker(claims);
          if (!result.report) throw new ReviewError(503, 'Repository context is unavailable.');
          return json(result.report);
        });
      }
      throw new ReviewError(404, 'Not found.');
    } catch (error) {
      json({ error: error instanceof ReviewError ? error.message : 'The engine service is temporarily unavailable.' }, error instanceof ReviewError ? error.status : 503);
    }
  };
}
