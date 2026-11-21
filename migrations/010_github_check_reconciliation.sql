ALTER TABLE api_pull_request_workflow ADD COLUMN IF NOT EXISTS github_rerequest jsonb;

-- A manual review can finish after the GitHub workflow has gone idle.
-- Wake its existing PR workflow transactionally with the completed report.
CREATE OR REPLACE FUNCTION api_wake_review_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE api_pull_request_workflow
     SET wake_at=clock_timestamp(), next_run_at=clock_timestamp()
   WHERE organization_id=NEW.organization_id AND repository_id=NEW.repository_id
     AND connection_id=NEW.connection_id AND installation_id=NEW.installation_id
     AND number::text=NEW.request->>'number' AND state->>'head'=NEW.snapshot->>'head'
     AND state->>'base'=NEW.snapshot->>'base_tip' AND state ? 'check'
     AND state->>'job' IS DISTINCT FROM NEW.id;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='api_engine_job'::regclass AND tgname='api_completed_review_check') THEN
    CREATE TRIGGER api_completed_review_check AFTER UPDATE OF status ON api_engine_job
      FOR EACH ROW WHEN (NEW.status='completed' AND OLD.status IS DISTINCT FROM NEW.status AND NOT (NEW.request ? 'fix_of'))
      EXECUTE FUNCTION api_wake_review_check();
    UPDATE api_pull_request_workflow w SET wake_at=clock_timestamp(),next_run_at=clock_timestamp()
     WHERE w.state#>>'{check,phase}' IN ('failed','cancelled','unavailable') AND EXISTS (
       SELECT 1 FROM api_engine_job j WHERE j.organization_id=w.organization_id AND j.repository_id=w.repository_id
         AND j.connection_id=w.connection_id AND j.installation_id=w.installation_id AND j.request->>'number'=w.number::text
         AND j.snapshot->>'head'=w.state->>'head' AND j.snapshot->>'base_tip'=w.state->>'base'
         AND j.status='completed' AND NOT (j.request ? 'fix_of') AND j.id IS DISTINCT FROM w.state->>'job');
  END IF;
END;
$$;
