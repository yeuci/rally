import { LaunchContextSchema, type LaunchContext } from '@rally/protocol';
import { HostError, type RequestHandlers } from './host-bridge.ts';
import { matchmake, toWsUrl } from './matchmake.ts';

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

export interface HarnessHandlerDeps {
  buildLaunchContext: () => LaunchContext;
  /** Colyseus HTTP base URL. */
  colyseusUrl: string;
  /** `server.room` from game.json, or null for games without a server. */
  room: string | null;
  saves: SaveStore;
  onReady: (ctx: LaunchContext) => void;
  onLoading: (progress: number) => void;
  onExit: (reason: string) => void;
  onJoined: (info: { roomId: unknown; sessionId: unknown }) => void;
  onReconnection: (info: { roomId: string; ttlSec: number }) => void;
}

// Same limits as apps/mobile/src/game-host/handlers.ts (which mirror the game_saves check constraints).
const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_SAVE_BYTES = 65_536;
const SAVE_PUTS_PER_MINUTE = 10;

/**
 * Same behaviour as apps/mobile/src/game-host/handlers.ts (slot/size validation, save.put rate limit,
 * CONFLICT on a stale ifVersion), with browser-backed pieces: `session.join` matchmakes against a real
 * Colyseus, `save.*` persists in localStorage.
 * Not listed here (→ NOT_SUPPORTED, like the shell today): leaderboard.*, achievement.*, invite.open,
 * haptics, orientation.lock.
 */
export function createHarnessHandlers(deps: HarnessHandlerDeps): RequestHandlers {
  let ready = false;
  const putBucket = new TokenBucket(SAVE_PUTS_PER_MINUTE, 60_000);
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
      deps.onReady(parsed.data);
      return parsed.data;
    },

    ping: ({ t }) => ({ t, hostTime: Date.now() }),

    'session.join': async () => {
      if (!ready) throw new HostError('NOT_READY', 'call ready() before session.join()');
      if (!deps.room) throw new HostError('NOT_SUPPORTED', 'game.json has no server.room');
      const seatReservation = await matchmake(deps.colyseusUrl, 'joinOrCreate', deps.room, {});
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
