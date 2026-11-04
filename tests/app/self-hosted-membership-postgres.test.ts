import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { selfHostedMembership } from "../../src/self-hosted/membership-service";

test("self-hosted invitations work without billing tables and preserve scope, roles and concurrent acceptance", { skip: !process.env.MEMBERSHIP_TEST_DATABASE_URL }, async () => {
  const schema = `membership_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: process.env.MEMBERSHIP_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "user"(id text PRIMARY KEY,email text NOT NULL); CREATE TABLE organization(id text PRIMARY KEY,name text); CREATE TABLE member(id text PRIMARY KEY,"organizationId" text,"userId" text,role text,"createdAt" timestamptz,UNIQUE("organizationId","userId"))');
    await pool.query(`INSERT INTO "user" VALUES ('owner','owner@example.com'),('guest','guest@example.com'),('member','member@example.com'); INSERT INTO organization VALUES ('org','Team'),('other','Other'); INSERT INTO member VALUES ('owner-member','org','owner','owner',now()),('viewer-member','org','member','member',now())`);
    const migration = await readFile(new URL(import.meta.resolve("@inkspect/api/migrations/self-hosted/001_membership.sql")), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    const service = selfHostedMembership(pool);
    const input = { email: " Guest@Example.com ", role: "member" };
    await assert.rejects(service.invite("org", "member", input), /Only workspace owners/);
    await assert.rejects(service.invite("other", "owner", input), /Only workspace owners/);
    await assert.rejects(service.invite("org", "owner", { ...input, role: "owner" }), /member or admin/);
    const results = await Promise.allSettled([service.invite("org", "owner", input), service.invite("org", "owner", input)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const invitation = (await service.list("org"))[0];
    assert.equal(invitation.email, "guest@example.com");
    assert.equal(await service.find(invitation.id, "wrong@example.com"), undefined);
    assert.deepEqual(await service.list("other"), []);
    await assert.rejects(service.cancel("other", "owner", invitation.id), /Only workspace owners/);
    const guest = { id: "guest", email: "guest@example.com", emailVerified: true };
    await assert.rejects(service.accept(invitation.id, { ...guest, emailVerified: false }), /Verify your email/);
    await assert.rejects(service.accept(invitation.id, { ...guest, email: "wrong@example.com" }), /No invitation/);
    assert.deepEqual(await Promise.all([service.accept(invitation.id, guest), service.accept(invitation.id, guest)]), [{ organizationId: "org" }, { organizationId: "org" }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM member WHERE "userId"=$1', [guest.id])).rows[0].n, 1);
    await pool.query('DELETE FROM member WHERE "userId"=$1', [guest.id]);
    await assert.rejects(service.accept(invitation.id, guest), /expired or was cancelled/);
    const cancelled = await service.invite("org", "owner", input);
    await service.cancel("org", "owner", cancelled.id);
    await assert.rejects(service.accept(cancelled.id, guest), /expired or was cancelled/);
    const expired = await service.invite("org", "owner", input);
    await pool.query("UPDATE workspace_invitation SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await assert.rejects(service.accept(expired.id, guest), /expired or was cancelled/);
    const renewed = await service.invite("org", "owner", { ...input, role: "admin" });
    await service.accept(renewed.id, guest);
    assert.equal((await pool.query('SELECT role FROM member WHERE "userId"=$1', [guest.id])).rows[0].role, "admin");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
