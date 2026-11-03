/**
 * Turns a stored refresh token into a short-lived access token for each request.
 *
 * There are two separate sign-ins, on purpose:
 *   - "read":  a refresh token that only has the read-only scope. Used by the read tools.
 *   - "write": a refresh token with the full scope. Used only by the write tools.
 * Keeping them apart means the everyday read tools hold a credential that cannot change anything, and the write
 * credential is only touched when you ask for a write.
 */
import { ApiError, SetupError } from '../errors.ts';
import type { CredentialStore } from './credentials.ts';
import { envNameOf } from './credentials.ts';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/chromewebstore.readonly';
export const FULL_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

export type Access = 'read' | 'write';

const REQUEST_TIMEOUT_MS = 30_000;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Splits Google's space-separated scope string into a set. */
export function scopesOf(scope: unknown): Set<string> {
  return new Set(typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : []);
}

/** True when the grant is exactly what this access level should have, and nothing else. */
export function isExpectedGrant(access: Access, scope: unknown): boolean {
  const scopes = scopesOf(scope);
  const expected = access === 'read' ? READONLY_SCOPE : FULL_SCOPE;
  return scopes.size === 1 && scopes.has(expected);
}

export function scopeFor(access: Access): string {
  return access === 'read' ? READONLY_SCOPE : FULL_SCOPE;
}

export class TokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private readonly access: Access;
  private readonly credentials: CredentialStore;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;

  constructor(access: Access, credentials: CredentialStore, fetcher: Fetcher, now: () => number = Date.now) {
    this.access = access;
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.now = now;
  }

  /** Returns a valid access token, refreshing it one minute before it expires. */
  async get(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - 60_000) return this.cached.token;

    const refreshKey = this.access === 'read' ? 'refresh_token' : 'write_refresh_token';
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      this.credentials.lookup('client_id'),
      this.credentials.lookup('client_secret'),
      this.credentials.lookup(refreshKey),
    ]);
    if (!clientId || !clientSecret || !refreshToken) {
      const command = this.access === 'read' ? 'chrome-store-mcp login <client.json>' : 'chrome-store-mcp login --write <client.json>';
      throw new SetupError(`Not signed in for ${this.access} access. Run \`${command}\` once, or set ${envNameOf(refreshKey)}.`);
    }

    const response = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: scopeFor(this.access), // ask for exactly this scope, never more
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      // Only Google's short error code is shown (e.g. "invalid_grant"), never the request or the full answer.
      const code = typeof data.error === 'string' ? data.error : 'unknown';
      const hint = code === 'invalid_grant' ? ' The sign-in expired or was revoked: run the login command again.' : '';
      throw new ApiError(`Google refused to refresh the ${this.access} sign-in (${String(response.status)}, ${code}).${hint}`);
    }
    if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
      throw new ApiError('Google answered the token refresh without an access token.');
    }
    if (data.scope !== undefined && !isExpectedGrant(this.access, data.scope)) {
      throw new SetupError(`The stored ${this.access} sign-in has unexpected permissions, so it is not used. Run the login command again.`);
    }

    this.cached = { token: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };
    return this.cached.token;
  }
}
