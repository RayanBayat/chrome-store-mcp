/**
 * The monthly maintenance check: `npm run maintenance`. See docs/maintenance.md for the whole review.
 *
 * It checks, and reports in Markdown:
 *   1. how long ago the last review was (src/maintenance.ts);
 *   2. Google's live API description against maintenance/api-surface.json: new, removed or changed methods;
 *   3. outdated npm packages (`npm outdated`) and known vulnerabilities (`npm audit`);
 *   4. the Node.js LTS releases against the CI matrix and `engines`.
 * It exits with 1 when something needs attention, so CI can open an issue.
 *
 *   npm run maintenance                     print the report
 *   npm run maintenance -- --report out.md  also write it to a file
 *   npm run maintenance -- --record         after a review: save today's date and the live API snapshot
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LAST_REVIEWED, REVIEW_INTERVAL_DAYS, daysSinceReview } from '../src/maintenance.ts';

const run = promisify(execFile);
const ROOT = new URL('../', import.meta.url);
const DISCOVERY_URL = 'https://chromewebstore.googleapis.com/$discovery/rest?version=v2';
const NODE_RELEASES_URL = 'https://nodejs.org/dist/index.json';

export interface ApiMethod {
  id: string;
  httpMethod: string;
  path: string;
  scopes: string[];
}

export interface ApiSurface {
  revision: string;
  methods: ApiMethod[];
}

interface DiscoveryResource {
  methods?: Record<string, { id: string; httpMethod: string; path: string; flatPath?: string; scopes?: string[] }>;
  resources?: Record<string, DiscoveryResource>;
}

/** Flattens Google's nested API description into a sorted list of methods. */
export function extractMethods(discovery: { revision: string; resources: Record<string, DiscoveryResource> }): ApiSurface {
  const methods: ApiMethod[] = [];
  const walk = (resources: Record<string, DiscoveryResource>): void => {
    for (const resource of Object.values(resources)) {
      for (const spec of Object.values(resource.methods ?? {})) {
        methods.push({
          id: spec.id,
          httpMethod: spec.httpMethod,
          path: spec.flatPath ?? spec.path,
          scopes: [...(spec.scopes ?? [])].sort(),
        });
      }
      walk(resource.resources ?? {});
    }
  };
  walk(discovery.resources);
  methods.sort((a, b) => a.id.localeCompare(b.id));
  return { revision: discovery.revision, methods };
}

export interface SurfaceDiff {
  added: ApiMethod[];
  removed: ApiMethod[];
  changed: { before: ApiMethod; after: ApiMethod }[];
}

/** What changed between the committed snapshot and Google's live description. */
export function diffSurface(snapshot: ApiSurface, live: ApiSurface): SurfaceDiff {
  const before = new Map(snapshot.methods.map((method) => [method.id, method]));
  const after = new Map(live.methods.map((method) => [method.id, method]));
  const diff: SurfaceDiff = { added: [], removed: [], changed: [] };
  for (const [id, method] of after) {
    const old = before.get(id);
    if (!old) diff.added.push(method);
    else if (JSON.stringify(old) !== JSON.stringify(method)) diff.changed.push({ before: old, after: method });
  }
  for (const [id, method] of before) if (!after.has(id)) diff.removed.push(method);
  return diff;
}

/** The LTS majors that are still supported, newest first (from nodejs.org's release list). */
export function supportedLtsMajors(releases: { version: string; lts: string | false }[]): number[] {
  const majors = new Set<number>();
  for (const release of releases) {
    if (release.lts === false) continue;
    majors.add(Number(release.version.slice(1).split('.')[0]));
  }
  // Node keeps an LTS line for about 30 months, so the three newest LTS majors are the supported ones.
  return [...majors].sort((a, b) => b - a).slice(0, 3);
}

export interface HeldBack {
  packages: Record<string, { heldAt: string; latestSeen: string; reason: string; since: string }>;
  overrides: Record<string, { version: string; reason: string; since: string }>;
}

export interface OutdatedEntry {
  name: string;
  current: string;
  latest: string;
}

/** Splits `npm outdated` into packages to update now and packages held back on purpose (still at the judged version). */
export function classifyOutdated(outdated: OutdatedEntry[], heldBack: HeldBack): { toUpdate: OutdatedEntry[]; held: OutdatedEntry[] } {
  const toUpdate: OutdatedEntry[] = [];
  const held: OutdatedEntry[] = [];
  for (const entry of outdated) {
    const hold = heldBack.packages[entry.name];
    if (hold && hold.latestSeen === entry.latest) held.push(entry);
    else toUpdate.push(entry);
  }
  return { toUpdate, held };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  return response.json();
}

async function npmJson(args: string[]): Promise<unknown> {
  // `npm outdated` and `npm audit` exit with 1 when they find something; their JSON is still on stdout.
  const result = await run('npm', args, { cwd: fileURLToPath(ROOT), maxBuffer: 16 * 1024 * 1024 }).catch((error: unknown) => {
    const stdout = (error as { stdout?: unknown }).stdout;
    return { stdout: typeof stdout === 'string' ? stdout : '{}' };
  });
  return JSON.parse(result.stdout || '{}');
}

function formatMethod(method: ApiMethod): string {
  return `\`${method.httpMethod} ${method.path}\` (${method.id})`;
}

interface Report {
  markdown: string;
  needsAttention: boolean;
  live: ApiSurface | null;
}

async function buildReport(today: Date): Promise<Report> {
  const lines: string[] = [`# Maintenance check, ${today.toISOString().slice(0, 10)}`, ''];
  let needsAttention = false;

  const days = daysSinceReview(today);
  const overdue = days > REVIEW_INTERVAL_DAYS;
  needsAttention ||= overdue;
  lines.push('## Last review', '', `${LAST_REVIEWED}, ${String(days)} days ago${overdue ? ' (overdue)' : ''}.`, '');

  lines.push('## Chrome Web Store API', '');
  let live: ApiSurface | null = null;
  try {
    const snapshot = JSON.parse(await readFile(new URL('maintenance/api-surface.json', ROOT), 'utf8')) as ApiSurface;
    live = extractMethods((await fetchJson(DISCOVERY_URL)) as { revision: string; resources: Record<string, DiscoveryResource> });
    const diff = diffSurface(snapshot, live);
    lines.push(`Snapshot revision ${snapshot.revision}, live revision ${live.revision}.`, '');
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
      lines.push('No method was added, removed or changed.', '');
    } else {
      needsAttention = true;
      for (const method of diff.added)
        lines.push(`- NEW: ${formatMethod(method)}: add a tool or list it as not exposed (docs/maintenance.md).`);
      for (const method of diff.removed) lines.push(`- REMOVED: ${formatMethod(method)}: remove the tool that uses it.`);
      for (const { before, after } of diff.changed) lines.push(`- CHANGED: ${formatMethod(before)} -> ${formatMethod(after)}`);
      lines.push('');
    }
  } catch (error) {
    needsAttention = true;
    lines.push(`Could not compare: ${error instanceof Error ? error.message : String(error)}`, '');
  }

  lines.push('## npm packages', '');
  const heldBack = JSON.parse(await readFile(new URL('maintenance/held-back.json', ROOT), 'utf8')) as HeldBack;
  const outdatedJson = (await npmJson(['outdated', '--json'])) as Record<string, { current?: string; latest?: string }>;
  const outdated = Object.entries(outdatedJson).map(([name, info]) => ({ name, current: info.current ?? '-', latest: info.latest ?? '-' }));
  const { toUpdate, held } = classifyOutdated(outdated, heldBack);
  if (toUpdate.length === 0) {
    lines.push('Every package is on its latest version, apart from the ones held back below.', '');
  } else {
    needsAttention = true;
    lines.push('Update these to their latest version, or add them to maintenance/held-back.json with the reason:', '');
    lines.push('| Package | Current | Latest |', '|---|---|---|');
    for (const entry of toUpdate) lines.push(`| ${entry.name} | ${entry.current} | ${entry.latest} |`);
    lines.push('');
  }
  if (held.length > 0) {
    lines.push('Held back on purpose (check the reason still holds):', '');
    for (const entry of held)
      lines.push(`- ${entry.name} ${entry.current} (latest ${entry.latest}): ${heldBack.packages[entry.name]?.reason ?? ''}`);
    lines.push('');
  }
  for (const [name, override] of Object.entries(heldBack.overrides)) {
    lines.push(`- Override: ${name} ${override.version}: ${override.reason}`);
  }
  if (Object.keys(heldBack.overrides).length > 0) lines.push('');
  const audit = (await npmJson(['audit', '--json'])) as { metadata?: { vulnerabilities?: Record<string, number> } };
  const vulnerabilities = audit.metadata?.vulnerabilities ?? {};
  const total = Object.entries(vulnerabilities)
    .filter(([level]) => level !== 'total' && level !== 'info')
    .reduce((sum, [, count]) => sum + count, 0);
  needsAttention ||= total > 0;
  lines.push(`Known vulnerabilities (npm audit): ${String(total)}.`, '');

  lines.push('## Node.js', '');
  try {
    const releases = (await fetchJson(NODE_RELEASES_URL)) as { version: string; lts: string | false }[];
    const lts = supportedLtsMajors(releases);
    const ci = await readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8');
    const missing = lts.filter((major) => !new RegExp(`\\b${String(major)}\\b`).test(ci.match(/node-version: \[([^\]]*)\]/)?.[1] ?? ''));
    lines.push(`Supported LTS lines: ${lts.join(', ')}.`, '');
    if (missing.length > 0) {
      needsAttention = true;
      lines.push(`The CI matrix does not test: ${missing.join(', ')}. Update .github/workflows/ci.yml (and engines in package.json).`, '');
    }
  } catch (error) {
    lines.push(`Could not check: ${error instanceof Error ? error.message : String(error)}`, '');
  }

  lines.push(
    '## Also check by hand',
    '',
    '- MCP specification changelog: https://modelcontextprotocol.io/specification',
    '- Chrome Web Store API docs: https://developer.chrome.com/docs/webstore/api',
    '',
  );
  return { markdown: lines.join('\n'), needsAttention, live };
}

async function record(today: Date, live: ApiSurface | null): Promise<void> {
  if (!live) throw new Error('Cannot record: the live API description could not be read.');
  const date = today.toISOString().slice(0, 10);
  const maintenanceFile = new URL('src/maintenance.ts', ROOT);
  const source = (await readFile(maintenanceFile, 'utf8'))
    .replace(/export const LAST_REVIEWED = '[^']*';/, `export const LAST_REVIEWED = '${date}';`)
    .replace(/export const API_REVISION = '[^']*';/, `export const API_REVISION = '${live.revision}';`);
  await writeFile(maintenanceFile, source);
  const snapshotFile = new URL('maintenance/api-surface.json', ROOT);
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as Record<string, unknown>;
  await writeFile(snapshotFile, `${JSON.stringify({ ...snapshot, revision: live.revision, methods: live.methods }, null, 2)}\n`);
  process.stdout.write(
    `Recorded the review on ${date} (API revision ${live.revision}). Run npm test: it fails if a new API method has no tool.\n`,
  );
}

async function main(argv: string[]): Promise<number> {
  const today = new Date();
  const report = await buildReport(today);
  process.stdout.write(`${report.markdown}\n`);
  const reportIndex = argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : undefined;
  if (reportPath) await writeFile(reportPath, report.markdown);
  if (argv.includes('--record')) {
    await record(today, report.live);
    return 0;
  }
  return report.needsAttention ? 1 : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
