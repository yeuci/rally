/**
 * Snapshot interpolation for networked entities (architecture §6: clients interpolate server snapshots).
 *
 * Push every state patch with its time ON THE SERVER'S TIMELINE (its tick × step, or a server timestamp: see
 * netclock.ts for why arrival times wobble), all entities of one patch at once. Sample at a render time behind the
 * newest data, with `sampleAt(id, t)` (t from game-kit's `RenderClock`) or `sample(id, now)` = `sampleAt(id, now −
 * delayMs)` when the push times are already local. Between the two snapshots around the render time a field is
 * interpolated linearly, or as a cubic Hermite curve when its rate is in the snapshot too (`rates: { x: 'vx' }`),
 * so speed stays continuous across snapshots. Past the newest snapshot an entity is extrapolated for at most
 * `extrapolateMs` (default 0: none), then held.
 */

export type Sample<F extends string> = Record<F, number>;

export interface SnapshotBufferOptions<F extends string> {
  /** Numeric fields to keep and interpolate, e.g. `['x', 'y', 'vx', 'vy']`. */
  fields: readonly F[];
  /** `sample()` renders this far behind the push times, ms. Default 100. Unused by `sampleAt()`. */
  delayMs?: number;
  /** Snapshots kept (older ones are dropped). Default 32. */
  capacity?: number;
  /**
   * Rate fields: `{ x: 'vx', y: 'vy' }` makes `x` follow a Hermite curve with slopes `vx` (both must be in
   * `fields`), and lets extrapolation use them. Rates are per `rateUnitMs`.
   */
  rates?: Partial<Record<F, F>>;
  /** Time unit of the rates, ms (default 1000: per second). */
  rateUnitMs?: number;
  /** Extrapolate at most this far past the newest snapshot (from its rates, else the last two snapshots). Default 0. */
  extrapolateMs?: number;
}

interface Snapshot<F extends string> {
  t: number;
  entities: Map<string, Sample<F>>;
}

export class SnapshotBuffer<F extends string> {
  readonly fields: readonly F[];
  delayMs: number;
  extrapolateMs: number;
  private readonly capacity: number;
  private readonly rates: [F, F][];
  private readonly rateUnitMs: number;
  private readonly snaps: Snapshot<F>[] = [];

  constructor(options: SnapshotBufferOptions<F>) {
    this.fields = options.fields;
    this.delayMs = options.delayMs ?? 100;
    this.capacity = options.capacity ?? 32;
    this.extrapolateMs = options.extrapolateMs ?? 0;
    this.rateUnitMs = options.rateUnitMs ?? 1000;
    this.rates = Object.entries(options.rates ?? {}) as [F, F][];
  }

  /**
   * Record one whole snapshot (every entity) at time `t`, ms. The same time again replaces that snapshot (a patch
   * that changed nothing on the timeline); an older time starts a new timeline (the buffer is cleared first).
   */
  push(t: number, entities: Iterable<[string, Sample<F>]>): void {
    const last = this.snaps[this.snaps.length - 1];
    const copy = new Map<string, Sample<F>>();
    for (const [id, s] of entities) {
      const c = {} as Sample<F>;
      for (const f of this.fields) c[f] = s[f];
      copy.set(id, c);
    }
    if (last && t === last.t) {
      last.entities = copy;
      return;
    }
    if (last && t < last.t) this.clear();
    this.snaps.push({ t, entities: copy });
    if (this.snaps.length > this.capacity) this.snaps.splice(0, this.snaps.length - this.capacity);
  }

  /** Forget everything (e.g. a new round teleports everyone). */
  clear(): void {
    this.snaps.length = 0;
  }

  get size(): number {
    return this.snaps.length;
  }

  /** Time of the newest snapshot, or null when empty. */
  get newest(): number | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1]!.t : null;
  }

  /** {@link sampleAt} at `now − delayMs` (push times on the local clock). */
  sample(id: string, now: number): Sample<F> | null {
    return this.sampleAt(id, now - this.delayMs);
  }

  /** One entity at time `t` (same timeline as `push`), or null if it is not in the buffer. */
  sampleAt(id: string, t: number): Sample<F> | null {
    const snaps = this.snaps;
    if (snaps.length === 0) return null;
    // Newest snapshot at or before t.
    let i = snaps.length - 1;
    while (i > 0 && snaps[i]!.t > t) i--;
    const a = snaps[i]!;
    const va = a.entities.get(id);
    if (!va) {
      // Not there yet at t: show its oldest later sample once one exists.
      for (let k = i + 1; k < snaps.length; k++) {
        const v = snaps[k]!.entities.get(id);
        if (v) return { ...v };
      }
      return null;
    }
    if (t <= a.t) return { ...va };
    const b = snaps[i + 1];
    const vb = b?.entities.get(id);
    if (!b || !vb) return b ? { ...va } : this.extrapolate(i, id, va, t - a.t);

    const span = b.t - a.t;
    const u = (t - a.t) / span;
    const out = {} as Sample<F>;
    for (const f of this.fields) out[f] = va[f] + (vb[f] - va[f]) * u;
    if (this.rates.length) {
      // Cubic Hermite: positions at both ends, slopes from the rates (scaled to the span).
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      const k = span / this.rateUnitMs;
      for (const [f, r] of this.rates) out[f] = h00 * va[f] + h10 * k * va[r] + h01 * vb[f] + h11 * k * vb[r];
    }
    return out;
  }

  /** Past the newest snapshot (index `i`): continue for at most `extrapolateMs`, then hold. */
  private extrapolate(i: number, id: string, va: Sample<F>, ahead: number): Sample<F> {
    const dt = Math.min(ahead, this.extrapolateMs);
    if (dt <= 0) return { ...va };
    const out = { ...va };
    if (this.rates.length) {
      for (const [f, r] of this.rates) out[f] = va[f] + (va[r] * dt) / this.rateUnitMs;
      return out;
    }
    const prev = this.snaps[i - 1];
    const vp = prev?.entities.get(id);
    if (!prev || !vp) return out;
    const k = dt / (this.snaps[i]!.t - prev.t);
    for (const f of this.fields) out[f] = va[f] + (va[f] - vp[f]) * k;
    return out;
  }
}
