import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PullGitHub, type Delivery } from "../../src/pull-request-github";
import type { Worker } from "../../src/repository-store";

test('GitHub comment delivery recovers an ambiguous POST, reuses its ID and refuses foreign comments', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'inkspect-comment-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const privateKey = join(directory, 'test.pem');
  await writeFile(privateKey, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const worker: Worker = { organization_id: 'org', repository_id: '17', connection_id: 'c', installation_id: '44', full_name: 'team/repo', queue_database: 'app', queue_schema: 'queue', app_id: '1', private_key_file: privateKey, size_bytes: '100', access_verified_at: new Date(), access_error: null };
  const marker = '<!-- inkspect:pr:unique -->';
  let posts = 0, patches = 0, drop = true, foreign = false;
  let comment: Record<string, unknown> | undefined;
  const saved: Delivery = {};
  const reactions: string[] = [];
  let state: Delivery = {};
  const save = async () => { Object.assign(saved, structuredClone(state)); };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/installation')) return Response.json({ id: 44, app_id: 1 });
    if (path.endsWith('/access_tokens')) {
      const payload = JSON.parse(String(init.body));
      assert.deepEqual(payload.permissions, { metadata: 'read', pull_requests: 'write' });
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
    const github = await PullGitHub.open(worker, 1, new AbortController().signal);
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
