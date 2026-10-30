/**
 * Server-side play sessions (architecture §8: solo scores need a host-recorded session start). The controller
 * starts one when the game screen mounts, in parallel with the WebView load, and closes it exactly once when the
 * game ends for any reason. `record_play` (M1) is only the fallback for a session that could not be started.
 */
export interface PlaySessionService {
  /** `start_play_session(game_id, version)`; resolves to the session id, rejects when it could not be started. */
  start(game: { id: string; version: string }): Promise<string>;
  /** `end_play_session(session_id, playtime_s)`: closes the session and records the play (stats, recently played). */
  end(sessionId: string, playtimeS: number): Promise<void>;
  /** `record_play(game_id, playtime_s)`: the M1 path, used when no session exists. */
  recordPlay(gameId: string, playtimeS: number): Promise<void>;
}
