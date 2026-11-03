/**
 * Keeps the tools in step with Google's API: every method in maintenance/api-surface.json must be on the request
 * allowlist with the right HTTP method and sign-in. When `npm run maintenance -- --record` adds a new method to the
 * snapshot, this test fails until a tool is added for it (or it is listed in NOT_EXPOSED with a reason).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { FULL_SCOPE, READONLY_SCOPE } from '../src/auth/tokens.ts';
import { ALLOWED_REQUESTS } from '../src/store/client.ts';
import { classifyOutdated, diffSurface, extractMethods, supportedLtsMajors, type ApiSurface } from '../scripts/maintenance.ts';
import { ITEM, PUBLISHER } from './helpers.ts';

/** API methods deliberately not offered as tools, each with the reason. Empty today. */
const NOT_EXPOSED: Record<string, string> = {};

async function snapshot(): Promise<ApiSurface> {
  return JSON.parse(await readFile(new URL('../maintenance/api-surface.json', import.meta.url), 'utf8')) as ApiSurface;
}

describe('API surface snapshot', () => {
  it('every Google method is on the allowlist with the right HTTP method and sign-in', async () => {
    const { methods } = await snapshot();
    for (const method of methods) {
      if (method.id in NOT_EXPOSED) continue;
      const concrete = `/${method.path}`.replace('{publishersId}', PUBLISHER).replace('{itemsId}', ITEM);
      // Uploads go to the /upload/ prefix of the same path.
      const path = method.id === 'chromewebstore.media.upload' ? `/upload${concrete}` : concrete;
      const access = method.scopes.includes(READONLY_SCOPE) ? 'read' : 'write';
      if (access === 'write') assert.deepEqual(method.scopes, [FULL_SCOPE], `${method.id} should need the full scope`);
      const rule = ALLOWED_REQUESTS.find((candidate) => candidate.path.test(path));
      assert.ok(rule, `${method.id} has no tool: add one, or list it in NOT_EXPOSED with a reason`);
      assert.equal(rule.method, method.httpMethod, method.id);
      assert.equal(rule.access, access, method.id);
    }
  });

  it('the allowlist has nothing that Google does not offer', async () => {
    const { methods } = await snapshot();
    assert.equal(ALLOWED_REQUESTS.length, methods.length - Object.keys(NOT_EXPOSED).length);
  });
});

describe('held-back packages', () => {
  it('each one is ignored for major updates in .github/dependabot.yml, and nothing else is', async () => {
    const heldBack = JSON.parse(await readFile(new URL('../maintenance/held-back.json', import.meta.url), 'utf8')) as {
      packages: Record<string, unknown>;
    };
    const dependabot = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
    const ignored = [...dependabot.matchAll(/- dependency-name: '?([^'\n]+)'?/g)].map((match) => match[1]);
    assert.deepEqual(ignored.sort(), Object.keys(heldBack.packages).sort());
  });
});

describe('maintenance script helpers', () => {
  const method = (id: string, httpMethod = 'GET'): ApiSurface['methods'][number] => ({ id, httpMethod, path: `v2/${id}`, scopes: [] });

  it('flattens the nested API description', () => {
    const surface = extractMethods({
      revision: '1',
      resources: {
        a: {
          methods: { m: { id: 'z.a.m', httpMethod: 'GET', path: 'p', flatPath: 'v2/p' } },
          resources: { b: { methods: { n: { id: 'z.a.b.n', httpMethod: 'POST', path: 'q' } } } },
        },
      },
    });
    assert.deepEqual(
      surface.methods.map((m) => [m.id, m.path]),
      [
        ['z.a.b.n', 'q'],
        ['z.a.m', 'v2/p'],
      ],
    );
  });

  it('reports added, removed and changed methods', () => {
    const diff = diffSurface(
      { revision: '1', methods: [method('keep'), method('gone'), method('edit')] },
      { revision: '2', methods: [method('keep'), method('edit', 'POST'), method('new')] },
    );
    assert.deepEqual(
      diff.added.map((m) => m.id),
      ['new'],
    );
    assert.deepEqual(
      diff.removed.map((m) => m.id),
      ['gone'],
    );
    assert.deepEqual(
      diff.changed.map((c) => c.after.httpMethod),
      ['POST'],
    );
  });

  it('stays quiet about a held-back package until a newer version than the judged one appears', () => {
    const heldBack = {
      packages: { typescript: { heldAt: '6.0.3', latestSeen: '7.0.2', reason: 'linter', since: '2026-11-03' } },
      overrides: {},
    };
    const known = classifyOutdated([{ name: 'typescript', current: '6.0.3', latest: '7.0.2' }], heldBack);
    assert.deepEqual([known.toUpdate.length, known.held.length], [0, 1]);
    const newer = classifyOutdated([{ name: 'typescript', current: '6.0.3', latest: '7.1.0' }], heldBack);
    assert.deepEqual([newer.toUpdate.length, newer.held.length], [1, 0]);
    const other = classifyOutdated([{ name: 'zod', current: '4.6.7', latest: '4.7.0' }], heldBack);
    assert.equal(other.toUpdate.length, 1);
  });

  it('picks the three newest LTS lines', () => {
    const releases = [
      { version: 'v27.0.0', lts: false as const },
      { version: 'v26.1.0', lts: 'Lithium' },
      { version: 'v24.9.0', lts: 'Krypton' },
      { version: 'v22.20.0', lts: 'Jod' },
      { version: 'v20.19.0', lts: 'Iron' },
    ];
    assert.deepEqual(supportedLtsMajors(releases), [26, 24, 22]);
  });
});
