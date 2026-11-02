/**
 * Pure rules behind the daily play streak (lib/streak.ts, the StreakCard on the dashboard, the streak celebration):
 * parsing what `my_streak()` returns, the day boundary (UTC, like the daily challenges), the card's labels and the
 * bonus preview, the Realtime `streak` event and what it does to the cached streak. No React Native imports:
 * test/streak.test.ts runs them under plain Node.
 *
 * The streak itself is counted by the database (20261102000400_streaks.sql; docs/progress.md): a trigger on the XP
 * ledger counts every counted match and valid solo run toward the earner's UTC day, grows the streak once per day and
 * pays the day's bonus. Nothing here decides an amount; `next_coins` / `next_xp` come from the server's rules.
 */
import type { MyStreak, StreakEvent } from '@rally/db';
import { rewardLine, type Celebration } from './levels-model';

export type { MyStreak, StreakEvent };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/** A broadcast payload, or `{ payload }` around it. */
const unwrap = (raw: unknown): Record<string, unknown> | null => {
  const outer = obj(raw);
  return obj(outer?.payload) ?? outer;
};
const dayOf = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d\d-\d\d/.test(s) ? s.slice(0, 10) : null;
};
const whole = (v: unknown): number => Math.max(0, Math.floor(num(v) ?? 0));

// --- days ----------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The UTC day of an instant, 'YYYY-MM-DD' (the streak's and the daily challenges' day boundary). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// --- my_streak -----------------------------------------------------------------------------------------------------

/** The streak as the card holds it: the server's answer, with its day as a 'YYYY-MM-DD' string. */
export interface Streak {
  /** Consecutive days up to `lastPlayedOn`, as the server reported it (0 once a day was missed). */
  current: number;
  longest: number;
  /** The UTC day of the latest counted game; null before the first one. */
  lastPlayedOn: string | null;
  /** What the next day's first counted game pays. */
  nextCoins: number;
  nextXp: number;
}

export const EMPTY_STREAK: Streak = { current: 0, longest: 0, lastPlayedOn: null, nextCoins: 0, nextXp: 0 };

/** `my_streak()` → streak; anything missing or malformed reads as nothing yet (the card shows "No streak yet"). */
export function parseStreak(raw: unknown): Streak {
  const o = obj(raw) ?? {};
  const current = whole(o.current);
  return {
    current,
    longest: Math.max(current, whole(o.longest)),
    lastPlayedOn: dayOf(o.last_played_on),
    nextCoins: whole(o.next_coins),
    nextXp: whole(o.next_xp),
  };
}

/** A counted game was played today (UTC). Derived from the day, so it turns false at 00:00 UTC without a refetch. */
export function isDoneToday(s: Pick<Streak, 'lastPlayedOn'>, now: number): boolean {
  return s.lastPlayedOn === utcDay(now);
}

/**
 * The streak as it stands at `now`: `current` while the latest game was today or yesterday (the day is not over), 0
 * once a day was missed. The server answers the same way at read time; re-derived here so a cached answer stays right
 * across midnight.
 */
export function currentStreak(s: Pick<Streak, 'current' | 'lastPlayedOn'>, now: number): number {
  if (!s.lastPlayedOn) return 0;
  return s.lastPlayedOn >= utcDay(now - DAY_MS) ? s.current : 0;
}

export type StreakStatus = 'done' | 'due' | 'none';

/** `done`: played today; `due`: a live streak waiting for today's game; `none`: nothing to keep (0, or never). */
export function streakStatus(s: Pick<Streak, 'current' | 'lastPlayedOn'>, now: number): StreakStatus {
  if (isDoneToday(s, now)) return 'done';
  return currentStreak(s, now) > 0 ? 'due' : 'none';
}

// --- labels --------------------------------------------------------------------------------------------------------

/** "3-day streak", "1-day streak", "No streak yet". */
export function streakTitle(days: number): string {
  return days > 0 ? `${days}-day streak` : 'No streak yet';
}

/** The card's second line: "Done for today", "Play today to keep it", "Play a game to start one". */
export function streakStatusLine(status: StreakStatus): string {
  switch (status) {
    case 'done':
      return 'Done for today';
    case 'due':
      return 'Play today to keep it';
    default:
      return 'Play a game to start one';
  }
}

/** "Longest 7 days" (undefined while there is none). */
export function longestLabel(longest: number): string | undefined {
  if (longest <= 0) return undefined;
  return `Longest ${longest} ${longest === 1 ? 'day' : 'days'}`;
}

/** When the next bonus can be earned: today, or tomorrow once today's game is in. */
export function nextBonusWhen(s: Pick<Streak, 'lastPlayedOn'>, now: number): 'Today' | 'Tomorrow' {
  return isDoneToday(s, now) ? 'Tomorrow' : 'Today';
}

/** The bonus preview: "Tomorrow +15 coins · +10 XP" ('' when the rules pay nothing). */
export function nextBonusLine(s: Streak, now: number): string {
  const reward = rewardLine({ coins: s.nextCoins, xp: s.nextXp });
  return reward ? `${nextBonusWhen(s, now)} ${reward}` : '';
}

/** For screen readers: "3-day streak, done for today. Longest 7 days. Tomorrow +30 coins · +10 XP". */
export function streakA11y(s: Streak, now: number): string {
  const status = streakStatus(s, now);
  const parts = [`${streakTitle(currentStreak(s, now))}, ${streakStatusLine(status).toLowerCase()}`];
  const longest = longestLabel(s.longest);
  if (longest) parts.push(longest);
  const bonus = nextBonusLine(s, now);
  if (bonus) parts.push(bonus);
  return parts.join('. ');
}

// --- Realtime ------------------------------------------------------------------------------------------------------

/** A `streak` broadcast (`{type: 'streak', …}`, or `{ payload }` around it) → event; null if malformed. */
export function parseStreakEvent(raw: unknown): StreakEvent | null {
  const v = unwrap(raw);
  if (!v || v.type !== 'streak') return null;
  const current = num(v.current);
  const day = dayOf(v.last_played_on);
  if (current === null || current < 1 || !day) return null;
  return {
    type: 'streak',
    current,
    longest: Math.max(current, whole(v.longest)),
    last_played_on: day,
    coins: whole(v.coins),
    xp: whole(v.xp),
    at: str(v.at) ?? new Date(0).toISOString(),
  };
}

/**
 * The cached streak after a `streak` event: never backwards (events can arrive out of order with a refetch); the
 * bonus preview is kept as it was until the refetch that follows (the event does not carry the next day's amounts).
 */
export function applyStreakEvent(current: Streak | undefined, e: StreakEvent): Streak {
  if (current?.lastPlayedOn && current.lastPlayedOn > e.last_played_on) return current;
  if (current?.lastPlayedOn === e.last_played_on && current.current >= e.current) return current;
  return {
    current: e.current,
    longest: Math.max(current?.longest ?? 0, e.longest, e.current),
    lastPlayedOn: e.last_played_on,
    nextCoins: current?.nextCoins ?? 0,
    nextXp: current?.nextXp ?? 0,
  };
}

/**
 * Whether an event is news: the streak grew to a day the cache had not seen (a day already shown, or a repeat of the
 * same event, is not celebrated twice). Nothing cached yet counts as news.
 */
export function streakGrew(before: Pick<Streak, 'lastPlayedOn'> | undefined, e: StreakEvent): boolean {
  return !before?.lastPlayedOn || e.last_played_on > before.lastPlayedOn;
}

/** The celebration for a new streak day (shown by `CelebrationToast`, like a level-up). */
export function streakCelebration(e: StreakEvent, key: number): Extract<Celebration, { kind: 'streak' }> {
  return { key, kind: 'streak', days: e.current, coins: e.coins, xp: e.xp };
}
