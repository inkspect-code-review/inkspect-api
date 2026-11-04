import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { selfHostedUsageHistory } from "../../src/self-hosted/usage-history";
import type { UsageEntry, UsageGroup } from "@inkspect/core/lib/usage/usage-display";

test("self-hosted usage joins measurements without leaking tenants or inventing costs", { skip: !process.env.MEMBERSHIP_TEST_DATABASE_URL }, async () => {
  const schema = `usage_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: process.env.MEMBERSHIP_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE organization(id text PRIMARY KEY); CREATE TABLE api_repository_worker(organization_id text,repository_id text,full_name text,PRIMARY KEY(organization_id,repository_id)); INSERT INTO "user" VALUES (\'owner\'); INSERT INTO organization VALUES (\'org\'),(\'other\'); INSERT INTO api_repository_worker VALUES(\'org\',\'2\',\'team/repo\'),(\'other\',\'2\',\'private/other\')');
    for (const file of ["002_chat_execution.sql", "004_review_execution.sql", "005_provider_usage.sql"]) await pool.query(await readFile(new URL(import.meta.resolve(`@inkspect/api/migrations/self-hosted/${file}`)), "utf8"));
    await pool.query(`INSERT INTO workspace_review_execution(request_id,organization_id,user_id,repository_id,connection_id,installation_id,request,state,measurement)
      VALUES ('measured','org','owner','2','connection','1','{}','completed','{"input_tokens":10,"output_tokens":5,"provider_cost_nano_usd":"9007199254740993"}'),
      ('unknown','org','owner','2','connection','1','{}','failed','{}'),('pending','org','owner','2','connection','1','{}','pending',NULL),
      ('foreign','other','owner','2','connection','1','{}','completed','{"provider_cost_nano_usd":"9999999999999999"}')`);
    await pool.query(`INSERT INTO workspace_chat_usage(organization_id,operation_id,user_id,message_id,calls,measurement) VALUES
      ('org','answer:1','owner','1',1,'{"model":"chat-model","inputTokens":20,"outputTokens":7,"providerCostNanoUSD":"12"}'),
      ('org','answer:2','owner','2',1,'{}'),('org','route:3','owner','3',0,'{}')`);
    await pool.query(`INSERT INTO workspace_provider_usage(organization_id,category,operation_id,user_id,repository_id,measurement)
      SELECT 'org','embedding','index:'||n,'owner','2','{"provider":"embed","input_tokens":2,"output_tokens":0,"provider_cost_nano_usd":"1","complete":true}'::jsonb FROM generate_series(1,52) n`);
    await pool.query(`INSERT INTO workspace_provider_usage VALUES('org','embedding','old','owner','2','{"provider_cost_nano_usd":"999"}',now()-interval '91 day',now())`);
    const read = (query = "", org = "org") => selfHostedUsageHistory(pool, org, new URLSearchParams(query));
    const all = await read();
    assert.equal(all.records.length, 50); assert.equal(all.has_more, true);
    assert.equal(all.totals.find(t => t.category === "review")?.amount, "9007199254740993", "preserve integer precision");
    assert.equal(all.totals.find(t => t.category === "review")?.unmeasured, 1, "pending is not an unknown completed call");
    assert.equal(all.totals.find(t => t.category === "embedding")?.amount, "52");
    assert.equal(all.totals.find(t => t.category === "chat")?.unmeasured, 1, "no-call routing has a known zero cost");
    const next = await read("page=2");
    assert.equal(next.records.length, 8); assert.equal(next.has_more, false);
    assert.equal(new Set([...all.records, ...next.records].map(r => r.id)).size, 58);
    assert.doesNotMatch(JSON.stringify(all), /private\/other|9999999999999999/);
    const chat = (await read("category=chat")).records as UsageEntry[];
    assert.equal(chat.find(r => r.operation_id === "answer:1")?.input_tokens, "20");
    assert.equal(chat.find(r => r.operation_id === "answer:2")?.amount, null);
    assert.equal(chat.find(r => r.operation_id === "route:3")?.amount, "0");
    const grouped = await read("groupBy=day&category=review&days=7");
    const group = grouped.records[0] as UsageGroup;
    assert.equal(group.operations, 3); assert.equal(group.unmeasured, 1); assert.equal(group.in_progress, 1);
    assert.equal(group.amount, "9007199254740993"); assert.equal(group.repository_name, "team/repo");
    assert.equal(grouped.daily?.at(-1)?.input_tokens, "10");
    assert.equal(grouped.daily?.[0]?.input_tokens, "0");
    assert.equal((await read(`group=${group.id}`)).records.length, 3);
    assert.equal((await read(`group=${group.id}`, "other")).records.length, 1, "the group hash is not an authorization token; organization remains mandatory");
    for (const query of ["page=0", "page=201", "days=8", "category=seats", "group=x", `group=${group.id}&groupBy=day`]) await assert.rejects(read(query), /valid usage filter/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
});
