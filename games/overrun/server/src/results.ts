import type { RunSummary } from './match.ts';

/**
 * How a finished run maps onto Rally's server-written stats (apps/game-server `server_record_match`):
 *
 * - Boards (`wave`, `kills` in game.json) are **cumulative** on the server: the RPC adds an integer delta of 1…10 per
 *   player and match to their entry (deltas outside that range, or 0, are ignored). So `wave` grows by the waves a
 *   run reached (up to 10 per run) and `kills` by the run's kills (up to 10 per run). A "best wave ever" board
 *   needs a max-mode board in the database; until then the exact numbers of every run are in the result's
 *   `details` (match_results.payload).
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

/** The largest per-match delta `server_record_match` accepts on a board. */
export const MAX_BOARD_DELTA = 10;

/** A board delta the RPC accepts (an integer 1…10), or null for nothing to add. */
export function boardDelta(value: number): number | null {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_BOARD_DELTA, n);
}
