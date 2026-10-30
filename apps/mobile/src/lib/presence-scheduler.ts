/**
 * The presence heartbeat's rules (m3-phase2 §2 "Shell"), with the clock, the timers and the RPC injected so
 * test/presence.test.ts runs them under plain Node. lib/presence.ts owns the app's one instance (real timers,
 * `supabase.rpc('heartbeat')`, `AppState`).
 *
 * - **Who**: only a linked account (`setAccount(userId)`; anonymous and signed-out sessions pass null and never beat).
 * - **When**: while the app is active, one beat right away and on every status change, then every `interval_s`
 *   (45 s; the server's answer may adjust it within 15–300 s). Beats never overlap; changes made while one is in
 *   flight are coalesced into the next.
 * - **What**: `online`, or `in_game` with the game and room ids the play route got from `onJoined`.
 * - **Background**: the interval pauses at once. Back within `graceMs` it resumes where it was (a beat right away if
 *   one fell due meanwhile or the status changed); still away after the grace, `offline` is sent and the row is gone
 *   until the next beat.
 * - **Sign-out**: `signOut()` sends `offline` (while the session can still authenticate it) and stops.
 * - **ok:false** (rate limited, banned, a refused session): the interval stops. Only a new reason to beat re-arms it:
 *   a status change, coming back from the background after the grace, or another account. Network errors keep the
 *   interval (the next tick retries); the server's 90 s TTL covers what a missed beat leaves behind.
 */

export type PresenceStatus = 'online' | 'in_game';

/** What the shell is doing, as `heartbeat` reports it. */
export interface PresenceState {
  status: PresenceStatus;
  gameId?: string;
  roomId?: string;
}

export interface Beat {
  status: PresenceStatus | 'offline';
  gameId?: string;
  roomId?: string;
}

/** `heartbeat`'s answer (`{ok, ttl_s, interval_s}`); a thrown error is treated as transient. */
export interface BeatAnswer {
  ok: boolean;
  intervalS?: number;
}

export interface SchedulerTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface HeartbeatSchedulerOptions {
  send: (beat: Beat) => Promise<BeatAnswer>;
  timers: SchedulerTimers;
  /** Default and fallback beat period (the server says 45 s). */
  intervalMs?: number;
  /** How long the app may be away (background / inactive) before `offline` is sent. */
  graceMs?: number;
}

export const HEARTBEAT_INTERVAL_MS = 45_000;
/** Short: an app switcher peek or a permission prompt should not flicker the status; a real background should. */
export const HEARTBEAT_BACKGROUND_GRACE_MS = 10_000;
const INTERVAL_MIN_MS = 15_000;
const INTERVAL_MAX_MS = 300_000;

/** The server's `interval_s` in ms when it is sane, else `fallback`. */
export function beatIntervalMs(intervalS: unknown, fallback = HEARTBEAT_INTERVAL_MS): number {
  if (typeof intervalS !== 'number' || !Number.isFinite(intervalS)) return fallback;
  const ms = intervalS * 1000;
  return ms >= INTERVAL_MIN_MS && ms <= INTERVAL_MAX_MS ? ms : fallback;
}

/** `heartbeat` RPC data → answer. Anything unexpected is `ok:false` (stop rather than hammer the server). */
export function parseBeatAnswer(data: unknown): BeatAnswer {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };
  const d = data as { ok?: unknown; interval_s?: unknown };
  return typeof d.interval_s === 'number' ? { ok: d.ok === true, intervalS: d.interval_s } : { ok: d.ok === true };
}

const sameState = (a: PresenceState, b: PresenceState) =>
  a.status === b.status && a.gameId === b.gameId && a.roomId === b.roomId;

/** The beat for a state: `online` never carries ids; `in_game` needs a game (else it reads as `online`). */
export function beatFor(state: PresenceState): Beat {
  if (state.status === 'in_game' && state.gameId) {
    return state.roomId ? { status: 'in_game', gameId: state.gameId, roomId: state.roomId } : { status: 'in_game', gameId: state.gameId };
  }
  return { status: 'online' };
}

export interface HeartbeatScheduler {
  /** The linked account to beat for; null for signed out or an anonymous session (stops without `offline`). */
  setAccount(userId: string | null): void;
  /** `AppState` is `active`. */
  setActive(active: boolean): void;
  /** What the shell is doing (`online`, or `in_game` with ids). */
  setPresence(state: PresenceState): void;
  /** Sends `offline` (if a row may exist) and stops; resolves when the server answered or failed. */
  signOut(): Promise<void>;
  /** Snapshot for tests and diagnostics. */
  inspect(): { account: string | null; active: boolean; halted: boolean; presence: PresenceState; scheduled: boolean; away: boolean };
}

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  const { send, timers } = opts;
  const defaultInterval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const graceMs = opts.graceMs ?? HEARTBEAT_BACKGROUND_GRACE_MS;

  let account: string | null = null;
  let active = false;
  let presence: PresenceState = { status: 'online' };
  /** Stopped after ok:false until a new reason to beat. */
  let halted = false;
  /** `offline` went out after the grace (the next return to the foreground beats at once). */
  let away = false;
  let intervalMs = defaultInterval;
  /** When the last online / in_game beat was sent (for resuming the interval after a short absence). */
  let lastBeatAt: number | null = null;
  /** The presence that beat carried: a change made while paused is sent as soon as beats resume. */
  let lastBeatState: PresenceState | null = null;
  /** The server may hold a row for `account` (a beat went out since the last `offline`). */
  let rowMayExist = false;
  let tick: unknown = null;
  let grace: unknown = null;
  /**
   * Serialises sends. Beats asked for while one is in flight wait in `queued`: a newer online / in_game beat replaces
   * an older waiting one (coalescing); `offline` is never dropped.
   */
  let inflight: Promise<void> | null = null;
  let queued: { beat: Beat; account: string }[] = [];

  const clearTick = () => {
    if (tick !== null) timers.clearTimeout(tick);
    tick = null;
  };
  const clearGrace = () => {
    if (grace !== null) timers.clearTimeout(grace);
    grace = null;
  };
  const running = () => account !== null && active && !halted;

  function schedule(delayMs: number) {
    clearTick();
    if (!running()) return;
    tick = timers.setTimeout(() => {
      tick = null;
      beat();
    }, Math.max(0, delayMs));
  }

  function dispatch(next: Beat, forAccount: string): Promise<void> {
    if (inflight) {
      if (next.status !== 'offline') queued = queued.filter((q) => q.beat.status === 'offline');
      queued.push({ beat: next, account: forAccount });
      return inflight;
    }
    const run = async () => {
      let job: { beat: Beat; account: string } | null = { beat: next, account: forAccount };
      while (job) {
        const { beat: b, account: who } = job;
        job = null;
        // An account change while queued drops the stale beat (it would be sent with the new session).
        if (b.status !== 'offline' && who !== account) {
          job = takeQueued();
          continue;
        }
        if (b.status === 'offline') rowMayExist = false;
        else {
          rowMayExist = true;
          lastBeatAt = timers.now();
        }
        try {
          const answer = await send(b);
          if (b.status !== 'offline' && who === account) {
            if (answer.ok) {
              intervalMs = beatIntervalMs(answer.intervalS, defaultInterval);
              // A later beat (queued behind one refused) got through: carry on.
              if (halted) {
                halted = false;
                schedule(intervalMs);
              }
            } else {
              halted = true;
              clearTick();
            }
          }
        } catch {
          // Transient (network): the interval keeps going and the next tick retries.
        }
        job = takeQueued();
      }
    };
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function takeQueued() {
    return queued.shift() ?? null;
  }

  /** One online / in_game beat now, then the next one an interval later. */
  function beat() {
    if (!running() || !account) return;
    away = false;
    lastBeatState = { ...presence };
    void dispatch(beatFor(presence), account);
    schedule(intervalMs);
  }

  function goAway() {
    grace = null;
    clearTick();
    if (!account || !rowMayExist) {
      away = true;
      return;
    }
    away = true;
    void dispatch({ status: 'offline' }, account);
  }

  return {
    setAccount(userId) {
      if (userId === account) return;
      account = userId;
      halted = false;
      away = false;
      lastBeatAt = null;
      lastBeatState = null;
      rowMayExist = false;
      intervalMs = defaultInterval;
      clearTick();
      clearGrace();
      // A new account starts from `online` (a game is per session; the play route sets it again).
      presence = { status: 'online' };
      if (running()) beat();
    },

    setActive(next) {
      if (next === active) return;
      active = next;
      if (!next) {
        clearTick();
        clearGrace();
        if (account) grace = timers.setTimeout(goAway, graceMs);
        return;
      }
      const wasWithinGrace = grace !== null;
      clearGrace();
      if (!account) return;
      if (away) {
        // Long enough away for `offline`: a fresh start, and a reason to retry after an ok:false.
        halted = false;
        beat();
        return;
      }
      if (!running()) return;
      const due = lastBeatAt === null ? 0 : lastBeatAt + intervalMs - timers.now();
      const changed = !lastBeatState || !sameState(lastBeatState, presence);
      if (!wasWithinGrace || due <= 0 || changed) beat();
      else schedule(due);
    },

    setPresence(next) {
      const normalized: PresenceState =
        next.status === 'in_game' && next.gameId ? { ...next } : { status: 'online' };
      if (sameState(normalized, presence)) return;
      presence = normalized;
      // A change is a reason to try again after an ok:false.
      halted = false;
      if (running()) beat();
    },

    async signOut() {
      const who = account;
      account = null;
      clearTick();
      clearGrace();
      presence = { status: 'online' };
      halted = false;
      away = false;
      lastBeatAt = null;
      lastBeatState = null;
      if (!who || !rowMayExist) {
        if (inflight) await inflight;
        return;
      }
      // Queued behind a beat in flight, `offline` still goes out last (beats for `who` left in the queue are dropped).
      await dispatch({ status: 'offline' }, who);
    },

    inspect() {
      return { account, active, halted, presence: { ...presence }, scheduled: tick !== null, away };
    },
  };
}
