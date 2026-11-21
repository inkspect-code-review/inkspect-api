import type { HostConfig } from "./engine-contract";
import type { ReviewCost, ReviewCostCall } from "@inkspect/core/lib/review-cost";

const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
// Provider list prices, not the conservative admission ceilings or customer credit prices.
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-2-sol.html
// https://aws.amazon.com/bedrock/pricing/ (Cohere Embed 4: $0.12/M, Rerank 3.5: $2/1K search units)
export function reviewCost(events: any[], host: HostConfig): ReviewCost {
  const calls: ReviewCostCall[] = [];
  const starts = events.filter(e => ['model.started', 'embedding.started', 'rerank.started'].includes(e.kind));
  for (const [index, start] of starts.entries()) {
    const category = start.kind.split('.')[0] as ReviewCostCall['category'];
    const matches = events.filter(e => e.kind === `${category}.usage` && e.id === start.id);
    // Headers survive malformed bodies; a body receipt supersedes, never adds to, its header receipt.
    const m = matches.length === 1 ? matches[0] : matches.length ? undefined : events.find(e => e.kind === `${category}.response` && e.id === start.id);
    const model = category === 'model' ? (start.model || host.model_id) : String(category === 'embedding' ? host.retrieval.embed_model : host.retrieval.rerank_model);
    const region = category === 'model' ? (start.region || host.model_region) : String(category === 'embedding' ? host.retrieval.region : host.retrieval.rerank_region);
    const call: ReviewCostCall = { id: String(start.id ?? `model-${index}`), category, model, region, status: 'unmeasured', cost_nano_usd: null,
      request_id: m?.request_id, measurement_source: m?.measurement_source, reason: 'Provider usage unavailable' };
    const uniqueStart = starts.filter(e => e.kind === start.kind && e.id === start.id).length === 1;
    const successful = uniqueStart && m && (m.http_status === undefined || m.http_status === 200);
    if (successful) {
      for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'search_units'] as const)
        if (count(m[key])) call[key] = m[key];
      if (category === 'rerank' && count(start.units)) call.documents = start.units;
      let amount: bigint | undefined;
      if (category === 'model' && count(m.input_tokens) && count(m.output_tokens)) {
        const read = m.cached_input_tokens ?? 0, write = m.cache_write_input_tokens;
        // Legacy receipts collapsed cache writes into input. Do not reprice them as uncached tokens.
        if ((model === 'global.openai.gpt-6.1-sol' || model === 'global.openai.gpt-6.2-sol') && count(read) && count(write) && m.input_tokens >= read + write) {
          const long = m.input_tokens > 272000;
          const rates = { input: long ? 4000 : 2000, output: long ? 15000 : 10000, cache_read: long ? 200 : 100, cache_write: long ? 5000 : 2500 };
          call.rates = rates;
          amount = BigInt(m.input_tokens - read - write) * BigInt(rates.input) + BigInt(read) * BigInt(rates.cache_read)
            + BigInt(write) * BigInt(rates.cache_write) + BigInt(m.output_tokens) * BigInt(rates.output);
        } else if(model==='us.anthropic.claude-opus-5-5' && region==='us-east-1' && count(read) && count(write)
          && count(m.cache_write_5m_tokens) && count(m.cache_write_1h_tokens) && m.cache_write_5m_tokens+m.cache_write_1h_tokens===write && m.input_tokens>=read+write) {
          const rates={input:4400,output:22000,cache_read:220,cache_write_5m:5500,cache_write_1h:8800};call.rates=rates;
          amount=BigInt(m.input_tokens-read-write)*4400n+BigInt(m.output_tokens)*22000n+BigInt(read)*220n+BigInt(m.cache_write_5m_tokens)*5500n+BigInt(m.cache_write_1h_tokens)*8800n;
        } else call.reason = 'Verified model/cache pricing unavailable';
      } else if (category === 'embedding' && count(m.input_tokens) && model === 'eu.cohere.embed-v4:0' && region === 'eu-west-2') {
        call.rates = { input: 120 }; amount = BigInt(m.input_tokens) * 120n;
      } else if (category === 'rerank' && count(m.search_units) && model === 'cohere.rerank-v3-5:0' && region === 'eu-central-1') {
        call.rates = { search_unit: 2000000 }; amount = BigInt(m.search_units) * 2000000n;
      } else if (category === 'rerank' && count(start.units) && start.units > 0 && model === 'cohere.rerank-v3-5:0' && region === 'eu-central-1') {
        call.rates = { search_unit: 2000000 };
        call.estimated_cost_nano_usd = (BigInt(Math.ceil(start.units / 100)) * 2000000n).toString();
        call.status = 'estimated';
        call.reason = 'Minimum estimate from document count; provider does not report billed search units. Internal chunking can increase cost.';
      }
      if (amount !== undefined) { call.status = 'measured'; call.cost_nano_usd = amount.toString(); delete call.reason; }
    }
    calls.push(call);
  }
  const components = (['model', 'embedding', 'rerank'] as const).map(category => {
    const entries = calls.filter(c => c.category === category);
    const complete = entries.every(c => c.cost_nano_usd !== null);
    const measured = entries.reduce((sum, c) => sum + BigInt(c.cost_nano_usd ?? 0), 0n).toString();
    const estimated = entries.reduce((sum, c) => sum + BigInt(c.estimated_cost_nano_usd ?? 0), 0n).toString();
    return { category, calls: entries.length, complete, cost_nano_usd: complete ? measured : null, measured_nano_usd: measured, estimated_nano_usd: estimated };
  });
  const complete = events.length > 0 && components.every(c => c.complete);
  const measured = components.reduce((sum, c) => sum + BigInt(c.measured_nano_usd), 0n).toString();
  return { version: 1, currency: 'USD', basis: 'provider_list_price', pricing_date: '2026-11-21', complete,
    total_nano_usd: complete ? measured : null, measured_nano_usd: measured,
    unmeasured_calls: calls.filter(c => c.status === 'unmeasured').length,
    estimated_nano_usd: components.reduce((sum, c) => sum + BigInt(c.estimated_nano_usd), 0n).toString(), calls, components };
}
