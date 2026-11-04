import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { Auth } from "@inkspect/core/lib/github";
import { pools } from "../../src/database";
import { githubInstallationAccess, githubPermissions, installationSettingsURL, refreshGitHubPermission, savedGitHubPermissions, seedGitHubPermissions } from "../../src/github-permissions";

test('permission links only target the verified GitHub installation settings', () => {
  for (const path of ['/settings/installations/123', '/organizations/team/settings/installations/123']) {
    assert.equal(installationSettingsURL(`https://github.com${path}`, '123'), `https://github.com${path}`);
  }
  for (const url of ['https://github.com.evil.test/settings/installations/123', 'https://evil.test/', 'javascript:alert(1)',
    'https://github.com/settings/installations/456', 'https://user@github.com/settings/installations/123',
    'https://github.com/settings/installations/123?redirect=evil', 'http://github.com/settings/installations/123']) {
    assert.equal(installationSettingsURL(url, '123'), null);
  }
});

test('permission reads are cached; explicit checks require the current workspace admin and a bound installation', async () => {
  let role = 'member', signedIn = true, checks = 0, seeds = 0;
  const auth = { options: { baseURL: 'http://localhost:3002' }, api: { getSession: async () => signedIn ? { user: { id: 'user' }, session: { activeOrganizationId: 'org' } } : null }, $context: Promise.resolve({ adapter: { findOne: async () => role ? { role } : null } }) } as unknown as Auth;
  const services = { savedGitHubPermissions: async (org: string) => { assert.equal(org, 'org'); return [{ installation_id: '123', contents: 'read' }]; },
    seedGitHubPermissions: async () => { seeds++; }, refreshGitHubPermission: async (id: string) => { assert.equal(id, '123'); checks++; } };
  const request = (method = 'GET', id = '123', org = 'org', origin = 'http://localhost:3002') => new Request(`http://localhost:3002/api/review-settings?view=github-permissions&organizationId=${org}`, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ installationId: id }) } : {}) });
  assert.equal((await githubPermissions(request(), auth, services)).status, 200);
  assert.equal(checks, 0); assert.equal(seeds, 0);
  assert.equal((await githubPermissions(request('POST'), auth, services)).status, 403);
  role = 'owner';
  assert.equal((await githubPermissions(request('POST', '999'), auth, services)).status, 404);
  assert.equal((await githubPermissions(request('POST', '123', 'other'), auth, services)).status, 409);
  assert.equal((await githubPermissions(request('POST', '123', 'org', 'https://evil.test'), auth, services)).status, 403);
  assert.equal(checks, 0);
  assert.equal((await githubPermissions(request('POST'), auth, services)).status, 200);
  assert.equal(checks, 1);
  signedIn = false;
  assert.equal((await githubPermissions(request(), auth, services)).status, 401);
});

test('manage access redirects to the canonical personal or organization installation URL', async () => {
  const auth = { api: { getSession: async () => ({ user: { id: 'user' }, session: { activeOrganizationId: 'org' } }) },
    $context: Promise.resolve({ adapter: { findOne: async () => ({ role: 'owner' }) } }) } as unknown as Auth;
  for (const path of ['/settings/installations/123', '/organizations/team/settings/installations/123']) {
    const url = `https://github.com${path}`;
    const services = { savedGitHubPermissions: async () => [{ installation_id: '123', installation_url: url, unavailable: false }],
      seedGitHubPermissions: async () => assert.fail('Cached settings must not need seeding'),
      refreshGitHubPermission: async () => assert.fail('Cached settings must not contact GitHub') };
    const response = await githubInstallationAccess(new Request('http://localhost/api/review-settings?view=github-access&organizationId=org&installationId=123'), auth, services);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), url);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('manage access verifies missing metadata and rejects untrusted URLs and unbound installations', async () => {
  let role = 'owner', signedIn = true, checked = false, seeds = 0, settingsURL: string | null = null;
  const auth = { api: { getSession: async () => signedIn ? { user: { id: 'user' }, session: { activeOrganizationId: 'org' } } : null },
    $context: Promise.resolve({ adapter: { findOne: async () => role ? { role } : null } }) } as unknown as Auth;
  const services = { savedGitHubPermissions: async (org: string) => { assert.equal(org, 'org'); return [{ installation_id: '123', installation_url: checked ? settingsURL : null, unavailable: false }]; },
    seedGitHubPermissions: async () => { seeds++; },
    refreshGitHubPermission: async (id: string) => { assert.equal(id, '123'); checked = true; } };
  const request = (id = '123', org = 'org', method = 'GET') => new Request(`http://localhost/api/review-settings?view=github-access&organizationId=${org}&installationId=${id}`, { method });
  assert.equal((await githubInstallationAccess(request('999'), auth, services)).status, 404);
  assert.equal(seeds, 0);
  settingsURL = 'https://github.com/organizations/team/settings/installations/123';
  const response = await githubInstallationAccess(request(), auth, services);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), settingsURL);
  assert.equal(seeds, 1);
  for (const invalid of [null, 'https://evil.test/settings/installations/123', 'https://github.com/settings/installations/456']) {
    settingsURL = invalid;
    const rejected = await githubInstallationAccess(request(), auth, services);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('location'), null);
  }
  assert.equal((await githubInstallationAccess(request('123', 'other'), auth, services)).status, 409);
  assert.equal((await githubInstallationAccess(request('123', 'org', 'POST'), auth, services)).status, 405);
  role = 'member';
  assert.equal((await githubInstallationAccess(request(), auth, services)).status, 403);
  role = '';
  assert.equal((await githubInstallationAccess(request(), auth, services)).status, 403);
  signedIn = false;
  assert.equal((await githubInstallationAccess(request(), auth, services)).status, 401);
});

test('saved installation permissions are isolated, refreshable, bounded and invalidated on failed verification', { skip: !process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL }, async () => {
  const schema = `permissions_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: process.env.INKSPECT_DEPLOY_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const previous = process.env.GITHUB_APP_ID; process.env.GITHUB_APP_ID = '7'; pools.set('app', pool);
  let calls = 0, write = false;
  const fetcher = async (id: string) => { calls++; return { id: Number(id), app_id: 7, html_url: `https://github.com/organizations/team/settings/installations/${id}`, permissions: { contents: write ? 'write' : 'read' } }; };
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query('CREATE TABLE "githubConnection"("organizationId" text,"installationId" text,"accountLogin" text)');
    await pool.query(`INSERT INTO "githubConnection" VALUES('org','123','team'),('other','456','private-team')`);
    await pool.query(await readFile(new URL(import.meta.resolve('@inkspect/api/migrations/006_github_permissions.sql')), 'utf8'));
    await seedGitHubPermissions();
    await Promise.all([1, 2].map(() => refreshGitHubPermission('123', new AbortController().signal, false, fetcher)));
    assert.equal(calls, 1, 'concurrent workers share one lease');
    const saved = await savedGitHubPermissions('org');
    assert.equal(saved.length, 1); assert.equal(saved[0].contents, 'read'); assert.equal(saved[0].account, 'team');
    await refreshGitHubPermission('123', new AbortController().signal, true, fetcher);
    assert.equal(calls, 1, 'repeat clicks respect the cooldown');
    write = true;
    await pool.query("UPDATE api_github_permissions SET checked_at=now()-interval '11 seconds' WHERE installation_id='123'");
    await refreshGitHubPermission('123', new AbortController().signal, true, fetcher);
    assert.equal((await savedGitHubPermissions('org'))[0].contents, 'write');
    await pool.query("UPDATE api_github_permissions SET next_check_at=now() WHERE installation_id='123'");
    await assert.rejects(refreshGitHubPermission('123', new AbortController().signal, false, async () => ({ ...await fetcher('456') })), /could not be checked/);
    assert.equal((await savedGitHubPermissions('org'))[0].unavailable, true);
    await pool.query('DELETE FROM "githubConnection" WHERE "installationId"=\'123\'');
    assert.deepEqual(await savedGitHubPermissions('org'), []);
  } finally {
    pools.delete('app'); if (previous === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = previous;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
  }
});
