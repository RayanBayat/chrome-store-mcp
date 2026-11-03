/**
 * The HTTP client for the Chrome Web Store API v2. It is the only file that talks to the store.
 *
 * Safety rules enforced here:
 *   - Every request goes through `assertAllowedRequest`, which only lets through the exact method + path pairs in
 *     ALLOWED_REQUESTS. Anything else throws before a single byte is sent.
 *   - Read requests use the read-only sign-in; write requests use the write sign-in. A read call can never carry the
 *     write token, and the allowlist entry for each path says which sign-in it needs.
 *   - Requests never follow redirects and time out.
 */
import { openAsBlob } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import type { Access, Fetcher } from '../auth/tokens.ts';
import { ApiError, InputError, redact } from '../errors.ts';

export const API_ORIGIN = 'https://chromewebstore.googleapis.com';

/** The store's own limit for a package. */
export const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;

const ITEM_PATH = String.raw`/publishers/[A-Za-z0-9_-]{1,128}/items/[a-p]{32}`;

/** Every request this client can make. Adding a tool means adding its line here, on purpose. */
export const ALLOWED_REQUESTS: readonly { method: 'GET' | 'POST'; path: RegExp; access: Access }[] = [
  { method: 'GET', path: new RegExp(`^/v2${ITEM_PATH}:fetchStatus$`), access: 'read' },
  { method: 'GET', path: new RegExp(`^/v2${ITEM_PATH}/ratingSummary$`), access: 'read' },
  { method: 'GET', path: new RegExp(`^/v2${ITEM_PATH}:fetchReviews$`), access: 'read' },
  { method: 'GET', path: new RegExp(`^/v2${ITEM_PATH}:queryMetrics$`), access: 'read' },
  { method: 'POST', path: new RegExp(`^/upload/v2${ITEM_PATH}:upload$`), access: 'write' },
  { method: 'POST', path: new RegExp(`^/v2${ITEM_PATH}:publish$`), access: 'write' },
  { method: 'POST', path: new RegExp(`^/v2${ITEM_PATH}:cancelSubmission$`), access: 'write' },
  { method: 'POST', path: new RegExp(`^/v2${ITEM_PATH}:rollback$`), access: 'write' },
  { method: 'POST', path: new RegExp(`^/v2${ITEM_PATH}:setPublishedDeployPercentage$`), access: 'write' },
];

/** Throws unless (method, URL, access) matches one line of ALLOWED_REQUESTS exactly. */
export function assertAllowedRequest(method: string, url: URL, access: Access): void {
  if (url.origin !== API_ORIGIN) throw new Error(`Refused: ${url.origin} is not the Chrome Web Store API.`);
  const allowed = ALLOWED_REQUESTS.some((rule) => rule.method === method && rule.access === access && rule.path.test(url.pathname));
  if (!allowed) throw new Error(`Refused: ${method} ${url.pathname} with ${access} access is not on the allowlist.`);
}

export interface TokenProvider {
  get(): Promise<string>;
}

export interface PackageFile {
  path: string;
  bytes: number;
}

/** Checks that a path points at a real ZIP file within the store's size limit, and returns its real path. */
export async function checkPackageFile(path: string): Promise<PackageFile> {
  if (!isAbsolute(path)) throw new InputError('zipPath must be an absolute path.');
  if (extname(path).toLowerCase() !== '.zip') throw new InputError('zipPath must end in .zip.');
  const realPath = await realpath(path).catch(() => {
    throw new InputError(`No file at ${path}.`);
  });
  const info = await stat(realPath);
  if (!info.isFile()) throw new InputError('zipPath must be a file.');
  if (info.size === 0 || info.size > MAX_PACKAGE_BYTES) throw new InputError('The ZIP must be between 1 byte and 2 GiB.');

  // Every ZIP file starts with the bytes "PK\x03\x04". Checking them stops a renamed file of another kind.
  const handle = await open(realPath, 'r');
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new InputError('The file is not a ZIP archive.');
  } finally {
    await handle.close();
  }
  return { path: realPath, bytes: info.size };
}

export class StoreClient {
  private readonly tokens: Record<Access, TokenProvider>;
  private readonly fetcher: Fetcher;

  constructor(tokens: Record<Access, TokenProvider>, fetcher: Fetcher) {
    this.tokens = tokens;
    this.fetcher = fetcher;
  }

  /** Sends one request after checking it against the allowlist, and returns the parsed JSON answer. */
  private async request(
    access: Access,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: URLSearchParams; json?: unknown; body?: Blob; contentType?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const url = new URL(path, API_ORIGIN);
    if (options.query && options.query.size > 0) url.search = options.query.toString();
    assertAllowedRequest(method, url, access);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.tokens[access].get()}`,
      Accept: 'application/json',
    };
    let body: string | Blob | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.body) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
      body = options.body;
    }

    const response = await this.fetcher(url.href, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text === '' ? {} : JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const message = (data as { error?: { message?: unknown } } | undefined)?.error?.message;
      const detail = typeof message === 'string' ? `: ${redact(message).slice(0, 500)}` : '';
      throw new ApiError(`Chrome Web Store API error ${String(response.status)}${detail}`);
    }
    if (data === undefined) throw new ApiError('The Chrome Web Store API answered with something that is not JSON.');
    return data;
  }

  // ---- Read (read-only sign-in) ----

  fetchStatus(name: string): Promise<unknown> {
    return this.request('read', 'GET', `/v2/${name}:fetchStatus`);
  }

  ratingSummary(name: string): Promise<unknown> {
    return this.request('read', 'GET', `/v2/${name}/ratingSummary`);
  }

  fetchReviews(name: string, query: URLSearchParams): Promise<unknown> {
    return this.request('read', 'GET', `/v2/${name}:fetchReviews`, { query });
  }

  queryMetrics(name: string, query: URLSearchParams): Promise<unknown> {
    return this.request('read', 'GET', `/v2/${name}:queryMetrics`, { query });
  }

  // ---- Write (write sign-in; the tools ask a person first where it matters) ----

  async upload(name: string, file: PackageFile): Promise<unknown> {
    const body = await openAsBlob(file.path, { type: 'application/zip' });
    return this.request('write', 'POST', `/upload/v2/${name}:upload`, { body, contentType: 'application/zip', timeoutMs: 15 * 60_000 });
  }

  publish(name: string, request: Record<string, unknown>): Promise<unknown> {
    return this.request('write', 'POST', `/v2/${name}:publish`, { json: request });
  }

  cancelSubmission(name: string): Promise<unknown> {
    return this.request('write', 'POST', `/v2/${name}:cancelSubmission`, { json: {} });
  }

  rollback(name: string, request: Record<string, unknown>): Promise<unknown> {
    return this.request('write', 'POST', `/v2/${name}:rollback`, { json: request });
  }

  setDeployPercentage(name: string, deployPercentage: number): Promise<unknown> {
    return this.request('write', 'POST', `/v2/${name}:setPublishedDeployPercentage`, { json: { deployPercentage } });
  }
}
