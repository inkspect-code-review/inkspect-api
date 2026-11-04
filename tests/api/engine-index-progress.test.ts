import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runRust } from "../../src/engine-process";
import { indexStage, mergeIndexProgress, needsIndexStats, watchIndexProgress, type IndexProgress } from "../../src/engine-index-progress";
import type { HostConfig } from "../../src/engine-contract";
import type { RepositoryIndex } from "@inkspect/core/lib/repository-types";

const initial = (): RepositoryIndex['progress'] => ({ stage: 'queued', scan: { stage: '', total: 0, processed: 0, read: 0, skipped: 0, chunks: 0 },
  chunks: 0, embedded: 0, reused: 0, indexed: false, logs: [{ at: new Date().toISOString(), message: 'Index queued.' }] });

test('real child progress arrives before exit, flushes the last snapshot, and preserves milestones on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkspect-index-test-'));
  const previous = { binary: process.env.INKSPECT_RUST_BINARY, state: process.env.INKSPECT_RUST_STATE };
  const binary = join(root, 'index-engine');
  const fixture = fileURLToPath(new URL('./fixtures/index-engine.cjs', import.meta.url));
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  process.env.INKSPECT_RUST_BINARY = binary;
  process.env.INKSPECT_RUST_STATE = root;
  try {
    for (const fail of [false, true]) {
      const observed: IndexProgress[] = [];
      let returned = false, inFlight = 0;
      const result = await runRust('index', { timeout_seconds: 5 } as HostConfig, { fail }, {}, '', `test-${fail}`, new AbortController().signal, undefined,
        async update => {
          assert.equal(returned, false);
          assert.equal(inFlight++, 0, 'progress callbacks are serialized');
          observed.push(update);
          await new Promise(resolve => setTimeout(resolve, 50));
          inFlight--;
        });
      returned = true;
      assert.equal(observed[0].stage, 'cloning', 'intermediate progress is delivered while the child runs');
      assert.equal(observed.at(-1)?.scan.total, 3);
      assert.equal(observed.at(-1)?.scan.read, 2);
      assert.equal(observed.at(-1)?.embedded, fail ? 5 : 9);
      assert.equal(observed.at(-1)?.indexed, !fail);
      assert.equal(observed.at(-1)?.stage, fail ? 'embedding' : 'summarizing');
      assert.equal(result.report?.indexed, fail ? undefined : true);
      assert.deepEqual(observed.at(-1)?.logs.map(log => log.message), fail ? ['cloning', 'embedding'] : ['cloning', 'embedding', 'summarizing']);
    }
  } finally {
    if (previous.binary === undefined) delete process.env.INKSPECT_RUST_BINARY; else process.env.INKSPECT_RUST_BINARY = previous.binary;
    if (previous.state === undefined) delete process.env.INKSPECT_RUST_STATE; else process.env.INKSPECT_RUST_STATE = previous.state;
    await rm(root, { recursive: true, force: true });
  }
});

test('final flush handles a fast process and reports persistence errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkspect-progress-test-'));
  try {
    const path = join(root, 'progress.json');
    const flush = watchIndexProgress(path, async () => { throw new Error('database unavailable'); }, () => {});
    const progress = initial();
    await writeFile(path, JSON.stringify({ ...progress, stage: 'cloning', scan: { ...progress.scan, measured: false }, logs: [] }));
    await assert.rejects(flush(), /database unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('counter repair preserves the existing index and summary and never requeues it', () => {
  const previous = { ...initial(), stage: 'completed', indexed: true, chunks: 929, embedded: 929, revision: 'a'.repeat(40),
    summary: { purpose: 'CMS', architecture: [], technologies: [], evidence: [], model: 'model', sampled: true } };
  assert.equal(needsIndexStats({ status: 'completed', progress: previous }), true);
  assert.equal(needsIndexStats({ status: 'failed', progress: previous }), true, 'saved indexes can outlive failed description generation');
  assert.equal(needsIndexStats({ status: 'failed', progress: initial() }), false);
  const repaired = mergeIndexProgress(previous, { scan: { ...previous.scan, measured: true, total: 300, read: 286, processed: 300, skipped: 14, stage: 'completed' } });
  assert.equal(repaired.summary, previous.summary);
  assert.equal(repaired.indexed, true);
  assert.equal(repaired.chunks, 929);
  assert.equal(repaired.revision, previous.revision);
  assert.equal(needsIndexStats({ status: 'completed', progress: repaired }), false);
  assert.equal(needsIndexStats({ status: 'running', progress: previous }), false);
  assert.equal(needsIndexStats({ status: 'completed', progress: { ...repaired, scan: { ...repaired.scan, total: 0, read: 0 } } }), false, 'measured empty indexes do not loop');
  let updated = indexStage(repaired, 'summarizing', 'Writing description.');
  updated = indexStage(updated, 'summarizing', 'Writing description complete.');
  updated = indexStage(updated, 'completed', 'Index ready.');
  assert.equal(updated.logs.length, 3, 'each stage keeps a stable progress row');
});
