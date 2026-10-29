import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageOn, meetsMinimumAge, parseDob, toIsoDate } from '../src/lib/auth/age';

const today = new Date(2026, 9, 29); // 29 Oct 2026, local time

test('parseDob rejects incomplete and impossible dates', () => {
  assert.deepEqual(parseDob('', '1', '2000', today), { ok: false, reason: 'incomplete' });
  assert.deepEqual(parseDob('1', '1', '200', today), { ok: false, reason: 'incomplete' });
  assert.deepEqual(parseDob('2', '30', '2000', today), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseDob('2', '29', '2001', today), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseDob('13', '1', '2000', today), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseDob('1', '1', '2030', today), { ok: false, reason: 'invalid' }, 'future');
  assert.deepEqual(parseDob('1', '1', '1890', today), { ok: false, reason: 'invalid' }, 'over 120');
});

test('parseDob accepts real dates, including 29 Feb in a leap year', () => {
  assert.deepEqual(parseDob('2', '29', '2004', today), { ok: true, date: { year: 2004, month: 2, day: 29 } });
  assert.deepEqual(parseDob('07', '04', '1990', today), { ok: true, date: { year: 1990, month: 7, day: 4 } });
});

test('13th birthday boundary', () => {
  assert.equal(ageOn({ year: 2013, month: 10, day: 29 }, today), 13);
  assert.equal(meetsMinimumAge({ year: 2013, month: 10, day: 29 }, today), true);
  assert.equal(ageOn({ year: 2013, month: 10, day: 30 }, today), 12);
  assert.equal(meetsMinimumAge({ year: 2013, month: 10, day: 30 }, today), false);
  assert.equal(meetsMinimumAge({ year: 2013, month: 11, day: 1 }, today), false);
});

test('toIsoDate pads to YYYY-MM-DD', () => {
  assert.equal(toIsoDate({ year: 2008, month: 4, day: 1 }), '2008-04-01');
});
