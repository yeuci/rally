import type { RequestResult } from '@rally/protocol';
import { HostError } from './bridge';

/**
 * Leaderboards and achievements as the bridge sees them (`leaderboard.submit`, `leaderboard.top`,
 * `achievement.unlock`). The play route backs it with Supabase (`supabase-progress.ts`), the Developer launcher with
 * `createMemoryProgressStore` so `/dev/play` never touches the backend.
 */
export interface ProgressStore {
  /**
   * Solo score for `boardId`. `sessionId` is the host's play session (`start_play_session`), which the server needs
   * to bound the score by elapsed time; null when the session could not be started (offline at launch) or there
   * is none (Developer launcher).
   */
  submitScore(boardId: string, score: number, sessionId: string | null): Promise<RequestResult<'leaderboard.submit'>>;
  top(boardId: string, scope: 'global' | 'friends', limit: number): Promise<RequestResult<'leaderboard.top'>>;
  unlockAchievement(key: string): Promise<RequestResult<'achievement.unlock'>>;
}

/** `submit_solo_score` jsonb → bridge result: `best` is null when the player has no score on the board yet. */
export function mapSubmitResult(raw: unknown): RequestResult<'leaderboard.submit'> {
  const r = (raw ?? {}) as { accepted?: unknown; best?: unknown };
  const best = typeof r.best === 'number' && Number.isFinite(r.best) ? r.best : r.best == null ? null : Number(r.best);
  return { accepted: r.accepted === true, best: best === null || Number.isNaN(best) ? null : best };
}

/** `leaderboard_top` rows → the protocol's entries (the avatar is not part of the bridge type). */
export function mapTopRows(
  rows: readonly { rank: number | string; user_id: string; username: string; score: number | string }[] | null,
): RequestResult<'leaderboard.top'> {
  return {
    entries: (rows ?? []).flatMap((r) => {
      const rank = Number(r.rank);
      const score = Number(r.score);
      if (!Number.isInteger(rank) || rank < 1 || !Number.isFinite(score)) return [];
      return [{ rank, userId: r.user_id, username: r.username, score }];
    }),
  };
}

/** `unlock_achievement` jsonb → bridge result. */
export function mapUnlockResult(raw: unknown): RequestResult<'achievement.unlock'> {
  const r = (raw ?? {}) as { unlocked?: unknown; alreadyHad?: unknown };
  return { unlocked: r.unlocked === true, alreadyHad: r.alreadyHad === true };
}

/**
 * Leaderboard / achievement RPC errors → bridge codes. `RATE_LIMITED` stays RATE_LIMITED; `ANONYMOUS_FORBIDDEN`
 * (a guest session can't hold scores) is NOT_SUPPORTED with the server's message; everything else is INTERNAL.
 */
export function mapProgressError(error: { message: string; code?: string }): HostError {
  if (/^RATE_LIMITED\b/.test(error.message)) return new HostError('RATE_LIMITED', error.message);
  if (/^ANONYMOUS_FORBIDDEN\b/.test(error.message)) return new HostError('NOT_SUPPORTED', error.message);
  return new HostError('INTERNAL', error.message);
}

/**
 * In-memory stand-in for the Developer launcher: one player (`userId`), higher scores win, every key unlocks.
 * Same result shapes as the RPCs, no server-side bounds.
 */
export function createMemoryProgressStore(user: { id: string; username: string }): ProgressStore {
  const best = new Map<string, number>();
  const unlocked = new Set<string>();
  return {
    async submitScore(boardId, score) {
      const current = best.get(boardId);
      if (current !== undefined && score <= current) return { accepted: false, best: current };
      best.set(boardId, score);
      return { accepted: true, best: score };
    },
    async top(boardId, _scope, limit) {
      const score = best.get(boardId);
      return {
        entries: score === undefined || limit < 1 ? [] : [{ rank: 1, userId: user.id, username: user.username, score }],
      };
    },
    async unlockAchievement(key) {
      if (unlocked.has(key)) return { unlocked: true, alreadyHad: true };
      unlocked.add(key);
      return { unlocked: true, alreadyHad: false };
    },
  };
}
