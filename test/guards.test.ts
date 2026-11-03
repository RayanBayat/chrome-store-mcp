/**
 * Safety layers that need a test of their own: no redirects, the output cap, the upload size check, the dialog
 * timeout and the sign-in's state check.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { login } from '../src/auth/login.ts';
import { READONLY_SCOPE } from '../src/auth/tokens.ts';
import { runDialog } from '../src/confirm/confirm.ts';
import { InputError } from '../src/errors.ts';
import { checkPackageFile, MAX_PACKAGE_BYTES } from '../src/store/client.ts';
import { MAX_OUTPUT_CHARS, render } from '../src/tools/result.ts';
import { fakeCredentials, fakeFetch, json, startServer } from './helpers.ts';

let folder = '';
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'cws-guards-'));
});
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('requests', () => {
  it('never follow redirects and always carry a timeout', async () => {
    const harness = await startServer();
    await harness.client.callTool({ name: 'cws_item_status', arguments: {} });
    await harness.client.callTool({ name: 'cws_publish', arguments: {} });
    assert.ok(harness.fetcher.calls.length >= 4, 'token and store requests for both sign-ins');
    for (const call of harness.fetcher.calls) {
      assert.equal(call.init.redirect, 'error', call.url);
      assert.ok(call.init.signal instanceof AbortSignal, call.url);
    }
    await harness.close();
  });
});

describe('output cap', () => {
  it('cuts answers longer than the cap and says so', () => {
    const text = render({ big: 'x'.repeat(MAX_OUTPUT_CHARS * 2) });
    assert.ok(text.length < MAX_OUTPUT_CHARS + 100);
    assert.match(text, /cut at 60000 characters/);
    assert.equal(render({ small: 1 }), '{\n  "small": 1\n}');
  });
});

describe('upload size', () => {
  it('refuses a ZIP over the store limit of 2 GiB (a sparse file: no disk space used)', async () => {
    const huge = join(folder, 'huge.zip');
    await writeFile(huge, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await truncate(huge, MAX_PACKAGE_BYTES + 1);
    await assert.rejects(checkPackageFile(huge), /between 1 byte and 2 GiB/);
  });

  it('refuses an empty ZIP', async () => {
    const empty = join(folder, 'empty.zip');
    await writeFile(empty, '');
    await assert.rejects(checkPackageFile(empty), InputError);
  });
});

describe('dialog timeout', () => {
  it('closes a dialog nobody answers and counts it as no', async () => {
    const slow = join(folder, 'slow-dialog');
    await writeFile(slow, '#!/bin/sh\nsleep 5\nexit 0\n', { mode: 0o755 });
    const started = Date.now();
    const code = await runDialog(slow, [], 200);
    assert.notEqual(code, 0);
    assert.ok(Date.now() - started < 3000, 'did not wait for the program to finish');
  });
});

describe('sign-in', () => {
  async function startLogin(): Promise<{
    done: Promise<void>;
    redirect: string;
    state: string;
    store: ReturnType<typeof fakeCredentials>;
  }> {
    const clientFile = join(folder, 'client.json');
    await writeFile(
      clientFile,
      JSON.stringify({ installed: { client_id: 'id.apps.googleusercontent.com', client_secret: 'client-secret' } }),
    );
    const store = fakeCredentials({});
    const fetcher = fakeFetch(() => json({ access_token: 'ya29.a', refresh_token: '1//new', scope: READONLY_SCOPE }));
    let consentUrl = '';
    let done: Promise<void> = Promise.resolve();
    const opened = new Promise<void>((resolve) => {
      done = login({
        access: 'read',
        clientFile,
        credentials: store,
        fetcher,
        log: () => undefined,
        openUrl: (url) => {
          consentUrl = url;
          resolve();
        },
      });
    });
    await opened;
    const url = new URL(consentUrl);
    return { done, redirect: url.searchParams.get('redirect_uri') ?? '', state: url.searchParams.get('state') ?? '', store };
  }

  it('refuses an answer with the wrong state and stores nothing', async () => {
    const { done, redirect, store } = await startLogin();
    const failed = assert.rejects(done, /State mismatch/);
    const response = await fetch(`${redirect}/?state=forged&code=abc`);
    assert.equal(response.status, 400);
    await failed;
    assert.deepEqual(store.values, {});
  });

  it('stores the client and refresh token after a valid answer', async () => {
    const { done, redirect, state, store } = await startLogin();
    const response = await fetch(`${redirect}/?state=${encodeURIComponent(state)}&code=abc`);
    assert.equal(response.status, 200);
    await done;
    assert.equal(store.values.refresh_token, '1//new');
    assert.equal(store.values.client_id, 'id.apps.googleusercontent.com');
  });
});
