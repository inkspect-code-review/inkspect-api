import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { database } from "./database";
import type { Worker } from "./repository-store";
export class MetadataFailure extends Error { constructor(public code: string, public status = 0) { super(code); } }
export class EmptyRepository extends MetadataFailure { constructor() { super('repository_empty', 409); } }
async function github(path: string, token: string, signal: AbortSignal, body?: object, emptyCommits = false) {
  const response = await fetch(`https://api.github.com${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Inkspect-API' }, ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' });
  // Only the commits endpoint's explicit empty-repository response is benign.
  // Never infer emptiness from repository size, missing permissions or any 409.
  if (emptyCommits && response.status === 409) {
    const text = await response.text();
    let message: unknown;
    if (text.length <= 1024 * 1024) { try { message = JSON.parse(text)?.message; } catch { /* Keep the upstream failure. */ } }
    if (message === 'Git Repository is empty.') throw new EmptyRepository();
  }
  if (!response.ok) throw new MetadataFailure(response.status === 404 || response.status === 401 ? 'access_unavailable' : 'github_unavailable', response.status);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new MetadataFailure('invalid_metadata');
  return JSON.parse(text);
}
async function appToken(appId: string, privateKeyFile: string) {
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const unsigned = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:appId,iat:now-60,exp:now+540})}`;
  const key = await readFile(privateKeyFile);
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key,'base64url')}`;
}
export async function installationMetadata(id: string, signal: AbortSignal) {
  if (!/^[1-9]\d*$/.test(id) || !process.env.GITHUB_APP_ID) throw new MetadataFailure('invalid_metadata');
  const jwt = await appToken(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY_FILE || '/etc/inkspect/github-app.pem');
  const installation = await github(`/app/installations/${id}`, jwt, signal);
  if (String(installation.id) !== id || String(installation.app_id) !== process.env.GITHUB_APP_ID) throw new MetadataFailure('invalid_metadata');
  return installation;
}
export async function repositoryToken(worker: Worker, signal: AbortSignal, contents: boolean | "write" = false, publish = false) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(worker.full_name)) throw new MetadataFailure('invalid_metadata');
  const jwt = await appToken(String(worker.app_id), worker.private_key_file);
  const install = await github(`/repos/${worker.full_name}/installation`, jwt, signal);
  if (String(install.id) !== String(worker.installation_id) || String(install.app_id) !== String(worker.app_id) || install.suspended_at) throw new MetadataFailure('revoked');
  const token = await github(`/app/installations/${worker.installation_id}/access_tokens`, jwt, signal, { repository_ids: [Number(worker.repository_id)], permissions: { metadata: 'read', ...(contents ? { contents: contents === 'write' ? 'write' : 'read' } : {}), ...(publish ? { pull_requests: 'write' } : {}) } });
  if (typeof token.token !== 'string' || token.repositories?.length !== 1 || String(token.repositories[0].id) !== worker.repository_id) throw new MetadataFailure('invalid_metadata');
  return token.token as string;
}
export async function fetchMetadata(worker: Worker, signal: AbortSignal) {
  const token = await repositoryToken(worker, signal);
  const repo = await github(`/repos/${worker.full_name}`, token, signal);
  if (String(repo.id) !== worker.repository_id || repo.full_name.toLowerCase() !== worker.full_name.toLowerCase() || !Number.isSafeInteger(repo.size) || repo.size < 0 || repo.size > Number.MAX_SAFE_INTEGER/1024) throw new MetadataFailure('invalid_metadata');
  return repo.size * 1024;
}
export async function refreshOne(signal: AbortSignal, fetcher = fetchMetadata) {
  const pool = database();
  // A durable lease prevents concurrent API instances from repeating exchanges.
  const claimed = (await pool.query<Worker>(`UPDATE api_repository_worker SET metadata_lease_until=now()+interval '60 seconds' WHERE (organization_id,repository_id) IN (SELECT organization_id,repository_id FROM api_repository_worker WHERE metadata_due_at <= now() AND (metadata_lease_until IS NULL OR metadata_lease_until < now()) AND coalesce(access_error,'') <> 'revoked' ORDER BY metadata_due_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
  if (!claimed) return false;
  try {
    const size = await fetcher(claimed, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
    await pool.query(`UPDATE api_repository_worker SET size_bytes=$3,access_verified_at=now(),access_error=NULL,metadata_due_at=now()+interval '10 minutes',metadata_lease_until=NULL WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$4 AND installation_id=$5 AND coalesce(access_error,'') <> 'revoked'`, [claimed.organization_id,claimed.repository_id,size,claimed.connection_id,claimed.installation_id]);
  } catch (error) {
    const code = error instanceof MetadataFailure ? error.code : 'github_unavailable';
    await pool.query(`UPDATE api_repository_worker SET access_error=$3,metadata_due_at=now()+interval '1 minute',metadata_lease_until=NULL WHERE organization_id=$1 AND repository_id=$2 AND connection_id=$4 AND installation_id=$5 AND coalesce(access_error,'') <> 'revoked'`, [claimed.organization_id,claimed.repository_id,code,claimed.connection_id,claimed.installation_id]);
    console.error(JSON.stringify({event:'repository.metadata',repository:claimed.repository_id,code}));
  }
  return true;
}

// Branch names stay in the query string; the repository identity comes only
// from the trusted worker registration and is rechecked against GitHub.
export async function fetchRepositoryRevision(worker: Worker, signal: AbortSignal) {
  const token = await repositoryToken(worker, signal, true);
  const repo = await github(`/repos/${worker.full_name}`, token, signal);
  if (String(repo.id) !== worker.repository_id || typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== worker.full_name.toLowerCase() || (repo.default_branch != null && (typeof repo.default_branch !== 'string' || !repo.default_branch || repo.default_branch.length > 255))) throw new MetadataFailure('invalid_metadata');
  const commits = await github(`/repos/${worker.full_name}/commits?${new URLSearchParams({ ...(repo.default_branch ? { sha: repo.default_branch } : {}), per_page: '1' })}`, token, signal, undefined, true);
  if (Array.isArray(commits) && commits.length === 0) throw new EmptyRepository();
  if (!repo.default_branch || !Array.isArray(commits) || commits.length !== 1 || typeof commits[0]?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commits[0].sha)) throw new MetadataFailure('invalid_metadata');
  return commits[0].sha as string;
}
