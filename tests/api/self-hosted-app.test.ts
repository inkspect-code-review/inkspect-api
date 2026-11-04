import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createSelfHostedApp } from "../../src/self-hosted/app";
import type { Auth } from "@inkspect/core/lib/github";

test('self-hosted API has no commercial routes and keeps authentication and origin checks', async () => {
  const pool = new Pool(); // No database connection is needed for denied requests.
  const auth = { options: { baseURL: 'http://localhost:3002' }, api: { getSession: async () => null } } as unknown as Auth;
  try {
    const app = createSelfHostedApp({ origin: auth.options.baseURL, pool, auth: () => auth });
    for (const path of ['/api/billing', '/api/internal/review-billing', '/api/support']) {
      for (const method of ['GET', 'POST']) assert.equal((await app.request(path, { method })).status, 404, path);
    }
    for (const path of ['/api/members', '/api/invitation', '/api/byok', '/api/usage']) {
      assert.equal((await app.request(path)).status, 401, path);
      assert.equal((await app.request(path, { headers: { origin: 'https://attacker.invalid' } })).status, 403, path);
    }
    assert.equal((await app.request('/api/usage', { method: 'POST' })).status, 405);
  } finally { await pool.end(); }
});
