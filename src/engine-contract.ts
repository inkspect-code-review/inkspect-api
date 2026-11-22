import { supportedModel } from "@inkspect/core/lib/byok/catalog";
import { timingSafeEqual } from 'node:crypto';
import { signEngineRequest, type EngineClaims } from "@inkspect/core/lib/engine-client";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { reviewCost } from "./review-cost";
import { modelUsage } from "./engine-model-usage";
import { FIX_NO_SAFE_REPAIR, FIX_VERIFICATION_FAILED } from "./engine-fix-verification";

export type HostConfig = {
  model_id: string; model_region: string; model_max_output_tokens: number; timeout_seconds: number;
  input_nano_usd: number; output_nano_usd: number; budget_nano_usd: number;
  model_input_allowance: number; model_max_request_bytes: number;
  retrieval: Record<string, unknown>; sandbox: Record<string, unknown>;
};
export function validateHost(value: HostConfig): HostConfig {
  if (!value || !/^[\w.:-]{1,200}$/.test(value.model_id) || !/^[a-z0-9-]+$/.test(value.model_region)
    || !Number.isSafeInteger(value.timeout_seconds) || value.timeout_seconds < 1 || value.timeout_seconds > 3600
    || !Number.isSafeInteger(value.model_max_output_tokens) || value.model_max_output_tokens < 1
    || !value.retrieval || !value.sandbox) throw new Error('Invalid Rust host configuration');
  for (const rate of [value.input_nano_usd, value.output_nano_usd, value.budget_nano_usd]) {
    if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error('Explicit positive model prices and budget are required');
  }
  if (![value.model_input_allowance, value.model_max_request_bytes].every(v => Number.isSafeInteger(v) && v > 0)
    || BigInt(value.model_input_allowance) * BigInt(value.input_nano_usd) + BigInt(value.model_max_output_tokens) * BigInt(value.output_nano_usd) > BigInt(value.budget_nano_usd)) throw new Error('The complete model allowance must fit the approved budget');
  const rc = value.retrieval;
  for (const key of ['region', 'embed_model', 'rerank_region', 'rerank_model']) if (typeof rc[key] !== 'string' || !rc[key]) throw new Error('Missing retrieval configuration');
  for (const [key, maximum] of Object.entries({ dimensions: 4096, candidates: 50, top_n: 50, queries: 16, content_bytes: 1048576, max_files: 1000 })) {
    if (!Number.isSafeInteger(rc[key]) || Number(rc[key]) < 1 || Number(rc[key]) > maximum) throw new Error('Invalid retrieval limit');
  }
  if (Number(rc.top_n) > Number(rc.candidates) || value.sandbox.containerize !== false
    || !Number.isSafeInteger(value.sandbox.clone_mib) || Number(value.sandbox.clone_mib) < 1 || Number(value.sandbox.clone_mib) > 500) throw new Error('Invalid Rust runtime limits');
  return value;
}
export function verifyRequest(method: string, path: string, body: string, encoded: string, signature: string, secret: string): EngineClaims {
  if (secret.trim().length < 32 || !/^[a-f0-9]{64}$/.test(signature) || encoded.length > 2048) throw new ReviewError(403, 'Invalid service authentication.');
  let claims: EngineClaims;
  try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw new ReviewError(403, 'Invalid service authentication.'); }
  if (!claims || ![claims.tenant, claims.subject, claims.connection].every(v => typeof v === 'string' && /^[\w-]{1,200}$/.test(v))
    || ![claims.repository, claims.installation].every(v => Number.isSafeInteger(v) && v > 0)
    || !Number.isSafeInteger(claims.expires) || claims.expires < Date.now() / 1000 || claims.expires > Date.now() / 1000 + 60) throw new ReviewError(403, 'Invalid service claims.');
  // Preserve the signed encoding: re-serializing claims would accept another wire representation.
  const expected = signEngineRequest(method, path, body, claims, secret);
  if (expected['X-Inkspect-Claims'] !== encoded || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected['X-Inkspect-Signature'], 'hex'))) throw new ReviewError(403, 'Invalid service authentication.');
  return claims;
}
export function schemaName(schema: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid queue schema');
  return `"${schema}"`;
}
export { engineJobId as jobID } from "@inkspect/core/lib/review-identity";
export function validateReview(body: Record<string, any>, host: HostConfig) {
  if (body.fix_of !== undefined) throw new ReviewError(400, "Use the fix action for repairs.");
  if (!Number.isSafeInteger(body.number) || body.number < 1 || ![body.base_tip, body.head].every(v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v))) throw new ReviewError(400, 'Select a current pull request snapshot.');
  if (body.byok && (!supportedModel(body.byok.provider,body.byok.model) || typeof body.byok.credential_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.byok.credential_id))) throw new ReviewError(400, 'Invalid BYOK selection.');
  if (body.model_id && body.model_id !== host.model_id) throw new ReviewError(400, 'This model is not configured for the Rust engine.');
  for (const field of ['retry_of', 'rerun_of']) if (body[field] !== undefined && !/^J-[a-f0-9]{32}$/.test(body[field])) throw new ReviewError(400, 'Invalid previous review.');
  const notes = body.review_notes;
  if (notes !== undefined && (!Array.isArray(notes) || notes.length > 5 || notes.some(n => !n || typeof n.author !== 'string' || !/^[\w.-]{1,100}$/.test(n.author) || typeof n.body !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(n.body)) || notes.reduce((n, v) => n + Buffer.byteLength(v.body), 0) > 2000)) throw new ReviewError(400, 'Invalid review notes.');
}
/** The repository's .inkspectignore is invalid; the engine fails closed before any model call. */
export const INVALID_IGNORE = 'source.invalid_ignore';
export const REVIEW_BUDGET_LIMIT = 'review.budget_limit';
export const reviewBudgetNotice = {
  title: 'Review budget reached',
  summary: 'The next model call would exceed the budget for this review. Split the pull request into smaller changes and run the review again.',
};
/** An engine failure code the product explains. The engine journals its stable code on exit because stderr is discarded. */
export function engineFailure(events: any[]): typeof INVALID_IGNORE | typeof REVIEW_BUDGET_LIMIT | typeof FIX_VERIFICATION_FAILED | typeof FIX_NO_SAFE_REPAIR | undefined {
  if (events.some(e => e?.kind === 'engine.failed' && e.code === FIX_NO_SAFE_REPAIR)) return FIX_NO_SAFE_REPAIR;
  if (events.some(e => e?.kind === 'engine.failed' && e.code === FIX_VERIFICATION_FAILED)
    || (events.some(e => e.kind === 'fix.verification.started') && !events.some(e => e.kind === 'fix.verification.passed'))) return FIX_VERIFICATION_FAILED;
  if (events.some(e => e?.kind === 'engine.failed' && e.code === REVIEW_BUDGET_LIMIT)) return REVIEW_BUDGET_LIMIT;
  return events.some(e => e?.kind === 'engine.failed' && e.code === INVALID_IGNORE) ? INVALID_IGNORE : undefined;
}
export function usageReceipt(events: any[], host: HostConfig, maximumCalls = 1) {
  return { ...modelReceipt(events, host, maximumCalls), provider_cost: reviewCost(events, host) };
}
function modelReceipt(events: any[], host: HostConfig, maximumCalls: number) {
  const starts = events.filter(e => e.kind === 'model.started');
  const measured = events.filter(e => e.kind === 'model.usage');
  // The engine skipped the model on purpose (.inkspectignore excluded every changed file): nothing ran, nothing is charged.
  if (!starts.length && !measured.length && events.some(e => e.kind === 'model.skipped'))
    return { complete: true, charged_nano_usd: '0', input_tokens: 0, output_tokens: 0, total_tokens: 0, calls: 0 };
  const m = modelUsage(events, maximumCalls);
  if (!m) return { complete: false, charged_nano_usd: '0' };
  const charge = BigInt(m.input_tokens) * BigInt(host.input_nano_usd) + BigInt(m.output_tokens) * BigInt(host.output_nano_usd);
  return { complete: true, charged_nano_usd: charge.toString(), input_tokens: m.input_tokens, output_tokens: m.output_tokens,
    total_tokens: m.input_tokens + m.output_tokens, cached_input_tokens: m.cached_input_tokens,
    cache_write_input_tokens: m.cache_write_input_tokens, calls: m.calls, provider: 'bedrock', model: host.model_id };
}
