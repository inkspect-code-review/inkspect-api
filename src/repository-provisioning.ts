import { connectedRepositories, repositoryIdentity, type ConnectedRepository } from "./connected-repositories";
export { connectedRepositories, repositoryIdentity, type ConnectedRepository } from "./connected-repositories";
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';

export type LocalWorker = { origin: string; pid?: number; index_pid?: number; schema: string; config: string };
export type ServiceTemplate = {
  listen: string; app_id: number; private_key_file: string; connection_id: string;
  access_file: string; review_file: string; review_sha256: string; catalog_sha256: string;
  binding: { id: string; tenant_id: string; owner: string; repository: string; repository_id: number; installation_id: number; [key: string]: unknown };
  manual: { secret_file: string; [key: string]: unknown }; [key: string]: unknown;
};
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const repositoryKey = (repo: ConnectedRepository) => `${repo.organization}:${repo.repository}`;
export function matchesRepository(config: ServiceTemplate, repo: ConnectedRepository) {
  return config.binding.tenant_id === repo.organization && config.connection_id === repo.connection &&
    config.binding.installation_id === repo.installation && config.binding.repository_id === repo.repository &&
    `${config.binding.owner}/${config.binding.repository}` === repo.fullName;
}
export async function writePrivateJSON(path: string, value: unknown) {
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}

// Call only at supervisor startup, after draining and stopping both worker modes.
// Keep queue identity, access, knowledge and task criteria intact across cutover.
export async function migrateCodexWorker(worker: LocalWorker, templatePath: string): Promise<boolean> {
  const config = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
  if (!config.manual?.codex_development) return false;
  const template = JSON.parse(await readFile(templatePath, 'utf8')) as ServiceTemplate;
  const targetBytes = await readFile(template.review_file);
  if (hash(targetBytes) !== template.review_sha256) throw new Error('Worker review template digest mismatch');
  const target = JSON.parse(targetBytes.toString());
  if (!template.manual || template.manual.codex_development || template.container ||
      !target.task?.approved || target.model?.Profile?.Selection?.provider !== 'bedrock') {
    throw new Error('An approved Bedrock worker template is required');
  }
  if (config.container) throw new Error('Bedrock workers require process execution');
  const reviewBytes = await readFile(config.review_file);
  if (hash(reviewBytes) !== config.review_sha256) throw new Error('Existing worker review digest mismatch');
  const review = JSON.parse(reviewBytes.toString());
  if (review.task?.tenant_id !== config.binding.tenant_id || !review.task?.approved ||
      hash(await readFile(review.catalog)) !== config.catalog_sha256) throw new Error('Existing worker scope or catalogue mismatch');
  review.model = target.model;
  review.limits = { ...review.limits, retrieval: target.limits?.retrieval };
  // A separate file also preserves a shared legacy profile and rollback evidence.
  const reviewPath = resolve(dirname(worker.config), 'review-bedrock.json');
  await writePrivateJSON(reviewPath, review);
  config.review_file = reviewPath;
  config.review_sha256 = hash(await readFile(reviewPath));
  config.binding.profile = template.binding.profile;
  delete config.manual.codex_development;
  await writePrivateJSON(worker.config, config);
  return true;
}

// Fresh tenants receive an empty knowledge catalogue, never the template
// tenant's documents. Pin both derived files with the engine's SHA-256 contract.
export async function prepareWorker(root: string, templatePath: string, repo: ConnectedRepository, port: number): Promise<LocalWorker> {
  const identity = repositoryIdentity(repo), directory = resolve(root, identity);
  const template = JSON.parse(await readFile(templatePath, 'utf8')) as ServiceTemplate;
  if (!template.manual || template.ci_schedule || template.ci_bindings || !Number.isSafeInteger(template.app_id) || template.app_id < 1) throw new Error('A manual worker template is required');
  const reviewBytes = await readFile(template.review_file);
  if (hash(reviewBytes) !== template.review_sha256) throw new Error('Worker review template digest mismatch');
  const review = JSON.parse(reviewBytes.toString());
  const catalogBytes = await readFile(review.catalog);
  if (hash(catalogBytes) !== template.catalog_sha256) throw new Error('Worker catalogue template digest mismatch');
  if (!review.task?.approved) throw new Error('Worker review template is not approved');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const catalogPath = resolve(directory, 'knowledge.json');
  const reviewPath = resolve(directory, 'review.json');
  await writePrivateJSON(catalogPath, { id: 'repository-bootstrap', version: '1', tenant_id: repo.organization, entries: [] });
  review.task = { ...review.task, tenant_id: repo.organization };
  review.catalog = catalogPath;
  await writePrivateJSON(reviewPath, review);
  const [owner, repository] = repo.fullName.split('/');
  const config: ServiceTemplate = { ...template, listen: `127.0.0.1:${port}`, connection_id: repo.connection,
    binding: { ...template.binding, id: `dashboard-${identity}`, tenant_id: repo.organization, owner, repository, repository_id: repo.repository, installation_id: repo.installation },
    access_file: resolve(directory, 'access.json'), review_file: reviewPath,
    review_sha256: hash(await readFile(reviewPath)), catalog_sha256: hash(await readFile(catalogPath)),
  };
  // The bootstrap catalogue is intentionally new for this workspace.
  delete config.manual.knowledge_catalog_id;
  await writePrivateJSON(config.access_file, { tenant_id: repo.organization, app_id: config.app_id, installation_id: repo.installation, repository_id: repo.repository, connection_id: repo.connection, review: true, publish: false });
  const configPath = resolve(directory, 'service.json');
  await writePrivateJSON(configPath, config);
  return { origin: `http://${config.listen}`, schema: `dashboard_repo_${identity}`, config: configPath };
}

export async function registerWorker(pool: Pool, repo: ConnectedRepository, worker: LocalWorker, config: ServiceTemplate) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    // Serialize with callback updates/removal, then recheck after startup.
    const current = await tx.query(`SELECT id FROM "githubConnection" WHERE id=$1 AND "organizationId"=$2 AND "installationId"=$3
      AND repositories::jsonb @> $4::jsonb FOR UPDATE`, [repo.connection, repo.organization, String(repo.installation), JSON.stringify([{ id: repo.repository, fullName: repo.fullName }])]);
    const claim = await tx.query('SELECT id FROM "githubRepositoryClaim" WHERE "organizationId"=$1 AND "repositoryId"=$2 FOR UPDATE', [repo.organization, String(repo.repository)]);
    if (!current.rowCount || !claim.rowCount) { await tx.query('ROLLBACK'); return false; }
    await tx.query(`INSERT INTO api_repository_worker(organization_id,repository_id,connection_id,installation_id,full_name,queue_database,queue_schema,app_id,private_key_file)
      VALUES($1,$2,$3,$4,$5,$9,$6,$7,$8)
      ON CONFLICT(organization_id,repository_id) DO UPDATE SET
      connection_id=excluded.connection_id,installation_id=excluded.installation_id,full_name=excluded.full_name,
      queue_database=excluded.queue_database,queue_schema=excluded.queue_schema,app_id=excluded.app_id,private_key_file=excluded.private_key_file,
      size_bytes=NULL,access_verified_at=NULL,access_error=CASE WHEN api_repository_worker.connection_id=excluded.connection_id AND api_repository_worker.installation_id=excluded.installation_id THEN api_repository_worker.access_error ELSE NULL END,
      metadata_due_at=now(),metadata_lease_until=NULL
      WHERE (api_repository_worker.connection_id,api_repository_worker.installation_id,api_repository_worker.full_name,api_repository_worker.queue_schema)
        IS DISTINCT FROM (excluded.connection_id,excluded.installation_id,excluded.full_name,excluded.queue_schema)`,
    [repo.organization, String(repo.repository), repo.connection, repo.installation, repo.fullName, worker.schema, config.app_id, config.private_key_file, worker.schema === 'inkspect_manual' ? 'legacy' : 'app']);
    await tx.query('COMMIT'); return true;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

export type ProvisioningRuntime = {
  workers: Record<string, LocalWorker>;
  prepare(repo: ConnectedRepository): Promise<LocalWorker>;
  start(key: string, worker: LocalWorker, repo: ConnectedRepository): Promise<void>;
  stop(key: string, worker: LocalWorker): Promise<void>;
  persist(): void;
  routes(routes: Record<string, string>): Promise<void>;
};

export async function reconcileRepositories(pool: Pool, runtime: ProvisioningRuntime, onError: (key: string) => void) {
  const repositories = await connectedRepositories(pool);
  const desired = new Map(repositories.map(repo => [repositoryKey(repo), repo]));
  // Stop obsolete processes before allowing a replacement to accept work.
  for (const [key, worker] of Object.entries(runtime.workers)) {
    const config = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
    const repo = desired.get(key);
    if (repo && matchesRepository(config, repo)) continue;
    await runtime.stop(key, worker);
    await pool.query('DELETE FROM api_repository_worker WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$3 AND queue_schema=$4',
      [config.binding.tenant_id, String(config.binding.repository_id), config.connection_id, worker.schema]);
    delete runtime.workers[key]; runtime.persist();
  }
  const routes: Record<string, string> = {};
  // Remove stale routes immediately even if another repository needs retries.
  await runtime.routes(Object.fromEntries(Object.entries(runtime.workers).map(([key, w]) => [key, w.origin])));
  for (const repo of repositories) {
    const key = repositoryKey(repo);
    try {
      let worker = runtime.workers[key];
      if (!worker) {
        worker = await runtime.prepare(repo);
        runtime.workers[key] = worker; runtime.persist();
      }
      await runtime.start(key, worker, repo);
      const config = JSON.parse(await readFile(worker.config, 'utf8')) as ServiceTemplate;
      if (!await registerWorker(pool, repo, worker, config)) {
        await runtime.stop(key, worker);
        delete runtime.workers[key]; runtime.persist();
        continue;
      }
      routes[key] = worker.origin;
    } catch { onError(key); }
  }
  await runtime.routes(routes);
}
