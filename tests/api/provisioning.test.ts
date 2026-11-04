import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, migrateCodexWorker, prepareWorker, repositoryIdentity, reconcileRepositories, registerWorker, type ConnectedRepository, type ServiceTemplate, type LocalWorker, type ProvisioningRuntime } from "../../src/repository-provisioning";

const repository: ConnectedRepository = { organization: 'new-workspace', connection: 'connection-1', installation: 44, repository: 17, fullName: 'team/repo' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'inkspect-provisioning-'));
  const catalog = join(directory, 'template-knowledge.json');
  await writeFile(catalog, JSON.stringify({ tenant_id: 'old-workspace', entries: [{ private: 'old workspace knowledge' }] }));
  const review = join(directory, 'template-review.json');
  await writeFile(review, JSON.stringify({ task: { tenant_id: 'old-workspace', approved: true }, catalog }));
  const template = join(directory, 'template.json');
  await writeFile(template, JSON.stringify({ app_id: 1, private_key_file: '/operator/key', review_file: review,
    review_sha256: hash(await readFile(review)), catalog_sha256: hash(await readFile(catalog)),
    binding: { tenant_id: 'old-workspace', profile: 'trusted-profile' }, manual: { secret_file: '/operator/signing', knowledge_catalog_id: 'old-workspace-catalog' } }));
  return { directory, template, review };
}

test('provisioning binds the new scope and pins a fresh empty catalogue, without copying tenant knowledge', async () => {
  const f = await fixture();
  try {
    const worker = await prepareWorker(f.directory, f.template, repository, 18081);
    const config = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
    const review = JSON.parse(await readFile(config.review_file, 'utf8'));
    const catalog = JSON.parse(await readFile(review.catalog, 'utf8'));
    assert.equal(config.binding.tenant_id, repository.organization);
    assert.equal(config.connection_id, repository.connection);
    assert.equal(config.binding.repository_id, repository.repository);
    assert.equal(config.manual.knowledge_catalog_id, undefined);
    assert.equal(review.task.tenant_id, repository.organization);
    assert.deepEqual(catalog.entries, []);
    assert.equal(catalog.tenant_id, repository.organization);
    assert.equal(config.review_sha256, hash(await readFile(config.review_file)));
    assert.equal(config.catalog_sha256, hash(await readFile(review.catalog)));
    assert.equal(JSON.parse(await readFile(config.access_file, 'utf8')).publish, false);
    for (const change of [{ organization: 'another' }, { connection: 'replacement' }, { installation: 45 }, { repository: 18 }, { fullName: 'team/renamed' }]) {
      assert.notEqual(repositoryIdentity(repository), repositoryIdentity({ ...repository, ...change }));
    }
    assert.throws(() => repositoryIdentity({ ...repository, organization: '../escape' }));
    await writeFile(f.review, '{}');
    await assert.rejects(prepareWorker(f.directory, f.template, repository, 18082), /digest mismatch/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('Bedrock cutover preserves repository scope, knowledge, billing and queue identity', async () => {
  const f = await fixture();
  try {
    const worker = await prepareWorker(f.directory, f.template, repository, 18081);
    const original = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
    original.manual.codex_development = { model: 'development-model' };
    original.manual.billing_url = 'http://127.0.0.1:3002';
    original.manual.knowledge_catalog_id = 'this-workspace-catalog';
    await writeFile(worker.config, JSON.stringify(original));
    const before = JSON.parse(await readFile(original.review_file, 'utf8'));
    const knowledge = await readFile(before.catalog, 'utf8');
    const target = JSON.parse(await readFile(f.review, 'utf8'));
    target.model = { Profile: { Selection: { provider: 'bedrock', model_id: 'approved-model' } } };
    target.limits = { retrieval: { embed_model: 'approved-embed' } };
    await writeFile(f.review, JSON.stringify(target));
    const template = JSON.parse(await readFile(f.template, 'utf8'));
    template.review_sha256 = hash(await readFile(f.review));
    template.binding.profile = 'bedrock-rag';
    await writeFile(f.template, JSON.stringify(template));
    const identity = { ...worker };
    assert.equal(await migrateCodexWorker(worker, f.template), true);
    assert.deepEqual(worker, identity);
    const config = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
    const review = JSON.parse(await readFile(config.review_file, 'utf8'));
    assert.deepEqual(config.binding, { ...original.binding, profile: 'bedrock-rag' });
    assert.equal(config.connection_id, original.connection_id);
    assert.equal(config.access_file, original.access_file);
    assert.deepEqual(config.manual, { secret_file: original.manual.secret_file, billing_url: original.manual.billing_url, knowledge_catalog_id: original.manual.knowledge_catalog_id });
    assert.deepEqual(review.task, before.task);
    assert.equal(review.catalog, before.catalog);
    assert.equal(await readFile(review.catalog, 'utf8'), knowledge);
    assert.deepEqual(review.model, target.model);
    assert.deepEqual(review.limits.retrieval, target.limits.retrieval);
    assert.equal(config.review_sha256, hash(await readFile(config.review_file)));
    assert.deepEqual(JSON.parse(await readFile(original.review_file, 'utf8')), before);
    assert.equal(await migrateCodexWorker(worker, f.template), false);
    // Tampered template bytes must fail before changing a legacy service.
    await writeFile(worker.config, JSON.stringify(original));
    await writeFile(f.review, '{}');
    await assert.rejects(migrateCodexWorker(worker, f.template), /digest mismatch/);
    assert.deepEqual(JSON.parse(await readFile(worker.config, 'utf8')), original);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('reconciliation handles empty installs, retries, reconnects, removals and webhook revocation', { skip: process.env.RUN_API_POSTGRES_TEST !== '1' }, async () => {
  const schema = `api_provision_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 4 });
  const f = await fixture();
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "githubConnection"(id text PRIMARY KEY,"organizationId" text,"installationId" text,repositories text)');
    await pool.query('CREATE TABLE "githubRepositoryClaim"(id text PRIMARY KEY,"organizationId" text,"repositoryId" text)');
    await pool.query(await readFile(new URL(import.meta.resolve('@inkspect/api/migrations/001_repository_api.sql')), 'utf8'));
    const workers: Record<string, LocalWorker> = {};
    let prepared = 0, failStartup = true, stopped = 0;
    let routes: Record<string, string> = {};
    const errors: string[] = [];
    const runtime: ProvisioningRuntime = { workers, persist() {},
      prepare: repo => { prepared++; return prepareWorker(f.directory, f.template, repo, 18081); },
      start: async () => { if (failStartup) throw new Error('Startup failed'); },
      stop: async () => { stopped++; }, routes: async value => { routes = value; },
    };
    const reconcile = () => reconcileRepositories(pool, runtime, key => errors.push(key));
    await reconcile(); assert.equal(prepared, 0);
    await pool.query('INSERT INTO "githubConnection" VALUES($1,$2,$3,$4)', [repository.connection, repository.organization, String(repository.installation), JSON.stringify([{ id: repository.repository, fullName: repository.fullName }])]);
    await reconcile(); assert.equal(prepared, 0); // No workspace claim, no worker.
    await pool.query('INSERT INTO "githubRepositoryClaim" VALUES(\'claim\',$1,$2)', [repository.organization, String(repository.repository)]);
    await reconcile(); assert.equal(prepared, 1); assert.equal(errors.length, 1);
    assert.equal((await pool.query('SELECT * FROM api_repository_worker')).rowCount, 0);
    assert.deepEqual(routes, {});
    failStartup = false;
    await reconcile(); await reconcile();
    assert.equal(prepared, 1); assert.equal((await pool.query('SELECT * FROM api_repository_worker')).rowCount, 1);
    assert.equal(Object.keys(routes).length, 1);
    // Reconciliation never restores access revoked by a signed webhook.
    await pool.query("UPDATE api_repository_worker SET access_error='revoked',metadata_due_at='2100-01-01'");
    await reconcile();
    assert.equal((await pool.query('SELECT access_error FROM api_repository_worker')).rows[0].access_error, 'revoked');
    const oldSchema = Object.values(workers)[0].schema;
    await pool.query('UPDATE "githubConnection" SET id=\'replacement\'');
    await reconcile(); assert.equal(stopped, 1); assert.equal(prepared, 2);
    const current = (await pool.query('SELECT * FROM api_repository_worker')).rows[0];
    assert.equal(current.connection_id, 'replacement'); assert.notEqual(current.queue_schema, oldSchema);
    assert.equal(current.access_verified_at, null);
    const worker = Object.values(workers)[0];
    const config = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
    // A connection removed while its worker starts cannot be registered.
    await pool.query('DELETE FROM "githubConnection"');
    assert.equal(await registerWorker(pool, { ...repository, connection: 'replacement' }, worker, config), false);
    await reconcile(); assert.equal(stopped, 2);
    assert.equal((await pool.query('SELECT * FROM api_repository_worker')).rowCount, 0);
    assert.deepEqual(workers, {}); assert.deepEqual(routes, {});
  } finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); await rm(f.directory, { recursive: true, force: true }); }
});
