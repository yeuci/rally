import type { LaunchContext } from '@rally/protocol';
import { HostError, type RequestHandlers } from './bridge';
import { matchmake } from './matchmake';
import type { ProgressStore } from './progress';
import { TokenBucket } from './rate-limit';
import type { SaveStore } from './saves';

/** Colyseus matchmaking target for `session.join`; null for solo-only games. */
export interface MatchmakingTarget {
  httpUrl: string;
  wsUrl: string;
  roomName: string;
  /** Supabase JWT for the game server (verified via JWKS from M3; ignored by the M0 hello room). */
  getAccessToken?: () => Promise<string | undefined>;
}

export interface HostHandlerDeps {
  /** Built when the game calls `ready()`, so device info (safe area, orientation) is current. */
  getLaunchContext: () => LaunchContext;
  saves: SaveStore;
  /** Leaderboards + achievements (Supabase in the play route, in memory in the Developer launcher). */
  progress: ProgressStore;
  /**
   * Whether `leaderboard.submit` is open to the game. False for multiplayer games (manifest `server`): their
   * results are written by the room (architecture §8), so client-reported scores are refused.
   */
  soloScores: boolean;
  /** The host's play session id; awaited by `leaderboard.submit` if it is still starting. Null if there is none. */
  getPlaySessionId: () => Promise<string | null>;
  matchmaking: MatchmakingTarget | null;
  onReady: () => void;
  onLoading: (progress: number) => void;
  onExit: (reason: string) => void;
  now?: () => number;
}

const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/; // game_saves_slot check constraint
const MAX_SAVE_BYTES = 65536; // game_saves_size check constraint (pg_column_size < 64 KB)
const SAVE_PUTS_PER_MINUTE = 10;
/** Per-method limits for the progress methods (per game session, on top of the server's own limits). */
export const PROGRESS_LIMITS_PER_MINUTE = { submit: 30, top: 60, unlock: 60 } as const;
/** Board ids and achievement keys come from the manifest; the server resolves them, the host only bounds them. */
const MAX_KEY_LENGTH = 128;
const isKey = (s: string) => s.length >= 1 && s.length <= MAX_KEY_LENGTH;

/**
 * SDK v1 host handlers. Everything not listed (invite.open, haptics, orientation.lock) answers NOT_SUPPORTED from
 * the bridge: the capability methods sit behind the 4.7.2 kill switch, invites arrive with parties.
 *
 * Bridge handlers plus a hook the host calls when the WebView starts loading a new main document.
 */
export type HostHandlers = RequestHandlers & {
  /** A page reload (Vite's first-run dependency optimisation, a game calling location.reload()) must be allowed to call ready() again. */
  resetHandshake(): void;
};

export function createHostHandlers(deps: HostHandlerDeps): HostHandlers {
  let ready = false;
  const putBucket = new TokenBucket(SAVE_PUTS_PER_MINUTE, 60_000, deps.now);
  const submitBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.submit, 60_000, deps.now);
  const topBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.top, 60_000, deps.now);
  const unlockBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.unlock, 60_000, deps.now);
  const limit = (bucket: TokenBucket, method: string, perMinute: number) => {
    if (!bucket.tryTake()) throw new HostError('RATE_LIMITED', `${method} is limited to ${perMinute} per minute`);
  };
  const checkBoard = (boardId: string) => {
    if (!isKey(boardId)) throw new HostError('INVALID_PARAMS', `boardId must be 1–${MAX_KEY_LENGTH} characters`);
  };

  const checkSlot = (slot: string) => {
    if (!SLOT_RE.test(slot)) throw new HostError('INVALID_PARAMS', 'slot must match [A-Za-z0-9_-]{1,32}');
  };

  return {
    resetHandshake: () => {
      ready = false;
    },

    ready: () => {
      if (ready) throw new HostError('ALREADY_READY', 'ready() was already called');
      ready = true;
      deps.onReady();
      return deps.getLaunchContext();
    },

    ping: ({ t }) => ({ t, hostTime: Date.now() }),

    'session.join': async () => {
      if (!ready) throw new HostError('NOT_READY', 'call ready() before session.join()');
      const mm = deps.matchmaking;
      if (!mm) throw new HostError('NOT_SUPPORTED', 'this game has no multiplayer server');
      const token = await mm.getAccessToken?.();
      const seatReservation = await matchmake(mm.httpUrl, 'joinOrCreate', mm.roomName, {}, token);
      return { endpoint: mm.wsUrl, seatReservation };
    },

    'session.reportReconnection': () => null,

    'save.get': async ({ slot }) => {
      checkSlot(slot);
      return deps.saves.get(slot);
    },

    'save.put': async ({ slot, data, ifVersion }) => {
      checkSlot(slot);
      if (data === undefined) throw new HostError('INVALID_PARAMS', 'save data must be JSON');
      if (utf8Length(JSON.stringify(data)) >= MAX_SAVE_BYTES) throw new HostError('INVALID_PARAMS', 'save data exceeds 64 KB');
      if (!putBucket.tryTake()) throw new HostError('RATE_LIMITED', `save.put is limited to ${SAVE_PUTS_PER_MINUTE} per minute`);
      return deps.saves.put(slot, data, ifVersion);
    },

    'leaderboard.submit': async ({ boardId, score }) => {
      if (!deps.soloScores) {
        throw new HostError('NOT_SUPPORTED', 'multiplayer results are recorded by the game server, not leaderboard.submit');
      }
      checkBoard(boardId);
      limit(submitBucket, 'leaderboard.submit', PROGRESS_LIMITS_PER_MINUTE.submit);
      const sessionId = await deps.getPlaySessionId();
      return deps.progress.submitScore(boardId, score, sessionId);
    },

    'leaderboard.top': async ({ boardId, scope, limit: count }) => {
      checkBoard(boardId);
      limit(topBucket, 'leaderboard.top', PROGRESS_LIMITS_PER_MINUTE.top);
      return deps.progress.top(boardId, scope, count);
    },

    'achievement.unlock': async ({ key }) => {
      if (!isKey(key)) throw new HostError('INVALID_PARAMS', `key must be 1–${MAX_KEY_LENGTH} characters`);
      limit(unlockBucket, 'achievement.unlock', PROGRESS_LIMITS_PER_MINUTE.unlock);
      return deps.progress.unlockAchievement(key);
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

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
