import type { OriginJoin } from '../lib/join-target';
import type { KeyValueStorage } from './session-journal';

/**
 * The match the signed-in user can rejoin after the app was killed or the game closed without a consented exit
 * (m3-phase2 §4). One record per user, `rally.rejoin.<userId>`, same serial / best-effort pattern as
 * session-journal.ts. Pure apart from the injected storage (AsyncStorage in the app, memory in the Developer
 * launcher); unit-tested.
 *
 * - **Written** when the game calls `session.reportReconnection` for the room the host joined (handlers.ts checks
 *   the room); the TTL is clamped to the server's 60 s grace.
 * - **Re-stamped** when the app goes to the background: `expiresAt = now + ttl` (the server's grace starts when the
 *   socket drops, later than that, so this is conservative).
 * - **Cleared** on a consented exit, on joining another room, when a resume fails, and when the record expires.
 */
export interface RejoinRecord {
  gameId: string;
  roomId: string;
  /** The game's `room.reconnectionToken`: `<roomId>:<token>` (see `splitReconnectionToken`). */
  token: string;
  /** The private room's join code, when the host knew it (joined with `room` + code, or through a friend). */
  code?: string;
  /** How the match was first joined; a resume reports this intent to the game. */
  join: OriginJoin;
  /** Seconds of grace the record was written with (re-stamps reuse it). */
  ttlSec: number;
  /** Epoch ms after which the server has given the seat away. */
  expiresAt: number;
}

/** `RallyRoom.reconnectSeconds` (m3-phase2 decisions): no record outlives it. */
export const REJOIN_GRACE_S = 60;
const ORIGINS: readonly string[] = ['quick', 'create', 'room', 'friend'];

export const rejoinKey = (userId: string) => `rally.rejoin.${userId}`;

/** Whole seconds left on a record (0 once expired), for the rejoin sheet's countdown. */
export function rejoinSecondsLeft(rec: Pick<RejoinRecord, 'expiresAt'>, now = Date.now()): number {
  return Math.max(0, Math.floor((rec.expiresAt - now) / 1000));
}

/**
 * `room.reconnectionToken` is `<roomId>:<token>` (the Colyseus SDK builds it that way). Split on the **first** `:`:
 * the matchmaker's `reconnect/<roomId>` takes the rest as `{ reconnectionToken }`. Null without both halves.
 */
export function splitReconnectionToken(full: string): { roomId: string; token: string } | null {
  const i = full.indexOf(':');
  if (i <= 0 || i === full.length - 1) return null;
  return { roomId: full.slice(0, i), token: full.slice(i + 1) };
}

const clampTtl = (ttlSec: number) => Math.min(REJOIN_GRACE_S, Math.max(1, Math.floor(Number.isFinite(ttlSec) ? ttlSec : 0)));

function parse(raw: string | null): RejoinRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RejoinRecord> | null;
    if (!v || typeof v.gameId !== 'string' || typeof v.roomId !== 'string' || typeof v.token !== 'string') return null;
    if (typeof v.join !== 'string' || !ORIGINS.includes(v.join)) return null;
    if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return null;
    if (v.code !== undefined && typeof v.code !== 'string') return null;
    const rec: RejoinRecord = {
      gameId: v.gameId,
      roomId: v.roomId,
      token: v.token,
      join: v.join as OriginJoin,
      ttlSec: clampTtl(typeof v.ttlSec === 'number' ? v.ttlSec : REJOIN_GRACE_S),
      expiresAt: v.expiresAt,
    };
    if (v.code) rec.code = v.code;
    return rec;
  } catch {
    return null;
  }
}

export interface RejoinJournal {
  /** The live record, or null (none, unreadable or expired: those are dropped). */
  get(): Promise<RejoinRecord | null>;
  /** Store a record; `ttlSec` is clamped to [1, 60] and `expiresAt = now + ttlSec`. */
  save(rec: Omit<RejoinRecord, 'expiresAt'>): Promise<void>;
  /** App to the background: `expiresAt = now + ttlSec`, only if the record is for `roomId`. */
  restamp(roomId: string): Promise<void>;
  /** Drop the record (all of it, or only when `match` says so). */
  clear(match?: (rec: RejoinRecord) => boolean): Promise<void>;
}

/** Every journal operation runs in order (save / restamp / clear race otherwise across awaits). */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

export function createRejoinJournal(storage: KeyValueStorage, userId: string, now: () => number = Date.now): RejoinJournal {
  const key = rejoinKey(userId);
  const swallow = async (op: () => Promise<void>) => {
    try {
      await op();
    } catch {
      /* best effort */
    }
  };
  /** The stored record, dropping an unreadable or expired one. */
  const read = async (): Promise<RejoinRecord | null> => {
    const raw = await storage.getItem(key);
    const rec = parse(raw);
    if (rec && rec.expiresAt > now()) return rec;
    if (raw !== null) await storage.removeItem(key);
    return null;
  };
  const write = (rec: RejoinRecord) => storage.setItem(key, JSON.stringify(rec));
  return {
    get: () =>
      serial(async () => {
        try {
          return await read();
        } catch {
          return null;
        }
      }),
    save: (rec) =>
      serial(() =>
        swallow(() => {
          const ttlSec = clampTtl(rec.ttlSec);
          const out: RejoinRecord = { ...rec, ttlSec, expiresAt: now() + ttlSec * 1000 };
          if (!out.code) delete out.code;
          return write(out);
        }),
      ),
    restamp: (roomId) =>
      serial(() =>
        swallow(async () => {
          const rec = await read();
          if (rec && rec.roomId === roomId) await write({ ...rec, expiresAt: now() + rec.ttlSec * 1000 });
        }),
      ),
    clear: (match) =>
      serial(() =>
        swallow(async () => {
          if (!match) return storage.removeItem(key);
          const rec = await read();
          if (rec && match(rec)) await storage.removeItem(key);
        }),
      ),
  };
}

/** A `KeyValueStorage` over a Map (the Developer launcher's journal: lives as long as the JS context). */
export function createMemoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
  };
}
