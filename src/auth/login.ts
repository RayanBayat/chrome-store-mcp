/**
 * The one-time sign-in: `chrome-store-mcp login [--write] <client.json>`.
 *
 * What happens, step by step:
 *   1. Read the OAuth client file you downloaded from Google Cloud (type "Desktop app").
 *   2. Start a tiny web server on 127.0.0.1 (a random free port) to receive Google's answer.
 *   3. Open Google's consent page asking for ONE scope: read-only, or (with --write) full access.
 *      PKCE and a random "state" value make sure the answer belongs to this sign-in.
 *   4. Exchange the answer for a refresh token, and refuse (and revoke) it if Google granted anything else.
 *   5. Save it in the keyring. Without a keyring, print it once so you can put it in an environment variable.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { CredentialStore } from './credentials.ts';
import { envNameOf } from './credentials.ts';
import { type Access, type Fetcher, isExpectedGrant, scopeFor, TOKEN_URL } from './tokens.ts';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Reads the JSON file Google Cloud gives you for a Desktop-app OAuth client: `{"installed": {...}}`. */
export function parseClientFile(text: string): OAuthClient {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The client file is not JSON. Download the OAuth client (Desktop app) JSON from Google Cloud.');
  }
  const installed = (data as { installed?: { client_id?: unknown; client_secret?: unknown } }).installed;
  if (!installed) {
    throw new Error('The file has no "installed" client. Create an OAuth client of type "Desktop app", not "Web application".');
  }
  const { client_id: clientId, client_secret: clientSecret } = installed;
  if (
    typeof clientId !== 'string' ||
    !clientId.endsWith('.apps.googleusercontent.com') ||
    typeof clientSecret !== 'string' ||
    !clientSecret
  ) {
    throw new Error('The client file is missing client_id or client_secret.');
  }
  return { clientId, clientSecret };
}

/** PKCE: a random secret (verifier) and its SHA-256 hash (challenge). Google only ever sees the challenge first. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildConsentUrl(access: Access, clientId: string, redirectUri: string, challenge: string, state: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopeFor(access),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline', // so Google sends a refresh token
    prompt: 'consent', // so Google sends it every time, not only the first time
  }).toString();
  return url.href;
}

/** Exchanges Google's one-time code for tokens. Refuses, and revokes, any grant that is not exactly the expected scope. */
export async function exchangeCode(
  fetcher: Fetcher,
  access: Access,
  client: OAuthClient,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Google refused the sign-in (${String(response.status)}, ${typeof data.error === 'string' ? data.error : 'unknown'}).`);
  }
  if (!isExpectedGrant(access, data.scope)) {
    const tokens = [data.refresh_token, data.access_token].filter((token): token is string => typeof token === 'string');
    await Promise.all(tokens.map((token) => revokeToken(fetcher, token)));
    throw new Error(`Refused: Google granted "${String(data.scope)}" instead of only ${scopeFor(access)}. The grant was revoked.`);
  }
  if (typeof data.refresh_token !== 'string') {
    throw new Error('Google sent no refresh token. Remove the app at https://myaccount.google.com/permissions and sign in again.');
  }
  return data.refresh_token;
}

/** Tells Google to cancel a token right away. Failures are ignored: there is nothing more we can do. */
export async function revokeToken(fetcher: Fetcher, token: string): Promise<void> {
  await fetcher(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
}

/** Waits for Google to send the browser back to http://127.0.0.1:<port>/ and returns the refresh token. */
function receiveRefreshToken(
  access: Access,
  client: OAuthClient,
  fetcher: Fetcher,
  log: (line: string) => void,
  openUrl: (url: string) => void,
): Promise<string> {
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString('base64url');

  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        response.writeHead(404).end();
        return;
      }
      const finish = (status: number, page: string, outcome: () => void): void => {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(page);
        clearTimeout(timer);
        server.close();
        outcome();
      };
      if (url.searchParams.get('state') !== state) {
        finish(400, 'This answer is not for the current sign-in. Close this tab and try again.', () => {
          reject(new Error('State mismatch: the answer was not for this sign-in.'));
        });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        const error = url.searchParams.get('error') ?? 'no code';
        finish(400, 'Sign-in was not completed. You can close this tab.', () => {
          reject(new Error(`Google returned: ${error}`));
        });
        return;
      }
      exchangeCode(fetcher, access, client, code, verifier, redirectUriOf(server)).then(
        (token) => {
          finish(200, `Signed in with ${access} access. You can close this tab.`, () => {
            resolve(token);
          });
        },
        (failure: unknown) => {
          finish(400, 'Sign-in refused. See the terminal.', () => {
            reject(failure instanceof Error ? failure : new Error(String(failure)));
          });
        },
      );
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 5 minutes.'));
    }, SIGN_IN_TIMEOUT_MS);

    server.listen(0, '127.0.0.1', () => {
      const consentUrl = buildConsentUrl(access, client.clientId, redirectUriOf(server), challenge, state);
      log(`Opening Google's consent page (${access} access). If no browser opens, visit:\n${consentUrl}`);
      openUrl(consentUrl);
    });
  });
}

function redirectUriOf(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('The local sign-in server has no port.');
  return `http://127.0.0.1:${String(address.port)}`;
}

export function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined); // the URL is printed too, so a missing opener is fine
  child.unref();
}

export async function login(options: {
  access: Access;
  clientFile: string;
  credentials: CredentialStore;
  fetcher: Fetcher;
  log: (line: string) => void;
  /** Opens the consent page. Defaults to the system browser; tests pass a fake. */
  openUrl?: (url: string) => void;
}): Promise<void> {
  const { access, clientFile, credentials, fetcher, log } = options;
  const client = parseClientFile(await readFile(clientFile, 'utf8'));
  const refreshToken = await receiveRefreshToken(access, client, fetcher, log, options.openUrl ?? openInBrowser);
  const refreshKey = access === 'read' ? 'refresh_token' : 'write_refresh_token';

  try {
    await credentials.store('client_id', client.clientId);
    await credentials.store('client_secret', client.clientSecret);
    await credentials.store(refreshKey, refreshToken);
    log(`Saved in the keyring (service "chrome-store-mcp"). You can now delete ${clientFile}.`);
  } catch {
    log(
      [
        'No keyring is available, so set these environment variables in your MCP client settings instead:',
        `  ${envNameOf('client_id')}=${client.clientId}`,
        `  ${envNameOf('client_secret')}=<the client_secret from ${clientFile}>`,
        `  ${envNameOf(refreshKey)}=${refreshToken}`,
        'Treat the refresh token like a password.',
      ].join('\n'),
    );
  }
}

/** Revokes the stored sign-in at Google and removes it from the keyring. */
export async function logout(options: {
  access: Access;
  credentials: CredentialStore;
  fetcher: Fetcher;
  log: (line: string) => void;
}): Promise<void> {
  const { access, credentials, fetcher, log } = options;
  const refreshKey = access === 'read' ? 'refresh_token' : 'write_refresh_token';
  const token = await credentials.lookup(refreshKey);
  if (token) await revokeToken(fetcher, token);
  await credentials.clear(refreshKey);
  log(`Signed out (${access} access). If you set ${envNameOf(refreshKey)}, remove it from your MCP settings too.`);
}
