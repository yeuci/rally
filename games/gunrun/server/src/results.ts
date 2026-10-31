import type { MatchSummary } from './match.ts';

/**
 * How a finished match maps onto Rally's server-written stats (apps/game-server `server_record_match`):
 *
 * - `wins` is a **total** board (game.json `mode: "total"`): the winner gets one more (`leaderboardDeltas`).
 * - `kills` is a **best** board (mode omitted): each signed-in player's kills in the match (`leaderboardScores`); the
 *   database keeps everyone's best single match. 0 is not sent (the database ignores scores <= 0 anyway).
 * - Achievements are keys from game.json; `server_record_match` ignores unknown keys and repeats.
 * - Bots never appear in any of it: the room leaves them out of the result entirely.
 */

/** Achievement keys (game.json) and what earns them in one match. */
export const ACHIEVEMENTS = {
  /** Win a match. */
  first_win: 1,
  /** Win without dying. */
  flawless: 0,
  /** Two opponents with one rocket or grenade. */
  two_for_one: 2,
  /** Knife three opponents down a rung. */
  humiliation: 3,
  /** An opponent killed by a barrel you set off. */
  kaboom: 1,
} as const;

export type AchievementKey = keyof typeof ACHIEVEMENTS;

/** The achievements `playerId` earned in a match (empty when they did not take part). */
export function matchAchievements(summary: MatchSummary, playerId: string): AchievementKey[] {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return [];
  const won = summary.winner === playerId;
  const keys: AchievementKey[] = [];
  if (won) keys.push('first_win');
  if (won && s.deaths <= ACHIEVEMENTS.flawless) keys.push('flawless');
  if (s.bestBlast >= ACHIEVEMENTS.two_for_one) keys.push('two_for_one');
  if (s.knifeKills >= ACHIEVEMENTS.humiliation) keys.push('humiliation');
  if (s.barrelKills >= ACHIEVEMENTS.kaboom) keys.push('kaboom');
  return keys;
}

/** Board ids from game.json. */
export type BoardKey = 'wins' | 'kills';

/**
 * `playerId`'s numbers for the boards: `wins` 1 for the winner (a delta on the total board, else null), `kills` their
 * kills in the match (a best-run score, null for none). Null everywhere for someone who did not take part.
 */
export function matchBoardScores(summary: MatchSummary, playerId: string): Record<BoardKey, number | null> {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return { wins: null, kills: null };
  return { wins: summary.winner === playerId ? 1 : null, kills: s.kills >= 1 ? Math.floor(s.kills) : null };
}
