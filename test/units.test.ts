/**
 * Small pure functions: configuration, IDs, query building, dialog text and the maintenance clock.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readConfig } from '../src/config.ts';
import { cleanForDialog, createConfirm, dialogCommand } from '../src/confirm/confirm.ts';
import { DeclinedError, InputError, redact, SetupError } from '../src/errors.ts';
import { maintenanceNotice } from '../src/maintenance.ts';
import { itemName } from '../src/store/ids.ts';
import { metricsQuery, parseDate, reviewsQuery } from '../src/tools/read-tools.ts';
import { ITEM, PUBLISHER } from './helpers.ts';

describe('readConfig', () => {
  it('reads defaults and validates them at start-up', () => {
    assert.deepEqual(readConfig({ CWS_PUBLISHER_ID: PUBLISHER, CWS_ITEM_ID: ITEM }), {
      publisherId: PUBLISHER,
      itemId: ITEM,
      confirm: 'auto',
    });
    assert.throws(() => readConfig({ CWS_ITEM_ID: 'nope' }), SetupError);
    assert.throws(() => readConfig({ CWS_CONFIRM: 'yes' }), SetupError);
  });
});

describe('itemName', () => {
  it('builds the resource name', () => {
    assert.equal(itemName(PUBLISHER, ITEM), `publishers/${PUBLISHER}/items/${ITEM}`);
  });
  for (const bad of ['../x', 'a/b', 'a.b', '', 'me:publish', 'x'.repeat(129)]) {
    it(`refuses publisher ${JSON.stringify(bad)}`, () => {
      assert.throws(() => itemName(bad, ITEM), InputError);
    });
  }
  for (const bad of [`${ITEM}:publish`, ITEM.toUpperCase(), 'short', `${ITEM.slice(0, 31)}q`]) {
    it(`refuses item ${JSON.stringify(bad)}`, () => {
      assert.throws(() => itemName(PUBLISHER, bad), InputError);
    });
  }
});

describe('queries', () => {
  it('reviews: rating filter, order and paging', () => {
    const query = reviewsQuery({ rating: 5, orderBy: 'create_time desc', pageSize: 20, pageToken: 'next' });
    assert.equal(query.toString(), 'filter=rating+%3D+5&orderBy=create_time+desc&pageSize=20&pageToken=next');
  });
  it('metrics: repeated metrics, one dimension and the date range', () => {
    const query = metricsQuery({ metrics: ['installs', 'users-7d'], dimension: 'country', from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(query.getAll('metrics'), ['installs', 'users-7d']);
    assert.equal(query.get('dimensions'), 'country');
    assert.equal(query.get('timeSpec.firstDate.day'), '1');
    assert.equal(query.get('timeSpec.lastDate.month'), '10');
  });
  it('metrics: refuses duplicates, reversed ranges and impossible dates', () => {
    assert.throws(() => metricsQuery({ metrics: ['installs', 'installs'] }), InputError);
    assert.throws(() => metricsQuery({ metrics: ['installs'], from: '2026-11-01', to: '2026-10-01' }), InputError);
    assert.throws(() => parseDate('2026-02-30', 'from'), InputError);
    assert.deepEqual(parseDate('2028-02-29', 'from'), { year: 2028, month: 2, day: 29 });
  });
});

describe('confirmation', () => {
  it('cleans markup and control characters from dialog text', () => {
    assert.equal(cleanForDialog('a <b>b</b> & c\u0007‮'), 'a bb/b  c');
  });
  it('passes the text as one argument, with no markup for zenity', () => {
    const args = dialogCommand('zenity', { action: 'Publish', details: ['line one'] });
    assert.ok(args.includes('--no-markup'));
    assert.ok(args.includes('--default-cancel'));
    assert.ok(args.some((arg) => arg.startsWith('--text=') && arg.includes('line one')));
  });
  it('mode none never asks; dialog mode refuses without a desktop', async () => {
    const elicit = (): Promise<'unsupported'> => Promise.resolve('unsupported');
    await createConfirm({ mode: 'none', env: {}, platform: 'linux', elicit })({ action: 'x', details: [] });
    const noDesktop = createConfirm({ mode: 'dialog', env: {}, platform: 'linux', elicit, hasProgram: () => Promise.resolve(true) });
    await assert.rejects(noDesktop({ action: 'x', details: [] }), SetupError);
  });
  it('a non-zero dialog answer is a decline', async () => {
    const confirm = createConfirm({
      mode: 'auto',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      platform: 'linux',
      elicit: () => Promise.resolve(true),
      hasProgram: (program) => Promise.resolve(program === 'zenity'),
      runDialog: () => Promise.resolve(1),
    });
    await assert.rejects(confirm({ action: 'x', details: [] }), DeclinedError);
  });
});

describe('maintenance and redaction', () => {
  it('reminds only after 30 days', () => {
    assert.equal(maintenanceNotice(new Date('2026-12-03T00:00:00Z'), '2026-11-03'), null);
    assert.match(maintenanceNotice(new Date('2026-12-05T00:00:00Z'), '2026-11-03') ?? '', /32 days ago/);
  });
  it('redacts access and refresh tokens', () => {
    assert.equal(redact('a ya29.abc-DEF_1.2 b 1//0gXyZ-9 c'), 'a [redacted] b [redacted] c');
  });
});
