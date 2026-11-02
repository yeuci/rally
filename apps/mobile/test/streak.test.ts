import assert from 'node:assert/strict';
import { test } from 'node:test';
import { celebrationText, queueCelebration, type Celebration } from '../src/lib/levels-model';
import {
  applyStreakEvent,
  currentStreak,
  EMPTY_STREAK,
  isDoneToday,
  longestLabel,
  nextBonusLine,
  nextBonusWhen,
  parseStreak,
  parseStreakEvent,
  streakA11y,
  streakCelebration,
  streakGrew,
  streakStatus,
  streakStatusLine,
  streakTitle,
  utcDay,
  type Streak,
} from '../src/lib/streak-model';

// The day these fixtures live in (UTC), and moments in it.
const DAY = '2026-11-01';
const MIDNIGHT = Date.parse(`${DAY}T00:00:00Z`);
const NOW = MIDNIGHT + 18.8 * 3_600_000; // 18:48 UTC
const DAY_MS = 86_400_000;

const streak = (over: Partial<Streak> = {}): Streak => ({
  current: 3,
  longest: 7,
  lastPlayedOn: DAY,
  nextCoins: 30,
  nextXp: 10,
  ...over,
});

test('my_streak parsed defensively: numbers clamped, the day as YYYY-MM-DD, junk reads as nothing yet', () => {
  assert.deepEqual(
    parseStreak({ current: 3, longest: 7, last_played_on: DAY, today_done: true, next_coins: 30, next_xp: 10 }),
    streak(),
  );
  // A date-time or a Date-ish string still gives the day; longest never below current.
  assert.deepEqual(parseStreak({ current: 4, longest: 2, last_played_on: `${DAY}T00:00:00.000Z`, next_coins: 40 }), {
    current: 4,
    longest: 4,
    lastPlayedOn: DAY,
    nextCoins: 40,
    nextXp: 0,
  });
  assert.deepEqual(parseStreak({ current: -2, longest: '7', last_played_on: 'yesterday', next_coins: 10.9 }), {
    ...EMPTY_STREAK,
    nextCoins: 10,
  });
  assert.deepEqual(parseStreak(null), EMPTY_STREAK);
  assert.deepEqual(parseStreak('nope'), EMPTY_STREAK);
});

test('the day boundary is UTC: today is done until midnight, yesterday keeps the streak alive, a missed day ends it', () => {
  assert.equal(utcDay(NOW), DAY);
  assert.equal(utcDay(MIDNIGHT - 1), '2026-10-31');
  const s = streak();
  assert.equal(isDoneToday(s, NOW), true);
  assert.equal(currentStreak(s, NOW), 3);
  assert.equal(streakStatus(s, NOW), 'done');
  // Just after midnight: not done any more, still alive (yesterday counts), today's game is due.
  const tomorrow = MIDNIGHT + DAY_MS + 60_000;
  assert.equal(isDoneToday(s, tomorrow), false);
  assert.equal(currentStreak(s, tomorrow), 3);
  assert.equal(streakStatus(s, tomorrow), 'due');
  // A whole day missed: the streak is over, whatever the stale row says; the longest is untouched.
  const dayAfter = MIDNIGHT + 2 * DAY_MS + 60_000;
  assert.equal(currentStreak(s, dayAfter), 0);
  assert.equal(streakStatus(s, dayAfter), 'none');
  assert.equal(streakTitle(currentStreak(s, dayAfter)), 'No streak yet');
  // Never played.
  assert.equal(currentStreak(EMPTY_STREAK, NOW), 0);
  assert.equal(streakStatus(EMPTY_STREAK, NOW), 'none');
  // The server's 0 after a missed day is believed even when the day would still count.
  assert.equal(currentStreak(streak({ current: 0, lastPlayedOn: DAY }), NOW), 0);
});

test('labels: the title, the status line, the longest and the bonus preview', () => {
  assert.equal(streakTitle(0), 'No streak yet');
  assert.equal(streakTitle(1), '1-day streak');
  assert.equal(streakTitle(12), '12-day streak');
  assert.equal(streakStatusLine('done'), 'Done for today');
  assert.equal(streakStatusLine('due'), 'Play today to keep it');
  assert.equal(streakStatusLine('none'), 'Play a game to start one');
  assert.equal(longestLabel(0), undefined);
  assert.equal(longestLabel(1), 'Longest 1 day');
  assert.equal(longestLabel(7), 'Longest 7 days');
  const s = streak();
  assert.equal(nextBonusWhen(s, NOW), 'Tomorrow');
  assert.equal(nextBonusWhen(s, MIDNIGHT + DAY_MS), 'Today');
  assert.equal(nextBonusLine(s, NOW), 'Tomorrow +30 coins · +10 XP');
  assert.equal(nextBonusLine(streak({ lastPlayedOn: '2026-10-31', nextCoins: 30, nextXp: 0 }), NOW), 'Today +30 coins');
  assert.equal(nextBonusLine(streak({ nextCoins: 0, nextXp: 0 }), NOW), '');
  assert.equal(streakA11y(s, NOW), '3-day streak, done for today. Longest 7 days. Tomorrow +30 coins · +10 XP');
  assert.equal(
    streakA11y({ ...EMPTY_STREAK, nextCoins: 10, nextXp: 10 }, NOW),
    'No streak yet, play a game to start one. Today +10 coins · +10 XP',
  );
});

test('streak broadcast: parsed (also wrapped in {payload}); malformed and other events ignored', () => {
  const raw = {
    type: 'streak',
    current: 4,
    longest: 7,
    last_played_on: DAY,
    coins: 30,
    xp: 10,
    at: `${DAY}T18:48:00.000Z`,
  };
  assert.deepEqual(parseStreakEvent(raw), raw);
  assert.deepEqual(parseStreakEvent({ payload: raw }), raw);
  // The longest is never below the current; a missing time still parses.
  assert.deepEqual(parseStreakEvent({ type: 'streak', current: 9, longest: 2, last_played_on: DAY }), {
    type: 'streak',
    current: 9,
    longest: 9,
    last_played_on: DAY,
    coins: 0,
    xp: 0,
    at: new Date(0).toISOString(),
  });
  for (const bad of [
    null,
    'streak',
    [],
    { ...raw, type: 'coins' },
    { ...raw, current: 0 },
    { ...raw, current: '4' },
    { ...raw, last_played_on: undefined },
    { ...raw, last_played_on: 'today' },
  ]) {
    assert.equal(parseStreakEvent(bad), null, JSON.stringify(bad));
  }
});

test('applying an event: the cached streak takes a new day, never goes backwards, keeps the bonus preview', () => {
  const e = parseStreakEvent({
    type: 'streak',
    current: 4,
    longest: 7,
    last_played_on: '2026-11-02',
    coins: 30,
    xp: 10,
  })!;
  const cached = streak();
  assert.deepEqual(applyStreakEvent(cached, e), { ...cached, current: 4, lastPlayedOn: '2026-11-02' });
  // Nothing cached yet: the event is the streak (the preview arrives with the refetch).
  assert.deepEqual(applyStreakEvent(undefined, e), {
    current: 4,
    longest: 7,
    lastPlayedOn: '2026-11-02',
    nextCoins: 0,
    nextXp: 0,
  });
  // The longest grows with the event, and is kept when the cache knew a longer one.
  assert.equal(applyStreakEvent(streak({ longest: 3 }), e).longest, 7);
  assert.equal(applyStreakEvent(streak({ longest: 20 }), e).longest, 20);
  // An older event, or the same day already cached, changes nothing (same object).
  const newer = streak({ current: 5, lastPlayedOn: '2026-11-03' });
  assert.equal(applyStreakEvent(newer, e), newer);
  const same = streak({ current: 4, lastPlayedOn: '2026-11-02' });
  assert.equal(applyStreakEvent(same, e), same);
  // A reset after a missed day is a new day too: 1 replaces the stale 3.
  const reset = parseStreakEvent({ type: 'streak', current: 1, longest: 7, last_played_on: '2026-11-05' })!;
  assert.deepEqual(applyStreakEvent(cached, reset), { ...cached, current: 1, lastPlayedOn: '2026-11-05' });
});

test('a day the app had not seen is celebrated once; a day already shown, or no growth, is not', () => {
  const e = parseStreakEvent({
    type: 'streak',
    current: 4,
    longest: 7,
    last_played_on: '2026-11-02',
    coins: 30,
    xp: 10,
  })!;
  assert.equal(streakGrew(undefined, e), true, 'nothing cached yet');
  assert.equal(streakGrew(EMPTY_STREAK, e), true, 'never played before');
  assert.equal(streakGrew(streak({ lastPlayedOn: DAY }), e), true);
  assert.equal(streakGrew(streak({ lastPlayedOn: '2026-11-02' }), e), false, 'already shown');
  assert.equal(streakGrew(streak({ lastPlayedOn: '2026-11-03' }), e), false, 'older event');
  assert.deepEqual(streakCelebration(e, 7), { key: 7, kind: 'streak', days: 4, coins: 30, xp: 10 });
});

test('the streak celebration: its lines, and the queue keeps one streak (the later day wins)', () => {
  assert.deepEqual(celebrationText({ key: 1, kind: 'streak', days: 3, coins: 20, xp: 10 }), {
    title: '3-day streak',
    body: 'Streak kept up',
    reward: '+20 coins · +10 XP',
  });
  assert.deepEqual(celebrationText({ key: 2, kind: 'streak', days: 1, coins: 10, xp: 0 }), {
    title: '1-day streak',
    body: 'Streak started',
    reward: '+10 coins',
  });
  assert.equal(celebrationText({ key: 3, kind: 'streak', days: 2, coins: 0, xp: 0 }).reward, '');
  // The title is the card's (lib/streak-model.ts streakTitle).
  assert.equal(celebrationText({ key: 4, kind: 'streak', days: 5, coins: 40, xp: 10 }).title, streakTitle(5));

  const day = (key: number, days: number): Celebration => ({ key, kind: 'streak', days, coins: 10, xp: 10 });
  const lvl: Celebration = { key: 9, kind: 'level', level: 5, coins: 80 };
  let q: Celebration[] = [];
  q = queueCelebration(q, lvl);
  q = queueCelebration(q, day(1, 3));
  q = queueCelebration(q, day(2, 4));
  assert.deepEqual(q, [lvl, day(2, 4)], 'a later day replaces the queued one');
  q = queueCelebration(q, day(3, 2));
  assert.deepEqual(q, [lvl, day(2, 4)], 'an earlier day does not');
  q = queueCelebration(q, day(4, 4));
  assert.deepEqual(q, [lvl, day(4, 4)], 'the same day again: the newer key');
});
