import assert from "node:assert/strict";
import test from "node:test";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { selfHostedProviders } from "../../src/self-hosted/provider-store";
import { byokModels } from "@inkspect/core/lib/byok/catalog";
import { credentialAAD } from "@inkspect/core/lib/byok/encryption";

test("self-hosted providers encrypt credentials and enforce membership, management, rotation and removal without billing", { skip: !process.env.MEMBERSHIP_TEST_DATABASE_URL }, async () => {
  const schema = `providers_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: process.env.MEMBERSHIP_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
  const directory = await mkdtemp(join(tmpdir(), "inkspect-provider-test-"));
  const previous = process.env.INKSPECT_BYOK_PUBLIC_KEY_FILE;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const secret = "synthetic-provider-test-secret-1234";
  const model = byokModels[0];
  try {
    await writeFile(join(directory, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));
    process.env.INKSPECT_BYOK_PUBLIC_KEY_FILE = join(directory, "public.pem");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE organization(id text PRIMARY KEY); CREATE TABLE member("organizationId" text,"userId" text,role text)');
    await pool.query(`INSERT INTO "user" VALUES ('owner'),('member'),('outsider'); INSERT INTO organization VALUES ('org'),('other'); INSERT INTO member VALUES ('org','owner','owner'),('org','member','member'),('other','outsider','owner')`);
    await pool.query(await readFile(new URL(import.meta.resolve("@inkspect/api/migrations/self-hosted/003_provider_settings.sql")), "utf8"));
    const providers = selfHostedProviders(pool);
    assert.equal(providers.ready(), true);
    assert.equal(await providers.forReview("org", "owner"), null);
    await assert.rejects(providers.setMode("org", "owner", "byok"), /Save a provider key/);
    await assert.rejects(providers.save("org", "member", model.provider, model.id, secret), /owners and admins/);
    await assert.rejects(providers.save("org", "outsider", model.provider, model.id, secret), /owners and admins/);
    await assert.rejects(providers.save("org", "owner", "unsupported", "unknown", secret), /supported model/);
    await providers.save("org", "owner", model.provider, model.id, secret);
    const state = await providers.state("org");
    assert.equal(state.review_provider, "byok");
    assert.equal(state.connection?.key_suffix, "1234");
    assert.doesNotMatch(JSON.stringify(state), /synthetic-provider-test-secret|envelope|ciphertext|wrapped_key/);
    assert.doesNotMatch(JSON.stringify((await pool.query("SELECT * FROM workspace_provider_credential")).rows), /synthetic-provider-test-secret/);
    const selection = await providers.forReview("org", "member");
    assert.ok(selection);
    await assert.rejects(providers.forReview("org", "outsider"), /membership required/);
    await assert.rejects(providers.credentials("other", "outsider", selection), /changed/);
    const { envelope } = await providers.credentials("org", "member", selection);
    const aad = credentialAAD({ organization: "org", id: selection.credential_id, provider: selection.provider, model: selection.model });
    const key = privateDecrypt({ key: privateKey, oaepHash: "sha256", oaepLabel: aad, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrapped_key, "base64"));
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
      decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      assert.equal(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString(), secret);
    } finally { key.fill(0); }
    await providers.save("org", "owner", model.provider, model.id, "synthetic-rotated-provider-secret-5678");
    await assert.rejects(providers.credentials("org", "member", selection), /changed/);
    await assert.rejects(providers.remove("org", "member"), /owners and admins/);
    await providers.remove("org", "owner");
    assert.equal((await providers.state("org")).review_provider, "byok");
    await assert.rejects(providers.forReview("org", "owner"), /Configure your review provider/);
    await assert.rejects(providers.setMode("org", "outsider", "managed"), /owners and admins/);
    await providers.setMode("org", "owner", "managed");
    assert.equal(await providers.forReview("org", "member"), null);
    await pool.query('DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2', ["org", "member"]);
    await assert.rejects(providers.forReview("org", "member"), /membership required/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'billing_%'", [schema])).rows[0].n, 0);
  } finally {
    if (previous === undefined) delete process.env.INKSPECT_BYOK_PUBLIC_KEY_FILE;
    else process.env.INKSPECT_BYOK_PUBLIC_KEY_FILE = previous;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
