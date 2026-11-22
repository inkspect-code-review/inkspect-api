import test from 'node:test';
import assert from 'node:assert/strict';
import { signEngineRequest } from "@inkspect/core/lib/engine-client";
import { engineFailure, verifyRequest, validateReview, validateHost, usageReceipt, schemaName, jobID, type HostConfig } from "../../src/engine-contract";

const host: HostConfig = { model_id: 'test.model', model_region: 'eu-west-2', model_max_output_tokens: 100,
  timeout_seconds: 60, input_nano_usd: 2, output_nano_usd: 5, budget_nano_usd: 1000,
  model_input_allowance: 200, model_max_request_bytes: 10000,
  retrieval: { region: 'eu-west-2', embed_model: 'embed', rerank_region: 'eu-central-1', rerank_model: 'rank', dimensions: 1024, candidates: 40, top_n: 8, queries: 8, content_bytes: 512000, max_files: 100 },
  sandbox: { containerize: false, clone_mib: 500 } };
test('signed engine requests bind identity, exact path, expiry and bytes', () => {
  const secret = 's'.repeat(32), claims = { tenant: 'tenant', subject: 'person', connection: 'connection', installation: 1, repository: 2, expires: Math.floor(Date.now() / 1000) + 30 };
  const body = '{"number":1}', headers = signEngineRequest('POST', '/github/reviews', body, claims, secret);
  const verify = (path: string, raw: string) => verifyRequest('POST', path, raw, headers['X-Inkspect-Claims'], headers['X-Inkspect-Signature'], secret);
  assert.deepEqual(verify('/github/reviews', body), claims);
  assert.throws(() => verify('/jobs', body));
  assert.throws(() => verify('/github/reviews', body + ' '));
  const expired = signEngineRequest('GET', '/jobs', '', { ...claims, expires: 1 }, secret);
  assert.throws(() => verifyRequest('GET', '/jobs', '', expired['X-Inkspect-Claims'], expired['X-Inkspect-Signature'], secret));
});
test('unknown or incomplete provider outcomes cannot produce a free receipt', () => {
  for (const events of [[], [{ kind: 'model.started' }], [{ kind: 'model.usage', input_tokens: 2, output_tokens: 3 }],
    [{ kind: 'model.started' }, { kind: 'model.usage', input_tokens: -1, output_tokens: 3 }]]) {
    assert.equal(usageReceipt(events, host).complete, false);
  }
  const measured = usageReceipt([{ kind: 'model.started' }, { kind: 'model.usage', input_tokens: 20, output_tokens: 3 }], host);
  assert.equal(measured.complete, true); assert.equal(measured.charged_nano_usd, '55');
});
test('explicit pricing and full input allowance must fit approved budget', () => {
  assert.equal(validateHost(host), host);
  assert.throws(() => validateHost({ ...host, input_nano_usd: 0 }));
  assert.throws(() => validateHost({ ...host, budget_nano_usd: 100 }));
  assert.throws(() => validateHost({ ...host, retrieval: {} }));
  assert.throws(() => validateHost({ ...host, sandbox: { ...host.sandbox, containerize: true } }));
});
test('admission rejects unsupported provider, unconfigured model and oversized notes', () => {
  const body = { number: 1, base_tip: 'a'.repeat(40), head: 'b'.repeat(40) };
  validateReview(body, host);
  assert.throws(() => validateReview({ ...body, byok: {} }, host));
  assert.throws(() => validateReview({ ...body, model_id: 'arbitrary.model' }, host));
  assert.throws(() => validateReview({ ...body, review_notes: [{ author: 'user', body: 'x'.repeat(2001) }] }, host));
});
test('queue identifiers cannot escape SQL and repeated admissions have stable identities', () => {
  assert.throws(() => schemaName('tenant";DROP TABLE jobs;--'));
  assert.equal(schemaName('rust_repo_ab12'), '"rust_repo_ab12"');
  assert.equal(jobID('one'), jobID('one')); assert.notEqual(jobID('one'), jobID('two'));
});

test('recognizes the review budget failure separately from other model failures', () => {
  assert.equal(engineFailure([{kind: 'engine.failed', code: 'review.budget_limit'}]), 'review.budget_limit');
  assert.equal(engineFailure([{kind: 'engine.failed', code: 'model.failed'}]), undefined);
});
