import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORT_LIMITS, REPORT_REASONS } from '@rally/db';
import {
  REPORT_NOTE_MAX,
  REPORT_REASON_OPTIONS,
  buildReportArgs,
  canSendReport,
  isReportReason,
  reportErrorMessage,
  reportThanks,
} from '../src/lib/report-model';

const BEN = '11111111-1111-4111-8111-111111111111';

test('the sheet offers exactly the reasons report_user accepts, each once, with a label', () => {
  assert.deepEqual(
    REPORT_REASON_OPTIONS.map((o) => o.value),
    [...REPORT_REASONS],
  );
  for (const o of REPORT_REASON_OPTIONS) assert.ok(o.label.length > 0, o.value);
  assert.equal(
    REPORT_REASON_OPTIONS.find((o) => o.value === 'inappropriate_profile')?.label,
    'Inappropriate name or photo',
  );
  assert.equal(REPORT_NOTE_MAX, REPORT_LIMITS.note);
});

test('isReportReason: the fixed set only', () => {
  assert.equal(isReportReason('cheating'), true);
  for (const v of ['Cheating', 'abuse', '', null, undefined, 3]) assert.equal(isReportReason(v), false, String(v));
});

test('buildReportArgs: needs a target and a reason', () => {
  assert.equal(buildReportArgs({ userId: BEN, reason: null, note: 'x' }), null);
  assert.equal(buildReportArgs({ userId: '', reason: 'spam', note: '' }), null);
  assert.deepEqual(buildReportArgs({ userId: BEN, reason: 'spam', note: '' }), { p_user_id: BEN, p_reason: 'spam' });
});

test('buildReportArgs: the note is trimmed, left out when blank, cut to the limit', () => {
  assert.deepEqual(buildReportArgs({ userId: BEN, reason: 'hate', note: '  slurs in chat \n' }), {
    p_user_id: BEN,
    p_reason: 'hate',
    p_note: 'slurs in chat',
  });
  assert.equal(buildReportArgs({ userId: BEN, reason: 'hate', note: ' \n\t ' })?.p_note, undefined);
  const long = buildReportArgs({ userId: BEN, reason: 'other', note: `  ${'a'.repeat(600)}` });
  assert.equal(long?.p_note?.length, REPORT_LIMITS.note);
  // A cut that ends in spaces does not send them.
  const spaced = buildReportArgs({ userId: BEN, reason: 'other', note: `${'a'.repeat(499)}  b` });
  assert.equal(spaced?.p_note, 'a'.repeat(499));
});

test('buildReportArgs: game and room go along when known; a room id is cut to 128', () => {
  assert.deepEqual(buildReportArgs({ userId: BEN, reason: 'cheating', note: '', gameId: 'sumo', roomId: 'abc123' }), {
    p_user_id: BEN,
    p_reason: 'cheating',
    p_game_id: 'sumo',
    p_room_id: 'abc123',
  });
  const args = buildReportArgs({ userId: BEN, reason: 'cheating', note: '', gameId: ' ', roomId: 'r'.repeat(200) });
  assert.equal(args?.p_game_id, undefined);
  assert.equal(args?.p_room_id?.length, REPORT_LIMITS.roomId);
  const none = buildReportArgs({ userId: BEN, reason: 'cheating', note: '', gameId: null, roomId: null });
  assert.deepEqual(Object.keys(none ?? {}).sort(), ['p_reason', 'p_user_id']);
});

test('canSendReport: a reason, and not while sending', () => {
  assert.equal(canSendReport(null, false), false);
  assert.equal(canSendReport('spam', false), true);
  assert.equal(canSendReport('spam', true), false);
});

test('reportErrorMessage: the caller-side failures the RPC can raise', () => {
  assert.match(reportErrorMessage({ message: 'RATE_LIMITED: too many reports, try again later' }), /a lot of reports/);
  assert.match(reportErrorMessage({ message: 'ANONYMOUS_FORBIDDEN: link an account first' }), /Finish creating/);
  assert.match(reportErrorMessage({ message: 'UNAUTHENTICATED' }), /Sign in again/);
  assert.match(reportErrorMessage(new TypeError('Network request failed')), /offline/);
  assert.equal(
    reportErrorMessage({ message: 'INVALID: cannot report yourself' }),
    "Couldn't send the report. Try again.",
  );
  assert.equal(reportErrorMessage(null), "Couldn't send the report. Try again.");
});

test('reportThanks: a thank-you, and the block when it happened', () => {
  assert.equal(reportThanks('@ben', false), "Thanks for reporting. We'll take a look.");
  assert.equal(reportThanks('@ben', true), 'Thanks for reporting. @ben is blocked.');
});
