import type { PlaySessionService } from './play-session';

/**
 * Keeps the open play session of the signed-in user on the device, so a session the app never got to close (killed
 * or jettisoned while backgrounded: no JS runs, `end_play_session` is never sent) is closed on the next launch with
 * the last playtime the controller checkpointed. One record per user (one game runs at a time). Best effort:
 * storage errors are swallowed. Pure apart from the injected storage (AsyncStorage in the app), unit-tested.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface OpenPlaySession {
  id: string;
  gameId: string;
  playtimeS: number;
  /** The game reached `ready()`: only then does closing the session record a play. */
  played: boolean;
}

export const journalKey = (userId: string) => `rally.open-play-session.${userId}`;

/** Sessions this JS context opened and has not closed yet: never "recovered" from under a running game. */
const live = new Set<string>();
/** Every journal operation runs in order (save / clear / recover race otherwise across awaits). */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

function parse(raw: string | null): OpenPlaySession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OpenPlaySession> | null;
    if (!v || typeof v.id !== 'string' || typeof v.gameId !== 'string' || typeof v.played !== 'boolean') return null;
    const playtimeS = typeof v.playtimeS === 'number' && Number.isFinite(v.playtimeS) ? Math.max(0, v.playtimeS) : 0;
    return { id: v.id, gameId: v.gameId, playtimeS, played: v.played };
  } catch {
    return null;
  }
}

export interface PlaySessionJournal {
  /** A session of this context was opened (its id is known). */
  open(id: string): void;
  save(rec: OpenPlaySession): Promise<void>;
  /** The session was closed (or abandoned): drop its record, unless the slot already holds another session. */
  clear(id: string): Promise<void>;
  /**
   * Next launch: close a session left open by an earlier run with `end` (only if it was played; otherwise just drop
   * it) and return it, or null when there was nothing to close. Skips sessions this context still runs. The record
   * is dropped either way: `end_play_session` is idempotent, but a failing one must not repeat on every launch.
   */
  recover(end: (rec: OpenPlaySession) => Promise<void>): Promise<OpenPlaySession | null>;
}

export function createPlaySessionJournal(storage: KeyValueStorage, userId: string): PlaySessionJournal {
  const key = journalKey(userId);
  const swallow = async (op: () => Promise<void>) => {
    try {
      await op();
    } catch {
      /* best effort */
    }
  };
  return {
    open: (id) => {
      live.add(id);
    },
    save: (rec) => serial(() => swallow(() => storage.setItem(key, JSON.stringify(rec)))),
    clear: (id) =>
      serial(async () => {
        live.delete(id);
        await swallow(async () => {
          const current = parse(await storage.getItem(key));
          if (!current || current.id === id) await storage.removeItem(key);
        });
      }),
    recover: (end) =>
      serial(async () => {
        let rec: OpenPlaySession | null;
        try {
          const raw = await storage.getItem(key);
          rec = parse(raw);
          if (!rec) {
            if (raw !== null) await storage.removeItem(key); // unreadable: drop it
            return null;
          }
        } catch {
          return null;
        }
        if (live.has(rec.id)) return null;
        await swallow(() => storage.removeItem(key));
        if (!rec.played) return null;
        try {
          await end(rec);
        } catch {
          /* the next play refreshes stats anyway */
        }
        return rec;
      }),
  };
}

/**
 * Wraps the RPC-level service so every session it starts is journaled: `checkpoint` stores the latest playtime,
 * `end` / `abandon` drop the record (after the RPC, so a kill in between still recovers; ending twice is a no-op
 * server-side).
 */
export function withJournal(
  svc: Omit<PlaySessionService, 'checkpoint' | 'abandon'>,
  journal: PlaySessionJournal,
): PlaySessionService {
  const games = new Map<string, string>();
  return {
    start: async (game) => {
      const id = await svc.start(game);
      games.set(id, game.id);
      journal.open(id);
      return id;
    },
    end: async (id, playtimeS) => {
      try {
        await svc.end(id, playtimeS);
      } finally {
        await journal.clear(id);
      }
    },
    recordPlay: (gameId, playtimeS) => svc.recordPlay(gameId, playtimeS),
    checkpoint: (id, playtimeS, played) => {
      const gameId = games.get(id);
      if (gameId) void journal.save({ id, gameId, playtimeS, played });
    },
    abandon: (id) => journal.clear(id),
  };
}
