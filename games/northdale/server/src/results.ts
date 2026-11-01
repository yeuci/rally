import type { RunSummary } from './match.ts';

/**
 * How a finished run maps onto Rally's server-written stats (apps/game-server `server_record_match`):
 *
 * - `nights` and `kills` are **best run** boards (game.json `mode` omitted = best): each signed-in survivor's nights
 *   survived in the run and their own kills, sent as `leaderboardScores`; the database keeps everyone's best.
 * - `escapes` is a **total** board (`mode: "total"`): +1 for each signed-in survivor of a run that escaped
 *   (`leaderboardDeltas`).
 * - Achievements are keys from game.json; `server_record_match` ignores unknown keys and repeats.
 * - The database ignores scores <= 0, so 0 is never sent.
 */

/** Achievement keys (game.json) and what earns them in one run. */
export const ACHIEVEMENTS = {
  /** First Light: see the dawn after night 1. */
  first_light: 1,
  /** Blood Moon: survive a Blood Moon (to its dawn, or escape during it). */
  blood_moon: 1,
  /** Getaway: escape Northdale. */
  getaway: 1,
  /** Good Boy: be there when the dog joins. */
  good_boy: 1,
  /** Unplugged: 25 kills with the guitar in one run. */
  unplugged: 25,
} as const;

export type AchievementKey = keyof typeof ACHIEVEMENTS;

/** The achievements `playerId` earned in a run (empty when they did not take part). */
export function runAchievements(summary: RunSummary, playerId: string): AchievementKey[] {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return [];
  const keys: AchievementKey[] = [];
  if (summary.nights >= ACHIEVEMENTS.first_light) keys.push('first_light');
  if (summary.bloodMoons >= ACHIEVEMENTS.blood_moon) keys.push('blood_moon');
  if (summary.escaped) keys.push('getaway');
  if (s.foundDog) keys.push('good_boy');
  if (s.guitarKills >= ACHIEVEMENTS.unplugged) keys.push('unplugged');
  return keys;
}

/** Board ids from game.json. */
export type BoardKey = 'nights' | 'kills' | 'escapes';

/**
 * `playerId`'s numbers for the boards: `nights` the run's nights survived and `kills` their kills (best-run scores),
 * `escapes` 1 when the run escaped (a delta on the total board). null for nothing to report.
 */
export function runBoardScores(summary: RunSummary, playerId: string): Record<BoardKey, number | null> {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return { nights: null, kills: null, escapes: null };
  return { nights: positive(summary.nights), kills: positive(s.kills), escapes: summary.escaped ? 1 : null };
}

function positive(value: number): number | null {
  const n = Math.floor(value);
  return Number.isFinite(n) && n >= 1 ? n : null;
}
