import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { selfHostedChatLedger } from "../../src/self-hosted/chat-ledger";
import type { ChatReplyInput } from "@inkspect/core/lib/chat-ai";

test("self-hosted chat tracks execution and measurements without credits or duplicate execution", { skip: !process.env.MEMBERSHIP_TEST_DATABASE_URL }, async () => {
  const schema = `chat_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: process.env.MEMBERSHIP_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE organization(id text PRIMARY KEY); CREATE TABLE member("organizationId" text,"userId" text); CREATE TABLE "chatConversation"(id text PRIMARY KEY,"organizationId" text,"userId" text)');
    await pool.query(`INSERT INTO "user" VALUES ('owner'),('other'); INSERT INTO organization VALUES ('org'),('other'); INSERT INTO member VALUES ('org','owner'),('org','other'); INSERT INTO "chatConversation" VALUES ('conversation','org','owner'),('another','org','owner')`);
    await pool.query(await readFile(new URL(import.meta.resolve("@inkspect/api/migrations/self-hosted/002_chat_execution.sql")), "utf8"));
    const ledger = selfHostedChatLedger(pool);
    const input: ChatReplyInput = { organizationId: "org", userId: "owner", conversationId: "conversation", messageId: "message", repositoryNames: [], messages: [{ role: "user", content: "Private question" }] };
    const reply = { content: "Private answer", model: "test", inputTokens: 5, outputTokens: 7, totalTokens: 12, durationMs: 10, chargedNanoUSD: "123" };
    const results = await Promise.allSettled([ledger.begin(input, "test"), ledger.begin(input, "test")]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    await assert.rejects(ledger.begin({ ...input, userId: "other" }, "test"), /denied/);
    await assert.rejects(ledger.begin({ ...input, conversationId: "another" }, "test"), /denied/);
    await ledger.check(input, "search");
    await ledger.routing(input, undefined, reply);
    await ledger.routing(input, undefined, reply);
    await ledger.complete(input, reply, true);
    assert.deepEqual(await ledger.begin(input, "test"), reply);
    const measurements = (await pool.query("SELECT * FROM workspace_chat_usage ORDER BY operation_id")).rows;
    assert.equal(measurements.length, 2);
    assert.equal(measurements[0].measurement.providerCostNanoUSD, "123");
    assert.doesNotMatch(JSON.stringify(measurements), /Private question|Private answer|chargedNanoUSD/);
    await ledger.delivered(input.messageId);
    await assert.rejects(ledger.begin(input, "test"), /already saved/);
    const failed = { ...input, messageId: "failed" };
    await ledger.begin(failed, "test"); await ledger.failed(failed, "test", true);
    await assert.rejects(ledger.begin(failed, "test"), /already started/);
    const pending = { ...input, messageId: "pending" };
    await ledger.begin(pending, "test");
    await ledger.deleteConversation("org", "conversation");
    await assert.rejects(ledger.check(pending, "answer"), /no longer active/);
    await ledger.complete(pending, reply, true);
    assert.equal((await pool.query("SELECT result FROM workspace_chat_turn WHERE message_id='pending'")).rows[0].result, null);
    await pool.query('DELETE FROM member WHERE "userId"=$1', ["owner"]);
    await assert.rejects(ledger.begin({ ...input, messageId: "revoked" }, "test"), /denied/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
});
