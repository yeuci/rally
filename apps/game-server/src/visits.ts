import { serverConfig, type ServerConfig } from './config.js';
import { realTimers, type MirrorTimers } from './mirror.js';
import { DEFAULT_RETRY_DELAYS_MS, isRetryable } from './results.js';
import { MAX_VISITS_PER_CALL, ServiceRpcError, serviceApi, type ServiceApi } from './supabase.js';

/**
 * `VisitCounter`: reports game visits (joins) to `server_record_visits`, batched per game.
 *
 * - {@link VisitCounter.record} only adds to the game's pending count. A batch goes out `flushIntervalMs` (10 s) after
 *   its first visit, or at once when it reaches `batchSize` (100); so each game is written at most every 10 s unless
 *   it is busy. One call per game at a time, at most {@link MAX_VISITS_PER_CALL} visits each.
 * - Network errors, timeouts, 408, 429 and 5xx are retried after 1 s, 5 s and 30 s (the results sink's backoff,
 *   `DEFAULT_RETRY_DELAYS_MS`), then the batch is dropped with a log line. Visits arriving meanwhile wait for the
 *   retry to finish. The RPC is not idempotent, so a timeout that did reach the database may count a batch twice:
 *   visits are a popularity signal, not an exact figure.
 * - `NOT_FOUND` (a game that is not in the catalog, such as the dev `hello` room) is permanent: logged once, the
 *   game's visits are dropped from then on and never sent again. Other permanent errors (`INVALID`, a rejected key)
 *   drop the batch with a log line.
 * - {@link VisitCounter.shutdown} (process shutdown) sends everything pending in one last attempt per game, bounded
 *   by `shutdownTimeoutMs` (1 s; pm2 kills the process 1.6 s after SIGINT by default).
 * - Best effort, like the mirror: nothing here throws into, awaits in, or blocks a room; failures are logged once per
 *   outage, plus a line on recovery and one per dropped batch.
 */
export type VisitApi = Pick<ServiceApi, 'recordVisits'>;

export interface VisitCounterOptions {
  /** How long a game's batch collects visits before it is sent. Default 10 000. */
  flushIntervalMs?: number;
  /** A batch this large is sent at once. Default 100. */
  batchSize?: number;
  /** Waits before each retry of a failed batch. Default 1 s, 5 s, 30 s (4 attempts in all). */
  retryDelaysMs?: readonly number[];
  /** How long {@link VisitCounter.shutdown} waits for the last writes. Default 1000. */
  shutdownTimeoutMs?: number;
  timers?: MirrorTimers;
  log?: (msg: string) => void;
}

interface GameBatch {
  /** Visits recorded and not sent yet. */
  pending: number;
  /** Visits in the call in flight. */
  sending: number;
  /** The batch window, or the wait before a retry. */
  timer: unknown;
  busy: Promise<void> | null;
  /** A failed batch waiting for its next attempt (`attempt` = attempts made so far). */
  retry: { count: number; attempt: number } | null;
}

/** `NOT_FOUND` from a `server_*` RPC (`raise … using errcode = 'no_data_found'`: P0002, message `NOT_FOUND: …`). */
export function isNotFound(err: unknown): boolean {
  return err instanceof ServiceRpcError && (err.code === 'P0002' || /\bNOT_FOUND\b/.test(err.message));
}

export class VisitCounter {
  private readonly games = new Map<string, GameBatch>();
  /** Games the database does not know (NOT_FOUND): their visits are dropped without a call. */
  private readonly unknownGames = new Set<string>();
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly shutdownTimeoutMs: number;
  private readonly timers: MirrorTimers;
  private readonly log: (msg: string) => void;
  private healthy = true;
  private closing = false;

  constructor(
    private readonly api: VisitApi,
    opts: VisitCounterOptions = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 10_000;
    this.batchSize = Math.min(opts.batchSize ?? 100, MAX_VISITS_PER_CALL);
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 1000;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Count `count` visits of `gameId` (batched, see the class comment). Never throws. */
  record(gameId: string, count = 1): void {
    if (!gameId || !Number.isInteger(count) || count <= 0 || this.unknownGames.has(gameId)) return;
    let g = this.games.get(gameId);
    if (!g) {
      g = { pending: 0, sending: 0, timer: null, busy: null, retry: null };
      this.games.set(gameId, g);
    }
    g.pending += count;
    if (!this.closing) this.schedule(gameId, g);
  }

  /** Visits not recorded yet (pending, waiting for a retry or in flight), for one game or all of them. */
  unrecorded(gameId?: string): number {
    let n = 0;
    for (const [id, g] of this.games) {
      if (gameId === undefined || id === gameId) n += g.pending + g.sending + (g.retry?.count ?? 0);
    }
    return n;
  }

  /** Resolves when no call is in flight (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const busy = [...this.games.values()].map((g) => g.busy).filter(Boolean);
      if (busy.length === 0) return;
      await Promise.allSettled(busy);
    }
  }

  /** Clear every timer (tests). Pending visits are kept but no longer sent on their own. */
  stop(): void {
    for (const g of this.games.values()) {
      if (g.timer !== null) this.timers.clearTimeout(g.timer);
      g.timer = null;
    }
  }

  /**
   * Process shutdown: stop the timers and send every game's pending and failed visits now, one attempt each (no
   * retries), waiting at most `shutdownTimeoutMs`. Logs what could not be recorded. Never throws.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.stop();
    let deadline: unknown = null;
    const timedOut = new Promise<boolean>((resolve) => {
      deadline = this.timers.setTimeout(() => resolve(true), this.shutdownTimeoutMs);
    });
    const done = (async () => {
      for (;;) {
        await this.settled();
        if (!this.sendAll()) return false;
      }
    })();
    const late = await Promise.race([done, timedOut]);
    this.timers.clearTimeout(deadline);
    const left = this.unrecorded();
    if (left > 0) {
      this.log(
        `[visits] shutdown: ${left} visit(s) not recorded` +
          (late ? ` (gave up after ${this.shutdownTimeoutMs} ms)` : ''),
      );
    }
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  /** Start the game's batch window, or send at once when the batch is full. */
  private schedule(gameId: string, g: GameBatch): void {
    if (g.busy || g.retry || g.pending === 0) return;
    if (g.pending >= this.batchSize) {
      if (g.timer !== null) this.timers.clearTimeout(g.timer);
      g.timer = null;
      this.sendPending(gameId, g);
      return;
    }
    g.timer ??= this.timers.setTimeout(() => {
      g.timer = null;
      this.sendPending(gameId, g);
    }, this.flushIntervalMs);
  }

  private sendPending(gameId: string, g: GameBatch): void {
    if (g.busy || g.retry || g.pending === 0 || this.games.get(gameId) !== g) return;
    const count = Math.min(g.pending, MAX_VISITS_PER_CALL);
    g.pending -= count;
    this.attempt(gameId, g, count, 0);
  }

  /** Shutdown: one call per idle game with pending or failed visits; true when anything was sent. */
  private sendAll(): boolean {
    let sent = false;
    for (const [gameId, g] of this.games) {
      if (g.busy) continue;
      if (g.timer !== null) this.timers.clearTimeout(g.timer);
      g.timer = null;
      if (g.retry) {
        g.pending += g.retry.count;
        g.retry = null;
      }
      if (g.pending === 0) continue;
      const count = Math.min(g.pending, MAX_VISITS_PER_CALL);
      g.pending -= count;
      this.attempt(gameId, g, count, 0);
      sent = true;
    }
    return sent;
  }

  private attempt(gameId: string, g: GameBatch, count: number, attempt: number): void {
    g.sending = count;
    g.busy = Promise.resolve()
      .then(() => this.api.recordVisits(gameId, count))
      .then(
        () => {
          if (!this.healthy) {
            this.healthy = true;
            this.log(`[visits] recording recovered (${gameId} +${count})`);
          }
        },
        (err: unknown) => this.failed(gameId, g, count, attempt + 1, err),
      )
      .finally(() => {
        g.sending = 0;
        g.busy = null;
        if (!this.closing && this.games.get(gameId) === g) this.schedule(gameId, g);
      });
  }

  /** `attempts`: calls made for this batch so far. */
  private failed(gameId: string, g: GameBatch, count: number, attempts: number, err: unknown): void {
    const why = err instanceof Error ? err.message : String(err);
    if (isNotFound(err)) {
      this.unknownGames.add(gameId);
      if (g.timer !== null) this.timers.clearTimeout(g.timer);
      this.games.delete(gameId);
      this.log(`[visits] ${gameId} is not a catalog game (${why}): its visits are not recorded`);
      return;
    }
    if (!this.closing && isRetryable(err) && attempts <= this.retryDelaysMs.length) {
      const delay = this.retryDelaysMs[attempts - 1]!;
      g.retry = { count, attempt: attempts };
      g.timer = this.timers.setTimeout(() => {
        g.timer = null;
        const r = g.retry;
        g.retry = null;
        if (r && this.games.get(gameId) === g) this.attempt(gameId, g, r.count, r.attempt);
      }, delay);
      if (this.healthy) {
        this.healthy = false;
        this.log(
          `[visits] recording ${count} visit(s) of ${gameId} failed (${why}); retrying after ` +
            `${this.retryDelaysMs.map((ms) => `${ms / 1000} s`).join(', ')}, then dropping the batch`,
        );
      }
      return;
    }
    this.log(`[visits] dropped ${count} visit(s) of ${gameId} after ${attempts} attempt(s): ${why}`);
  }
}

/** Development without a service key: batches are logged instead of sent. */
export function dryRunVisitApi(log: (msg: string) => void = (m) => console.info(m)): VisitApi {
  return {
    async recordVisits(gameId, count) {
      log(`[visits] (no service key) ${gameId} +${count}`);
    },
  };
}

/**
 * The process counter: real with a service client; a dry run that logs in development without one; none otherwise
 * (tests, and a guests-only production server without Supabase).
 */
export function createDefaultVisitCounter(
  config: Pick<ServerConfig, 'mode'>,
  api: VisitApi | null,
): VisitCounter | null {
  if (api) return new VisitCounter(api);
  if (config.mode === 'development') return new VisitCounter(dryRunVisitApi());
  return null;
}

/** `undefined` = not built yet (built from the environment on first use); `null` = visits are not counted. */
let counter: VisitCounter | null | undefined;

/** The process's visit counter (see {@link createDefaultVisitCounter}). */
export function visitCounter(): VisitCounter | null {
  if (counter === undefined) counter = createDefaultVisitCounter(serverConfig(), serviceApi());
  return counter;
}

/** Replace the process's counter (tests): `null` disables counting, `undefined` goes back to the default. */
export function configureVisitCounter(next: VisitCounter | null | undefined): void {
  counter = next;
}

/** Graceful shutdown hook (app.config.ts): flush the process counter, if one was ever built. Never throws. */
export async function shutdownVisits(): Promise<void> {
  try {
    await counter?.shutdown();
  } catch (err) {
    console.warn('[visits] shutdown flush failed', err);
  }
}
