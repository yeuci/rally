/**
 * Date-of-birth parsing and the 13+ check (architecture §8). Pure: no React Native imports, unit-tested in
 * test/age.test.ts. The server enforces the same rule in `profiles_validate` (AGE_GATE).
 */
export const MIN_AGE = 13;
const MAX_AGE = 120;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export type DobParseResult = { ok: true; date: CalendarDate } | { ok: false; reason: 'incomplete' | 'invalid' };

/** Parse three user-typed fields into a real calendar date (rejects 31 Feb, the future, and > 120 years ago). */
export function parseDob(month: string, day: string, year: string, today: Date = new Date()): DobParseResult {
  if (!/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) {
    return { ok: false, reason: 'incomplete' };
  }
  const date = { year: Number(year), month: Number(month), day: Number(day) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    return { ok: false, reason: 'invalid' };
  }
  const age = ageOn(date, today);
  if (age < 0 || age > MAX_AGE) return { ok: false, reason: 'invalid' };
  return { ok: true, date };
}

/**
 * Whole years between `dob` and the UTC calendar date of `today`. UTC, not local time: the server checks
 * `birth_date` against `current_date` in UTC (`profiles_validate`), and a refusal here is remembered on the
 * device, so both sides must agree on what "today" is. Someone turning 13 today (UTC) passes both.
 */
export function ageOn(dob: CalendarDate, today: Date = new Date()): number {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const d = today.getUTCDate();
  let age = y - dob.year;
  if (m < dob.month || (m === dob.month && d < dob.day)) age -= 1;
  return age;
}

export function meetsMinimumAge(dob: CalendarDate, today: Date = new Date()): boolean {
  return ageOn(dob, today) >= MIN_AGE;
}

/** `YYYY-MM-DD`, the shape `profiles.birth_date` (date) and the signup metadata expect. */
export function toIsoDate(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
