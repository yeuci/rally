/**
 * Server-written multiplayer results (architecture §4, §8: results are written only by the room).
 *
 * Phase 1: `reportMatchResult` only logs. TODO(M3 phase 2): with `SUPABASE_SERVICE_ROLE_KEY`, write through the
 * service role — one `game_stats` upsert per non-guest player (plays, wins) and the game's server leaderboards
 * (`leaderboard_entries`, e.g. Sumo's `wins` board += 1 for the winner), plus `user_achievements` for keys the room
 * awarded — in one RPC so a match is recorded atomically and idempotently by `matchId`. Guests are skipped.
 */

export interface MatchResultPlayer {
  /** Supabase user id or `guest:<random>`. */
  userId: string;
  username: string;
  guest: boolean;
  /** 1 = winner; ties share a placement. */
  placement: number;
  /** Game-specific score (Sumo: round wins). */
  score: number;
  /** Achievement keys from game.json this player earned in the match. */
  achievements: string[];
}

export interface MatchResult {
  /** Unique per match (`<roomId>:<n>`); the phase-2 write is idempotent on it. */
  matchId: string;
  gameId: string;
  roomId: string;
  /** Winner's userId, or null for no winner. */
  winnerUserId: string | null;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  rounds: number;
  /** Server leaderboard increments, by board id from game.json (`{ wins: 1 }` for the winner). */
  leaderboardDeltas: Record<string, Record<string, number>>;
  players: MatchResultPlayer[];
  /** Free-form game details (e.g. how the match was decided). */
  details?: Record<string, unknown>;
}

export type MatchResultSink = (result: MatchResult) => void | Promise<void>;

let sink: MatchResultSink = (result) => {
  const who = result.players.map((p) => `${p.username}${p.guest ? '(guest)' : ''}=${p.score}#${p.placement}`).join(' ');
  console.info(
    `[results] ${result.gameId} ${result.matchId} winner=${result.winnerUserId ?? '—'} rounds=${result.rounds} ` +
      `${result.durationSec.toFixed(1)}s ${who}`,
  );
  console.info(`[results] ${JSON.stringify(result)}`);
};

/** Record a finished match. Never throws: a failed write must not crash the room. */
export async function reportMatchResult(result: MatchResult): Promise<void> {
  try {
    await sink(result);
  } catch (err) {
    console.error('[results] reportMatchResult failed', err);
  }
}

/** Replace the sink (tests, and the phase-2 Supabase writer). Returns the previous one. */
export function setMatchResultSink(next: MatchResultSink): MatchResultSink {
  const prev = sink;
  sink = next;
  return prev;
}
