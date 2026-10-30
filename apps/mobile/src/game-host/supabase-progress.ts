import { withAnonymousRetry } from '@/lib/launch';
import { supabase } from '@/lib/supabase';
import { HostError } from './bridge';
import { mapProgressError, mapSubmitResult, mapTopRows, mapUnlockResult, unlockNeedsSession, type ProgressStore } from './progress';

/**
 * Leaderboards and achievements through Supabase as the signed-in user: `submit_solo_score` (bounded by the play
 * session's server-side start time and the board's `max_score_per_minute`), `leaderboard_top` and
 * `unlock_achievement`. Results and errors are mapped to the bridge's shapes in `progress.ts`.
 */
export function createSupabaseProgressStore(gameId: string): ProgressStore {
  return {
    async submitScore(boardId, score, sessionId) {
      if (!sessionId)
        throw new HostError('INTERNAL', 'no play session (it could not be started); scores are not recorded');
      const { data, error } = await withAnonymousRetry(() =>
        supabase.rpc('submit_solo_score', {
          p_game_id: gameId,
          p_board_key: boardId,
          p_score: score,
          p_session_id: sessionId,
        }),
      );
      if (error) throw mapProgressError(error);
      return mapSubmitResult(data);
    },

    async top(boardId, scope, limit) {
      const { data, error } = await supabase.rpc('leaderboard_top', {
        p_game_id: gameId,
        p_board_key: boardId,
        p_scope: scope,
        p_limit: limit,
      });
      if (error) throw mapProgressError(error);
      return mapTopRows(data);
    },

    async unlockAchievement(key, sessionId) {
      // The server refuses a new unlock (NOT_FOUND) unless this game's play session exists.
      if (!sessionId) throw unlockNeedsSession();
      const { data, error } = await withAnonymousRetry(() =>
        supabase.rpc('unlock_achievement', { p_game_id: gameId, p_key: key }),
      );
      if (error) throw mapProgressError(error);
      return mapUnlockResult(data);
    },
  };
}
