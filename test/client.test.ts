import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TokenSource } from '../src/auth/tokens.ts';
import { ApiError } from '../src/errors.ts';
import { ALLOWED_REQUESTS, assertAllowedRequest, StoreClient } from '../src/store/client.ts';
import { fakeCredentials, NAME, storeFetch } from './helpers.ts';

const BASE = `https://chromewebstore.googleapis.com/v2/${NAME}`;

describe('request allowlist', () => {
  it('allows each read path only with GET and the read sign-in', () => {
    for (const suffix of [':fetchStatus', ':fetchReviews', ':queryMetrics', '/ratingSummary']) {
      assertAllowedRequest('GET', new URL(BASE + suffix), 'read');
      assert.throws(() => {
        assertAllowedRequest('GET', new URL(BASE + suffix), 'write');
      }, /not on the allowlist/);
      assert.throws(() => {
        assertAllowedRequest('POST', new URL(BASE + suffix), 'read');
      }, /not on the allowlist/);
    }
  });

  it('allows each write path only with POST and the write sign-in', () => {
    for (const suffix of [':publish', ':cancelSubmission', ':rollback', ':setPublishedDeployPercentage']) {
      assertAllowedRequest('POST', new URL(BASE + suffix), 'write');
      assert.throws(() => {
        assertAllowedRequest('POST', new URL(BASE + suffix), 'read');
      }, /not on the allowlist/);
    }
    assertAllowedRequest('POST', new URL(`https://chromewebstore.googleapis.com/upload/v2/${NAME}:upload`), 'write');
  });

  it('refuses other hosts, other paths and smuggled segments', () => {
    assert.throws(() => {
      assertAllowedRequest('GET', new URL(`https://evil.example/v2/${NAME}:fetchStatus`), 'read');
    }, /not the Chrome Web Store API/);
    for (const path of [`/v2/${NAME}:delete`, `/v2/${NAME}/../x:fetchStatus`, `/v1.1/items/x`, `/v2/publishers/a/items/b:fetchStatus`]) {
      assert.throws(() => {
        assertAllowedRequest('GET', new URL(`https://chromewebstore.googleapis.com${path}`), 'read');
      });
    }
  });

  it('has nine entries: four reads and five writes', () => {
    assert.equal(ALLOWED_REQUESTS.filter((rule) => rule.access === 'read').length, 4);
    assert.equal(ALLOWED_REQUESTS.filter((rule) => rule.access === 'write').length, 5);
    for (const rule of ALLOWED_REQUESTS) assert.equal(rule.method, rule.access === 'read' ? 'GET' : 'POST');
  });
});

describe('StoreClient errors', () => {
  it('redacts tokens and shows the status', async () => {
    const fetcher = storeFetch({ error: { message: 'bad token ya29.leaked here' } }, 403);
    const credentials = fakeCredentials();
    const client = new StoreClient(
      { read: new TokenSource('read', credentials, fetcher), write: new TokenSource('write', credentials, fetcher) },
      fetcher,
    );
    await assert.rejects(client.fetchStatus(NAME), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /403/);
      assert.doesNotMatch(error.message, /ya29\./);
      return true;
    });
  });
});
