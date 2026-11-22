import test from 'node:test';
import assert from 'node:assert/strict';
import { publishResolutions, type FollowupReport, type ResolutionDelivery } from '../../src/finding-followup';
import type { PullGitHub, FindingThread } from '../../src/pull-request-github';

const originalHead = 'a'.repeat(40), head = 'b'.repeat(40);
const old: FindingThread = { id: 12, nodeId: 'node-12', job: 'original', originalHead, outdated: true,
  finding: 'f', path: 'file.ts', line: 4, body: 'Existing issue' };
const resolution = { thread: '12', path: 'file.ts', line: 5, explanation: 'Checks the target before admitting the request.' };
const report = { run: { id: 'new', target: { revision_id: head }, coverage_complete: true }, verification_gaps: [],
  resolved_findings: [resolution], findings: [] } as unknown as FollowupReport;

function fixture() {
  const events: string[] = [];
  const deliveries: Record<string, ResolutionDelivery> = {};
  const github = {
    root: '/repos/team/repo',
    async compareFindingRevisions(before: string, after: string) {
      assert.deepEqual([before, after], [originalHead, head]);
      return { status: 'ahead', merge_base_commit: { sha: before }, files: [
        { filename: 'file.ts', patch: '@@ -4,2 +4,2 @@\n same\n-before\n+after' },
      ] };
    },
    async deliver(d: ResolutionDelivery, marker: string, body: string, kind: string, _save: unknown, _guard: unknown, extra: unknown, mode: string) {
      assert.equal(mode, 'first-resolution');
      assert.equal(kind, 'inline'); assert.deepEqual(extra, { reply_to: 12 });
      assert.equal(marker, '<!-- inkspect:resolution:new:12 -->');
      assert.ok(body.includes(resolution.explanation));
      assert.ok(body.includes('/blob/' + head + '/file.ts#L5'));
      if (!d.id) { d.id = 13; events.push('reply'); }
    },
    async resolveFindingThread(id: string) { assert.equal(id, old.nodeId); events.push('resolve'); },
  };
  const run = (r = report, threads = [old], guard = async () => {}) =>
    publishResolutions(github as unknown as PullGitHub, r, threads, deliveries, async () => {}, guard);
  return { github, events, run };
}

test('explains an outdated finding before resolving and recovers between writes', async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(f.run(report, [old], async () => { if (++calls === 2) throw Error('head changed'); }), /head changed/);
  assert.deepEqual(f.events, ['reply']);
  await f.run();
  await f.run();
  assert.deepEqual(f.events, ['reply', 'resolve']);
});

test('absence, uncertainty, continuing findings and unchanged evidence leave threads open', async () => {
  const f = fixture();
  await f.run({ ...report, resolved_findings: [] });
  await f.run({ ...report, verification_gaps: [{ blocking: true, reason: 'Incomplete review' }] } as FollowupReport);
  await f.run({ ...report, resolved_findings: [{ ...resolution, line: 4 }] });
  await f.run({ ...report, resolved_findings: [{ ...resolution, thread: 'foreign' }] });
  await f.run({ ...report, findings: [{ id: 'repeated' }], presentation: { version: 1, github_findings: { repeated: old.body } } } as unknown as FollowupReport);
  await f.run(report, [{ ...old, originalHead: head }]);
  await f.run(report, []);
  assert.deepEqual(f.events, []);
});
