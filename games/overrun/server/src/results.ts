import type { RunSummary } from './match.ts';

/**
 * How a finished run maps onto Rally's server-written stats (apps/game-server `server_record_match`):
 *
 * - Boards (`wave`, `kills` in game.json) are **best run** boards (`leaderboards.mode = 'best'`, the default): the
 *   room sends each signed-in player's numbers for the run as `leaderboardScores`, and the database keeps the
 *   highest one per player (never lowered). `wave` = the wave the run reached, `kills` = that player's kills in the
 *   run. Nothing is capped here; the database ignores scores <= 0 (so 0 is not sent) and absurd ones (> 1e9).
 * - Achievements are keys from game.json; `server_record_match` ignores unknown keys and repeats.
 */

/** Achievement keys (game.json) and what earns them in one run. */
export const ACHIEVEMENTS = {
  /** Reach wave 10. */
  first_wave_10: 10,
  /** 500 kills in one run. */
  horde_slayer: 500,
  /** Revive 3 teammates in one run. */
  medic: 3,
  /** Clear a whole wave without taking damage (from its first second to its last). */
  untouchable: 1,
  /** 10 kills with one barrel explosion you set off. */
  demolition: 10,
} as const;

export type AchievementKey = keyof typeof ACHIEVEMENTS;

/** The achievements `playerId` earned in a run (empty when they did not take part). */
export function runAchievements(summary: RunSummary, playerId: string): AchievementKey[] {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return [];
  const keys: AchievementKey[] = [];
  if (summary.wave >= ACHIEVEMENTS.first_wave_10) keys.push('first_wave_10');
  if (s.kills >= ACHIEVEMENTS.horde_slayer) keys.push('horde_slayer');
  if (s.revives >= ACHIEVEMENTS.medic) keys.push('medic');
  if (s.cleanWaves >= ACHIEVEMENTS.untouchable) keys.push('untouchable');
  if (s.bestBlast >= ACHIEVEMENTS.demolition) keys.push('demolition');
  return keys;
}

/** Board ids from game.json. */
export type BoardKey = 'wave' | 'kills';

/**
 * `playerId`'s scores for a run on the best-run boards: the wave the run reached and the player's kills in it, as
 * sent (no cap). null for nothing to report: the player did not take part, or the number is not a positive integer
 * (the database ignores scores <= 0 anyway).
 */
export function runBoardScores(summary: RunSummary, playerId: string): Record<BoardKey, number | null> {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return { wave: null, kills: null };
  return { wave: positive(summary.wave), kills: positive(s.kills) };
}

function positive(value: number): number | null {
  const n = Math.floor(value);
  return Number.isFinite(n) && n >= 1 ? n : null;
}
