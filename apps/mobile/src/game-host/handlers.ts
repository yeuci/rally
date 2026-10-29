import type { LaunchContext } from '@rally/protocol';
import { HostError, type RequestHandlers } from './bridge';
import { matchmake } from './matchmake';
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
  matchmaking: MatchmakingTarget | null;
  onReady: () => void;
  onLoading: (progress: number) => void;
  onExit: (reason: string) => void;
  now?: () => number;
}

const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/; // game_saves_slot check constraint
const MAX_SAVE_BYTES = 65536; // game_saves_size check constraint (pg_column_size < 64 KB)
const SAVE_PUTS_PER_MINUTE = 10;

/**
 * SDK v1 host handlers. Everything not listed (leaderboard.*, achievement.unlock, invite.open, haptics,
 * orientation.lock) answers NOT_SUPPORTED from the bridge: leaderboards/achievements arrive in M2, the
 * capability methods sit behind the 4.7.2 kill switch.
 */
export function createHostHandlers(deps: HostHandlerDeps): RequestHandlers {
  let ready = false;
  const putBucket = new TokenBucket(SAVE_PUTS_PER_MINUTE, 60_000, deps.now);

  const checkSlot = (slot: string) => {
    if (!SLOT_RE.test(slot)) throw new HostError('INVALID_PARAMS', 'slot must match [A-Za-z0-9_-]{1,32}');
  };

  return {
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
