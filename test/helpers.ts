/**
 * Fakes shared by the tests: a credential store in memory, a fetch that records requests, and an MCP client wired to
 * the server in memory (no network, no keyring, no dialogs).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CredentialKey, CredentialStore } from '../src/auth/credentials.ts';
import { FULL_SCOPE, READONLY_SCOPE } from '../src/auth/tokens.ts';
import type { Config } from '../src/config.ts';
import { createServer, type ServerDeps } from '../src/server.ts';

export const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
export const PUBLISHER = '4f6c2d1e-0b9a-4c3d-8e7f-123456789abc';
export const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;

export const READ_TOKEN = { access_token: 'ya29.read-token', expires_in: 3599, scope: READONLY_SCOPE, token_type: 'Bearer' };
export const WRITE_TOKEN = { access_token: 'ya29.write-token', expires_in: 3599, scope: FULL_SCOPE, token_type: 'Bearer' };

export function fakeCredentials(
  values: Partial<Record<CredentialKey, string>> = {
    client_id: 'id.apps.googleusercontent.com',
    client_secret: 'client-secret',
    refresh_token: '1//read-refresh',
    write_refresh_token: '1//write-refresh',
  },
): CredentialStore & { values: Partial<Record<CredentialKey, string>> } {
  const stored = { ...values };
  return {
    values: stored,
    lookup: (key) => Promise.resolve(stored[key] ?? null),
    store: (key, value) => {
      stored[key] = value;
      return Promise.resolve();
    },
    clear: (key) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is one of four known names
      delete stored[key];
      return Promise.resolve();
    },
  };
}

export interface Recorded {
  url: string;
  init: RequestInit;
}

export type FakeFetch = ((url: string, init: RequestInit) => Promise<Response>) & { calls: Recorded[] };

export function fakeFetch(answer: (url: string, init: RequestInit) => Response): FakeFetch {
  const calls: Recorded[] = [];
  const fetcher = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return Promise.resolve(answer(url, init));
  };
  return Object.assign(fetcher, { calls });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Answers the token endpoint with the right token for the refresh token used, and the store with `storeBody`. */
export function storeFetch(storeBody: unknown = { ok: true }, storeStatus = 200): FakeFetch {
  return fakeFetch((url, init) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
      return json(body.get('refresh_token') === '1//write-refresh' ? WRITE_TOKEN : READ_TOKEN);
    }
    return json(storeBody, storeStatus);
  });
}

export function storeCalls(fetcher: FakeFetch): Recorded[] {
  return fetcher.calls.filter((call) => call.url.startsWith('https://chromewebstore.googleapis.com/'));
}

export function bearerOf(call: Recorded): string | undefined {
  return (call.init.headers as Record<string, string>).Authorization;
}

export interface Harness {
  client: Client;
  fetcher: FakeFetch;
  dialogs: { program: string; args: string[] }[];
  close: () => Promise<void>;
}

/** Starts the real server with fakes and connects a real MCP client to it in memory. */
export async function startServer(
  options: {
    config?: Partial<Config>;
    fetcher?: FakeFetch;
    dialogAnswer?: number;
    now?: Date;
    clientCapabilities?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Harness> {
  const fetcher = options.fetcher ?? storeFetch();
  const dialogs: { program: string; args: string[] }[] = [];
  const deps: ServerDeps = {
    config: { publisherId: PUBLISHER, itemId: ITEM, confirm: 'dialog', ...options.config },
    credentials: fakeCredentials(),
    fetcher,
    env: options.env ?? { DISPLAY: ':0', PATH: '/usr/bin' },
    platform: 'linux',
    now: () => options.now ?? new Date('2026-11-04T12:00:00Z'),
    dialog: {
      hasProgram: (program) => Promise.resolve(program === 'kdialog'),
      runDialog: (program, args) => {
        dialogs.push({ program, args });
        return Promise.resolve(options.dialogAnswer ?? 0);
      },
    },
  };
  const server = createServer(deps);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: options.clientCapabilities ?? {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    fetcher,
    dialogs,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The text of a tool result (all our tools return one text block). */
export function textOf(result: unknown): string {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

export function isErrorResult(result: unknown): boolean {
  return (result as CallToolResult).isError === true;
}
