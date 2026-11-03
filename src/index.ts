#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   chrome-store-mcp                          start the MCP server on stdio (what your MCP client runs)
 *   chrome-store-mcp login <client.json>      sign in with read-only access (once)
 *   chrome-store-mcp login --write <client.json>  sign in with write access (once, only if you want write tools)
 *   chrome-store-mcp logout [--write]         revoke a sign-in and remove it from the keyring
 *
 * Run it from a clone with `node src/index.ts ...` (Node 22.18 or newer runs TypeScript directly).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCredentialStore } from './auth/credentials.ts';
import { login, logout } from './auth/login.ts';
import type { Access } from './auth/tokens.ts';
import { readConfig } from './config.ts';
import { describeError } from './errors.ts';
import { createServer, SERVER_VERSION } from './server.ts';

const USAGE = `chrome-store-mcp ${SERVER_VERSION}

Usage:
  chrome-store-mcp                              start the MCP server (stdio)
  chrome-store-mcp login [--write] <client.json>  sign in once (read-only by default)
  chrome-store-mcp logout [--write]             revoke a sign-in
  chrome-store-mcp --help | --version
`;

const fetcher = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const access: Access = rest.includes('--write') ? 'write' : 'read';
  const files = rest.filter((arg) => !arg.startsWith('--'));
  const credentials = createCredentialStore();

  switch (command) {
    case undefined: {
      const config = readConfig();
      const server = createServer({ config, credentials, fetcher, env: process.env, platform: process.platform, now: () => new Date() });
      await server.connect(new StdioServerTransport());
      return -1; // keep running until the client closes stdin
    }
    case 'login': {
      const [clientFile] = files;
      if (!clientFile) {
        process.stderr.write(USAGE);
        return 2;
      }
      await login({ access, clientFile, credentials, fetcher, log });
      return 0;
    }
    case 'logout':
      await logout({ access, credentials, fetcher, log });
      return 0;
    case '--version':
      log(SERVER_VERSION);
      return 0;
    case '--help':
    case 'help':
      log(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error && !describeError(error).startsWith('Unexpected') ? describeError(error) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
