import { MAX_STARS } from './constants.ts';
import type { DaySummary } from './game.ts';
import { MECHANIC_DAY } from './recipes.ts';

/**
 * How a finished day maps onto Rally's server-written stats (apps/game-server `server_record_match`). Each day (a
 * shift) is one record, so a crew that leaves after Thursday keeps Thursday; the restaurant closing mid-day records
 * that day too.
 *
 * - `days` is a **best** board: the day reached (Monday 1, Sunday 7, Overtime 8+). The database keeps each player's
 *   best.
 * - `tips` is a **best** board: the day's tips (the crew's, shared: a co-op board). 0 is not sent.
 * - Achievements are team achievements (keys from game.json): everyone in the crew that day earns them.
 * - Bots never appear in any of it.
 */

export const ACHIEVEMENTS = {
  /** Sunday survived. */
  survive_week: 7,
  /** A day finished at five stars with no angry customer. */
  five_star_day: MAX_STARS,
  /** No stale plate in a day, Wednesday or later. */
  belt_master: MECHANIC_DAY.tables,
  /** Ten gold plates served in one day. */
  gold_rush: 10,
  /** Every open seat taken at once. */
  full_house: 1,
} as const;

export type AchievementKey = keyof typeof ACHIEVEMENTS;

/** The team achievements a day earned. */
export function dayAchievements(s: DaySummary): AchievementKey[] {
  const keys: AchievementKey[] = [];
  if (s.week) keys.push('survive_week');
  if (!s.closed && s.perfect && s.stars >= ACHIEVEMENTS.five_star_day) keys.push('five_star_day');
  if (!s.closed && s.day >= ACHIEVEMENTS.belt_master && s.stale === 0 && s.served > 0) keys.push('belt_master');
  if (s.gold >= ACHIEVEMENTS.gold_rush) keys.push('gold_rush');
  if (s.fullHouse) keys.push('full_house');
  return keys;
}

export type BoardKey = 'days' | 'tips';

/** The day's numbers for the best-run boards (null: nothing to send). */
export function dayBoardScores(s: DaySummary): Record<BoardKey, number | null> {
  return { days: positive(s.day), tips: positive(s.tips) };
}

function positive(v: number): number | null {
  const n = Math.floor(v);
  return Number.isFinite(n) && n >= 1 ? n : null;
}
