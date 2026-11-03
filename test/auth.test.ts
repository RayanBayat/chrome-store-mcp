import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { createCredentialStore, type CommandRunner } from '../src/auth/credentials.ts';
import { buildConsentUrl, createPkcePair, exchangeCode, parseClientFile, REVOKE_URL } from '../src/auth/login.ts';
import { FULL_SCOPE, isExpectedGrant, READONLY_SCOPE, TokenSource } from '../src/auth/tokens.ts';
import { ApiError, SetupError } from '../src/errors.ts';
import { fakeCredentials, fakeFetch, json, READ_TOKEN, WRITE_TOKEN } from './helpers.ts';

const CLIENT = { clientId: 'id.apps.googleusercontent.com', clientSecret: 'client-secret' };

describe('isExpectedGrant', () => {
  it('accepts exactly the one scope for each access level', () => {
    assert.equal(isExpectedGrant('read', READONLY_SCOPE), true);
    assert.equal(isExpectedGrant('write', FULL_SCOPE), true);
  });
  it('refuses wider, mixed or missing grants', () => {
    assert.equal(isExpectedGrant('read', FULL_SCOPE), false);
    assert.equal(isExpectedGrant('read', `${READONLY_SCOPE} ${FULL_SCOPE}`), false);
    assert.equal(isExpectedGrant('write', `${FULL_SCOPE} openid`), false);
    assert.equal(isExpectedGrant('read', undefined), false);
  });
});

describe('TokenSource', () => {
  it('asks for the read-only scope for reads and caches the token', async () => {
    const fetcher = fakeFetch(() => json(READ_TOKEN));
    const tokens = new TokenSource('read', fakeCredentials(), fetcher, () => 1_000);
    assert.equal(await tokens.get(), READ_TOKEN.access_token);
    assert.equal(await tokens.get(), READ_TOKEN.access_token);
    assert.equal(fetcher.calls.length, 1);
    const body = new URLSearchParams(fetcher.calls[0]!.init.body as string);
    assert.equal(body.get('scope'), READONLY_SCOPE);
    assert.equal(body.get('refresh_token'), '1//read-refresh');
  });
  it('uses the separate write refresh token and the full scope for writes', async () => {
    const fetcher = fakeFetch(() => json(WRITE_TOKEN));
    await new TokenSource('write', fakeCredentials(), fetcher).get();
    const body = new URLSearchParams(fetcher.calls[0]!.init.body as string);
    assert.equal(body.get('scope'), FULL_SCOPE);
    assert.equal(body.get('refresh_token'), '1//write-refresh');
  });
  it('refuses a read token that reports more than read-only access', async () => {
    const fetcher = fakeFetch(() => json({ ...READ_TOKEN, scope: FULL_SCOPE }));
    await assert.rejects(new TokenSource('read', fakeCredentials(), fetcher).get(), SetupError);
  });
  it('says how to sign in when nothing is stored, without calling Google', async () => {
    const fetcher = fakeFetch(() => json(READ_TOKEN));
    await assert.rejects(new TokenSource('write', fakeCredentials({}), fetcher).get(), /login --write/);
    assert.equal(fetcher.calls.length, 0);
  });
  it("shows only Google's error code", async () => {
    const fetcher = fakeFetch(() => json({ error: 'invalid_grant', error_description: 'detail 1//leak' }, 400));
    await assert.rejects(new TokenSource('read', fakeCredentials(), fetcher).get(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /invalid_grant/);
      assert.doesNotMatch(error.message, /detail|1\/\//);
      return true;
    });
  });
});

describe('credential store', () => {
  it('prefers environment variables, then the keyring, without a shell', async () => {
    const commands: { program: string; args: string[]; input?: string | undefined }[] = [];
    const run: CommandRunner = (program, args, input) => {
      commands.push({ program, args, input });
      return Promise.resolve({ code: 0, stdout: 'from-keyring\n', stderr: '' });
    };
    const store = createCredentialStore({ CWS_CLIENT_ID: 'from-env' }, run);
    assert.equal(await store.lookup('client_id'), 'from-env');
    assert.equal(await store.lookup('refresh_token'), 'from-keyring');
    await store.store('write_refresh_token', 'secret-value');
    assert.deepEqual(commands[0]!.args, ['lookup', 'service', 'chrome-store-mcp', 'key', 'refresh_token']);
    assert.equal(commands[1]!.input, 'secret-value', 'the secret goes through stdin');
    assert.ok(!commands[1]!.args.includes('secret-value'), 'never on the command line');
  });
  it('returns null when there is no keyring', async () => {
    const store = createCredentialStore({}, () => Promise.reject(new Error('ENOENT')));
    assert.equal(await store.lookup('client_id'), null);
  });
});

describe('login helpers', () => {
  it('reads a Desktop-app client file and refuses others', () => {
    assert.deepEqual(
      parseClientFile(JSON.stringify({ installed: { client_id: CLIENT.clientId, client_secret: 'client-secret' } })),
      CLIENT,
    );
    assert.throws(() => parseClientFile(JSON.stringify({ web: { client_id: CLIENT.clientId, client_secret: 'x' } })), /Desktop app/);
    assert.throws(() => parseClientFile('nope'), /not JSON/);
  });

  it('asks for exactly one scope, with PKCE S256 and a state', () => {
    const { verifier, challenge } = createPkcePair();
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    for (const [access, scope] of [
      ['read', READONLY_SCOPE],
      ['write', FULL_SCOPE],
    ] as const) {
      const url = new URL(buildConsentUrl(access, CLIENT.clientId, 'http://127.0.0.1:5555', challenge, 'st4te'));
      assert.equal(url.searchParams.get('scope'), scope);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('state'), 'st4te');
      assert.equal(url.searchParams.get('access_type'), 'offline');
    }
  });

  it('returns the refresh token of the expected grant', async () => {
    const fetcher = fakeFetch(() => json({ access_token: 'ya29.a', refresh_token: '1//r', scope: FULL_SCOPE }));
    assert.equal(await exchangeCode(fetcher, 'write', CLIENT, 'code', 'verifier', 'http://127.0.0.1:1'), '1//r');
    assert.equal(new URLSearchParams(fetcher.calls[0]!.init.body as string).get('code_verifier'), 'verifier');
  });

  it('refuses and revokes a grant that does not match', async () => {
    const fetcher = fakeFetch((url) =>
      url === REVOKE_URL
        ? new Response('')
        : json({ access_token: 'ya29.a', refresh_token: '1//r', scope: `${READONLY_SCOPE} ${FULL_SCOPE}` }),
    );
    await assert.rejects(exchangeCode(fetcher, 'read', CLIENT, 'code', 'v', 'http://127.0.0.1:1'), /Refused/);
    const revoked = fetcher.calls
      .filter((call) => call.url === REVOKE_URL)
      .map((call) => new URLSearchParams(call.init.body as string).get('token'));
    assert.deepEqual(revoked.sort(), ['1//r', 'ya29.a']);
  });
});
