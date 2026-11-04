import type { Auth } from "@inkspect/core/lib/github";
import { organizationAccess } from "@inkspect/core/lib/organization-access";
import { readReviewJSON, reviewJSON, reviewFailure, ReviewError } from "@inkspect/core/lib/review-access";
import { database } from "./database";
import { installationMetadata } from "./metadata";

export function installationSettingsURL(value: unknown, id: string) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(id)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return null;
    return new RegExp(`^/(?:organizations/[A-Za-z0-9-]+/)?settings/installations/${id}$`).test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export async function savedGitHubPermissions(organization: string) {
  const result = await database().query(`SELECT c."installationId" AS installation_id,c."accountLogin" AS account,
    p.contents,p.installation_url,p.checked_at,coalesce(p.unavailable,false) AS unavailable
    FROM "githubConnection" c LEFT JOIN api_github_permissions p
    ON p.installation_id=c."installationId" AND p.app_id=$2
    WHERE c."organizationId"=$1 ORDER BY c."accountLogin"`, [organization, process.env.GITHUB_APP_ID || '']);
  return result.rows;
}

export async function refreshGitHubPermission(id: string, signal: AbortSignal, force = false, fetcher = installationMetadata) {
  const pool = database();
  // Both explicit checks and background workers share a lease and a short cooldown.
  const claimed = await pool.query(`UPDATE api_github_permissions SET lease_until=now()+interval '30 seconds'
    WHERE installation_id=$1 AND app_id=$2 AND (lease_until IS NULL OR lease_until<now())
      AND (next_check_at<=now() OR ($3 AND (checked_at IS NULL OR checked_at<now()-interval '10 seconds')))
      AND EXISTS(SELECT 1 FROM "githubConnection" WHERE "installationId"=$1) RETURNING installation_id`,
  [id, process.env.GITHUB_APP_ID || '', force]);
  if (!claimed.rowCount) return;
  try {
    const value = await fetcher(id, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    const url = installationSettingsURL(value.html_url, id);
    if (String(value.id) !== id || String(value.app_id) !== process.env.GITHUB_APP_ID || !url) throw new Error('Invalid installation metadata');
    const contents = value.permissions?.contents === 'write' ? 'write' : value.permissions?.contents === 'read' ? 'read' : 'none';
    await pool.query(`UPDATE api_github_permissions SET contents=$2,installation_url=$3,checked_at=now(),unavailable=$4,
      next_check_at=now()+interval '5 minutes',lease_until=NULL WHERE installation_id=$1`, [id, contents, url, !!value.suspended_at]);
  } catch {
    await pool.query(`UPDATE api_github_permissions SET unavailable=true,checked_at=now(),
      next_check_at=now()+interval '1 minute',lease_until=NULL WHERE installation_id=$1`, [id]);
    throw new ReviewError(503, 'GitHub permissions could not be checked. Please try again shortly.');
  }
}

export async function seedGitHubPermissions() {
  if (!process.env.GITHUB_APP_ID) return;
  await database().query(`INSERT INTO api_github_permissions(installation_id,app_id)
    SELECT DISTINCT "installationId",$1 FROM "githubConnection" WHERE "installationId" ~ '^[1-9][0-9]*$'
    ON CONFLICT(installation_id) DO UPDATE SET app_id=excluded.app_id,contents=NULL,checked_at=NULL,next_check_at=now()
    WHERE api_github_permissions.app_id<>excluded.app_id`, [process.env.GITHUB_APP_ID]);
}

export async function refreshOneGitHubPermission(signal: AbortSignal) {
  await seedGitHubPermissions();
  const next = (await database().query(`SELECT p.installation_id FROM api_github_permissions p
    WHERE p.app_id=$1 AND p.next_check_at<=now() AND (p.lease_until IS NULL OR p.lease_until<now())
      AND EXISTS(SELECT 1 FROM "githubConnection" c WHERE c."installationId"=p.installation_id)
    ORDER BY p.next_check_at LIMIT 1`, [process.env.GITHUB_APP_ID || ''])).rows[0];
  if (next) await refreshGitHubPermission(next.installation_id, signal);
}

export async function githubPermissions(request: Request, auth: Auth, services = { savedGitHubPermissions, seedGitHubPermissions, refreshGitHubPermission }) {
  try {
    const access = await organizationAccess(request, auth);
    if (request.method !== 'GET' && request.method !== 'POST') throw new ReviewError(405, 'Method not allowed.');
    if (request.method === 'POST') {
      if (!access.canManage) throw new ReviewError(403, 'Only workspace owners and admins can recheck GitHub access.');
      const body = await readReviewJSON(request);
      const connections = await services.savedGitHubPermissions(access.organizationId);
      if (Object.keys(body).length !== 1 || !connections.some(c => c.installation_id === body.installationId)) throw new ReviewError(404, 'GitHub connection not found.');
      await services.seedGitHubPermissions();
      await services.refreshGitHubPermission(String(body.installationId), request.signal, true);
    }
    return reviewJSON({ connections: await services.savedGitHubPermissions(access.organizationId), can_manage: access.canManage });
  } catch (error) { return reviewFailure(error); }
}

export async function githubInstallationAccess(request: Request, auth: Auth, services = { savedGitHubPermissions, seedGitHubPermissions, refreshGitHubPermission }) {
  try {
    if (request.method !== 'GET') throw new ReviewError(405, 'Method not allowed.');
    const access = await organizationAccess(request, auth);
    if (!access.canManage) throw new ReviewError(403, 'Only workspace owners and admins can manage GitHub access.');
    const id = new URL(request.url).searchParams.get('installationId');
    let connection = (await services.savedGitHubPermissions(access.organizationId)).find(c => c.installation_id === id);
    if (!connection) throw new ReviewError(404, 'GitHub connection not found.');
    let url = installationSettingsURL(connection.installation_url, connection.installation_id);
    // Existing installations already have a canonical settings URL in the
    // metadata cache. New connections may need their first explicit check.
    if (!url || connection.unavailable) {
      await services.seedGitHubPermissions();
      await services.refreshGitHubPermission(connection.installation_id, request.signal, true);
      connection = (await services.savedGitHubPermissions(access.organizationId)).find(c => c.installation_id === id);
      if (!connection) throw new ReviewError(404, 'GitHub connection not found.');
      url = installationSettingsURL(connection.installation_url, connection.installation_id);
      if (!url || connection.unavailable) throw new ReviewError(503, 'GitHub access settings are temporarily unavailable. Please try again shortly.');
    }
    return new Response(null, { status: 303, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
  } catch (error) { return reviewFailure(error); }
}
