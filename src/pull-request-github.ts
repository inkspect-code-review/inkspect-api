import { repositoryAccess } from "./metadata";
import type { Worker } from "./repository-store";

import type { CheckThreshold } from "./review-settings";

export class GitHubFailure extends Error {
  constructor(public status: number) { super(`github_${status}`); }
}
export type Delivery = { id?: number; sending?: boolean; body?: string };
export class CheckUnavailable extends Error {}
export type CheckNotice = { title: string; summary: string };
export type ReviewCheck = { job: string; head: string; id?: number; attempt?: number; threshold?: CheckThreshold; phase?: CheckPhase | 'critical' };
export type CheckPhase = 'unavailable' | 'queued' | 'paused' | 'in_progress' | 'clean' | 'blocking' | 'incomplete' | 'failed' | 'cancelled';
const checkOutputs = {
  unavailable: ['Review unavailable', 'The review cannot proceed.'],
  queued: ['Review queued', 'Waiting for a review worker to start.'],
  paused: ['Review paused', 'The review is waiting to resume.'],
  in_progress: ['Review in progress', 'Inkspect is reviewing this commit.'],
  incomplete: ['Review incomplete', 'Inkspect could not verify a complete review of this commit.'],
  failed: ['Review failed', 'The review could not finish.'],
  cancelled: ['Review cancelled', 'Review of this revision stopped.'],
} as const;
export type PullSnapshot = { head: string; base: string; baseRef: string; open: boolean; draft: boolean; title?: string; author?: string };
type Comment = { id: number; body: string; user?: { type: string; login?: string }; performed_via_github_app?: { id: number }; issue_url?: string; in_reply_to_id?: number; path?: string; line?: number };

export type FindingThread = { id: number; nodeId?: string; originalHead?: string; outdated?: boolean; job: string; finding: string; path: string; line: number; body: string };
const threadQuery = `query FindingThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String, $history: Boolean!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated diffSide path line startLine originalLine originalStartLine
        comments(first: 1) { nodes { fullDatabaseId body originalCommit @include(if: $history) { oid } author { __typename login } replyTo { id } } }
      }
    }
  } }
}`;

export class PullGitHub {
  private constructor(private worker: Worker, private number: number, private token: string, private signal: AbortSignal, readonly checksEnabled: boolean, private appSlug?: string) {}
  static async open(worker: Worker, number: number, signal: AbortSignal, contents: boolean | "write" = false, reviewChecks = false) {
    const access = await repositoryAccess(worker, signal, contents, true, reviewChecks);
    return new PullGitHub(worker, number, access.token, signal, access.checks, access.appSlug);
  }
  get root() { return `/repos/${this.worker.full_name}`; }
  async request(path: string, method = 'GET', body?: object): Promise<any> {
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid GitHub path');
    return this.githubRequest(path, method, body);
  }
  private async githubRequest(path: string, method: string, body?: object): Promise<any> {
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: 'error',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Inkspect-API' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new GitHubFailure(response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty GitHub response');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('GitHub response too large'); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async updateCheck(check: ReviewCheck, phase: CheckPhase, details: string, guard: () => Promise<void>, notice?: CheckNotice) {
    const request = async (path: string, method = 'GET', payload?: object) => {
      try { return await this.request(path, method, payload); }
      catch (error) { throw new CheckUnavailable('GitHub check unavailable', { cause: error }); }
    };
    const name = 'Inkspect';
    const threshold = check.threshold ?? 'P0';
    const range = threshold === 'P0' ? 'P0' : `P0–${threshold}`;
    const [title, summary] = phase === 'blocking' ? ['Blocking findings', `The review found issues in the blocking range (${range}).`]
      : phase === 'clean' ? ['No blocking findings', `Review completed with no findings in the blocking range (${range}).`]
      : checkOutputs[phase];
    const externalId = check.attempt ? `${check.job}/${check.attempt}` : check.job;
    const conclusions = { unavailable: 'failure', clean: 'success', blocking: 'failure', incomplete: 'action_required', failed: 'failure', cancelled: 'cancelled' };
    const body = { external_id: externalId, details_url: details, output: notice ?? { title, summary },
      ...(phase === 'queued' ? { status: 'queued' } : phase === 'in_progress' || phase === 'paused' ? { status: 'in_progress' } : { status: 'completed', conclusion: conclusions[phase] }) };
    if (!check.id) {
      // The job ID is stable across worker restarts, including a lost POST receipt.
      const query = new URLSearchParams({ check_name: name, app_id: String(this.worker.app_id), filter: 'all', per_page: '100' });
      for (let page = 1; ; page++) {
        query.set('page', String(page));
        const { check_runs: runs } = await request(`${this.root}/commits/${check.head}/check-runs?${query}`);
        if (!Array.isArray(runs)) throw new Error('Invalid check list');
        const prior = runs.find(run => run.external_id === externalId && run.head_sha === check.head &&
          String(run.app?.id) === String(this.worker.app_id) && run.name === name);
        if (prior) {
          if (!Number.isSafeInteger(prior.id) || prior.id < 1) throw new Error('Invalid check receipt');
          check.id = prior.id;
          break;
        }
        if (runs.length < 100) break;
      }
    }
    await guard();
    if (check.id) {
      try { await request(`${this.root}/check-runs/${check.id}`, 'PATCH', body); }
      catch (error) {
        if (error instanceof CheckUnavailable && error.cause instanceof GitHubFailure && error.cause.status === 404) {
          delete check.id;
          delete check.phase;
        }
        throw error;
      }
    } else {
      const created = await request(`${this.root}/check-runs`, 'POST', { ...body, name, external_id: externalId, head_sha: check.head });
      if (!Number.isSafeInteger(created.id) || created.id < 1) throw new Error('Invalid check receipt');
      check.id = created.id;
    }
    check.phase = phase;
  }
  async snapshot(): Promise<PullSnapshot> {
    const pull = await this.request(`${this.root}/pulls/${this.number}`);
    if (pull.number !== this.number || String(pull.base?.repo?.id) !== this.worker.repository_id ||
        pull.base?.repo?.full_name?.toLowerCase() !== this.worker.full_name.toLowerCase() ||
        !/^[a-f0-9]{40}$/.test(pull.head?.sha) || !/^[a-f0-9]{40}$/.test(pull.base?.sha) || typeof pull.base.ref !== 'string' || !pull.base.ref || typeof pull.draft !== 'boolean') throw new Error('GitHub snapshot mismatch');
    return { head: pull.head.sha, base: pull.base.sha, baseRef: pull.base.ref, open: pull.state === 'open', draft: pull.draft,
      title: typeof pull.title === 'string' ? pull.title.trim() || undefined : undefined,
      author: typeof pull.user?.login === 'string' ? pull.user.login : undefined };
  }
  async eyes() { await this.request(`${this.root}/issues/${this.number}/reactions`, 'POST', { content: 'eyes' }); }
  async commentEyes(kind: 'issue' | 'inline', id: string) {
    await this.request(`${this.root}/${kind === 'issue' ? 'issues' : 'pulls'}/comments/${id}/reactions`, 'POST', { content: 'eyes' });
  }
  async canReview(sender: string) {
    const access = await this.request(`${this.root}/collaborators/${encodeURIComponent(sender)}/permission`);
    return ['admin', 'maintain', 'write'].includes(access.permission) || access.user?.permissions?.push === true;
  }
  owns(comment: Comment) {
    if (comment.user?.type !== 'Bot') return false;
    if (comment.performed_via_github_app) return String(comment.performed_via_github_app.id) === String(this.worker.app_id);
    // Inline comments may identify the installation's bot only by its account.
    return !!this.appSlug && comment.user.login?.toLowerCase() === `${this.appSlug}[bot]`;
  }
  async findingThreads(workflow: string, includeOutdated = false): Promise<FindingThread[]> {
    if (includeOutdated) return PullGitHub.readFindingHistory(this.worker, this.number, workflow, this.signal);
    return this.readThreads(workflow, false);
  }
  static async readFindingHistory(worker: Worker, number: number, workflow: string, signal: AbortSignal) {
    // Reading originalCommit requires contents:read even on a PR we can comment on.
    const access = await repositoryAccess(worker, signal, true, 'read');
    const reader = new PullGitHub(worker, number, access.token, signal, false, access.appSlug);
    return reader.readThreads(workflow, true);
  }
  private async readThreads(workflow: string, includeOutdated: boolean): Promise<FindingThread[]> {
    const [owner, repo] = this.worker.full_name.split('/');
    const threads: FindingThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.githubRequest('/graphql', 'POST', { query: threadQuery, variables: { owner, repo, number: this.number, cursor, history: includeOutdated } });
      const connection = result.data?.repository?.pullRequest?.reviewThreads;
      if (result.errors?.some((e: { type?: string }) => e.type === 'FORBIDDEN')) throw new GitHubFailure(403);
      if (result.errors?.length || !Array.isArray(connection?.nodes)) throw new Error('Cannot read PR finding threads');
      for (const thread of connection.nodes) {
        const root = thread.comments.nodes[0];
        // Continuing findings are matched on their first line, including older single-line comments.
        const line = thread.isOutdated ? thread.originalStartLine ?? thread.originalLine : thread.startLine ?? thread.line;
        if (thread.isResolved || (thread.isOutdated && !includeOutdated) || thread.diffSide !== 'RIGHT' || !Number.isInteger(line) ||
            !root || root.replyTo || root.author?.__typename !== 'Bot' || !this.appSlug || root.author.login.toLowerCase().replace(/\[bot\]$/, '') !== this.appSlug) continue;
        const marker = /^<!-- inkspect:finding:([^:\s]+):([^:\s]+):([^:\s]+) -->\r?\n/.exec(root.body);
        const id = Number(root.fullDatabaseId);
        if (marker?.[1] === workflow && Number.isSafeInteger(id) && id > 0) {
          threads.push({ id, nodeId: thread.id, originalHead: root.originalCommit?.oid, outdated: thread.isOutdated, job: marker[2], finding: marker[3], path: thread.path, line, body: root.body.slice(marker[0].length) });
        }
      }
      if (!connection.pageInfo.hasNextPage) return threads.sort((a, b) => a.id - b.id);
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) throw new Error('Invalid thread cursor');
      cursor = connection.pageInfo.endCursor;
    }
    throw new Error('GitHub thread pagination limit');
  }
  private comparisonClient?: PullGitHub;
  async compareFindingRevisions(before: string, head: string) {
    if (!this.comparisonClient) {
      const access = await repositoryAccess(this.worker, this.signal, true, false);
      this.comparisonClient = new PullGitHub(this.worker, this.number, access.token, this.signal, false);
    }
    try {
      return await this.comparisonClient.request(`${this.root}/compare/${before}...${head}`);
    } catch (error) {
      if (error instanceof GitHubFailure && [404, 409, 422].includes(error.status)) return null;
      throw error;
    }
  }
  async resolveFindingThread(nodeId: string) {
    const result = await this.githubRequest('/graphql', 'POST', {
      query: 'mutation ResolveFinding($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }',
      variables: { thread: nodeId },
    });
    const thread = result.data?.resolveReviewThread?.thread;
    if (result.errors?.length || thread?.id !== nodeId || thread.isResolved !== true) throw new Error('Cannot confirm finding resolution');
  }
  async list(path: string): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('Invalid GitHub list');
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error('GitHub pagination limit');
  }
  async inlineParent(id: number) {
    const rows: Comment[] = await this.list(`${this.root}/pulls/${this.number}/comments`);
    return rows.find(row => row.id === id && this.owns(row));
  }
  // The send intent is durable before POST. After a lost response, recover only
  // an app-owned marker on this PR. An uncertain POST is never blindly repeated.
  async deliver(delivery: Delivery, marker: string, body: string, kind: 'issue' | 'inline',
    save: () => Promise<void>, guard: () => Promise<void>, extra: Record<string, unknown> = {},
    mode: 'update' | 'first-resolution' = 'update') {
    const listPath = `${this.root}/${kind === 'issue' ? 'issues' : 'pulls'}/${this.number}/comments`;
    const itemPath = `${this.root}/${kind === 'issue' ? 'issues' : 'pulls'}/comments`;
    // A verification reply records the first review that confirmed the repair.
    // Later jobs may retry the resolve mutation but must preserve that evidence.
    const once = mode === 'first-resolution';
    if (once && (kind !== 'inline' || !Number.isSafeInteger(extra.reply_to))) throw new Error('Missing resolution thread');
    if (once && delivery.id) return;
    if (!delivery.id) {
      const rows: Comment[] = await this.list(listPath);
      const old = rows.find(row => {
        if (!this.owns(row)) return false;
        if (!once) return row.body?.startsWith(marker + '\n');
        const match = /^<!-- inkspect:resolution:[^:\s]+:(\d+) -->\r?\n/.exec(row.body);
        return row.in_reply_to_id === extra.reply_to && match?.[1] === String(extra.reply_to);
      });
      if (old) {
        delivery.id = old.id; delivery.body = old.body; delivery.sending = false; await save();
        if (once) return;
      } else if (delivery.sending) throw new Error('comment_creation_uncertain');
    }
    const content = `${marker}\n${body}`;
    if (delivery.id) {
      if (delivery.body === content) return;
      let old: Comment | undefined;
      try { old = await this.request(`${itemPath}/${delivery.id}`); }
      catch (error) {
        if (!(error instanceof GitHubFailure) || error.status !== 404) throw error;
        // A deleted comment must not permanently block this PR's workflow.
        // Persist the reset before the normal guarded creation path below.
        delete delivery.id; delete delivery.body; delivery.sending = false;
        await save();
      }
      if (old) {
        if (!this.owns(old) || !old.body?.startsWith(marker + '\n')) throw new Error('Comment ownership mismatch');
        await guard();
        await this.request(`${itemPath}/${delivery.id}`, 'PATCH', { body: content });
      }
    }
    if (!delivery.id) {
      await guard();
      delivery.sending = true; await save();
      let created: Comment;
      try {
        const { reply_to, ...fields } = extra;
        created = await this.request(reply_to ? `${listPath}/${reply_to}/replies` : listPath, 'POST', { body: content, ...fields });
      } catch (error) {
        // A definitive rejection cannot have created a comment. Network/5xx
        // outcomes stay uncertain and are reconciled by marker on the next run.
        if (error instanceof GitHubFailure && [401, 403, 404, 422, 429].includes(error.status)) { delivery.sending = false; await save(); }
        throw error;
      }
      if (!Number.isSafeInteger(created.id) || created.id < 1) throw new Error('Invalid comment receipt');
      delivery.id = created.id; delivery.sending = false;
    }
    delivery.body = content; await save();
  }
  async changedLines() {
    const files = await this.list(`${this.root}/pulls/${this.number}/files`);
    return new Map<string, Set<number>>(files.map(file => [file.filename, patchRightLines(file.patch || '')]));
  }
}

export function patchRightLines(patch: string) {
  const lines = new Set<number>(); let right = 0; let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { right = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || line.startsWith('\\') || line.startsWith('-')) continue;
    if (line.startsWith('+') || line.startsWith(' ')) { lines.add(right); right++; }
  }
  return lines;
}

// GitHub anchors single-line comments with line, and multiline comments with
// both ends on the same side of the diff. Keep unanchorable ranges in the summary.
export function findingAnchor(lines: Set<number> | undefined, location: { start_line: number; end_line?: number }) {
  const start = location.start_line;
  const end = location.end_line ?? start;
  if (!lines || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= lines.size) return;
  for (let line = start; line <= end; line++) if (!lines.has(line)) return;
  return start === end ? { line: end, side: 'RIGHT' } : { start_line: start, start_side: 'RIGHT', line: end, side: 'RIGHT' };
}
