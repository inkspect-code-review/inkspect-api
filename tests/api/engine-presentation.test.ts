import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStoredReport } from "../../src/engine-process";
import { reportBody, findingBody } from "../../src/pull-request-report";
import type { ReviewReport } from "@inkspect/core/lib/review-types";

test('old stored reports use the Rust renderer offline and are delivered byte for byte', { skip: !process.env.INKSPECT_TEST_RUST_BINARY }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkspect-presentation-test-'));
  const before = { binary: process.env.INKSPECT_RUST_BINARY, state: process.env.INKSPECT_RUST_STATE };
  process.env.INKSPECT_RUST_BINARY = process.env.INKSPECT_TEST_RUST_BINARY;
  process.env.INKSPECT_RUST_STATE = root;
  try {
    const revision = { tenant_id: 'tenant', repository_id: '1', provider: 'github', provider_instance: 'github.com', revision_id: 'a'.repeat(40) };
    const report = {
      schema_version: '1', decision: 'ready_for_human', summary: 'Stored review',
      run: { id: 'J-stored', status: 'completed', freshness: 'current', coverage_complete: true, base: revision, target: revision, model: { provider: 'bedrock', model_id: 'not-called' } },
      scores: { code_quality: { score: 4, rationale: 'Missing edge case test', to_improve: 'Add an edge case test' }, security: { score: 5, rationale: 'No concern' } },
      change_alignment: { level: 'aligned', rationale: 'Matches intent' },
      findings: [{ id: 'F-1', title: 'Check an edge case', severity: 'P3', reason: 'Missing coverage', suggestion: 'Add a test', verification: 'Run tests', revision, location: { path: 'math.ts', start_line: 2, end_line: 2 }, evidence_ids: [] }],
      diagram: { title: 'Math flow', view: 'current', nodes: [{ id: 'a', label: 'Input' }, { id: 'b', label: 'Result' }], edges: [{ from: 'a', to: 'b' }] },
      verification_gaps: [], evidence: [], assessments: [],
    } as unknown as ReviewReport;
    report.presentation = await renderStoredReport(report);
    assert.match(report.presentation.markdown, /No blocking issues found/);
    assert.match(report.presentation.markdown, /### Scores/);
    assert.match(report.presentation.markdown, /4\/5/);
    assert.match(report.presentation.markdown, /```mermaid/);
    assert.match(report.presentation.markdown, /Change vs\. PR intent/);
    assert.equal(reportBody(report), report.presentation.markdown);
    assert.equal(findingBody(report, 'F-1'), report.presentation.github_findings['F-1']);
    assert.match(report.presentation.finding_prompts['F-1'], /Missing coverage/);
    assert.deepEqual(await readdir(root), [], 'offline rendering cleans its private temporary files');
  } finally {
    for (const [key, value] of Object.entries({ INKSPECT_RUST_BINARY: before.binary, INKSPECT_RUST_STATE: before.state })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
