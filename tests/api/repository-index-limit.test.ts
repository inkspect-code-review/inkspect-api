import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibility, indexLimit, type Worker } from '../../src/repository-store';

test('a repository limit changes only the size check for that registration', () => {
  const limit = 1024 ** 3;
  const now = Date.now();
  const worker = { size_bytes: String(limit), access_verified_at: new Date(now) } as Worker;
  const approved = { ...worker, index_limit_bytes: String(limit) };

  assert.equal(eligibility(worker, now).limit_bytes, indexLimit);
  assert.equal(eligibility({ ...worker, index_limit_bytes: null }, now).allowed, false);
  assert.equal(eligibility(approved, now).allowed, true);
  assert.equal(eligibility(approved, now).limit_bytes, limit);
  const over = eligibility({ ...approved, size_bytes: String(limit + 1) }, now);
  assert.equal(over.allowed, false);
  assert.equal(over.support_required, true);
  assert.match(over.reason ?? '', /1024 MB/);
  assert.equal(eligibility({ ...approved, size_bytes: null }, now).allowed, false);
  assert.equal(eligibility({ ...approved, access_error: 'revoked' }, now).allowed, false);
  assert.equal(eligibility({ ...approved, access_verified_at: new Date(now - 900_000) }, now).allowed, false);
});
