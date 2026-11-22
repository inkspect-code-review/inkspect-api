import { matchingGithubReview } from './github-check-reconciliation';
import { publishResolutions, type FollowupReport, type ResolutionDelivery } from './finding-followup';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { engineRequest } from "@inkspect/core/lib/engine-client";
import type { ReviewLifecycle } from "@inkspect/core/lib/review-lifecycle";
import { admitIndex } from "@inkspect/core/lib/repository-store";
import { ReviewError } from "@inkspect/core/lib/review-access";
import type { ReportResponse, ReviewJob } from "@inkspect/core/lib/review-types";
import { database } from "./database";
import { eligibility, enqueueIndex, lastIndexed, latestIndex, type Worker } from "./repository-store";
import { CheckUnavailable, findingAnchor, PullGitHub, type CheckNotice, type Delivery, type ReviewCheck, type CheckPhase } from "./pull-request-github";
import { overviewSeverity, overviewSeverities } from "@inkspect/core/lib/review-overview";
import { originalThread, linkedFindingSummary } from "./continuing-findings";
import { findingBody, reportBody, safeText } from "./pull-request-report";
import { INVALID_IGNORE } from "./engine-contract";
import { appLogin } from "./pull-request-events";
import { isIgnoredAuthor, checkThresholds, type CheckThreshold } from "./review-settings";

const ignoreDocs = '[how `.inkspectignore` works](https://inkspect.si/inkspectignore)';

export type ReviewNote = { author: string; body: string };
// notes: participant requests for the next admission, frozen while admitting.
// published: the completed job whose report is already on the pull request.
export type WorkflowState = { head?: string; base?: string; index?: string; job?: string; rerun?: string; stopped?: boolean;
  check?: ReviewCheck; eyes?: boolean; summary?: Delivery; findings?: Record<string, Delivery & { continued?: number }>; error?: string;
  resolutions?: Record<string, ResolutionDelivery>; resolutionJob?: string;
  lastCheckDelivery?: string; reuseCheck?: boolean; notes?: ReviewNote[]; admitting?: boolean; published?: string };
export type Workflow = { id: string; organization_id: string; repository_id: string; connection_id: string;
  installation_id: string; number: number; github_rerequest?: { delivery: string; check: number; head: string; base: string; sender: string }; state: WorkflowState };
type Binding = Worker & { subject: string; automatic: boolean; check_threshold?: CheckThreshold; ignored_authors?: string[] };
type Message = { comment_id: string; kind: 'issue' | 'inline'; sender: string; intent: 'review' | 'explain'; reply_to: string | null;
  note?: string | null; state: { ignored?: boolean; eyes?: boolean; requested?: boolean; job?: string; done?: boolean; delivery?: Delivery } };
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
// Mirrors the engine's bounds: at most five notes and 2000 bytes per review.
const fitsNotes = (notes: ReviewNote[], note: ReviewNote) =>
  notes.length < 5 && [...notes, note].reduce((size, n) => size + Buffer.byteLength(n.body), 0) <= 2000;

const commonServices = { engineRequest, admitIndex, eligibility, enqueueIndex, lastIndexed, latestIndex };
export type WorkflowServices = typeof commonServices & { reviewLifecycle: ReviewLifecycle; pausedLabel: string; admissionHelp: string;
  matchingReview?: (row: Workflow, head: string, base: string, baseRef: string, rerequest: boolean) => Promise<string | undefined>;
  admissionBlock?: (error: unknown) => CheckNotice | undefined;
  waitingBlock?: (row: Workflow, job: ReviewJob) => Promise<CheckNotice | undefined>;
};
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
  const reviewLink = (job?: string) => {
    const link = new URL('/dashboard', process.env.BETTER_AUTH_URL || 'https://app.inkspect.si');
    link.search = new URLSearchParams({ view: 'reviews', repositoryId: row.repository_id, ...(job ? { jobId: job } : {}) }).toString();
    return link.href;
  };
  const syncCheck = async (check: ReviewCheck, phase: CheckPhase, validate: () => Promise<void>, notice?: CheckNotice) => {
    if (!github.checksEnabled || check.phase === phase) return;
    // A completed check stays in history when the same job resumes.
    if (check.phase === 'unavailable' && ['queued', 'paused', 'in_progress'].includes(phase)) {
      check.attempt = (check.attempt ?? 0) + 1;
      delete check.id;
      delete check.phase;
      await save();
    }
    await github.updateCheck(check, phase, reviewLink(check.job.startsWith('J-') ? check.job : undefined), validate, notice);
    await save();
  };
  const blockedCheck = async (identity: string, notice: CheckNotice) => {
    if (s.check?.job !== identity) {
      const previous = s.reuseCheck && s.check?.head === current.head ? s.check : undefined;
      s.check = { job: identity, head: current.head, threshold: previous?.threshold ?? worker.check_threshold ?? 'P0', id: previous?.id };
      await save();
    }
    try { await syncCheck(s.check, 'unavailable', guard, notice); }
    catch (error) { if (!(error instanceof CheckUnavailable)) throw error; }
    await publish(`## Inkspect · ${notice.title}\n\n${notice.summary}`);
    return 60_000;
  };
  const stopCheck = async () => {
    if (s.check && (!s.check.phase || ['queued', 'paused', 'in_progress'].includes(s.check.phase))) await syncCheck(s.check, 'cancelled', guardBinding);
  };
  if (isIgnoredAuthor(current.author, worker.ignored_authors)) {
    await stopCheck();
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
    if (live.head !== current.head || live.base !== current.base || live.baseRef !== current.baseRef || live.open !== current.open || live.draft !== current.draft) throw new Error('Pull request changed');
  };
  const publish = async (body: string) => {
    s.summary ??= {};
    await github.deliver(s.summary, marker, body, 'issue', save, guard);
  };
  if (!current.open || current.draft) {
    await stopCheck();
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
    await stopCheck();
    if (!worker.automatic) return null;
    if (s.job) {
      const old = await send(`/jobs/${s.job}`) as ReviewJob;
      if (!terminal(old.job.status)) await send(`/jobs/${s.job}/cancel`, 'POST', {});
      await services.reviewLifecycle.settle(row.organization_id, old);
    }
    // Notes that have not reached a review yet apply to the new commit's review.
    s.head = current.head; s.base = current.base; delete s.job; delete s.rerun; delete s.index; s.findings = {}; delete s.error;
    delete s.admitting; delete s.published; delete s.reuseCheck;
    await save();
  }
  if (!s.eyes) { await guard(); await github.eyes(); s.eyes = true; await save(); }
  if (!s.summary?.id) await publish(`## Inkspect · Review queued\n\n👀 Preparing repository context for commit \`${s.head}\`.`);
  let job: ReviewJob | undefined = s.job ? await send(`/jobs/${s.job}`) : undefined;
  const requested = row.github_rerequest;
  const rerequest = !!(requested && requested.delivery !== s.lastCheckDelivery && requested.head === current.head && requested.base === current.base &&
    requested.check === s.check?.id && worker.automatic && await github.canReview(requested.sender));
  if (s.check?.head === current.head && (s.job || rerequest || (!s.rerun && !s.notes?.length)) && !s.admitting) {
    const matching = await services.matchingReview?.(row, current.head, current.base, current.baseRef, rerequest);
    if (matching && matching !== s.job) {
      const replacement: ReviewJob = await send(`/jobs/${matching}`);
      if (replacement.job.id !== matching || replacement.snapshot.head !== current.head ||
          replacement.snapshot.base_tip !== current.base || replacement.snapshot.repository_id !== row.repository_id)
        throw new Error('Review reconciliation scope mismatch');
      job = replacement; s.job = matching; s.findings = {}; delete s.published;
      s.reuseCheck = true;
    }
    if (rerequest && requested) {
      s.lastCheckDelivery = requested.delivery;
      delete s.check.phase;
      if (job && ['failed', 'cancelled'].includes(job.job.status)) {
        s.rerun = job.job.id; delete s.job; job = undefined; s.findings = {};
      }
      s.reuseCheck = true;
    }
    if (rerequest || matching && s.reuseCheck) await save();
  }
  if (s.stopped && worker.automatic) {
    if (job && ['cancelled', 'failed'].includes(job.job.status)) {
      await stopCheck();
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
      const explanation = parent?.body?.replace(/^<!--[^\n]*-->\n/, '').split(/\n\n(?:Reply “fixed”|Comment `@|New pushes trigger an automatic review)/)[0];
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
        await stopCheck();
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
    const admissionCheck = `admission/${row.id}/${current.head}/${current.base}/${s.rerun ?? 'first'}`;
    if (s.check?.job !== admissionCheck) await publish(`## Inkspect · Review queued\n\nRepository index ready. Reviewing commit \`${s.head}\`.`);
    await guard();
    if (!worker.automatic) return null;
    // Freeze the notes before the first attempt: an uncertain admission retries
    // with the identical request, so the engine and billing deduplicate it.
    s.admitting = true; await save();
    try {
      job = await services.reviewLifecycle.start({ organizationId: row.organization_id, userId: worker.subject, member: { role: 'member' }, connections: [] },
        { repository_id: Number(row.repository_id), number: row.number, base_tip: s.base, head: s.head, ...(s.rerun ? (s.reuseCheck ? { retry_of: s.rerun } : { rerun_of: s.rerun }) : {}),
          ...(s.notes?.length ? { review_notes: s.notes } : {}) }, claims, services.engineRequest);
      if (!job || !/^J-[a-f0-9]{32}$/.test(job.job.id)) throw new Error('Invalid review receipt');
      s.job = job.job.id; delete s.admitting; delete s.notes; await save();
    } catch (error) {
      if (error instanceof ReviewError && [400, 402, 403, 409].includes(error.status)) {
        delete s.admitting; await save();
        const block = services.admissionBlock?.(error);
        if (block) return blockedCheck(admissionCheck, block);
        await publish(`## Inkspect · Review needs attention\n\nThe review could not start. ${services.admissionHelp}`);
        return 60_000;
      }
      throw error;
    }
  }
  if (!job) job = await send(`/jobs/${s.job}`);
  if (!job) throw new Error('Missing review job');
  // Each check keeps its original policy across polling, retries and later settings edits.
  // Receipts from before configurable thresholds used P0.
  const threshold = s.check && (s.check.job === s.job || s.reuseCheck) ? s.check.threshold ?? 'P0' : worker.check_threshold ?? 'P0';
  let retryCheck = false;
  const reviewCheck = async (phase: CheckPhase) => {
    if (!github.checksEnabled) return;
    if (!s.job || job?.job.id !== s.job || s.head !== current.head || s.base !== current.base) throw new Error('Review check target mismatch');
    if (s.check?.job !== s.job) {
      s.check = { job: s.job, head: current.head, threshold,
        ...(s.reuseCheck && s.check?.head === current.head ? { id: s.check.id } : {}) };
      await save();
    }
    delete s.reuseCheck;
    try { await syncCheck(s.check, phase, guard); }
    catch (error) {
      if (!(error instanceof CheckUnavailable)) throw error;
      // Comment delivery and settlement can proceed while the Checks API retries.
      retryCheck = true;
      console.error(JSON.stringify({ event: 'github.check_retry', workflow: row.id }));
    }
  };
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
        result.report.run.id !== s.job || result.report.run.status !== 'completed' || result.report.run.freshness !== 'current') {
      if (job.job.id === s.job) await reviewCheck('incomplete');
      throw new Error('Report freshness not verified');
    }
    const cutoff = checkThresholds.indexOf(threshold);
    const blocking = result.report.findings.some(finding => overviewSeverities.indexOf(overviewSeverity(finding.severity)) <= cutoff);
    const complete = result.report.run.coverage_complete && !result.report.verification_gaps.some(gap => gap.blocking);
    await reviewCheck(blocking ? 'blocking' : complete ? 'clean' : 'incomplete');
    const report = reportBody(result.report);
    const deliveries = s.findings ??= {};
    const lines = await github.changedLines();
    const inline = result.report.findings.flatMap(finding => {
      const anchor = findingAnchor(lines.get(finding.location.path), finding.location);
      return anchor ? [{ finding, anchor }] : [];
    });
    const pending = inline.filter(({ finding }) => !deliveries[finding.id]);
    const followup: FollowupReport = result.report;
    const resolving = complete && (followup.resolved_findings?.length ?? 0) > 0 &&
      (job.snapshot as { base_ref?: string }).base_ref === current.baseRef && !!current.baseRef;
    const threads = pending.length || resolving ? await github.findingThreads(row.id, resolving) : [];
    const usedThreads = new Set(Object.values(deliveries).map(delivery => delivery.continued));
    for (const { finding } of inline) {
      if (!deliveries[finding.id]) {
        const prior = originalThread(threads.filter(thread => !usedThreads.has(thread.id)), job.job.id, finding, findingBody(result.report, finding.id));
        if (prior) usedThreads.add(prior.id);
        deliveries[finding.id] = prior ? { continued: prior.id } : {};
      }
    }
    // Freeze the publication plan before the first write. Replaying this job
    // must not create a new comment if someone subsequently resolves a thread.
    if (pending.length) await save();
    try {
      for (const { finding, anchor } of inline) {
        const delivery = deliveries[finding.id];
        if (delivery.continued) continue;
        await github.deliver(delivery, `<!-- inkspect:finding:${row.id}:${s.job}:${finding.id} -->`, findingBody(result.report, finding.id), 'inline', save, guard,
          { commit_id: s.head, path: finding.location.path, ...anchor });
      }
    } finally {
      // Link only confirmed deliveries. On a rejected/uncertain inline post
      // the summary still contains the full finding while the worker retries.
      await publish(linkedFindingSummary(report, result.report.findings, deliveries,
        `https://github.com/${worker.full_name}/pull/${row.number}`, result.report.presentation?.github_findings ?? {}));
    }
    if (resolving) {
      if (s.resolutionJob !== s.job) {
        s.resolutionJob = s.job;
        // Keep pending sends across pushes, especially if GitHub lost the POST response.
        s.resolutions = Object.fromEntries(Object.entries(s.resolutions ?? {}).filter(([, d]) => !d.resolved));
      }
      await publishResolutions(github, followup, threads, s.resolutions ??= {}, save, guard);
    }
    s.published = s.job; await save();
    // One more pass completes acknowledgments and starts any waiting request.
    return deferred || messages.some(m => m.state.requested && !m.state.done && !m.state.ignored) ? 1000 : retryCheck ? 30_000 : null;
  }
  if (terminal(job.job.status)) {
    await reviewCheck(job.job.status === 'cancelled' ? 'cancelled' : 'failed');
    // Rules come from the pull request's base, so the fix has to land there first.
    await publish(job.job.status === 'failed' && job.job.error_code === INVALID_IGNORE
      ? `## Inkspect · Review failed\n\nThe \`.inkspectignore\` file on the base branch is invalid, so the review did not run. Fix it on the base branch, update this pull request from that branch, then comment \`${reviewCommand}\`. See ${ignoreDocs}.`
      : `## Inkspect · Review ${job.job.status === 'cancelled' ? 'cancelled' : 'failed'}\n\nThe review did not finish. Check the [review in Inkspect](${reviewLink(s.job)}), then comment \`${reviewCommand}\` to retry.`);
    return deferred || messages.some(m => m.state.requested && !m.state.done && !m.state.ignored) ? 1000 : retryCheck ? 30_000 : null;
  }
  if (job.job.status === 'queued' || job.job.status === 'paused') {
    const block = await services.waitingBlock?.(row, job);
    if (block) {
      if (job.job.id !== s.job || job.snapshot.head !== current.head || job.snapshot.repository_id !== row.repository_id || job.snapshot.base_tip !== current.base) throw new Error('Review check target mismatch');
      return blockedCheck(job.job.id, block);
    }
  }
  await reviewCheck(job.job.status === 'queued' || job.job.status === 'paused' ? job.job.status : 'in_progress');
  await publish(`## Inkspect · ${job.job.status === 'paused' ? services.pausedLabel : job.job.status === 'queued' ? 'Review queued' : 'Review in progress'}\n\nCommit \`${s.head}\`.\n\nThe final report will replace this message.`);
  return 10_000;
}

async function bindingFor(tx: PoolClient, row: Workflow): Promise<Binding | undefined> {
  return (await tx.query<Binding>(`SELECT w.*,m."userId" AS subject,coalesce(s.automatic,true) AS automatic,coalesce(s.check_threshold,'P0') AS check_threshold,coalesce(s.ignored_authors,'{}'::text[]) AS ignored_authors
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
      const started = (await tx.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
      const row = (await tx.query<Workflow>('SELECT * FROM api_pull_request_workflow WHERE id=$1 AND next_run_at<=now()', [candidate.id])).rows[0];
      if (!row) { await tx.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); locked = undefined; continue; }
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
            worker.check_threshold = live.check_threshold;
            worker.ignored_authors = live.ignored_authors;
          };
          const github = await PullGitHub.open(worker, row.number, AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120_000)]), false, true);
          const messages = (await tx.query<Message>(`SELECT * FROM api_pull_request_message WHERE workflow_id=$1 AND NOT coalesce((state->>'done')::boolean,false) AND NOT coalesce((state->>'ignored')::boolean,false) ORDER BY created_at LIMIT 50`, [row.id])).rows;
          const saveMessage = async (m: Message) => { await tx.query('UPDATE api_pull_request_message SET state=$4 WHERE workflow_id=$1 AND kind=$2 AND comment_id=$3', [row.id, m.kind, m.comment_id, JSON.stringify(m.state)]); };
          delay = await advancePull(row, worker, github, save, guard, messages, saveMessage, { ...services,
            matchingReview: (scope, head, base, baseRef, rerequest) => matchingGithubReview(tx, scope, head, base, baseRef, rerequest),
          });
          if (row.github_rerequest) {
            await tx.query('UPDATE api_pull_request_workflow SET github_rerequest=NULL WHERE id=$1 AND github_rerequest=$2',
              [row.id, row.github_rerequest]);
          }
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
