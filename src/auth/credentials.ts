/**
 * Where the Google credentials are kept.
 *
 * Two places are supported, checked in this order:
 *   1. Environment variables (CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_WRITE_REFRESH_TOKEN).
 *      Works everywhere (macOS, Windows, servers), but the values sit in plain text in your MCP settings.
 *   2. The desktop keyring on Linux (KWallet or GNOME Keyring, through the `secret-tool` command).
 *      Recommended: the values are encrypted at rest and never written to a config file.
 *
 * `secret-tool` is run without a shell and secrets are passed on stdin, so they never appear in a process listing.
 */
import { spawn } from 'node:child_process';

export const KEYRING_SERVICE = 'chrome-store-mcp';

/** The four values this server may need. The write token is optional: without it, only read tools work. */
export const CREDENTIAL_KEYS = ['client_id', 'client_secret', 'refresh_token', 'write_refresh_token'] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

const ENV_NAMES: Record<CredentialKey, string> = {
  client_id: 'CWS_CLIENT_ID',
  client_secret: 'CWS_CLIENT_SECRET',
  refresh_token: 'CWS_REFRESH_TOKEN',
  write_refresh_token: 'CWS_WRITE_REFRESH_TOKEN',
};

export interface CredentialStore {
  /** Returns the value, or null when it is not set anywhere. */
  lookup(key: CredentialKey): Promise<string | null>;
  /** Saves a value in the keyring. Throws when no keyring is available. */
  store(key: CredentialKey, value: string): Promise<void>;
  /** Deletes a value from the keyring (environment variables are yours to remove). */
  clear(key: CredentialKey): Promise<void>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with arguments (never through a shell) and feeds `input` on stdin. */
export type CommandRunner = (program: string, args: string[], input?: string) => Promise<RunResult>;

export const runCommand: CommandRunner = (program, args, input = '') =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });

export function createCredentialStore(env: NodeJS.ProcessEnv = process.env, run: CommandRunner = runCommand): CredentialStore {
  return {
    async lookup(key) {
      const fromEnv = env[ENV_NAMES[key]];
      if (fromEnv) return fromEnv;
      try {
        const result = await run('secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'key', key]);
        const value = result.stdout.replace(/\n$/, '');
        return result.code === 0 && value !== '' ? value : null;
      } catch {
        return null; // no secret-tool on this machine: only environment variables are available
      }
    },
    async store(key, value) {
      const result = await run(
        'secret-tool',
        ['store', `--label=${KEYRING_SERVICE} ${key}`, 'service', KEYRING_SERVICE, 'key', key],
        value,
      ).catch(() => null);
      if (result === null) throw new Error('No keyring found (secret-tool is missing).');
      if (result.code !== 0) throw new Error(`The keyring refused to store ${key}: ${result.stderr.trim()}`);
    },
    async clear(key) {
      await run('secret-tool', ['clear', 'service', KEYRING_SERVICE, 'key', key]).catch(() => null);
    },
  };
}

/** The environment variable that holds a credential, for messages that tell the person what to set. */
export function envNameOf(key: CredentialKey): string {
  return ENV_NAMES[key];
}
