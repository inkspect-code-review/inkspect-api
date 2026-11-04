import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { claimReview, recoverReview } from "../../src/engine-queue";
import type { EngineJob } from "../../src/engine-store";

const url = process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL;
test('rolling generation preserves running ownership, blocks old claims and never replays an orphan', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 5 });
  const owner = await pool.connect(), candidate = await pool.connect();
  try {
    await pool.query(await readFile(new URL(import.meta.resolve('@inkspect/api/migrations/004_rust_engine.sql')), 'utf8'));
    await pool.query('TRUNCATE api_engine_event,api_engine_job');
    await pool.query("UPDATE api_engine_runtime SET generation='old' WHERE id");
    const make = async (id: string, repo: string) => (await pool.query<EngineJob>(`INSERT INTO api_engine_job(id,request_id,organization_id,repository_id,connection_id,installation_id,subject,request,snapshot,host_config)
      VALUES($1,$1,'tenant',$2,'connection',1,'user','{}','{}','{}') RETURNING *`, [id, repo])).rows[0];
    const a = await make('J-' + 'a'.repeat(32), '1'), b = await make('J-' + 'b'.repeat(32), '1'), c = await make('J-' + 'c'.repeat(32), '2');
    await owner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`rust-review:${a.id}`]);
    assert.equal(await claimReview(owner, a, 'old'), true);
    await pool.query("UPDATE api_engine_runtime SET generation='new' WHERE id");
    assert.equal(await claimReview(candidate, c, 'old'), false, 'retired generation cannot claim another job');
    assert.equal(await claimReview(candidate, b, 'new'), false, 'new generation cannot overlap a running repository review');
    assert.equal(await claimReview(candidate, c, 'new'), true, 'other repositories continue during drain');
    assert.equal(await recoverReview(candidate, a.id, { complete: false }), false, 'recovery cannot steal a live old owner');
    await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`rust-review:${a.id}`]);
    assert.equal(await recoverReview(candidate, a.id, { complete: false }), true);
    assert.equal((await pool.query('SELECT status FROM api_engine_job WHERE id=$1', [a.id])).rows[0].status, 'failed');
    assert.equal(await claimReview(candidate, a, 'new'), false, 'possibly paid interrupted work must not replay');
    assert.equal(await claimReview(candidate, b, 'new'), true);
  } finally { owner.release(true); candidate.release(true); await pool.end(); }
});
