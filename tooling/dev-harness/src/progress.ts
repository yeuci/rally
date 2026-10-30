import type { RequestResult } from '@rally/protocol';

export interface BoardDef {
  id: string;
  sort: 'asc' | 'desc';
  maxScorePerMinute?: number;
}

export interface AchievementDef {
  key: string;
  title: string;
  hidden: boolean;
}

interface StoredEntry {
  userId: string;
  username: string;
  score: number;
  /** ms epoch of the best score (ties rank the earlier score first). */
  at: number;
}

export interface HarnessUser {
  id: string;
  username: string;
}

/**
 * Leaderboards and achievements for the fake host, persisted in localStorage:
 *
 *   rally-harness:board:<gameId>:<boardId>   → StoredEntry[] (one best per user; seeded with a few bots)
 *   rally-harness:ach:<gameId>:<userId>      → string[] (unlocked keys)
 *
 * Same result shapes as the shell's ProgressStore (apps/mobile/src/game-host/progress.ts): `accepted` is true when
 * the score became the player's new best, `best` is the player's best after the call.
 */
export interface ProgressStore {
  submit(board: BoardDef, user: HarnessUser, score: number): RequestResult<'leaderboard.submit'>;
  top(
    board: BoardDef,
    user: HarnessUser,
    scope: 'global' | 'friends',
    limit: number,
  ): RequestResult<'leaderboard.top'>;
  unlock(user: HarnessUser, key: string): RequestResult<'achievement.unlock'>;
  clear(): void;
}

/** Bots on every fresh board, so ranks mean something. Even indices are the dev user's "friends". */
const BOTS = ['ada', 'grace', 'linus', 'margaret', 'ken', 'barbara', 'dennis', 'radia'];
const BOT_SCORES_DESC = [48, 36, 27, 19, 14, 9, 6, 3];
const BOT_SCORES_ASC = [20, 28, 35, 44, 52, 61, 75, 90];

export function localProgressStore(gameId: string, now: () => number = Date.now): ProgressStore {
  const boardPrefix = `rally-harness:board:${gameId}:`;
  const achPrefix = `rally-harness:ach:${gameId}:`;
  const memory = new Map<string, string>();
  const storage = (() => {
    try {
      const s = window.localStorage;
      s.getItem(boardPrefix);
      return s;
    } catch {
      return null;
    }
  })();
  const read = <T>(key: string): T | undefined => {
    try {
      const raw = storage ? storage.getItem(key) : (memory.get(key) ?? null);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (key: string, value: unknown) => {
    const json = JSON.stringify(value);
    if (storage) storage.setItem(key, json);
    else memory.set(key, json);
  };

  const better = (board: BoardDef, a: number, b: number) => (board.sort === 'asc' ? a < b : a > b);
  const entriesOf = (board: BoardDef): StoredEntry[] => {
    const existing = read<StoredEntry[]>(boardPrefix + board.id);
    if (existing) return existing;
    const scores = board.sort === 'asc' ? BOT_SCORES_ASC : BOT_SCORES_DESC;
    const seeded = BOTS.map((name, i) => ({ userId: `bot-${name}`, username: name, score: scores[i]!, at: i }));
    write(boardPrefix + board.id, seeded);
    return seeded;
  };

  return {
    submit(board, user, score) {
      const entries = entriesOf(board);
      const mine = entries.find((e) => e.userId === user.id);
      if (mine && !better(board, score, mine.score)) return { accepted: false, best: mine.score };
      if (mine) Object.assign(mine, { score, at: now(), username: user.username });
      else entries.push({ userId: user.id, username: user.username, score, at: now() });
      write(boardPrefix + board.id, entries);
      return { accepted: true, best: score };
    },
    top(board, user, scope, limit) {
      const friends = new Set([user.id, ...BOTS.filter((_, i) => i % 2 === 0).map((n) => `bot-${n}`)]);
      const sorted = entriesOf(board)
        .filter((e) => scope === 'global' || friends.has(e.userId))
        .sort((a, b) => (a.score === b.score ? a.at - b.at : better(board, a.score, b.score) ? -1 : 1));
      // Competition ranking: equal scores share a rank (1, 2, 2, 4).
      let rank = 0;
      const ranked = sorted.map((e, i) => {
        if (i === 0 || e.score !== sorted[i - 1]!.score) rank = i + 1;
        return { rank, userId: e.userId, username: e.username, score: e.score };
      });
      return { entries: ranked.slice(0, limit) };
    },
    unlock(user, key) {
      const k = achPrefix + user.id;
      const have = read<string[]>(k) ?? [];
      if (have.includes(key)) return { unlocked: true, alreadyHad: true };
      write(k, [...have, key]);
      return { unlocked: true, alreadyHad: false };
    },
    clear() {
      memory.clear();
      if (!storage) return;
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(boardPrefix) || key?.startsWith(achPrefix)) storage.removeItem(key);
      }
    },
  };
}
