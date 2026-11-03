/**
 * The real command, started as a separate process, the way an MCP client starts it.
 * A fake `secret-tool` is put first on the PATH, so the real keyring is never touched.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let fakeBin = '';

before(async () => {
  fakeBin = await mkdtemp(join(tmpdir(), 'fake-secret-tool-'));
  // Takes 300 ms and finds nothing, so a tool call is still running when stdin closes.
  await writeFile(join(fakeBin, 'secret-tool'), '#!/bin/sh\nsleep 0.3\nexit 1\n', { mode: 0o755 });
});
after(async () => {
  await rm(fakeBin, { recursive: true, force: true });
});

function runServer(lines: unknown[]): Promise<{ code: number | null; messages: Record<string, unknown>[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOME: fakeBin },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('close', (code) => {
      const messages = output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ code, messages });
    });
    child.stdin.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  });
}

describe('command line', () => {
  it('prints the version', async () => {
    const child = spawn(process.execPath, [ENTRY, '--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.match(output, /^\d+\.\d+\.\d+\n$/);
  });

  it('serves MCP over stdio and answers a call still running when stdin closes', async () => {
    const { code, messages } = await runServer([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'cws_item_status', arguments: { publisherId: 'p', itemId: 'abcdefghijklmnopabcdefghijklmnop' } },
      },
    ]);
    assert.equal(code, 0);
    const byId = new Map(messages.map((message) => [message.id, message]));
    const init = byId.get(1)?.result as { serverInfo: { name: string } };
    assert.equal(init.serverInfo.name, 'chrome-store-mcp');
    const list = byId.get(2)?.result as { tools: unknown[] };
    assert.equal(list.tools.length, 9);
    const call = byId.get(3)?.result as { isError: boolean; content: { text: string }[] };
    assert.equal(call.isError, true);
    assert.match(call.content[0]!.text, /Not signed in for read access/);
  });
});
