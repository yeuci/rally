/**
 * Server time on the client, for snapshot interpolation (architecture §6).
 *
 * Snapshots must be placed on the SERVER's timeline (its tick or simulation time), not stamped with their arrival
 * time: patches leave the server on their own timer (Colyseus `patchRate`), so each one carries a varying amount of
 * simulation (a 30 Hz sim patched at 20 Hz alternates 1 and 2 ticks per patch), and the network and the event loop
 * deliver them in bursts. Interpolating by arrival time turns both into visible speed wobble.
 *
 * - {@link ServerClock} estimates `local − server` from (server time, arrival time) pairs: the lower envelope (the
 *   earliest arrival over a sliding window, because a late packet is queueing, not a clock change), smoothed so the
 *   envelope's small steps (a new earliest arrival, the old one leaving the window) do not show. The spread of the
 *   window above the envelope is the observed jitter.
 * - {@link interpolationDelay} picks how far behind the estimated server "now" to render: one interval plus the
 *   jitter, clamped to 2–3 patch intervals.
 * - {@link RenderClock} combines the two and eases the render time toward a new estimate (never jumps, never runs
 *   backwards, at most ±5 % off real time), so a moving estimate does not show as speed wobble.
 */

export interface ServerClockOptions {
  /** Sliding window of arrivals the estimate looks at, ms of local time. Default 3000. */
  windowMs?: number;
  /** Gain per observation of the smoothing toward the window's earliest arrival. Default 0.1. */
  smoothing?: number;
  /** A deviation larger than this re-seeds the estimate (new room, server restart, a long stall). Default 1000 ms. */
  resetMs?: number;
}

export class ServerClock {
  /** Estimated `local − server` time, ms (smoothed earliest arrival); null before the first observation. */
  offsetMs: number | null = null;
  /** The window's earliest arrival, `local − server` ms (unsmoothed). */
  floorMs: number | null = null;
  /** Observed jitter: how much later than the earliest arrival the latest one in the window came, ms. */
  jitterMs = 0;
  private readonly windowMs: number;
  private readonly smoothing: number;
  private readonly resetMs: number;
  private readonly samples: { at: number; offset: number }[] = [];

  constructor(options: ServerClockOptions = {}) {
    this.windowMs = options.windowMs ?? 3000;
    this.smoothing = options.smoothing ?? 0.1;
    this.resetMs = options.resetMs ?? 1000;
  }

  /**
   * A snapshot of server time `serverMs` arrived at local time `localMs` (both ms). Call it once per server time
   * (the first arrival of each tick). Returns the arrival's lateness against the estimate before this update.
   */
  observe(serverMs: number, localMs: number): number {
    const sample = localMs - serverMs;
    const late = this.offsetMs === null ? 0 : sample - this.offsetMs;
    const reseed = this.offsetMs === null || Math.abs(late) > this.resetMs;
    if (reseed) this.samples.length = 0;
    this.samples.push({ at: localMs, offset: sample });
    while (this.samples.length > 1 && this.samples[0]!.at < localMs - this.windowMs) this.samples.shift();
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.samples) {
      lo = Math.min(lo, s.offset);
      hi = Math.max(hi, s.offset);
    }
    this.floorMs = lo;
    this.offsetMs = reseed ? lo : this.offsetMs! + (lo - this.offsetMs!) * this.smoothing;
    this.jitterMs = hi - lo;
    return late;
  }

  /** Estimated server time at local time `localMs` (only meaningful once {@link offsetMs} is set). */
  toServer(localMs: number): number {
    return localMs - (this.offsetMs ?? 0);
  }

  /** Local time at which data of server time `serverMs` is expected to arrive (the earliest arrivals). */
  toLocal(serverMs: number): number {
    return serverMs + (this.offsetMs ?? 0);
  }

  reset(): void {
    this.offsetMs = null;
    this.floorMs = null;
    this.jitterMs = 0;
    this.samples.length = 0;
  }
}

export interface DelayOptions {
  /** Interval between server snapshots (patches), ms. */
  intervalMs: number;
  /** Smallest delay, in intervals. Default 2. */
  minIntervals?: number;
  /** Largest delay, in intervals. Default 3. */
  maxIntervals?: number;
}

/**
 * Interpolation delay for the observed jitter: one interval (the wait for the next snapshot) plus the jitter (how
 * late it can be), clamped to `minIntervals`…`maxIntervals` intervals.
 */
export function interpolationDelay(jitterMs: number, options: DelayOptions): number {
  const { intervalMs, minIntervals = 2, maxIntervals = 3 } = options;
  const want = intervalMs + Math.max(0, jitterMs);
  return Math.min(maxIntervals * intervalMs, Math.max(minIntervals * intervalMs, want));
}

export interface RenderClockOptions extends ServerClockOptions, DelayOptions {
  /** Time constant of the easing toward a new estimate, ms. Default 1000. */
  easeMs?: number;
  /** Most the render lag may change per ms of real time (0.05 = time runs at 0.95–1.05×). */
  slew?: number;
  /** A lag change larger than this (or the first frame, or a frame gap larger than this) snaps. Default 250 ms. */
  snapMs?: number;
}

/** Where on the server's timeline to draw remote entities: `estimated server now − adaptive delay`, eased. */
export class RenderClock {
  readonly server: ServerClock;
  private readonly delay: DelayOptions;
  private readonly easeMs: number;
  private readonly slew: number;
  private readonly snapMs: number;
  private readonly resetMs: number;
  /** Shown `local − render time` (offset + delay, eased), ms. */
  private lag: number | null = null;
  private lastNow = 0;
  private lastServerMs = -Infinity;

  constructor(options: RenderClockOptions) {
    this.server = new ServerClock(options);
    this.delay = options;
    this.easeMs = options.easeMs ?? 1000;
    this.slew = options.slew ?? 0.05;
    this.snapMs = options.snapMs ?? 250;
    this.resetMs = options.resetMs ?? 1000;
  }

  /**
   * A snapshot of server time `serverMs` arrived at local time `localMs`. Repeats of the same (or an older) server
   * time are ignored, except a jump back by more than the reset threshold (a new timeline).
   */
  observe(serverMs: number, localMs: number): void {
    if (serverMs <= this.lastServerMs && this.lastServerMs - serverMs <= this.resetMs) return;
    this.lastServerMs = serverMs;
    this.server.observe(serverMs, localMs);
  }

  /** The current target delay behind the estimated server time, ms. */
  get delayMs(): number {
    return interpolationDelay(this.server.jitterMs, this.delay);
  }

  /** Server time to render at local time `now` (ms), or null before the first snapshot. */
  renderTime(now: number): number | null {
    const offset = this.server.offsetMs;
    if (offset === null) return null;
    const target = offset + this.delayMs;
    const dt = now - this.lastNow;
    if (this.lag === null || Math.abs(target - this.lag) > this.snapMs || dt > this.snapMs || dt < 0) {
      this.lag = target;
    } else {
      const step = this.slew * dt;
      const eased = (target - this.lag) * Math.min(1, dt / this.easeMs);
      this.lag += Math.max(-step, Math.min(step, eased));
    }
    this.lastNow = now;
    return now - this.lag;
  }

  reset(): void {
    this.server.reset();
    this.lag = null;
    this.lastServerMs = -Infinity;
  }
}
