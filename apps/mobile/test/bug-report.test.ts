import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUG_REPORT_LIMITS, BUG_REPORTS_BUCKET } from '@rally/db';
import {
  BUG_LOGS_MAX,
  BUG_NOTE_MAX,
  bugReportMeta,
  bugReportTitle,
  bugReportsEnabled,
  buildBugReport,
  decodeBase64,
  gameIdFromPath,
  newestLogsThatFit,
  screenshotObjectPath,
  toBugReportSummaries,
  type BugReportInput,
} from '../src/lib/bug-report-model';
import type { LogLine } from '../src/lib/log-buffer';

test('on in dev builds and with EXPO_PUBLIC_BUG_REPORTS=1; off in store builds', () => {
  assert.equal(bugReportsEnabled(true, undefined), true);
  assert.equal(bugReportsEnabled(false, '1'), true);
  assert.equal(bugReportsEnabled(false, 'true'), true);
  assert.equal(bugReportsEnabled(false, undefined), false);
  assert.equal(bugReportsEnabled(false, '0'), false);
  assert.equal(bugReportsEnabled(false, ''), false);
});

test('limits match the bug_reports table', () => {
  assert.equal(BUG_NOTE_MAX, BUG_REPORT_LIMITS.note);
  assert.equal(BUG_LOGS_MAX, BUG_REPORT_LIMITS.logs);
  assert.equal(BUG_REPORTS_BUCKET, 'bug-reports');
});

test('gameIdFromPath: the play route only', () => {
  assert.equal(gameIdFromPath('/game/sumo/play'), 'sumo');
  assert.equal(gameIdFromPath('/game/gun%20run/play/'), 'gun run');
  assert.equal(gameIdFromPath('/game/sumo'), null);
  assert.equal(gameIdFromPath('/dev/play'), null);
  assert.equal(gameIdFromPath('/'), null);
  assert.equal(gameIdFromPath(null), null);
});

const line = (i: number, text = `line ${i}`): LogLine => ({ at: Date.UTC(2026, 10, 1) + i, level: 'warn', text });
const input = (over: Partial<BugReportInput> = {}): BugReportInput => ({
  note: '  Sumo froze  ',
  appVersion: '0.1.0',
  platform: 'ios',
  osVersion: '18.1',
  route: '/game/sumo/play',
  gameId: 'sumo',
  gameVersion: '0.2.1',
  logs: [line(1), line(2)],
  screenshotPath: 'u1/r1.jpg',
  context: { executionEnvironment: 'storeClient' },
  ...over,
});

test('buildBugReport: the row the client may insert, trimmed to the limits', () => {
  const row = buildBugReport(input());
  assert.deepEqual(Object.keys(row).sort(), [
    'app_version',
    'context',
    'game_id',
    'game_version',
    'logs',
    'note',
    'os_version',
    'platform',
    'route',
    'screenshot_path',
  ]);
  assert.equal(row.note, 'Sumo froze');
  assert.equal(row.game_id, 'sumo');
  assert.match(row.logs, /^\d\d:\d\d:\d\d\.\d{3} W line 1\n\d\d:\d\d:\d\d\.\d{3} W line 2$/);
  const big = buildBugReport(
    input({ note: 'n'.repeat(5000), route: '/'.repeat(400), gameId: null, gameVersion: null }),
  );
  assert.equal(big.note.length, BUG_NOTE_MAX);
  assert.equal(big.route.length, 300);
  assert.equal(big.game_id, null);
  assert.equal(big.game_version, null);
});

test('logs: the newest lines that fit, oldest dropped first', () => {
  const lines = Array.from({ length: 200 }, (_, i) => line(i, `${i} `.padEnd(499, 'x')));
  const text = newestLogsThatFit(lines, 20_000);
  assert.ok(text.length <= 20_000);
  assert.ok(text.endsWith('x'), 'ends with the newest line');
  assert.match(text.split('\n').at(-1)!, / W 199 x+$/);
  assert.ok(!text.includes(' W 0 x'), 'the oldest lines went first');
  assert.equal(newestLogsThatFit([], 100), '');
  // The full buffer (200 × 500) fits the table's limit after trimming.
  assert.ok(buildBugReport(input({ logs: lines })).logs.length <= BUG_LOGS_MAX);
});

test('screenshotObjectPath: the reporter folder', () => {
  assert.equal(screenshotObjectPath('u-1', 'abc'), 'u-1/abc.jpg');
});

test('decodeBase64: standard, URL-safe, unpadded, data URIs', () => {
  const bytes = (s: string) => Array.from(decodeBase64(s));
  assert.deepEqual(bytes('SGVsbG8='), [72, 101, 108, 108, 111]);
  assert.deepEqual(bytes('SGVsbG8'), [72, 101, 108, 108, 111]);
  assert.deepEqual(bytes('data:image/jpeg;base64,/9j/'), [0xff, 0xd8, 0xff]);
  assert.deepEqual(bytes('_9j_'), [0xff, 0xd8, 0xff]);
  assert.deepEqual(bytes('AQID\nBA=='), [1, 2, 3, 4]);
  assert.deepEqual(bytes(''), []);
  const random = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 0xff);
  assert.deepEqual(decodeBase64(Buffer.from(random).toString('base64')), random);
  assert.throws(() => decodeBase64('ab$c'), /invalid base64/);
});

test('the Developer list: title, meta line', () => {
  const [r] = toBugReportSummaries([
    {
      id: 'r1',
      created_at: '2026-11-01T10:00:00Z',
      note: '\n  Sumo froze\nafter round 2',
      route: '/game/sumo/play',
      game_id: 'sumo',
      game_version: '0.2.1',
      platform: 'ios',
      app_version: '0.1.0',
      screenshot_path: 'u1/r1.jpg',
    },
  ]);
  assert.equal(bugReportTitle(r!), 'Sumo froze');
  assert.equal(bugReportMeta(r!), 'sumo 0.2.1 · ios · v0.1.0 · Screenshot');
  assert.equal(bugReportTitle({ note: '' }), 'No note');
  assert.equal(
    bugReportMeta({
      route: '/settings',
      gameId: null,
      gameVersion: null,
      platform: 'android',
      appVersion: null,
      hasScreenshot: false,
    }),
    '/settings · android',
  );
  assert.deepEqual(toBugReportSummaries(null), []);
});
