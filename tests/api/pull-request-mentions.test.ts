import assert from 'node:assert/strict';
import test from 'node:test';
import { appLogin, addressedRequest, parsePullEvent } from "../../src/pull-request-events";

function event(body: string) {
  return { installation: { id: 44 }, repository: { id: 17, full_name: 'team/repo' }, action: 'created',
    sender: { login: 'maintainer', type: 'User' }, issue: { number: 3, pull_request: {} }, pull_request: { number: 3 },
    comment: { id: 123, body, user: { login: 'maintainer', type: 'User' }, in_reply_to_id: 50, path: 'src/a.ts', line: 7 } };
}

test('general comments and inline replies require an explicit mention, even for review keywords', () => {
  for (const type of ['issue_comment', 'pull_request_review_comment']) {
    for (const body of ['review again', 'fixed', 'fix applied', 'please review', 're-review', 'resolved',
      'düzelttim, tekrar incele', '@teammate review again', 'Why does this need changing?',
      '@inkspectsi-other review again', 'email@inkspectsi review again', '@inkspectsi thanks']) {
      assert.equal(parsePullEvent(type, event(body)), null, `${type}: ${body}`);
    }
  }
});

test('quotes, fenced/indented code, links, hidden text and escaped mentions do not address the bot', () => {
  for (const body of ['> @inkspectsi review again', '```text\n@inkspectsi\n```\nreview again',
    '~~~text\n@inkspectsi\n~~~\nreview again', '    @inkspectsi review again', '`@inkspectsi` review again',
    '<!-- @inkspectsi --> review again', '[@inkspectsi](https://example.com) review again', '\\@inkspectsi review again']) {
    for (const type of ['issue_comment', 'pull_request_review_comment']) {
      assert.equal(parsePullEvent(type, event(body)), null, `${type}: ${body}`);
    }
  }
});

test('explicitly addressed commands and contextual notes are preserved for both comment types', () => {
  for (const type of ['issue_comment', 'pull_request_review_comment']) {
    for (const body of ['@inkspectsi review again', '@INKSPECTSI[bot]: please review', '@inkspectsi tekrar incele']) {
      const parsed = parsePullEvent(type, event(body));
      assert.equal(parsed?.message?.intent, 'review', body);
      assert.equal(parsed?.message?.note, undefined);
    }
    assert.equal(parsePullEvent(type, event('@inkspectsi'))?.message?.intent, 'explain');
    const parsed = parsePullEvent(type, event('@inkspectsi check the error handling'));
    assert.equal(parsed?.message?.note, type === 'issue_comment' ? 'check the error handling' : 'src/a.ts:7: check the error handling');
  }
  assert.equal(addressedRequest('@custom-review review again', 'custom-review').review, true);
  assert.equal(addressedRequest('@inkspectsi review again', 'custom-review').addressed, false);
  assert.equal(appLogin('invalid.slug'), 'inkspectsi');
});

test('pull request lifecycle events remain independent of comment mentions', () => {
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    const data = { ...event(''), action, number: 3, pull_request: { number: 3, base: { repo: { id: 17 } } } };
    assert.equal(parsePullEvent('pull_request', data)?.number, 3);
  }
});
