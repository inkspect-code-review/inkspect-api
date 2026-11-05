import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PullGitHub, type Delivery, type ReviewCheck } from "../../src/pull-request-github";
import type { Worker } from "../../src/repository-store";

test('GitHub comment delivery recovers an ambiguous POST, reuses its ID and refuses foreign comments', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'inkspect-comment-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const privateKey = join(directory, 'test.pem');
  await writeFile(privateKey, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const worker: Worker = { organization_id: 'org', repository_id: '17', connection_id: 'c', installation_id: '44', full_name: 'team/repo', queue_database: 'app', queue_schema: 'queue', app_id: '1', private_key_file: privateKey, size_bytes: '100', access_verified_at: new Date(), access_error: null };
  const marker = '<!-- inkspect:pr:unique -->';
  let granted = false, expectChecks = false;
  let posts = 0, patches = 0, drop = true, foreign = false;
  let comment: Record<string, unknown> | undefined;
  const saved: Delivery = {};
  const reactions: string[] = [];
  let state: Delivery = {};
  const save = async () => { Object.assign(saved, structuredClone(state)); };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/installation')) return Response.json({ id: 44, app_id: 1, permissions: { checks: granted ? 'write' : 'read' } });
    if (path.endsWith('/access_tokens')) {
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(payload.permissions, { metadata: 'read', pull_requests: 'write', ...(expectChecks ? { checks: 'write' } : {}) });
      assert.deepEqual(payload.repository_ids, [17]);
      return Response.json({ token: 'test-only-token', repositories: [{ id: 17 }] });
    }
    if (path.endsWith('/pulls/1')) return Response.json({number:1,state:'open',draft:false,user:{login:'dependabot[bot]'},head:{sha:'b'.repeat(40)},base:{sha:'a'.repeat(40),repo:{id:17,full_name:'team/repo'}}});
    if (['/repos/team/repo/issues/comments/123/reactions', '/repos/team/repo/pulls/comments/456/reactions'].includes(path)) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), { content: 'eyes' });
      reactions.push(path);
      return Response.json({ id: 1 }, { status: reactions.length === 1 ? 201 : 200 });
    }
    if (path.endsWith('/issues/1/comments') && init.method === 'GET') return Response.json(comment ? [comment] : []);
    if (path.endsWith('/issues/1/comments') && init.method === 'POST') {
      posts++; assert.equal(saved.sending, true);
      comment = { id: 110 + posts, body: JSON.parse(String(init.body)).body, user: { type: 'Bot' }, performed_via_github_app: { id: 1 } };
      if (drop) throw new Error('connection lost after GitHub saved the comment');
      return Response.json(comment);
    }
    if (path.endsWith('/issues/comments/111') && init.method === 'GET') return comment ? Response.json({ ...comment, ...(foreign ? { performed_via_github_app: { id: 99 } } : {}) }) : Response.json({ message: 'Not Found' }, { status: 404 });
    if (path.endsWith('/issues/comments/111') && init.method === 'PATCH') { patches++; comment!.body = JSON.parse(String(init.body)).body; return Response.json(comment); }
    throw new Error(`Unexpected request ${init.method} ${path}`);
  });
  try {
    const signal = new AbortController().signal;
    assert.equal((await PullGitHub.open(worker, 1, signal, false, true)).checksEnabled, false);
    granted = true; expectChecks = true;
    assert.equal((await PullGitHub.open(worker, 1, signal, false, true)).checksEnabled, true);
    expectChecks = false;
    const github = await PullGitHub.open(worker, 1, signal);
    assert.equal(github.checksEnabled, false);
    assert.equal((await github.snapshot()).author,'dependabot[bot]');
    await github.commentEyes('issue', '123');
    await github.commentEyes('inline', '456');
    assert.deepEqual(reactions, ['/repos/team/repo/issues/comments/123/reactions', '/repos/team/repo/pulls/comments/456/reactions']);
    await assert.rejects(github.deliver(state, marker, 'Indexing', 'issue', save, async () => {}), /connection lost/);
    assert.equal(posts, 1); assert.equal(saved.sending, true);
    state = structuredClone(saved); drop = false;
    await github.deliver(state, marker, 'Reviewing', 'issue', save, async () => {});
    assert.equal(posts, 1); assert.equal(patches, 1); assert.equal(state.id, 111);
    await github.deliver(state, marker, 'Report ready', 'issue', save, async () => {});
    assert.equal(posts, 1); assert.equal(patches, 2);
    foreign = true;
    await assert.rejects(github.deliver(state, marker, 'Another report', 'issue', save, async () => {}), /ownership/);
    assert.equal(patches, 2);
    comment = undefined;
    await assert.rejects(github.deliver({ sending: true }, marker, 'Unknown', 'issue', async () => {}, async () => {}), /uncertain/);
    assert.equal(posts, 1);
    foreign = false;
    let guarded = false;
    await github.deliver(state, marker, 'Replacement after deletion', 'issue', save, async () => { guarded = true; });
    assert.equal(posts, 2); assert.equal(state.id, 112); assert.equal(state.sending, false);
    assert.equal(guarded, true);
    assert.equal(state.body, `${marker}\nReplacement after deletion`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('check delivery recovers a lost create receipt and updates the app-owned check', async () => {
  const check: ReviewCheck = { job: 'J-test', head: 'b'.repeat(40) };
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const receipt = { external_id: check.job, head_sha: check.head, name: 'Inkspect', app: { id: 1 }, id: 42 };
  let guards = 0;
  const guard = async () => { guards++; };
  const github: PullGitHub = Object.assign(Object.create(PullGitHub.prototype), {
    worker: { full_name: 'team/repo', app_id: '1' },
    request: async (path: string, method = 'GET', body: Record<string, unknown>) => {
      if (method === 'GET') {
        assert.match(path, new RegExp('/commits/' + check.head + '/check-runs'));
        return { check_runs: [{ ...receipt, app: { id: 2 }, id: 11 }, ...(writes.length ? [receipt] : [])] };
      }
      writes.push({ path, method, body });
      if (method === 'POST') throw new Error('Lost create receipt');
      return receipt;
    },
  });
  await assert.rejects(github.updateCheck(check, 'in_progress', 'https://example.org', guard), /check unavailable/);
  await github.updateCheck(check, 'clean', 'https://example.org', guard);
  assert.equal(guards, 2);
  assert.deepEqual(writes.map(w => [w.method, w.path, w.body.status, w.body.conclusion]), [
    ['POST', '/repos/team/repo/check-runs', 'in_progress', undefined],
    ['PATCH', '/repos/team/repo/check-runs/42', 'completed', 'success'],
  ]);
  assert.equal(writes[0].body.head_sha, check.head);
  assert.equal(check.id, 42);
  assert.equal(check.phase, 'clean');
  check.threshold = 'P2';
  await github.updateCheck(check, 'blocking', 'https://example.org', guard);
  assert.equal(writes.at(-1)?.body.conclusion, 'failure');
  assert.match((writes.at(-1)?.body.output as { summary: string }).summary, /P0–P2/);
});

test('thread lookup selects the earliest open current-line finding by this app on this PR', async t => {
  const method = PullGitHub.prototype.findingThreads;
  const github = Object.assign(Object.create(PullGitHub.prototype), {
    worker: { full_name: 'team/repo' }, number: 7, appSlug: 'review-app', signal: new AbortController().signal,
  });
  const root = { body: '<!-- inkspect:finding:workflow:old-job:old-id -->\nFirst finding', fullDatabaseId: '4500000001', replyTo: null, author: { __typename: 'Bot', login: 'review-app' } };
  const thread = { path: 'manifest.json', line: 265, diffSide: 'RIGHT', isOutdated: false, isResolved: false, comments: { nodes: [root] } };
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.deepEqual(JSON.parse(String(init.body)).variables, { owner: 'team', repo: 'repo', number: 7, cursor: pages ? 'after-first' : null });
    pages++;
    const nodes = pages === 1 ? [
      { ...thread, isResolved: true }, { ...thread, isOutdated: true }, { ...thread, diffSide: 'LEFT' },
      ...[{ author: { __typename: 'Bot', login: 'other' } }, { author: { __typename: 'User', login: 'review-app' } },
        { replyTo: { id: 'reply' } }, { body: root.body.replace('workflow', 'different') }, { fullDatabaseId: '4500000002' }]
        .map(fields => ({ ...thread, comments: { nodes: [{ ...root, ...fields }] } })),
    ] : [thread];
    return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
      nodes, pageInfo: { hasNextPage: pages === 1, endCursor: 'after-first' },
    } } } } });
  });
  assert.deepEqual((await method.call(github, 'workflow')).map(t => t.id), [4500000001, 4500000002]);
  assert.equal(pages, 2);
});
