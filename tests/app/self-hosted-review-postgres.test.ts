import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { selfHostedReviews } from "../../src/self-hosted/review-store";
import { selfHostedReviewLifecycle } from "../../src/self-hosted/review-lifecycle";
import { engineJobId } from "@inkspect/core/lib/review-identity";
import { ReviewError } from "@inkspect/core/lib/review-access";
import type { ReviewLifecycle } from "@inkspect/core/lib/review-lifecycle";
import { byokModels } from "@inkspect/core/lib/byok/catalog";

test("self-hosted review admission is scoped, durable, idempotent and independent of billing", { skip: !process.env.MEMBERSHIP_TEST_DATABASE_URL }, async () => {
  const schema = `reviews_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: process.env.MEMBERSHIP_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 6 });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE organization(id text PRIMARY KEY); CREATE TABLE member("organizationId" text,"userId" text,role text); CREATE TABLE "githubConnection"(id text,"organizationId" text,"installationId" text,repositories jsonb); CREATE TABLE "githubRepositoryClaim"("organizationId" text,"repositoryId" text)');
    await pool.query(`INSERT INTO "user" VALUES ('owner'),('member'),('outsider'); INSERT INTO organization VALUES ('org'),('other'); INSERT INTO member VALUES ('org','owner','owner'),('org','member','member'),('other','outsider','owner'); INSERT INTO "githubConnection" VALUES ('connection','org','1','[{"id":2,"fullName":"team/repo"}]'); INSERT INTO "githubRepositoryClaim" VALUES ('org','2')`);
    for (const file of ["003_provider_settings.sql", "004_review_execution.sql"]) await pool.query(await readFile(new URL(import.meta.resolve(`@inkspect/api/migrations/self-hosted/${file}`)), "utf8"));
    const reviews = selfHostedReviews(pool);
    const input = { organization: "org", user: "owner", repository: 2, connection: "connection", installation: 1, body: { repository_id: 2, number: 1, base_tip: "a".repeat(40), head: "b".repeat(40) } };
    await assert.rejects(reviews.authorize(input), /active review admission/);
    for (const invalid of [{ ...input, user: "outsider" }, { ...input, installation: 2 }, { ...input, organization: "other" }, { ...input, repository: 3, body: { ...input.body, repository_id: 3 } }]) await assert.rejects(reviews.reserve(invalid), /access is no longer/);
    const rows = await Promise.all([reviews.reserve(input), reviews.reserve(input)]);
    assert.equal(rows[0].request_id, rows[1].request_id);
    assert.equal((await pool.query("SELECT count(*)::int n FROM workspace_review_execution")).rows[0].n, 1);
    await assert.rejects(reviews.reserve({ ...input, user: "member" }), /another workspace member/);
    const id = engineJobId(rows[0].request_id);
    await assert.rejects(reviews.attach(input, `J-${"c".repeat(32)}`), /another run/);
    await reviews.attach(input, id);
    await reviews.reject(input);
    assert.equal((await reviews.authorize(input)).job_id, id, "a concurrent rejection cannot release an attached job");
    await reviews.settle("other", { job: { id, status: "completed" } });
    assert.equal((await reviews.authorize(input)).state, "pending");
    await reviews.settle("org", { job: { id, status: "completed" }, billing_usage: { complete: true, charged_nano_usd: "999", provider_cost: { components: [{ category: "model", complete: true, cost_nano_usd: "123" }] }, input_tokens: 10, output_tokens: 5, model: "operator-model", secret: "must-not-persist", content: "private source" } });
    await reviews.attach(input, id);
    await reviews.settle("org", { job: { id, status: "failed" }, billing_usage: { complete: false } });
    const settled = (await pool.query("SELECT state,measurement FROM workspace_review_execution WHERE job_id=$1", [id])).rows[0];
    assert.equal(settled.state, "completed");
    assert.equal(settled.measurement.provider_cost_nano_usd, "123");
    assert.doesNotMatch(JSON.stringify(settled), /charged|secret|private source/);

    const lifecycle = selfHostedReviewLifecycle(pool, async () => ({ default_model_id: "operator-model", models: [{ id: "operator-model", name: "Operator", provider: "bedrock", routing: "instance", available: true }], region: "test", checked_at: new Date().toISOString() }));
    const access = { organizationId: "org", userId: "owner", member: { role: "owner" }, connections: [] } as Parameters<ReviewLifecycle["start"]>[0];
    const claims = { tenant: "org", subject: "owner", connection: "connection", installation: 1, repository: 2 };
    const next = { ...input.body, number: 2 };
    let posts = 0, gets = 0, edition = "cloud", lost = true;
    const send: Parameters<ReviewLifecycle["start"]>[3] = async (path, _method, body) => {
      if (path === "/github/repositories") return { edition, repositories: [{ id: 2 }] };
      if (path === "/github/reviews") {
        posts++;
        const current = { ...input, body: body as Record<string, unknown> };
        const row = await reviews.authorize(current);
        await reviews.attach(current, engineJobId(row.request_id));
        if (lost) { lost = false; throw new Error("lost response"); }
        return { job: { id: engineJobId(row.request_id), status: "queued" } };
      }
      gets++; return { job: { id: path.split("/").at(-1), status: "queued" } };
    };
    await assert.rejects(lifecycle.start(access, next, claims, send), /self-hosted review service/);
    assert.equal(posts, 0);
    edition = "self-hosted";
    await assert.rejects(lifecycle.start(access, next, claims, send), /lost response/);
    const resumed = await lifecycle.start(access, next, claims, send);
    assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(resumed.job.status, "queued");
    await assert.rejects(lifecycle.start(access, { ...next, number: 3 }, claims, async path => {
      if (path === "/github/repositories") return { edition, repositories: [{ id: 2 }] };
      throw new ReviewError(409, "changed snapshot");
    }), /changed snapshot/);
    const rejected = await reviews.reserve({ ...input, body: { ...next, number: 3 } });
    assert.equal(rejected.state, "pending");

    const model = byokModels[0], selection = { credential_id: randomUUID(), provider: model.provider, model: model.id };
    await pool.query("INSERT INTO workspace_provider_settings VALUES('org','byok')");
    await pool.query("INSERT INTO workspace_provider_credential(organization_id,id,provider,model,envelope,key_suffix,updated_by) VALUES('org',$1,$2,$3,'{}','test','owner')", [selection.credential_id, selection.provider, selection.model]);
    const byokInput = { ...input, body: { ...input.body, number: 4, byok: selection } };
    const byok = await reviews.reserve(byokInput);
    await reviews.attach(byokInput, engineJobId(byok.request_id));
    await reviews.settle("org", { job: { id: engineJobId(byok.request_id), status: "completed" }, billing_usage: { complete: true, charged_nano_usd: "0", calls: 1 } });
    assert.equal((await pool.query("SELECT measurement FROM workspace_review_execution WHERE request_id=$1", [byok.request_id])).rows[0].measurement.provider_cost_nano_usd, undefined, "zero platform charge must not claim a free provider call");
    const rotating = { ...byokInput, body: { ...byokInput.body, number: 5 } };
    await reviews.reserve(rotating);
    await pool.query("UPDATE workspace_provider_credential SET id=$1", [randomUUID()]);
    await assert.rejects(reviews.authorize(rotating), /provider key or model changed/);
    await pool.query("DELETE FROM workspace_provider_settings");
    await pool.query('DELETE FROM member WHERE "userId"=$1', ["owner"]);
    await assert.rejects(reviews.reserve(input), /access is no longer/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
});
