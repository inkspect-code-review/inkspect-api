import type { Auth } from "@inkspect/core/lib/github";
import { organizationAccess } from "@inkspect/core/lib/organization-access";
import { readReviewJSON, ReviewError, reviewJSON, reviewFailure } from "@inkspect/core/lib/review-access";
import { database } from "./database";

export function normalizeIgnoredAuthors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new ReviewError(400, 'Enter up to 100 GitHub usernames.');
  return [...new Set(value.map(entry => {
    if (typeof entry !== 'string') throw new ReviewError(400, 'Enter GitHub usernames, such as dependabot[bot].');
    const login = entry.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?(?:\[bot\])?$/.test(login))
      throw new ReviewError(400, 'Enter GitHub usernames, such as dependabot[bot], without URLs or wildcards.');
    return login;
  }))];
}

export function isIgnoredAuthor(author: string | undefined, ignored: readonly string[] = []): boolean {
  if (!ignored.length) return false;
  // Missing GitHub identity must not bypass an active exclusion list.
  if (!author) throw new Error('Pull request author unavailable');
  return ignored.includes(author.toLowerCase());
}

export async function ignoredAuthors(organization: string): Promise<string[]> {
  return (await database().query('SELECT ignored_authors FROM api_review_settings WHERE organization_id=$1', [organization])).rows[0]?.ignored_authors ?? [];
}

export async function saveIgnoredAuthors(organization: string, user: string, authors: string[]) {
  const normalized = normalizeIgnoredAuthors(authors);
  const tx = await database().connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`INSERT INTO api_review_settings(organization_id,updated_by,ignored_authors) VALUES($1,$2,$3)
      ON CONFLICT(organization_id) DO UPDATE SET ignored_authors=excluded.ignored_authors,updated_by=excluded.updated_by,updated_at=clock_timestamp()`, [organization,user,normalized]);
    // Recheck existing work immediately, including PRs that can now resume.
    await tx.query('UPDATE api_pull_request_workflow SET wake_at=clock_timestamp(),next_run_at=clock_timestamp() WHERE organization_id=$1', [organization]);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

export async function automaticReviews(organization: string) {
  return (await database().query('SELECT automatic FROM api_review_settings WHERE organization_id=$1', [organization])).rows[0]?.automatic ?? true;
}
export async function saveAutomaticReviews(organization: string, user: string, automatic: boolean) {
  await database().query(`INSERT INTO api_review_settings(organization_id,automatic,updated_by) VALUES($1,$2,$3)
    ON CONFLICT(organization_id) DO UPDATE SET automatic=excluded.automatic,updated_by=excluded.updated_by,updated_at=clock_timestamp()`, [organization, automatic, user]);
  // Resume known PRs when enabled; a fresh live snapshot is always read first.
  if (automatic) await database().query('UPDATE api_pull_request_workflow SET wake_at=clock_timestamp(),next_run_at=clock_timestamp() WHERE organization_id=$1', [organization]);
}
export async function automaticFix(organization: string) {
  return (await database().query('SELECT auto_fix,auto_fix_by,auto_fix_since,auto_fix_version FROM api_review_settings WHERE organization_id=$1', [organization])).rows[0]
    || { auto_fix:false, auto_fix_by:null, auto_fix_since:null, auto_fix_version:'0' };
}
export async function saveAutomaticFix(organization: string, user: string, enabled: boolean) {
  const tx = await database().connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`INSERT INTO api_review_settings(organization_id,updated_by,auto_fix,auto_fix_by,auto_fix_since,auto_fix_version)
      VALUES($1,$2,$3,$2,clock_timestamp(),1) ON CONFLICT(organization_id) DO UPDATE SET
      auto_fix=$3,auto_fix_by=$2,auto_fix_since=CASE WHEN api_review_settings.auto_fix=$3 THEN api_review_settings.auto_fix_since ELSE clock_timestamp() END,
      auto_fix_version=api_review_settings.auto_fix_version+1,updated_by=$2,updated_at=clock_timestamp()`, [organization,user,enabled]);
    // Turning off (or replacing authorization) invalidates queued/in-flight auto fixes.
    await tx.query(`UPDATE api_engine_job SET cancel_requested=true,
      billing_usage=CASE WHEN status='queued' THEN '{"complete":true,"charged_nano_usd":"0","input_tokens":0,"output_tokens":0,"total_tokens":0,"calls":0}'::jsonb ELSE billing_usage END,
      finished_at=CASE WHEN status='queued' THEN clock_timestamp() ELSE finished_at END,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END
      WHERE organization_id=$1 AND request ? 'auto_fix_version' AND status IN ('queued','running','paused')`, [organization]);
    await tx.query('COMMIT');
  } catch(error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

export async function reviewSettings(request: Request, auth: Auth, services = { automaticReviews, saveAutomaticReviews, automaticFix, saveAutomaticFix, ignoredAuthors, saveIgnoredAuthors }) {
  try {
    const access = await organizationAccess(request, auth);
    const response = async () => reviewJSON({ automatic: await services.automaticReviews(access.organizationId), auto_fix: (await services.automaticFix(access.organizationId)).auto_fix, ignored_authors: await services.ignoredAuthors(access.organizationId), can_manage: access.canManage });
    if (request.method === 'GET') return await response();
    if (request.method !== 'POST') throw new ReviewError(405, 'Method not allowed.');
    if (!access.canManage) throw new ReviewError(403, 'Only workspace owners and admins can change review automation.');
    const body = await readReviewJSON(request);
    const keys = Object.keys(body);
    if (keys.length !== 1 || !['automatic','auto_fix','ignored_authors'].includes(keys[0])) throw new ReviewError(400, 'Choose one review automation setting to update.');
    if (keys[0] === 'ignored_authors') await services.saveIgnoredAuthors(access.organizationId, access.user.id, normalizeIgnoredAuthors(body.ignored_authors));
    else {
      if (typeof body[keys[0]] !== 'boolean') throw new ReviewError(400, 'Choose whether the review automation setting is enabled.');
      if (keys[0] === 'auto_fix') await services.saveAutomaticFix(access.organizationId, access.user.id, body.auto_fix as boolean);
      else await services.saveAutomaticReviews(access.organizationId, access.user.id, body.automatic as boolean);
    }
    return await response();
  } catch (error) { return reviewFailure(error); }
}
