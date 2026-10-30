/**
 * Server-side play sessions (architecture §8: solo scores need a host-recorded session start). The controller
 * starts one when the game screen mounts, in parallel with the WebView load, and closes it exactly once when the
 * game ends for any reason. `record_play` (M1) is only the fallback for a session that could not be started.
 *
 * A play is recorded only for a launch whose game called `ready()` (in any attempt): a game that never loaded is
 * not a play. Such a session is `abandon`ed instead of ended (no RPC closes a session without counting a play).
 */
export interface PlaySessionService {
  /** `start_play_session(game_id, version)`; resolves to the session id, rejects when it could not be started. */
  start(game: { id: string; version: string }): Promise<string>;
  /** `end_play_session(session_id, playtime_s)`: closes the session and records the play (stats, recently played). */
  end(sessionId: string, playtimeS: number): Promise<void>;
  /** `record_play(game_id, playtime_s)`: the M1 path, used when no session exists. */
  recordPlay(gameId: string, playtimeS: number): Promise<void>;
  /**
   * The session's latest known playtime while it is still open (at `ready()`, when the app goes to the background,
   * at a reload or crash), so a session the app never got to close (killed or jettisoned in the background) can be
   * closed on the next launch. Best effort, never awaited.
   */
  checkpoint?(sessionId: string, playtimeS: number, played: boolean): void;
  /**
   * The game never became ready: `abandon_play_session` closes the session without counting a play (an open one
   * would make a later `record_play` fallback refuse with CONFLICT), and what `checkpoint` kept is forgotten.
   */
  abandon?(sessionId: string): Promise<void>;
}

/**
 * The refusals `record_play` answers by design (hardening migration), which are not failures to report: CONFLICT
 * (a session is still open for the game: it gets ended or abandoned instead; do not retry), RATE_LIMITED (one play a
 * minute, 12 an hour per game) and NOT_FOUND (the game is not published). Null for anything else.
 */
export function recordPlayRefusal(message: string): 'conflict' | 'rate-limited' | 'not-found' | null {
  if (/^CONFLICT\b/.test(message)) return 'conflict';
  if (/^RATE_LIMITED\b/.test(message)) return 'rate-limited';
  if (/^NOT_FOUND\b/.test(message)) return 'not-found';
  return null;
}
