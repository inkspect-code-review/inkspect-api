// Complete receipts only: each paid call must have exactly one matching usage
// record. Bounded fix loops must never be charged as a single call or as free.
export function modelUsage(events: any[], maximumCalls = 1) {
  const starts = events.filter(e => e.kind === 'model.started');
  const usage = events.filter(e => e.kind === 'model.usage');
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  if (!starts.length || starts.length > maximumCalls || usage.length !== starts.length) return;
  const validId = (id: unknown) => typeof id === 'string' ? id.length > 0 : count(id);
  // Retain compatibility with old, single-call journals without receipt IDs.
  if (!(starts.length === 1 && starts[0].id === undefined && usage[0].id === undefined)) {
    if (starts.some(e => !validId(e.id)) || new Set(starts.map(e => e.id)).size !== starts.length
      || starts.some(s => usage.filter(e => e.id === s.id).length !== 1)) return;
  }
  if (usage.some(m => !count(m.input_tokens) || !count(m.output_tokens)
    || ['cached_input_tokens', 'cache_write_input_tokens'].some(k => m[k] !== undefined && (!count(m[k]) || m[k] > m.input_tokens)))) return;
  const sum = (key: string) => usage.reduce((n, m) => n + m[key], 0);
  const input = sum('input_tokens'), output = sum('output_tokens');
  if (![input, output, input + output].every(count)) return;
  return {input_tokens:input, output_tokens:output, total_tokens:input + output, calls:starts.length,
    cached_input_tokens:usage.every(m => m.cached_input_tokens !== undefined) ? sum('cached_input_tokens') : undefined,
    cache_write_input_tokens:usage.every(m => m.cache_write_input_tokens !== undefined) ? sum('cache_write_input_tokens') : undefined};
}
