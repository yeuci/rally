import { LaunchContextSchema, type LaunchContext } from '@rally/protocol';
import { HostError, type RequestHandlers } from './host-bridge.ts';
import { matchmake, roomIdForCode, toWsUrl } from './matchmake.ts';
import type { AchievementDef, BoardDef, HarnessUser, ProgressStore } from './progress.ts';

/** Port of apps/mobile/src/game-host/rate-limit.ts: `capacity` calls, refilled continuously over `perMs`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(capacity: number, perMs: number) {
    this.capacity = capacity;
    this.perMs = perMs;
    this.tokens = capacity;
    this.last = Date.now();
  }

  tryTake(): boolean {
    const t = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.capacity) / this.perMs);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * How `session.join` matchmakes. The shell only does `quick` today (joinOrCreate with the user's JWT); the others
 * exercise the private-room endpoints of apps/game-server ahead of the shell.
 */
export type JoinTarget =
  | { kind: 'quick' }
  /** `joinOrCreate` with `{ private: true }`: always a fresh private room with a join code. */
  | { kind: 'private' }
  /** `GET /rooms/code/<code>` → `joinById` with `{ code }`. */
  | { kind: 'code'; code: string }
  | { kind: 'room'; roomId: string };

export interface HarnessHandlerDeps {
  buildLaunchContext: () => LaunchContext;
  /** Colyseus HTTP base URL. */
  colyseusUrl: string;
  /** `server.room` from game.json, or null for games without a server. */
  room: string | null;
  /** Default `{ kind: 'quick' }`. */
  join?: JoinTarget;
  /**
   * Matchmaking body: `{ username, avatarUrl }` of the harness user, which the game server uses as the display name
   * of a guest (the harness has no Supabase session, so it never sends a token).
   */
  matchOptions?: Record<string, unknown>;
  saves: SaveStore;
  /** `leaderboards` / `achievements` from game.json. */
  leaderboards: BoardDef[];
  achievements: AchievementDef[];
  progress: ProgressStore;
  user: HarnessUser;
  onReady: (ctx: LaunchContext) => void;
  onLoading: (progress: number) => void;
  onExit: (reason: string) => void;
  onJoined: (info: { roomId: unknown; sessionId: unknown }) => void;
  onReconnection: (info: { roomId: string; ttlSec: number }) => void;
  onScore?: (info: { boardId: string; score: number; accepted: boolean; best: number | null; note?: string }) => void;
  onUnlock?: (info: { key: string; title: string; alreadyHad: boolean }) => void;
  now?: () => number;
}

// Same limits as apps/mobile/src/game-host/handlers.ts (which mirror the game_saves check constraints).
const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_SAVE_BYTES = 65_536;
const SAVE_PUTS_PER_MINUTE = 10;
/** apps/mobile/src/game-host/handlers.ts PROGRESS_LIMITS_PER_MINUTE. */
const PROGRESS_LIMITS_PER_MINUTE = { submit: 30, top: 60, unlock: 60 } as const;

/**
 * Same behaviour as apps/mobile/src/game-host/handlers.ts (slot/size validation, save.put rate limit,
 * CONFLICT on a stale ifVersion), with browser-backed pieces: `session.join` matchmakes against a real
 * Colyseus, `save.*` persists in localStorage.
 * `leaderboard.*` / `achievement.unlock` run against localStorage (progress.ts) and are validated against the
 * manifest: a game that declares no leaderboards (achievements) gets NOT_SUPPORTED, an undeclared board id or key
 * INVALID_PARAMS, a game with a `server` gets NOT_SUPPORTED for `leaderboard.submit` (its room writes results).
 * Scores above `maxScorePerMinute × max(1, ceil(minutes since ready()))` are answered `accepted: false`, the
 * same bound `submit_solo_score` applies from the play-session start (architecture §8).
 * Not listed here (→ NOT_SUPPORTED, like the shell today): invite.open, haptics, orientation.lock.
 */
export function createHarnessHandlers(deps: HarnessHandlerDeps): RequestHandlers {
  let ready = false;
  let readyAt = 0;
  const now = deps.now ?? Date.now;
  const putBucket = new TokenBucket(SAVE_PUTS_PER_MINUTE, 60_000);
  const submitBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.submit, 60_000);
  const topBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.top, 60_000);
  const unlockBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.unlock, 60_000);
  const limit = (bucket: TokenBucket, method: keyof typeof PROGRESS_LIMITS_PER_MINUTE) => {
    if (!bucket.tryTake()) {
      throw new HostError('RATE_LIMITED', `${method} is limited to ${PROGRESS_LIMITS_PER_MINUTE[method]} per minute`);
    }
  };
  const board = (boardId: string): BoardDef => {
    if (deps.leaderboards.length === 0) throw new HostError('NOT_SUPPORTED', 'game.json declares no leaderboards');
    const b = deps.leaderboards.find((l) => l.id === boardId);
    if (!b) {
      throw new HostError(
        'INVALID_PARAMS',
        `unknown board "${boardId}" (game.json leaderboards: ${deps.leaderboards.map((l) => l.id).join(', ')})`,
      );
    }
    return b;
  };
  const checkSlot = (slot: string) => {
    if (!SLOT_RE.test(slot)) throw new HostError('INVALID_PARAMS', 'slot must match [A-Za-z0-9_-]{1,32}');
  };
  return {
    ready: () => {
      if (ready) throw new HostError('ALREADY_READY', 'ready() was already called');
      const parsed = LaunchContextSchema.safeParse(deps.buildLaunchContext());
      if (!parsed.success)
        throw new HostError('INTERNAL', `harness launch context is invalid: ${parsed.error.message}`);
      ready = true;
      readyAt = now();
      deps.onReady(parsed.data);
      return parsed.data;
    },

    ping: ({ t }) => ({ t, hostTime: Date.now() }),

    'session.join': async () => {
      if (!ready) throw new HostError('NOT_READY', 'call ready() before session.join()');
      if (!deps.room) throw new HostError('NOT_SUPPORTED', 'game.json has no server.room');
      const join = deps.join ?? { kind: 'quick' };
      const opts = deps.matchOptions ?? {};
      const seatReservation =
        join.kind === 'code'
          ? // A private room admits joinById only with its code (apps/game-server routes.ts).
            await matchmake(deps.colyseusUrl, 'joinById', await roomIdForCode(deps.colyseusUrl, join.code), {
              ...opts,
              code: join.code,
            })
          : join.kind === 'room'
            ? await matchmake(deps.colyseusUrl, 'joinById', join.roomId, opts)
            : await matchmake(
                deps.colyseusUrl,
                'joinOrCreate',
                deps.room,
                join.kind === 'private' ? { ...opts, private: true } : opts,
              );
      deps.onJoined({ roomId: (seatReservation as { roomId?: unknown }).roomId, sessionId: seatReservation.sessionId });
      return { endpoint: toWsUrl(deps.colyseusUrl), seatReservation };
    },

    'session.reportReconnection': ({ roomId, ttlSec }) => {
      deps.onReconnection({ roomId, ttlSec });
      return null;
    },

    'save.get': ({ slot }) => {
      checkSlot(slot);
      const s = deps.saves.get(slot);
      return s ? { data: s.data, version: s.version } : { data: null, version: 0 };
    },

    'save.put': ({ slot, data, ifVersion }) => {
      checkSlot(slot);
      const json = data === undefined ? undefined : JSON.stringify(data);
      if (json === undefined) throw new HostError('INVALID_PARAMS', 'save data must be JSON');
      if (new TextEncoder().encode(json).byteLength >= MAX_SAVE_BYTES) {
        throw new HostError('INVALID_PARAMS', 'save data exceeds 64 KB');
      }
      if (!putBucket.tryTake()) {
        throw new HostError('RATE_LIMITED', `save.put is limited to ${SAVE_PUTS_PER_MINUTE} per minute`);
      }
      const current = deps.saves.get(slot)?.version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current) {
        throw new HostError('CONFLICT', `slot "${slot}" is at version ${current}`);
      }
      const version = current + 1;
      deps.saves.set(slot, { data: JSON.parse(json) as unknown, version });
      return { version };
    },

    'leaderboard.submit': ({ boardId, score }) => {
      if (deps.room) {
        throw new HostError(
          'NOT_SUPPORTED',
          'multiplayer results are recorded by the game server, not leaderboard.submit',
        );
      }
      const b = board(boardId);
      if (!ready) throw new HostError('NOT_READY', 'call ready() before leaderboard.submit()');
      limit(submitBucket, 'submit');
      if (b.maxScorePerMinute) {
        const elapsedSec = (now() - readyAt) / 1000;
        const bound = b.maxScorePerMinute * Math.max(1, Math.ceil(elapsedSec / 60));
        if (score > bound) {
          const best = deps.progress.top(b, deps.user, 'global', 100).entries.find((e) => e.userId === deps.user.id);
          const result = { accepted: false, best: best?.score ?? null };
          deps.onScore?.({
            boardId,
            score,
            ...result,
            note: `above the ${b.maxScorePerMinute}/min bound (${bound} after ${elapsedSec.toFixed(0)} s)`,
          });
          return result;
        }
      }
      const result = deps.progress.submit(b, deps.user, score);
      deps.onScore?.({ boardId, score, ...result });
      return result;
    },

    'leaderboard.top': ({ boardId, scope, limit: count }) => {
      const b = board(boardId);
      limit(topBucket, 'top');
      return deps.progress.top(b, deps.user, scope, count);
    },

    'achievement.unlock': ({ key }) => {
      if (deps.achievements.length === 0) throw new HostError('NOT_SUPPORTED', 'game.json declares no achievements');
      const a = deps.achievements.find((x) => x.key === key);
      if (!a) {
        throw new HostError(
          'INVALID_PARAMS',
          `unknown achievement "${key}" (game.json achievements: ${deps.achievements.map((x) => x.key).join(', ')})`,
        );
      }
      limit(unlockBucket, 'unlock');
      const result = deps.progress.unlock(deps.user, key);
      deps.onUnlock?.({ key, title: a.title, alreadyHad: result.alreadyHad });
      return result;
    },

    'ui.loading': ({ progress }) => {
      deps.onLoading(progress);
      return null;
    },

    'party.get': () => null,

    exit: (params) => {
      deps.onExit(params?.reason ?? 'game');
      return null;
    },
  };
}

export interface SaveEntry {
  data: unknown;
  version: number;
}

export interface SaveStore {
  get(slot: string): SaveEntry | undefined;
  set(slot: string, entry: SaveEntry): void;
  clear(): void;
}

/** Per-game save slots in localStorage (`rally-harness:save:<gameId>:<slot>`), in memory if storage is blocked. */
export function localSaveStore(gameId: string): SaveStore {
  const prefix = `rally-harness:save:${gameId}:`;
  const memory = new Map<string, SaveEntry>();
  const storage = (() => {
    try {
      const s = window.localStorage;
      s.getItem(prefix);
      return s;
    } catch {
      return null;
    }
  })();
  return {
    get(slot) {
      if (!storage) return memory.get(slot);
      try {
        const raw = storage.getItem(prefix + slot);
        return raw ? (JSON.parse(raw) as SaveEntry) : undefined;
      } catch {
        return undefined;
      }
    },
    set(slot, entry) {
      if (!storage) {
        memory.set(slot, entry);
        return;
      }
      storage.setItem(prefix + slot, JSON.stringify(entry));
    },
    clear() {
      memory.clear();
      if (!storage) return;
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) storage.removeItem(key);
      }
    },
  };
}
