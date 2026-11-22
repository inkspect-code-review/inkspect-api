import { database } from './database';
import { loadJob, type EngineJob } from './engine-store';
import type { Worker } from './repository-store';
import { PullGitHub, type Delivery, type FindingThread } from './pull-request-github';
import { sameIssue } from './continuing-findings';
import { findingBody } from './pull-request-report';
import type { ReviewReport } from '@inkspect/core/lib/review-types';

type PriorFinding = { thread: string; path: string; title: string; reason: string; suggestion: string };
type Resolution = { thread: string; line: number; path: string; explanation: string };
export type FollowupReport = ReviewReport & { resolved_findings?: Resolution[] };
export type ResolutionDelivery = Delivery & { resolved?: boolean };
const sha = /^[a-f0-9]{40}$/;

// Read historical prose from scoped saved reports. A GitHub comment can be edited.
export async function priorFindings(job: EngineJob, worker: Worker, signal: AbortSignal): Promise<PriorFinding[]> {
  const result = await database().query<{id:string}>(`SELECT id FROM api_pull_request_workflow
    WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND installation_id=$4 AND number=$5`,
    [job.organization_id, job.repository_id, job.connection_id, job.installation_id, job.request.number]);
  if (!result.rows[0]) return [];
  const threads = await PullGitHub.readFindingHistory(worker, job.request.number, result.rows[0].id, signal);
  const prior: PriorFinding[] = [];
  const jobs = new Map<string, EngineJob | undefined>();
  for (const thread of threads) {
    if (!thread.originalHead || thread.originalHead === job.snapshot.head || !sha.test(thread.originalHead)) continue;
    if (!jobs.has(thread.job)) jobs.set(thread.job, await loadJob(worker, thread.job));
    const source = jobs.get(thread.job);
    if (source?.status !== 'completed' || source.request.number !== job.request.number || source.request.fix_of ||
        source.snapshot.head !== thread.originalHead || (source.snapshot.base_ref ? source.snapshot.base_ref !== job.snapshot.base_ref :
          source.snapshot.base_tip !== job.snapshot.base_tip)) continue;
    const f = source.report?.findings?.find((f: {id:string}) => f.id === thread.finding);
    if (f?.location?.path !== thread.path || Buffer.byteLength(thread.path) > 1024 ||
        ![f.title, f.reason, f.suggestion].every(v => typeof v === 'string') ||
        Buffer.byteLength(f.title + f.reason + f.suggestion) > 4096) continue;
    prior.push({ thread: String(thread.id), path: thread.path, title: f.title, reason: f.reason, suggestion: f.suggestion });
    if (prior.length === 20) break;
  }
  return prior;
}

// A PR diff includes earlier changes too. Confirm the cited line was actually
// added or replaced since the original finding, using the two immutable SHAs.
function addedLines(patch: string) {
  const result = new Set<number>();
  let next = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) next = Number(hunk[1]);
    else if (next && line.startsWith('+')) result.add(next++);
    else if (next && line.startsWith(' ')) next++;
  }
  return result;
}
function markdownText(value: string) {
  return value.trim().replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()<>~|@!#&]/g, c => '&#' + c.charCodeAt(0) + ';');
}

export async function publishResolutions(github: PullGitHub, report: FollowupReport, threads: FindingThread[],
  deliveries: Record<string, ResolutionDelivery>, save: () => Promise<void>, guard: () => Promise<void>) {
  const head = report.run.target.revision_id;
  if (!sha.test(head) || !report.run.coverage_complete || report.verification_gaps.length) return;
  const comparisons = new Map<string, Map<string, Set<number>>>();
  for (const resolution of report.resolved_findings ?? []) {
    const thread = threads.find(t => String(t.id) === resolution.thread);
    if (!thread?.nodeId || !thread.originalHead || !sha.test(thread.originalHead) || thread.originalHead === head ||
        thread.job === report.run.id || !Number.isSafeInteger(resolution.line) || resolution.line < 1 ||
        typeof resolution.explanation !== 'string' || !resolution.explanation.trim() || resolution.explanation.length > 800 ||
        report.findings.some(f => sameIssue(thread.body, findingBody(report, f.id)))) continue;
    const key = String(thread.id);
    const delivery = deliveries[key] ??= {};
    if (delivery.resolved) continue;
    if (!comparisons.has(thread.originalHead)) {
      const compare = await github.compareFindingRevisions(thread.originalHead, head);
      const files = new Map<string, Set<number>>();
      if (compare?.status === 'ahead' && compare.merge_base_commit?.sha === thread.originalHead) {
        for (const file of compare.files ?? []) {
          if (typeof file.patch === 'string') files.set(file.filename, addedLines(file.patch));
        }
      }
      comparisons.set(thread.originalHead, files);
    }
    if (!comparisons.get(thread.originalHead)?.get(resolution.path)?.has(resolution.line)) continue;
    const repo = github.root.slice('/repos/'.length);
    const path = resolution.path.split('/').map(part => encodeURIComponent(part).replaceAll('(', '%28').replaceAll(')', '%29')).join('/');
    const evidence = `https://github.com/${repo}/blob/${head}/${path}#L${resolution.line}`;
    const body = `Verified in \`${head.slice(0, 12)}\`. ${markdownText(resolution.explanation)}\n\n[View the reviewed change](${evidence})`;
    await guard();
    await github.deliver(delivery, `<!-- inkspect:resolution:${report.run.id}:${thread.id} -->`, body, 'inline', save, guard, { reply_to: thread.id });
    await guard();
    await github.resolveFindingThread(thread.nodeId);
    delivery.resolved = true;
    await save();
  }
}
