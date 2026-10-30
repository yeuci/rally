import { errorCode, isUnsupported, type RallyLike } from './host.ts';

export type Source = 'host' | 'local';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  score: number;
}

export interface SubmitOutcome {
  accepted: boolean;
  /** Player's best on the board after this submit (null if none). */
  best: number | null;
  /** 'local' when the host has no leaderboards (standalone, or a shell that answers NOT_SUPPORTED). */
  source: Source;
  /** Bridge error code when the host call failed for another reason (RATE_LIMITED, TIMEOUT …). */
  error?: string;
}

export interface TopOutcome {
  entries: LeaderboardEntry[];
  source: Source;
  error?: string;
}

export interface UnlockOutcome {
  unlocked: boolean;
  alreadyHad: boolean;
  source: Source;
  error?: string;
}

export interface SoloOptions {
  /** Sort order per board for the local fallback. Default 'desc' (higher is better). */
  sort?: Record<string, 'asc' | 'desc'>;
  /** Who "you" are in the local fallback's entries. */
  user?: () => { id: string; username: string } | null | undefined;
}

export interface Solo {
  submit(boardId: string, score: number): Promise<SubmitOutcome>;
  top(boardId: string, opts?: { scope?: 'global' | 'friends'; limit?: number }): Promise<TopOutcome>;
  unlock(key: string): Promise<UnlockOutcome>;
  /** Your entry in a `top` result, if listed. */
  findMe(entries: readonly LeaderboardEntry[]): LeaderboardEntry | undefined;
}

/**
 * Solo leaderboards + achievements that never throw. When the host cannot do it (no shell, NOT_SUPPORTED) the
 * call falls back to an in-memory board for this page, so a game's game-over screen works everywhere; once a
 * method is unsupported it is not retried. Unlocked achievement keys are remembered so repeats skip the bridge.
 */
export function createSolo(rally: Pick<RallyLike, 'isHosted' | 'leaderboard' | 'achievement'>, options: SoloOptions = {}): Solo {
  const unsupported = new Set<string>();
  const localBest = new Map<string, number>();
  const unlockedKeys = new Set<string>();
  const me = () => options.user?.() ?? { id: 'local', username: 'you' };
  const better = (boardId: string, a: number, b: number) => ((options.sort?.[boardId] ?? 'desc') === 'asc' ? a < b : a > b);

  /** Run a host call unless the method is known to be unsupported; null means "use the local fallback". */
  async function viaHost<R>(method: string, call: () => Promise<R>): Promise<{ value: R } | { error?: string } | null> {
    if (!rally.isHosted || unsupported.has(method)) return null;
    try {
      return { value: await call() };
    } catch (err) {
      if (isUnsupported(err)) {
        unsupported.add(method);
        return null;
      }
      return { error: errorCode(err) ?? 'INTERNAL' };
    }
  }

  function submitLocal(boardId: string, score: number): { accepted: boolean; best: number } {
    const current = localBest.get(boardId);
    if (current === undefined || better(boardId, score, current)) {
      localBest.set(boardId, score);
      return { accepted: true, best: score };
    }
    return { accepted: false, best: current };
  }

  return {
    async submit(boardId, score) {
      // Keep the local board in step too, so a later fallback `top` is not empty.
      const local = submitLocal(boardId, score);
      const r = await viaHost('leaderboard.submit', () => rally.leaderboard.submit(boardId, score));
      if (r && 'value' in r) return { ...r.value, source: 'host' };
      return { ...local, source: 'local', ...(r?.error ? { error: r.error } : {}) };
    },
    async top(boardId, opts = {}) {
      const r = await viaHost('leaderboard.top', () =>
        rally.leaderboard.top(boardId, { scope: opts.scope ?? 'global', limit: opts.limit ?? 10 }),
      );
      if (r && 'value' in r) return { entries: r.value.entries, source: 'host' };
      const best = localBest.get(boardId);
      const user = me();
      const entries = best === undefined ? [] : [{ rank: 1, userId: user.id, username: user.username, score: best }];
      return { entries, source: 'local', ...(r?.error ? { error: r.error } : {}) };
    },
    async unlock(key) {
      if (unlockedKeys.has(key)) return { unlocked: true, alreadyHad: true, source: rally.isHosted ? 'host' : 'local' };
      const r = await viaHost('achievement.unlock', () => rally.achievement.unlock(key));
      if (r && 'value' in r) {
        if (r.value.unlocked) unlockedKeys.add(key);
        return { ...r.value, source: 'host' };
      }
      if (r?.error) return { unlocked: false, alreadyHad: false, source: 'host', error: r.error };
      unlockedKeys.add(key);
      return { unlocked: true, alreadyHad: false, source: 'local' };
    },
    findMe(entries) {
      const id = me().id;
      return entries.find((e) => e.userId === id);
    },
  };
}
