import assert from 'node:assert/strict';
import test from 'node:test';
import type { Auth } from "@inkspect/core/lib/github";
import { reviewSettings, normalizeIgnoredAuthors, isIgnoredAuthor, type CheckThreshold } from "../../src/review-settings";
test('automatic review settings require workspace membership, owner/admin, same origin and a boolean', async () => {
  let role = 'member', signedIn = true, enabled = true, autoFix = false, saves = 0;
  const auth = { options: { baseURL: 'http://localhost:3002' }, api: { getSession: async () => signedIn ? { user: { id: 'user' }, session: { activeOrganizationId: 'org' } } : null }, $context: Promise.resolve({ adapter: { findOne: async () => role ? { role } : null } }) } as unknown as Auth;
  let authors: string[] = [];
  let threshold: CheckThreshold = 'P0';
  let direction: 'TD' | 'LR' = 'TD';
  const services = { diagramDirection: async () => direction, saveDiagramDirection: async (org: string, user: string, value: 'TD' | 'LR') => {
    assert.equal(org, 'org'); assert.equal(user, 'user'); direction = value;
  }, checkThreshold: async () => threshold, saveCheckThreshold: async (org: string, user: string, value: CheckThreshold) => {
    assert.equal(org, 'org'); assert.equal(user, 'user'); threshold = value;
  }, ignoredAuthors: async () => authors, saveIgnoredAuthors: async (org:string,user:string,value:string[]) => { assert.equal(org,'org'); assert.equal(user,'user'); authors=value; }, automaticFix: async () => ({auto_fix:autoFix}), saveAutomaticFix: async (_org:string,_user:string,value:boolean) => { autoFix=value; }, automaticReviews: async () => enabled, saveAutomaticReviews: async (org: string, user: string, value: boolean) => { assert.equal(org, 'org'); assert.equal(user, 'user'); saves++; enabled = value; } };
  const request = (method = 'GET', value: unknown = false, origin = 'http://localhost:3002', org = 'org') => new Request(`http://localhost:3002/api/review-settings?organizationId=${org}`, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ automatic: value }) } : {}) });
  assert.equal((await (await reviewSettings(request(), auth, services)).json()).automatic, true);
  assert.equal((await reviewSettings(request('POST'), auth, services)).status, 403);
  role = 'owner';
  assert.equal((await reviewSettings(request('POST', false, 'https://evil.invalid'), auth, services)).status, 403);
  assert.equal((await reviewSettings(request('POST', false, undefined, 'other'), auth, services)).status, 409);
  assert.equal((await reviewSettings(request('POST', 'false'), auth, services)).status, 400);
  assert.equal(saves, 0);
  assert.equal((await reviewSettings(request('POST'), auth, services)).status, 200); assert.equal(enabled, false);
  const fixRequest=(value:unknown,origin='http://localhost:3002')=>new Request('http://localhost:3002/api/review-settings?organizationId=org',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({auto_fix:value})});
  assert.equal((await (await reviewSettings(request(),auth,services)).json()).auto_fix,false);
  assert.equal((await reviewSettings(fixRequest('true'),auth,services)).status,400);
  role='member'; assert.equal((await reviewSettings(fixRequest(true),auth,services)).status,403);
  role='owner'; assert.equal((await reviewSettings(fixRequest(true,'https://evil.invalid'),auth,services)).status,403);
  assert.equal((await reviewSettings(fixRequest(true),auth,services)).status,200); assert.equal(autoFix,true); assert.equal(enabled,false);
  assert.equal((await reviewSettings(fixRequest(false),auth,services)).status,200); assert.equal(autoFix,false);
  const listRequest = (body: unknown, origin='http://localhost:3002', org='org') => new Request(`http://localhost:3002/api/review-settings?organizationId=${org}`, {method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.deepEqual((await (await reviewSettings(request(),auth,services)).json()).ignored_authors, []);
  role='member'; assert.equal((await reviewSettings(listRequest({ignored_authors:['dependabot[bot]']}),auth,services)).status,403);
  role='admin';
  assert.equal((await reviewSettings(listRequest({ignored_authors:[]},'https://evil.invalid'),auth,services)).status,403);
  assert.equal((await reviewSettings(listRequest({ignored_authors:[]},undefined,'other'),auth,services)).status,409);
  for (const body of [{ignored_authors:'dependabot'}, {ignored_authors:[null]}, {ignored_authors:['https://github.com/apps/dependabot']}, {ignored_authors:['*']}, {ignored_authors:[],automatic:false}, {ignored_authors:Array(101).fill('user')}, {unknown:[]}]) {
    assert.equal((await reviewSettings(listRequest(body),auth,services)).status,400);
    assert.deepEqual(authors,[]);
  }
  const saved = await reviewSettings(listRequest({ignored_authors:[' @Dependabot[bot] ','dependabot[bot]','Alice']}),auth,services);
  assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).ignored_authors,['dependabot[bot]','alice']);
  assert.equal(enabled,false); assert.equal(autoFix,false);
  assert.equal((await reviewSettings(listRequest({ignored_authors:[]}),auth,services)).status,200);
  assert.deepEqual(authors,[]);
  assert.equal((await (await reviewSettings(request(),auth,services)).json()).check_threshold, 'P0');
  role = 'member';
  assert.equal((await reviewSettings(listRequest({check_threshold:'P1'}),auth,services)).status,403);
  role = 'admin';
  for (const invalid of ['P4', 'p1', 1, null, ['P1']]) {
    assert.equal((await reviewSettings(listRequest({check_threshold:invalid}),auth,services)).status,400);
  }
  for (const value of ['P1', 'P2', 'P3', 'P0']) {
    const res = await reviewSettings(listRequest({check_threshold:value}),auth,services);
    assert.equal(res.status,200);
    assert.equal((await res.json()).check_threshold,value);
  }
  assert.equal((await (await reviewSettings(request(), auth, services)).json()).diagram_direction, 'TD');
  role = 'member';
  assert.equal((await reviewSettings(listRequest({diagram_direction:'LR'}), auth, services)).status, 403);
  role = 'admin';
  assert.equal((await reviewSettings(listRequest({diagram_direction:'BT'}), auth, services)).status, 400);
  for (const value of ['LR', 'TD']) {
    const res = await reviewSettings(listRequest({diagram_direction:value}), auth, services);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).diagram_direction, value);
  }
  signedIn = false; assert.equal((await reviewSettings(request(), auth, services)).status, 401);
});

test('ignored authors use exact case-insensitive logins and never conflate bots with users', () => {
  const authors = normalizeIgnoredAuthors([' @Dependabot[bot] ', 'Alice', 'alice']);
  assert.deepEqual(authors,['dependabot[bot]','alice']);
  assert.equal(isIgnoredAuthor('DEPENDABOT[bot]', authors),true);
  assert.equal(isIgnoredAuthor('ALICE', authors),true);
  assert.equal(isIgnoredAuthor('dependabot', authors),false);
  assert.equal(isIgnoredAuthor('dependabot-extra[bot]', authors),false);
  assert.equal(isIgnoredAuthor(undefined, []),false);
  assert.throws(() => isIgnoredAuthor(undefined, authors),/author unavailable/);
  for (const login of ['', '@', 'two users', 'alice/repo', 'bot[bot][bot]', 'a'.repeat(101), '-user', 'user-']) assert.throws(() => normalizeIgnoredAuthors([login]));
});
