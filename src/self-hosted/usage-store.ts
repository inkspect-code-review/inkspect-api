import type { Pool } from "pg";

export type ProviderMeasurement = {
  complete: boolean; provider?: string; model?: string; provider_cost_nano_usd?: string;
  input_tokens?: number; output_tokens?: number; total_tokens?: number; cached_input_tokens?: number;
  cache_write_input_tokens?: number; calls?: number; units?: number; duration_ms?: number;
};
export async function recordProviderUsage(pool: Pool, scope: { organization: string; user: string; repository?: string; operation: string },
  category: "review" | "embedding" | "chat", value: ProviderMeasurement) {
  const measurement: ProviderMeasurement = { complete: value.complete === true };
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_input_tokens", "calls", "units", "duration_ms"] as const) {
    if (Number.isSafeInteger(value[field]) && Number(value[field]) >= 0) measurement[field] = value[field];
  }
  for (const field of ["provider", "model"] as const) if (typeof value[field] === "string" && value[field].length <= 200) measurement[field] = value[field];
  if (typeof value.provider_cost_nano_usd === "string" && /^\d{1,24}$/.test(value.provider_cost_nano_usd)) measurement.provider_cost_nano_usd = value.provider_cost_nano_usd;
  else measurement.complete = false;
  await pool.query(`INSERT INTO workspace_provider_usage(organization_id,category,operation_id,user_id,repository_id,measurement)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,category,operation_id) DO UPDATE
    SET measurement=workspace_provider_usage.measurement || EXCLUDED.measurement,updated_at=now()
    WHERE workspace_provider_usage.measurement->>'complete'='false'
      AND workspace_provider_usage.user_id=EXCLUDED.user_id AND workspace_provider_usage.repository_id IS NOT DISTINCT FROM EXCLUDED.repository_id`,
  [scope.organization,category,scope.operation,scope.user,scope.repository ?? null,measurement]);
}
