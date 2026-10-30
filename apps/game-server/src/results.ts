import { serviceApi, ServiceRpcError, type RecordedMatch, type ServiceApi } from './supabase.js';

/**
 * Server-written multiplayer results (architecture §4, §8; design m3-phase2 §3): only the room writes them.
 *
 * A finished match goes to the process's {@link MatchResultSink}:
 * - with a service client (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`), {@link createSupabaseResultSink}: one
 *   `server_record_match` call, retried after 1 s, 5 s and 30 s (safe: the RPC is idempotent on `matchId`), then an
 *   `[results] UNRECORDED <json>` line for manual replay;
 * - without one (development, tests, a guests-only server), {@link loggingResultSink}: the result is logged, nothing is
 *   recorded.
 *
 * {@link reportMatchResult} never throws and is never awaited by the room's simulation (`SumoRoom` fires and forgets
 * it, then tells each player what was recorded when it resolves).
 */

export interface MatchResultPlayer {
  /** Supabase user id or `guest:<random>`. */
  userId: string;
  username: string;
  guest: boolean;
  /** 1 = winner; ties share a placement. */
  placement: number;
  /** Game-specific score (Sumo: round wins). */
  score: number;
  /** Achievement keys from game.json this player earned in the match. */
  achievements: string[];
}

export interface MatchResult {
  /** Unique per match (`<roomId>:<n>`); `server_record_match` is idempotent on it. */
  matchId: string;
  gameId: string;
  roomId: string;
  /** Played in a private room (`server_record_match` needs it: private matches with < 2 players skip the boards). */
  private: boolean;
  /** Winner's userId, or null for no winner. */
  winnerUserId: string | null;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  rounds: number;
  /** Server leaderboard increments, by board id from game.json (`{ wins: 1 }` for the winner). */
  leaderboardDeltas: Record<string, Record<string, number>>;
  players: MatchResultPlayer[];
  /** Free-form game details (e.g. how the match was decided). */
  details?: Record<string, unknown>;
}

export type { RecordedMatch, RecordedPlayer } from './supabase.js';

/**
 * Records a match. Resolves with what Supabase answered, or null when nothing was recorded (no service client, or
 * every attempt failed). May reject; {@link reportMatchResult} turns that into null.
 */
export type MatchResultSink = (
  result: MatchResult,
) => RecordedMatch | null | void | Promise<RecordedMatch | null | void>;

export interface SupabaseResultSinkOptions {
  /** Waits before each retry. Default 1 s, 5 s, 30 s (4 attempts in all). */
  retryDelaysMs?: readonly number[];
  /** Injected for tests (a fake clock); default an unref'd `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Warnings and the `UNRECORDED` line. Default `console.warn` / `console.error`. */
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 30_000] as const;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Whether a failed `server_record_match` is worth another attempt: network errors and timeouts (status 0), 408,
 * 429 and 5xx. Other answers (`INVALID`, `NOT_FOUND`, a rejected key) would fail the same way again.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ServiceRpcError)) return true;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
}

/**
 * The Supabase writer: `api.recordMatch(result)` with retries (see the module comment). Never rejects: after the last
 * failure (or a failure that cannot succeed on retry) it logs `[results] UNRECORDED <json>` and resolves null.
 */
export function createSupabaseResultSink(
  api: Pick<ServiceApi, 'recordMatch'>,
  opts: SupabaseResultSinkOptions = {},
): (result: MatchResult) => Promise<RecordedMatch | null> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;
  const warn = opts.warn ?? ((m) => console.warn(m));
  const error = opts.error ?? ((m) => console.error(m));
  return async (result) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const recorded = await api.recordMatch(result);
        if (attempt > 0) warn(`[results] ${result.matchId} recorded on attempt ${attempt + 1}`);
        return recorded;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const retry = isRetryable(err) && attempt < delays.length;
        if (!retry) {
          error(`[results] ${result.matchId} not recorded after ${attempt + 1} attempt(s): ${why}`);
          error(`[results] UNRECORDED ${JSON.stringify(result)}`);
          return null;
        }
        const delay = delays[attempt]!;
        warn(`[results] ${result.matchId} attempt ${attempt + 1} failed (${why}); retrying in ${delay / 1000} s`);
        await sleep(delay);
      }
    }
  };
}

/** No service client: log the match (one summary line and the JSON for replay); nothing is recorded. */
export function loggingResultSink(log: (msg: string) => void = (m) => console.info(m)): MatchResultSink {
  return (result) => {
    const who = result.players
      .map((p) => `${p.username}${p.guest ? '(guest)' : ''}=${p.score}#${p.placement}`)
      .join(' ');
    log(
      `[results] (no service key, not recorded) ${result.gameId} ${result.matchId} winner=${result.winnerUserId ?? '—'} ` +
        `rounds=${result.rounds} ${result.durationSec.toFixed(1)}s ${who}`,
    );
    log(`[results] ${JSON.stringify(result)}`);
    return null;
  };
}

/** `undefined` = not built yet (built from the environment on first use). */
let sink: MatchResultSink | undefined;

function currentSink(): MatchResultSink {
  if (sink === undefined) {
    const api = serviceApi();
    sink = api ? createSupabaseResultSink(api) : loggingResultSink();
  }
  return sink;
}

/**
 * Record a finished match: what Supabase answered, or null when nothing was recorded. Never throws (a failed write
 * must not crash the room); may take as long as the retries (~40 s), so rooms do not await it in their tick.
 */
export async function reportMatchResult(result: MatchResult): Promise<RecordedMatch | null> {
  try {
    return (await currentSink()(result)) ?? null;
  } catch (err) {
    console.error('[results] reportMatchResult failed', err);
    return null;
  }
}

/**
 * Replace the sink (tests). Returns the previous one; `undefined` goes back to the default built from the
 * environment.
 */
export function setMatchResultSink(next: MatchResultSink | undefined): MatchResultSink | undefined {
  const prev = sink;
  sink = next;
  return prev;
}
