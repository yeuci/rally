import type { ServerConfig } from './config.js';
import type { GameRoomSnapshot, ServiceApi } from './supabase.js';

/**
 * `RoomMirror` (design §2): keeps `game_rooms` in step with the live Colyseus rooms of this process, so presence can
 * confirm that a friend really holds a seat (`player_ids`) and the catalog can count players.
 *
 * - {@link RoomMirror.update} only records the latest snapshot; writes are coalesced to at most one per room every
 *   `minIntervalMs` (2 s): the first one goes out at once, later ones carry the newest snapshot when the window ends.
 * - One `touchIntervalMs` (30 s) interval bumps `updated_at` of every live room in a single call (rows are live for
 *   60 s), retries failed writes and removals, and stops by itself when the process has no rooms.
 * - {@link RoomMirror.remove} deletes the row on dispose, after any write still in flight for that room.
 * - Best effort: failures are logged (once per outage, plus a line on recovery) and retried on the next tick; nothing
 *   here ever throws into, awaits in, or blocks the room.
 */
export type MirrorApi = Pick<ServiceApi, 'upsertGameRoom' | 'removeGameRoom' | 'touchGameRooms'>;

/** Injected for tests (a fake clock); defaults to the global timers, unref'd so they never keep the process up. */
export interface MirrorTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RoomMirrorOptions {
  /** Minimum time between two writes of the same room. Default 2000. */
  minIntervalMs?: number;
  /** Touch / retry interval. Default 30 000 (rows count as live for 60 s). */
  touchIntervalMs?: number;
  timers?: MirrorTimers;
  log?: (msg: string) => void;
}

export const realTimers: MirrorTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

interface Entry {
  snapshot: GameRoomSnapshot;
  /** The latest snapshot is not in the database yet. */
  dirty: boolean;
  /** The last write failed: wait for the next tick instead of the coalescing window. */
  failed: boolean;
  lastWriteAt: number;
  timer: unknown;
  busy: Promise<void> | null;
}

export class RoomMirror {
  private readonly rooms = new Map<string, Entry>();
  /** Room ids whose row still has to be deleted (removal pending or failed). */
  private readonly removals = new Set<string>();
  private readonly removing = new Map<string, Promise<void>>();
  private readonly minIntervalMs: number;
  private readonly touchIntervalMs: number;
  private readonly timers: MirrorTimers;
  private readonly log: (msg: string) => void;
  private interval: unknown = null;
  private ticking: Promise<void> | null = null;
  private healthy = true;

  constructor(
    private readonly api: MirrorApi,
    opts: RoomMirrorOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 2000;
    this.touchIntervalMs = opts.touchIntervalMs ?? 30_000;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Record the room's current snapshot; the write is coalesced (see the class comment). Never throws. */
  update(snapshot: GameRoomSnapshot): void {
    const id = snapshot.roomId;
    if (this.removals.has(id)) return; // disposed: never resurrect the row
    let e = this.rooms.get(id);
    if (!e) {
      e = { snapshot, dirty: true, failed: false, lastWriteAt: -Infinity, timer: null, busy: null };
      this.rooms.set(id, e);
    }
    e.snapshot = snapshot;
    e.dirty = true;
    this.schedule(e);
    this.ensureInterval();
  }

  /** The room is gone: drop pending writes and delete its row (after a write in flight). Never throws. */
  remove(roomId: string): void {
    const e = this.rooms.get(roomId);
    if (e) {
      this.rooms.delete(roomId);
      if (e.timer !== null) this.timers.clearTimeout(e.timer);
      e.timer = null;
    }
    this.removals.add(roomId);
    void this.sendRemove(roomId, e?.busy);
    this.ensureInterval();
  }

  /** Room ids currently mirrored. */
  get roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  /**
   * The periodic work (every `touchIntervalMs`): retry failed removals and writes, then touch every live room.
   * Exposed for tests; overlapping calls share one run.
   */
  tick(): Promise<void> {
    return (this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    }));
  }

  /** Resolves when no write or removal is in flight (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...[...this.rooms.values()].map((e) => e.busy), ...this.removing.values(), this.ticking].filter(
        Boolean,
      );
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Stop the interval and every pending timer (tests, shutdown). Rows are left to age out. */
  stop(): void {
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    this.interval = null;
    for (const e of this.rooms.values()) {
      if (e.timer !== null) this.timers.clearTimeout(e.timer);
      e.timer = null;
    }
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private schedule(e: Entry): void {
    if (e.timer !== null || e.busy) return; // a write is queued or in flight; it picks up the newest snapshot
    const delay = Math.max(0, e.lastWriteAt + this.minIntervalMs - this.timers.now());
    e.timer = this.timers.setTimeout(() => {
      e.timer = null;
      this.write(e);
    }, delay);
  }

  private write(e: Entry): void {
    const id = e.snapshot.roomId;
    if (this.rooms.get(id) !== e || !e.dirty || e.busy) return;
    const snapshot = e.snapshot;
    e.dirty = false;
    e.failed = false;
    e.lastWriteAt = this.timers.now();
    e.busy = this.call(`upsert ${id}`, () => this.api.upsertGameRoom(snapshot))
      .then((ok) => {
        if (!ok) {
          e.dirty = true;
          e.failed = true;
        }
      })
      .finally(() => {
        e.busy = null;
        if (this.rooms.get(id) === e && e.dirty && !e.failed) this.schedule(e);
      });
  }

  /** Delete the row once `after` (a write still in flight) has settled; one removal per room at a time. */
  private sendRemove(roomId: string, after?: Promise<void> | null): Promise<void> {
    if (!this.removals.has(roomId)) return Promise.resolve();
    const inFlight = this.removing.get(roomId);
    if (inFlight) return inFlight;
    const p = (after ?? Promise.resolve())
      .then(() => this.call(`remove ${roomId}`, () => this.api.removeGameRoom(roomId)))
      .then((ok) => {
        if (ok) this.removals.delete(roomId);
      })
      .finally(() => {
        this.removing.delete(roomId);
        this.stopIfIdle();
      });
    this.removing.set(roomId, p);
    return p;
  }

  private async runTick(): Promise<void> {
    const work: Promise<unknown>[] = [...this.removals].map((id) => this.sendRemove(id));
    for (const e of this.rooms.values()) {
      if (e.dirty && e.failed && !e.busy && e.timer === null) this.write(e);
      if (e.busy) work.push(e.busy);
    }
    await Promise.allSettled(work);
    // Rooms written just now are fresh; touch the others (all of them, in one call).
    const ids = [...this.rooms.values()].filter((e) => !e.dirty && !e.busy).map((e) => e.snapshot.roomId);
    if (ids.length > 0) {
      const ok = await this.call(`touch ${ids.length} room(s)`, () => this.api.touchGameRooms(ids));
      if (!ok) {
        // The rows may age out (60 s) or be purged (10 min) meanwhile: re-upsert them on the next tick rather than
        // rely on a touch to bring them back.
        for (const id of ids) {
          const e = this.rooms.get(id);
          if (e && !e.busy) {
            e.dirty = true;
            e.failed = true;
          }
        }
      }
    }
    this.stopIfIdle();
  }

  /** Run one call; true on success. Logs the first failure of an outage and the recovery, not every retry. */
  private async call(what: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      if (!this.healthy) {
        this.healthy = true;
        this.log(`[mirror] game_rooms writes recovered (${what})`);
      }
      return true;
    } catch (err) {
      if (this.healthy) {
        this.healthy = false;
        this.log(
          `[mirror] ${what} failed (${err instanceof Error ? err.message : String(err)}); retrying every ` +
            `${Math.round(this.touchIntervalMs / 1000)} s, rooms are unaffected`,
        );
      }
      return false;
    }
  }

  private ensureInterval(): void {
    if (this.interval !== null) return;
    this.interval = this.timers.setInterval(() => void this.tick(), this.touchIntervalMs);
  }

  private stopIfIdle(): void {
    if (this.rooms.size === 0 && this.removals.size === 0 && this.interval !== null) {
      this.timers.clearInterval(this.interval);
      this.interval = null;
    }
  }
}

/** Development without a service key: the coalesced writes are logged instead of sent (touches are silent). */
export function dryRunMirrorApi(log: (msg: string) => void = (m) => console.info(m)): MirrorApi {
  return {
    async upsertGameRoom(r) {
      log(
        `[mirror] (no service key) ${r.roomName} ${r.roomId} ${r.clients}/${r.maxClients}` +
          `${r.private ? ' private' : ''}${r.locked ? ' locked' : ''}${r.phase ? ` ${r.phase}` : ''}` +
          ` players=[${r.playerIds.join(',')}]`,
      );
    },
    async removeGameRoom(roomId) {
      log(`[mirror] (no service key) removed ${roomId}`);
    },
    async touchGameRooms() {},
  };
}

/**
 * The process mirror: real with a service client; a dry run that logs in development without one; none otherwise
 * (tests, and a guests-only production server without Supabase).
 */
export function createDefaultMirror(config: Pick<ServerConfig, 'mode'>, api: MirrorApi | null): RoomMirror | null {
  if (api) return new RoomMirror(api);
  if (config.mode === 'development') return new RoomMirror(dryRunMirrorApi());
  return null;
}
