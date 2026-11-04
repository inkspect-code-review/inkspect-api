import type { Pool } from "pg";
import { ReviewError } from "@inkspect/core/lib/review-access";
import type { UsageDay, UsageEntry, UsageGroup, UsageTotal } from "@inkspect/core/lib/usage/usage-display";

const number = (field: string) => `CASE WHEN measurement->>'${field}' ~ '^[0-9]{1,24}$' THEN (measurement->>'${field}')::numeric END`;
const groupKey = "md5(jsonb_build_array((started_at AT TIME ZONE 'UTC')::date,category,user_id,repository_id,provider,model)::text)";
// All sources contain execution/measurement records only. Never read Cloud
// grants, subscription state, markup or provider credentials in this reader.
const entries = `sources AS (
  SELECT 'review:' || request_id AS id,'review'::text AS category,request_id AS operation_id,user_id,repository_id,
    CASE WHEN state='rejected' THEN 'cancelled' ELSE state END AS status,
    coalesce(measurement,'{}'::jsonb) AS measurement,created_at AS started_at,finished_at
  FROM workspace_review_execution WHERE organization_id=$1 AND created_at>=now()-$3::integer*interval '1 day'
  UNION ALL
  SELECT 'chat:' || u.operation_id,'chat',u.operation_id,u.user_id,NULL,
    CASE WHEN u.measurement='{}'::jsonb AND u.calls>0 THEN 'unmeasured' ELSE 'completed' END,
    jsonb_build_object('provider','bedrock','model',u.measurement->'model','calls',u.calls,
      'input_tokens',u.measurement->'inputTokens','output_tokens',u.measurement->'outputTokens','total_tokens',u.measurement->'totalTokens',
      'cached_input_tokens',u.measurement->'cachedInputTokens','cache_write_input_tokens',u.measurement->'cacheWriteInputTokens',
      'duration_ms',u.measurement->'durationMs','provider_cost_nano_usd',CASE WHEN u.calls=0 THEN '"0"'::jsonb ELSE u.measurement->'providerCostNanoUSD' END),u.created_at,u.created_at
  FROM workspace_chat_usage u WHERE u.organization_id=$1 AND u.created_at>=now()-$3::integer*interval '1 day'
  UNION ALL
  SELECT 'provider:' || category || ':' || operation_id,category,operation_id,user_id,repository_id,
    CASE WHEN measurement->>'complete'='true' THEN 'completed' ELSE 'unmeasured' END,measurement,created_at,updated_at
  FROM workspace_provider_usage WHERE organization_id=$1 AND created_at>=now()-$3::integer*interval '1 day'
), entries AS (
  SELECT s.id,s.category,s.operation_id,s.user_id,s.repository_id,w.full_name AS repository_name,s.status,
    measurement->>'provider' AS provider,measurement->>'model' AS model,started_at,finished_at,
    ${number("input_tokens")} AS input_tokens,${number("output_tokens")} AS output_tokens,${number("total_tokens")} AS total_tokens,
    ${number("cached_input_tokens")} AS cached_input_tokens,${number("cache_write_input_tokens")} AS cache_write_input_tokens,
    ${number("calls")} AS calls,${number("units")} AS units,${number("duration_ms")} AS duration_ms,${number("provider_cost_nano_usd")} AS amount
  FROM sources s LEFT JOIN api_repository_worker w ON w.organization_id=$1 AND w.repository_id=s.repository_id
  WHERE $2='all' OR s.category=$2
)`;

export async function selfHostedUsageHistory(pool: Pool, organization: string, query: URLSearchParams) {
  const category = query.get("category") || "all", days = Number(query.get("days") || 30), page = Number(query.get("page") || 1);
  const groupBy = query.get("groupBy") || "none", group = query.get("group");
  if (!["all", "embedding", "review", "chat"].includes(category) || ![7, 30, 90].includes(days) || !Number.isInteger(page) || page < 1 || page > 200
    || !["none", "day"].includes(groupBy) || (group !== null && (!/^[a-f0-9]{32}$/.test(group) || groupBy !== "none"))) throw new ReviewError(400, "Choose a valid usage filter.");
  const values = [organization, category, days], grouped = groupBy === "day";
  const fields = ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_input_tokens", "calls", "units", "duration_ms", "amount"];
  const recordsQuery = grouped ? `WITH ${entries}, grouped AS (SELECT *,${groupKey} AS group_id FROM entries)
    SELECT group_id AS id,min((started_at AT TIME ZONE 'UTC')::date)::text AS day,category,user_id,repository_id,max(repository_name) AS repository_name,provider,model,
      count(*)::int AS operations,array_agg(DISTINCT status ORDER BY status) AS statuses,
      count(*) FILTER(WHERE amount IS NULL AND status NOT IN ('pending','running','paused'))::int AS unmeasured,
      count(*) FILTER(WHERE status IN ('pending','running','paused'))::int AS in_progress,
      count(*) FILTER(WHERE input_tokens IS NULL)::int AS missing_input_tokens,count(*) FILTER(WHERE output_tokens IS NULL)::int AS missing_output_tokens,
      ${fields.map(field => `sum(${field})::text AS ${field}`).join(",")},min(started_at) AS started_at,max(started_at) AS latest_at
    FROM grouped GROUP BY group_id,category,user_id,repository_id,provider,model ORDER BY latest_at DESC,group_id DESC LIMIT 51 OFFSET $4`
    : `WITH ${entries} SELECT id,category,operation_id,user_id,repository_id,repository_name,provider,model,status,started_at,finished_at,
      ${fields.filter(field => field !== "calls").map(field => `${field}::text AS ${field}`).join(",")},calls::int
      FROM entries ${group ? `WHERE ${groupKey}=$5` : ""} ORDER BY started_at DESC,id DESC LIMIT 51 OFFSET $4`;
  const [totals, records, daily] = await Promise.all([
    pool.query<UsageTotal>(`WITH ${entries} SELECT category,count(*)::int AS operations,count(*) FILTER(WHERE status='paused')::int AS paused,
      count(*) FILTER(WHERE amount IS NULL AND status NOT IN ('pending','running','paused'))::int AS unmeasured,
      coalesce(sum(amount),0)::text AS amount,coalesce(sum(input_tokens),0)::text AS input_tokens,coalesce(sum(output_tokens),0)::text AS output_tokens,coalesce(sum(total_tokens),0)::text AS total_tokens
      FROM entries GROUP BY category`, values),
    pool.query<UsageEntry | UsageGroup>(recordsQuery, [...values, (page - 1) * 50, ...(group ? [group] : [])]),
    grouped ? pool.query<UsageDay>(`WITH ${entries}, daily AS (
      SELECT (started_at AT TIME ZONE 'UTC')::date AS day,sum(input_tokens)::text AS input_tokens,sum(output_tokens)::text AS output_tokens FROM entries GROUP BY 1
    ), calendar AS (SELECT generate_series(((now() AT TIME ZONE 'UTC')-$3::integer*interval '1 day')::date::timestamp,(now() AT TIME ZONE 'UTC')::date::timestamp,interval '1 day')::date AS day)
    SELECT calendar.day::text,CASE WHEN daily.day IS NULL THEN '0' ELSE daily.input_tokens END AS input_tokens,
      CASE WHEN daily.day IS NULL THEN '0' ELSE daily.output_tokens END AS output_tokens FROM calendar LEFT JOIN daily USING(day) ORDER BY calendar.day`, values) : { rows: undefined },
  ]);
  return { group_by: groupBy, totals: totals.rows, records: records.rows.slice(0, 50), daily: daily.rows, has_more: records.rows.length > 50, page, days };
}
