import { repositoryAccess } from "./metadata";
import type { Worker } from "./repository-store";

import type { CheckThreshold } from "./review-settings";

export class GitHubFailure extends Error {
  constructor(public status: number) { super(`github_${status}`); }
}
export type Delivery = { id?: number; sending?: boolean; body?: string };
export class CheckUnavailable extends Error {}
export type ReviewCheck = { job: string; head: string; id?: number; threshold?: CheckThreshold; phase?: CheckPhase | 'critical' };
export type CheckPhase = 'in_progress' | 'clean' | 'blocking' | 'incomplete' | 'failed' | 'cancelled';
const checkOutputs = {
  in_progress: ['Review in progress', 'Inkspect is reviewing this commit.'],
  incomplete: ['Review incomplete', 'Inkspect could not verify a complete review of this commit.'],
  failed: ['Review failed', 'The review could not finish.'],
  cancelled: ['Review cancelled', 'Review of this revision stopped.'],
} as const;
export type PullSnapshot = { head: string; base: string; open: boolean; draft: boolean; author?: string };
type Comment = { id: number; body: string; user?: { type: string; login?: string }; performed_via_github_app?: { id: number }; issue_url?: string; in_reply_to_id?: number; path?: string; line?: number };

export type FindingThread = { id: number; job: string; finding: string; path: string; line: number; body: string };
const threadQuery = `query FindingThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { isResolved isOutdated diffSide path line
        comments(first: 1) { nodes { fullDatabaseId body author { __typename login } replyTo { id } } }
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
  async updateCheck(check: ReviewCheck, phase: CheckPhase, details: string, guard: () => Promise<void>) {
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
    const conclusions = { clean: 'success', blocking: 'failure', incomplete: 'action_required', failed: 'failure', cancelled: 'cancelled' };
    const body = { details_url: details, output: { title, summary },
      ...(phase === 'in_progress' ? { status: 'in_progress' } : { status: 'completed', conclusion: conclusions[phase] }) };
    if (!check.id) {
      // The job ID is stable across worker restarts, including a lost POST receipt.
      const query = new URLSearchParams({ check_name: name, app_id: String(this.worker.app_id), filter: 'all', per_page: '100' });
      for (let page = 1; ; page++) {
        query.set('page', String(page));
        const { check_runs: runs } = await request(`${this.root}/commits/${check.head}/check-runs?${query}`);
        if (!Array.isArray(runs)) throw new Error('Invalid check list');
        const prior = runs.find(run => run.external_id === check.job && run.head_sha === check.head &&
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
      const created = await request(`${this.root}/check-runs`, 'POST', { ...body, name, external_id: check.job, head_sha: check.head });
      if (!Number.isSafeInteger(created.id) || created.id < 1) throw new Error('Invalid check receipt');
      check.id = created.id;
    }
    check.phase = phase;
  }
  async snapshot(): Promise<PullSnapshot> {
    const pull = await this.request(`${this.root}/pulls/${this.number}`);
    if (pull.number !== this.number || String(pull.base?.repo?.id) !== this.worker.repository_id ||
        pull.base?.repo?.full_name?.toLowerCase() !== this.worker.full_name.toLowerCase() ||
        !/^[a-f0-9]{40}$/.test(pull.head?.sha) || !/^[a-f0-9]{40}$/.test(pull.base?.sha) || typeof pull.draft !== 'boolean') throw new Error('GitHub snapshot mismatch');
    return { head: pull.head.sha, base: pull.base.sha, open: pull.state === 'open', draft: pull.draft,
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
  async findingThreads(workflow: string): Promise<FindingThread[]> {
    const [owner, repo] = this.worker.full_name.split('/');
    const threads: FindingThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.githubRequest('/graphql', 'POST', { query: threadQuery, variables: { owner, repo, number: this.number, cursor } });
      const connection = result.data?.repository?.pullRequest?.reviewThreads;
      if (result.errors?.length || !Array.isArray(connection?.nodes)) throw new Error('Cannot read PR finding threads');
      for (const thread of connection.nodes) {
        const root = thread.comments.nodes[0];
        if (thread.isResolved || thread.isOutdated || thread.diffSide !== 'RIGHT' || !Number.isInteger(thread.line) ||
            !root || root.replyTo || root.author?.__typename !== 'Bot' || !this.appSlug || root.author.login.toLowerCase() !== this.appSlug) continue;
        const marker = /^<!-- inkspect:finding:([^:\s]+):([^:\s]+):([^:\s]+) -->\r?\n/.exec(root.body);
        const id = Number(root.fullDatabaseId);
        if (marker?.[1] === workflow && Number.isSafeInteger(id) && id > 0) {
          threads.push({ id, job: marker[2], finding: marker[3], path: thread.path, line: thread.line, body: root.body.slice(marker[0].length) });
        }
      }
      if (!connection.pageInfo.hasNextPage) return threads.sort((a, b) => a.id - b.id);
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) throw new Error('Invalid thread cursor');
      cursor = connection.pageInfo.endCursor;
    }
    throw new Error('GitHub thread pagination limit');
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
    save: () => Promise<void>, guard: () => Promise<void>, extra: Record<string, unknown> = {}) {
    const listPath = `${this.root}/${kind === 'issue' ? 'issues' : 'pulls'}/${this.number}/comments`;
    const itemPath = `${this.root}/${kind === 'issue' ? 'issues' : 'pulls'}/comments`;
    if (!delivery.id) {
      const rows: Comment[] = await this.list(listPath);
      const old = rows.find(row => this.owns(row) && row.body?.startsWith(marker + '\n'));
      if (old) { delivery.id = old.id; delivery.body = old.body; delivery.sending = false; await save(); }
      else if (delivery.sending) throw new Error('comment_creation_uncertain');
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
