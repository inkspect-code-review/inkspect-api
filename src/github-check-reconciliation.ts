import type { PoolClient } from 'pg';
import { database } from './database';
import type { Workflow } from './pull-request-workflow-core';

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

// A fork PR may have no pull_requests in the check payload. Locate the PR by
// our persisted check receipt, never by a sender-provided URL or branch name.
export async function enqueueCheckRerequest(data: any, delivery: string | null, pool = database()) {
  const run = data?.check_run;
  if (data?.action !== 'rerequested' || !delivery || !/^[a-z0-9-]{1,100}$/i.test(delivery) || run?.name !== 'Inkspect' ||
      !positive(run.id) || !positive(run.app?.id) || !positive(data.installation?.id) ||
      !positive(data.repository?.id) || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      typeof run.external_id !== 'string' || run.external_id.length > 300 ||
      data.sender?.type !== 'User' || typeof data.sender.login !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(data.sender.login)) return;
  const request = { delivery, check: run.id, head: run.head_sha, sender: data.sender.login };
  await pool.query(`UPDATE api_pull_request_workflow w SET github_rerequest=$1::jsonb || jsonb_build_object('base',w.state->>'base'),wake_at=clock_timestamp(),next_run_at=clock_timestamp()
    FROM api_repository_worker r WHERE r.organization_id=w.organization_id AND r.connection_id=w.connection_id
    AND r.repository_id=w.repository_id AND r.installation_id=w.installation_id AND r.app_id::text=$2
    AND w.repository_id=$3 AND w.installation_id=$4 AND w.state#>>'{check,id}'=$5 AND w.state#>>'{check,head}'=$6
    AND ((w.state#>>'{check,job}') || coalesce('/' || (w.state#>>'{check,attempt}'),''))=$7`,
    [request,String(run.app.id),String(data.repository.id),data.installation.id,String(run.id),run.head_sha,run.external_id]);
}

export async function matchingGithubReview(tx: PoolClient, scope: Workflow, head: string, base: string, baseRef: string, rerequest: boolean) {
  const result = await tx.query<{ id: string }>(`SELECT j.id FROM api_engine_job j
    LEFT JOIN api_engine_job prior ON prior.id=$8
    WHERE j.organization_id=$1 AND j.repository_id=$2 AND j.connection_id=$3 AND j.installation_id=$4
      AND j.request->>'number'=$5 AND j.snapshot->>'head'=$6 AND j.snapshot->>'base_tip'=$7
      AND j.snapshot->>'base_ref'=$9
      AND NOT (j.request ? 'fix_of') AND (j.status='completed' OR ($10 AND j.status IN ('queued','running','paused')))
      AND ($10 OR prior.id IS NULL OR (j.created_at,j.id)>=(prior.created_at,prior.id))
    ORDER BY j.created_at DESC,j.id DESC LIMIT 1`, [scope.organization_id, scope.repository_id,
    scope.connection_id, scope.installation_id, String(scope.number), head, base, scope.state.job ?? null, baseRef, rerequest]);
  return result.rows[0]?.id;
}
