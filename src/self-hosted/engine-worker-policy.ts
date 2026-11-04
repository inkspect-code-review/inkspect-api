import type { Pool } from 'pg';
import { selfHostedReviews } from "./review-store";
import { recordProviderUsage } from "./usage-store";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { selfHostedEnginePolicy, selfHostedProviderCredential } from "./engine-policy";
import { selfHostedFixPolicy } from "./fix-policy";
import { fixPullOpen, handleFix, isFix } from "../engine-fix-core";
import { MAX_FIX_MODEL_CALLS } from "../engine-fix-verification";
import { usageReceipt, type HostConfig } from "../engine-contract";
import { modelUsage } from "../engine-model-usage";
import { reviewCost } from "../review-cost";
import { present, type EngineJob } from "../engine-store";
import type { EngineWorkerPolicy } from "../engine-worker-policy";
import type { RetrievalScope } from "../engine-http-policy";

export function selfHostedEngineWorkerPolicy(pool: Pool): EngineWorkerPolicy {
  const reviews = selfHostedReviews(pool), fix = selfHostedFixPolicy(pool);
  async function retrieval(events: any[], configuration: HostConfig, scope: RetrievalScope) {
    for (const cost of reviewCost(events, configuration).calls.filter(call => call.category !== 'model')) {
      const start = events.find(event => event.id === cost.id && event.kind === `${cost.category}.started`);
      const usage = events.find(event => event.id === cost.id && event.kind === `${cost.category}.usage`);
      await recordProviderUsage(pool, { ...scope, operation: `${scope.operation}:${cost.category}:${cost.id}` }, 'embedding', {
        complete: cost.cost_nano_usd !== null, provider: 'bedrock', model: cost.model,
        ...(cost.cost_nano_usd === null ? {} : { provider_cost_nano_usd: cost.cost_nano_usd }),
        input_tokens: usage?.input_tokens, total_tokens: usage?.input_tokens, calls: 1, units: cost.search_units ?? start?.units,
      });
    }
  }
  return {
    fix,
    http: selfHostedEnginePolicy(pool, {
      fix: (worker, claims, id, method, configuration, signal, retry) => handleFix(fix, worker, claims, id, method, configuration, signal, undefined, retry),
      fixPullOpen, retrieval,
    }),
    async allowed(job) {
      const row = await reviews.authorize({ organization: job.organization_id, user: job.subject, repository: Number(job.repository_id), connection: job.connection_id,
        installation: Number(job.installation_id), body: job.request });
      if (row.request_id !== job.request_id || row.job_id !== job.id) throw new ReviewError(403, 'Review admission no longer matches this job.');
      return { allowed: true };
    },
    credential: job => selfHostedProviderCredential(pool, job),
    receipt(job, events) {
      const calls = isFix(job) ? MAX_FIX_MODEL_CALLS : 1;
      if (job.request.byok) {
        const usage = modelUsage(events, calls);
        return { complete: !!usage, provider: job.request.byok.provider, model: job.request.byok.model, ...(usage || {}) };
      }
      const measured = isFix(job) && !events.some(event => ['model.started', 'model.usage', 'journal.unavailable'].includes(event.kind)) ? [...events, { kind: 'model.skipped' }] : events;
      return usageReceipt(measured, job.host_config, calls);
    },
    retrieval: (job, events) => retrieval(events, job.host_config, { organization: job.organization_id, user: job.subject, repository: job.repository_id, operation: job.id }),
    async settle(job) { await reviews.settle(job.organization_id, present(job)); },
    async pending() {
      return (await pool.query<EngineJob>(`SELECT j.* FROM api_engine_job j JOIN workspace_review_execution r ON r.request_id=j.request_id AND r.job_id=j.id
        WHERE r.state='pending' AND j.status IN ('completed','failed','cancelled') ORDER BY r.last_checked_at NULLS FIRST LIMIT 50`)).rows;
    },
    async checked(job) { await pool.query('UPDATE workspace_review_execution SET last_checked_at=now() WHERE request_id=$1 AND job_id=$2', [job.request_id, job.id]); },
    async indexUsage(scope, events, chunks, description, host) {
      await retrieval(events, host, scope);
      await recordProviderUsage(pool, { ...scope, operation: `summary:${scope.operation}` }, 'embedding', { complete: description.chargedNanoUSD !== undefined,
        provider: 'bedrock', model: description.model, provider_cost_nano_usd: description.chargedNanoUSD,
        input_tokens: description.inputTokens, output_tokens: description.outputTokens, total_tokens: description.totalTokens,
        cached_input_tokens: description.cacheReadInputTokens, cache_write_input_tokens: description.cacheWriteInputTokens, calls: 1, duration_ms: description.durationMs });
      await recordProviderUsage(pool, { ...scope, operation: `chunks:${scope.operation}` }, 'embedding', { complete: true, provider_cost_nano_usd: '0', calls: 0, units: chunks });
    },
  };
}
