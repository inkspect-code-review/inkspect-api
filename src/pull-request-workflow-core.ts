import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { engineRequest } from "@inkspect/core/lib/engine-client";
import type { ReviewLifecycle } from "@inkspect/core/lib/review-lifecycle";
import { admitIndex } from "@inkspect/core/lib/repository-store";
import { ReviewError } from "@inkspect/core/lib/review-access";
import type { ReportResponse, ReviewJob } from "@inkspect/core/lib/review-types";
import { database } from "./database";
import { eligibility, enqueueIndex, lastIndexed, latestIndex, type Worker } from "./repository-store";
import { PullGitHub, type Delivery } from "./pull-request-github";
import { findingBody, reportBody, safeText } from "./pull-request-report";
import { INVALID_IGNORE } from "./engine-contract";
import { appLogin } from "./pull-request-events";
import { isIgnoredAuthor } from "./review-settings";

const ignoreDocs = '[how `.inkspectignore` works](https://inkspect.si/inkspectignore)';

export type ReviewNote = { author: string; body: string };
// notes: participant requests for the next admission, frozen while admitting.
// published: the completed job whose report is already on the pull request.
export type WorkflowState = { head?: string; base?: string; index?: string; job?: string; rerun?: string; stopped?: boolean;
  eyes?: boolean; summary?: Delivery; findings?: Record<string, Delivery>; error?: string;
  notes?: ReviewNote[]; admitting?: boolean; published?: string };
export type Workflow = { id: string; organization_id: string; repository_id: string; connection_id: string;
  installation_id: string; number: number; state: WorkflowState };
type Binding = Worker & { subject: string; automatic: boolean; ignored_authors?: string[] };
type Message = { comment_id: string; kind: 'issue' | 'inline'; sender: string; intent: 'review' | 'explain'; reply_to: string | null;
  note?: string | null; state: { ignored?: boolean; eyes?: boolean; requested?: boolean; job?: string; done?: boolean; delivery?: Delivery } };
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
// Mirrors the engine's bounds: at most five notes and 2000 bytes per review.
const fitsNotes = (notes: ReviewNote[], note: ReviewNote) =>
  notes.length < 5 && [...notes, note].reduce((size, n) => size + Buffer.byteLength(n.body), 0) <= 2000;

const commonServices = { engineRequest, admitIndex, eligibility, enqueueIndex, lastIndexed, latestIndex };
export type WorkflowServices = typeof commonServices & { reviewLifecycle: ReviewLifecycle; pausedLabel: string; admissionHelp: string };
export const workflowServices = (reviewLifecycle: ReviewLifecycle, pausedLabel = 'Review paused', admissionHelp = 'Check repository access, model availability and instance provider configuration in Inkspect.'): WorkflowServices => ({ ...commonServices, reviewLifecycle, pausedLabel, admissionHelp });
export async function advancePull(row: Workflow, worker: Binding, github: PullGitHub,
  save: () => Promise<void>, guardBinding: () => Promise<void>, messages: Message[], saveMessage: (m: Message) => Promise<void>, services: WorkflowServices): Promise<number | null> {
  const s = row.state;
  const reviewCommand = `@${appLogin()} review again`;
  const claims = { tenant: row.organization_id, subject: worker.subject, connection: row.connection_id,
    installation: Number(row.installation_id), repository: Number(row.repository_id) };
  const send = (path: string, method: 'GET' | 'POST' = 'GET', body?: object) => services.engineRequest(path, method, body, claims);
  const current = await github.snapshot();
  await guardBinding();
  if (isIgnoredAuthor(current.author, worker.ignored_authors)) {
    s.stopped = true; await save();
    for (const message of messages) {
      message.state.ignored = true; await saveMessage(message);
    }
    if (s.job) {
      let old = await send(`/jobs/${s.job}`) as ReviewJob;
      if (!terminal(old.job.status)) old = await send(`/jobs/${s.job}/cancel`, 'POST', {}) as ReviewJob;
      await services.reviewLifecycle.settle(row.organization_id, old);
      // Running jobs finish cancellation asynchronously; keep settling them.
      if (!terminal(old.job.status)) return 10_000;
    }
    return null;
  }
  const marker = `<!-- inkspect:pr:${row.id} -->`;
  const guard = async () => {
    await guardBinding();
    const live = await github.snapshot();
    if (isIgnoredAuthor(live.author, worker.ignored_authors)) throw new ReviewError(409, 'Pull request author is ignored.');
    if (live.head !== current.head || live.base !== current.base || live.open !== current.open || live.draft !== current.draft) throw new Error('Pull request changed');
  };
  const publish = async (body: string) => {
    s.summary ??= {};
    await github.deliver(s.summary, marker, body, 'issue', save, guard);
  };
  const link = new URL('/dashboard', process.env.BETTER_AUTH_URL || 'https://app.inkspect.si');
  link.search = new URLSearchParams({ view: 'reviews', repositoryId: row.repository_id, ...(s.job ? { jobId: s.job } : {}) }).toString();
  if (!current.open || current.draft) {
    s.stopped = true; await save();
    if (s.job) {
      const old = await send(`/jobs/${s.job}`) as ReviewJob;
      if (!terminal(old.job.status)) await send(`/jobs/${s.job}/cancel`, 'POST', {});
      // Closing/merging a reviewed PR must not erase its last report.
      if (old.job.status === 'completed') return null;
    }
    if (s.summary?.id) await publish(`## Inkspect · ${current.draft ? 'Waiting for review readiness' : 'Pull request closed'}\n\n${current.draft ? 'Mark this pull request ready for review to continue.' : 'Automatic review has stopped for this pull request.'}`);
    return null;
  }
  if (!worker.automatic && !s.job) {
    if (s.summary?.id) await publish('## Inkspect · Automatic reviews disabled\n\nEnable automatic reviews in workspace settings to continue.');
    return null;
  }
  if (s.head !== current.head || s.base !== current.base) {
    if (!worker.automatic) return null;
    if (s.job) {
      const old = await send(`/jobs/${s.job}`) as ReviewJob;
      if (!terminal(old.job.status)) await send(`/jobs/${s.job}/cancel`, 'POST', {});
      await services.reviewLifecycle.settle(row.organization_id, old);
    }
    // Notes that have not reached a review yet apply to the new commit's review.
    s.head = current.head; s.base = current.base; delete s.job; delete s.rerun; delete s.index; s.findings = {}; delete s.error;
    delete s.admitting; delete s.published;
    await save();
  }
  if (!s.eyes) { await guard(); await github.eyes(); s.eyes = true; await save(); }
  if (!s.summary?.id) await publish(`## Inkspect · Review queued\n\n👀 Preparing repository context for commit \`${s.head}\`.`);
  let job: ReviewJob | undefined = s.job ? await send(`/jobs/${s.job}`) : undefined;
  if (s.stopped && worker.automatic) {
    if (job && ['cancelled', 'failed'].includes(job.job.status)) {
      s.rerun = job.job.id; delete s.job; s.findings = {}; job = undefined;
    }
    delete s.stopped; await save();
  }

  let deferred = false;
  for (const message of messages) {
    if (message.state.done || message.state.ignored) continue;
    if (!worker.automatic) continue;
    if (!await github.canReview(message.sender)) { message.state.ignored = true; await saveMessage(message); continue; }
    // Inline conversations attach to this app's own finding threads, or to the
    // thread where a participant addressed the App with a review note.
    const parent = message.kind === 'inline' && message.reply_to ? await github.inlineParent(Number(message.reply_to)) : undefined;
    const thread = parent?.id ?? (message.kind === 'inline' && message.intent === 'review' && message.note ? Number(message.reply_to ?? message.comment_id) : undefined);
    if (message.kind === 'inline' && !thread) { message.state.ignored = true; await saveMessage(message); continue; }
    const reply = async (body: string) => {
      message.state.delivery ??= {};
      await github.deliver(message.state.delivery, `<!-- inkspect:reply:${row.id}:${message.kind}:${message.comment_id} -->`, body,
        message.kind, () => saveMessage(message), guard, thread ? { reply_to: thread } : {});
    };
    if (message.intent === 'explain') {
      const explanation = parent?.body?.replace(/^<!--[^\n]*-->\n/, '').split(/\n\n(?:Reply “fixed”|Comment `@)/)[0];
      await reply(explanation ? `The evidence and suggested change for this finding are:\n\n${explanation}\n\nPush a fix and comment \`${reviewCommand}\` to have it checked against the latest code.` : `I review new pushes and keep the first comment up to date. Comment \`${reviewCommand}\` to request another review. Include @${appLogin()} when addressing me in a finding thread.`);
      message.state.done = true; await saveMessage(message); continue;
    }
    if (!message.state.eyes) {
      await guard();
      await github.commentEyes(message.kind, message.comment_id);
      message.state.eyes = true; await saveMessage(message);
    }
    const note = message.note ? { author: message.sender, body: message.note } : undefined;
    if (!message.state.requested) {
      // A finished report is published before another review replaces it. A
      // running or already admitted review cannot gain a note; the note waits
      // for the next one instead of being silently ignored.
      const unpublished = job?.job.status === 'completed' && s.published !== job.job.id;
      const busy = (job && !terminal(job.job.status)) || (s.admitting && !s.job);
      if (unpublished || (note && (busy || !fitsNotes(s.notes ?? [], note)))) {
        deferred = true;
        if (note) await reply(`I’ll review \`${s.head}\` again with your note as soon as the current review finishes.`);
        continue;
      }
      if (job && terminal(job.job.status)) {
        s.rerun = job.job.id; delete s.job; s.findings = {}; delete s.notes; job = undefined;
      }
      if (note) s.notes = [...(s.notes ?? []), note];
      await save();
      // Persist intent before starting; a crash cannot turn a duplicate delivery
      // into another attempt. Messages received during a run share that run.
      message.state.requested = true; await saveMessage(message);
    }
    if (job && terminal(job.job.status) && message.state.job === job.job.id) {
      await reply(`The follow-up review of \`${s.head}\` ${job.job.status === 'completed' ? 'is complete' : 'could not complete'}. The [first comment](https://github.com/${worker.full_name}/pull/${row.number}#issuecomment-${s.summary!.id}) contains the latest result.`);
      message.state.done = true; await saveMessage(message);
    } else if (note) {
      await reply(`I’m reviewing \`${s.head}\` again with your note added to the review context. I’ll update this reply and the first comment when the review finishes.`);
    } else {
      await reply(`I’m checking the latest commit, \`${s.head}\`. New pushes also trigger a review automatically. I’ll update this reply and the first comment when the review finishes.`);
    }
  }

  if (!s.job) {
    // Read the setting again at the point of paid admission, not only receipt.
    await guardBinding();
    if (!worker.automatic) return null;
    if (isIgnoredAuthor(current.author, worker.ignored_authors)) return 1000;
    const indexed = await services.lastIndexed(worker);
    if (!indexed?.progress.indexed) {
      let index = await services.latestIndex(worker);
      if (s.index && index?.id === s.index && index.status === 'failed') {
        await publish(index.progress.error_code === INVALID_IGNORE
          ? `## Inkspect · Indexing failed\n\nThe \`.inkspectignore\` file on the default branch is invalid, so the repository was not indexed. Fix it, retry indexing in Inkspect, then request another review. See ${ignoreDocs}.`
          : '## Inkspect · Indexing failed\n\nRepository indexing did not finish. Retry indexing in Inkspect, then request another review.');
        return 30_000;
      }
      if (!index || !['queued', 'running'].includes(index.status)) {
        const check = services.eligibility(worker);
        if (!check.allowed) { await publish(`## Inkspect · Preparing repository\n\n${safeText(check.reason || 'Checking repository access.')}`); return check.support_required ? null : 15_000; }
        if (!s.index || (index && index.id !== s.index)) s.index = randomUUID();
        await save();
        await guard();
        if (!worker.automatic) return null;
        await services.admitIndex(row.organization_id, worker.subject, row.repository_id, s.index);
        index = await services.enqueueIndex(worker, s.index, worker.subject, false);
      }
      s.index = index.id; await save();
      const progress = index.progress;
      await publish(`## Inkspect · Indexing repository\n\nStage: **${safeText(progress.stage)}**\n\nFiles processed: ${progress.scan.processed}/${progress.scan.total} · Chunks embedded: ${progress.embedded}/${progress.chunks}\n\nReview will start when repository context is ready.`);
      return 10_000;
    }
    await publish(`## Inkspect · Review queued\n\nRepository index ready. Reviewing commit \`${s.head}\`.`);
    await guard();
    if (!worker.automatic) return null;
    // Freeze the notes before the first attempt: an uncertain admission retries
    // with the identical request, so the engine and billing deduplicate it.
    s.admitting = true; await save();
    try {
      job = await services.reviewLifecycle.start({ organizationId: row.organization_id, userId: worker.subject, member: { role: 'member' }, connections: [] },
        { repository_id: Number(row.repository_id), number: row.number, base_tip: s.base, head: s.head, ...(s.rerun ? { rerun_of: s.rerun } : {}),
          ...(s.notes?.length ? { review_notes: s.notes } : {}) }, claims, services.engineRequest);
      if (!job || !/^J-[a-f0-9]{32}$/.test(job.job.id)) throw new Error('Invalid review receipt');
      s.job = job.job.id; delete s.admitting; delete s.notes; await save();
    } catch (error) {
      if (error instanceof ReviewError && [400, 402, 403, 409].includes(error.status)) {
        delete s.admitting; await save();
        await publish(`## Inkspect · Review needs attention\n\nThe review could not start. ${services.admissionHelp}`);
        return 60_000;
      }
      throw error;
    }
  }
  if (!job) job = await send(`/jobs/${s.job}`);
  if (!job) throw new Error('Missing review job');
  for (const message of messages) if (message.state.requested && !message.state.done && !message.state.ignored) {
    message.state.job = s.job; await saveMessage(message);
  }
  await services.reviewLifecycle.settle(row.organization_id, job);
  if (job.job.status === 'completed') {
    const result = await send(`/jobs/${s.job}/report`) as ReportResponse;
    // Stored report reads do not contact GitHub and return `not_checked`.
    // Bind the report to this job and the live PR snapshot instead; deliver's
    // guard checks GitHub again immediately before each comment is written.
    if (job.job.id !== s.job || job.snapshot.repository_id !== row.repository_id ||
        job.snapshot.head !== current.head || job.snapshot.base_tip !== current.base ||
        result.report.run.target.repository_id !== row.repository_id || result.report.run.target.revision_id !== current.head ||
        result.report.run.id !== s.job || result.report.run.status !== 'completed' || result.report.run.freshness !== 'current') throw new Error('Report freshness not verified');
    await publish(reportBody(result.report));
    s.findings ??= {};
    const lines = await github.changedLines();
    for (const finding of result.report.findings) {
      const line = finding.location.start_line;
      // GitHub rejects comments outside a diff. Such findings remain fully
      // visible in the main report instead of being attached to the wrong line.
      if (!lines.get(finding.location.path)?.has(line)) continue;
      const delivery = s.findings[finding.id] ??= {};
      await github.deliver(delivery, `<!-- inkspect:finding:${row.id}:${s.job}:${finding.id} -->`, findingBody(result.report, finding.id), 'inline', save, guard,
        { commit_id: s.head, path: finding.location.path, line, side: 'RIGHT' });
    }
    s.published = s.job; await save();
    // One more pass completes acknowledgments and starts any waiting request.
    return deferred || messages.some(m => m.state.requested && !m.state.done && !m.state.ignored) ? 1000 : null;
  }
  if (terminal(job.job.status)) {
    // Rules come from the pull request's base, so the fix has to land there first.
    await publish(job.job.status === 'failed' && job.job.error_code === INVALID_IGNORE
      ? `## Inkspect · Review failed\n\nThe \`.inkspectignore\` file on the base branch is invalid, so the review did not run. Fix it on the base branch, update this pull request from that branch, then comment \`${reviewCommand}\`. See ${ignoreDocs}.`
      : `## Inkspect · Review ${job.job.status === 'cancelled' ? 'cancelled' : 'failed'}\n\nThe review did not finish. Check the [review in Inkspect](${link.href}), then comment \`${reviewCommand}\` to retry.`);
    return deferred || messages.some(m => m.state.requested && !m.state.done && !m.state.ignored) ? 1000 : null;
  }
  await publish(`## Inkspect · ${job.job.status === 'paused' ? services.pausedLabel : job.job.status === 'queued' ? 'Review queued' : 'Review in progress'}\n\nReviewing commit \`${s.head}\`.\n\nThe final report will replace this message.`);
  return 10_000;
}

async function bindingFor(tx: PoolClient, row: Workflow): Promise<Binding | undefined> {
  return (await tx.query<Binding>(`SELECT w.*,m."userId" AS subject,coalesce(s.automatic,true) AS automatic,coalesce(s.ignored_authors,'{}'::text[]) AS ignored_authors
    FROM api_repository_worker w JOIN "githubConnection" c ON c.id=w.connection_id AND c."organizationId"=w.organization_id AND c."installationId"=w.installation_id::text
    JOIN "githubRepositoryClaim" claim ON claim."organizationId"=w.organization_id AND claim."repositoryId"=w.repository_id
    JOIN member m ON m."organizationId"=w.organization_id AND m."userId"=claim."accountId"
    LEFT JOIN api_review_settings s ON s.organization_id=w.organization_id
    WHERE w.organization_id=$1 AND w.repository_id=$2 AND w.connection_id=$3 AND w.installation_id=$4
      AND coalesce(w.access_error,'') NOT IN ('revoked','access_unavailable')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.repositories::jsonb) r WHERE r->>'id'=w.repository_id AND lower(r->>'fullName')=lower(w.full_name))`,
  [row.organization_id, row.repository_id, row.connection_id, row.installation_id])).rows[0];
}

export async function processPullRequest(signal: AbortSignal, services: WorkflowServices, pool = database()) {
  const tx = await pool.connect();
  const abort = new AbortController();
  const lost = () => abort.abort(); tx.on('error', lost);
  let locked: string | undefined;
  try {
    const candidates = (await tx.query<Workflow>('SELECT * FROM api_pull_request_workflow WHERE next_run_at<=now() ORDER BY next_run_at LIMIT 20')).rows;
    for (const candidate of candidates) {
      const lock = `pr-workflow:${candidate.id}`;
      if (!(await tx.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lock])).rows[0].acquired) continue;
      locked = lock;
      const row = (await tx.query<Workflow>('SELECT * FROM api_pull_request_workflow WHERE id=$1 AND next_run_at<=now()', [candidate.id])).rows[0];
      if (!row) { await tx.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); locked = undefined; continue; }
      const started = (await tx.query('SELECT clock_timestamp() AS at')).rows[0].at;
      const save = async () => { await tx.query('UPDATE api_pull_request_workflow SET state=$2,updated_at=clock_timestamp() WHERE id=$1', [row.id, JSON.stringify(row.state)]); };
      let delay: number | null = 15_000;
      try {
        const worker = await bindingFor(tx, row);
        if (worker) {
          const guard = async () => {
            if (abort.signal.aborted || signal.aborted) throw new Error('Worker stopped');
            const live = await bindingFor(tx, row);
            if (!live || live.subject !== worker.subject) throw new Error('Repository connection changed');
            worker.automatic = live.automatic;
            worker.ignored_authors = live.ignored_authors;
          };
          const github = await PullGitHub.open(worker, row.number, AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120_000)]));
          const messages = (await tx.query<Message>(`SELECT * FROM api_pull_request_message WHERE workflow_id=$1 AND NOT coalesce((state->>'done')::boolean,false) AND NOT coalesce((state->>'ignored')::boolean,false) ORDER BY created_at LIMIT 50`, [row.id])).rows;
          const saveMessage = async (m: Message) => { await tx.query('UPDATE api_pull_request_message SET state=$4 WHERE workflow_id=$1 AND kind=$2 AND comment_id=$3', [row.id, m.kind, m.comment_id, JSON.stringify(m.state)]); };
          delay = await advancePull(row, worker, github, save, guard, messages, saveMessage, services);
          delete row.state.error;
        }
      } catch (error) {
        // No repository content, credentials, or private billing detail in logs.
        row.state.error = error instanceof ReviewError ? `review_${error.status}` : 'workflow_unavailable';
        console.error(JSON.stringify({ event: 'github.workflow_retry', workflow: row.id, code: row.state.error }));
        delay = 30_000;
      }
      await save();
      await tx.query(`UPDATE api_pull_request_workflow SET next_run_at=CASE WHEN wake_at>$2 THEN clock_timestamp()
        WHEN $3::integer IS NULL THEN NULL ELSE clock_timestamp()+$3*interval '1 millisecond' END WHERE id=$1`, [row.id, started, delay]);
      return true;
    }
    return false;
  } finally {
    if (locked) await tx.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [locked]).catch(() => abort.abort());
    tx.removeListener('error', lost); tx.release(abort.signal.aborted);
  }
}
