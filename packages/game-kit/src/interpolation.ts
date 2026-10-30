/**
 * Snapshot interpolation for networked entities (architecture §6: clients interpolate server snapshots).
 *
 * Push every state patch with its local receive time; render other players at `now - delayMs`, interpolating
 * between the two snapshots around that time. With 20 Hz patches a 100 ms delay keeps two snapshots in hand, so one
 * late or lost patch does not stall motion. Nothing is extrapolated: past the newest snapshot an entity holds still.
 */

export type Sample<F extends string> = Record<F, number>;

export interface SnapshotBufferOptions<F extends string> {
  /** Numeric fields to interpolate, e.g. `['x', 'y']`. */
  fields: readonly F[];
  /** Render delay behind the newest data, in ms. Default 100. */
  delayMs?: number;
  /** Snapshots kept (older ones are dropped). Default 32. */
  capacity?: number;
}

interface Snapshot<F extends string> {
  t: number;
  entities: Map<string, Sample<F>>;
}

export class SnapshotBuffer<F extends string> {
  readonly fields: readonly F[];
  delayMs: number;
  private readonly capacity: number;
  private readonly snaps: Snapshot<F>[] = [];

  constructor(options: SnapshotBufferOptions<F>) {
    this.fields = options.fields;
    this.delayMs = options.delayMs ?? 100;
    this.capacity = options.capacity ?? 32;
  }

  /** Record the state as received at local time `t` (ms, e.g. `performance.now()`). Times must not go backwards. */
  push(t: number, entities: Iterable<[string, Sample<F>]>): void {
    const last = this.snaps[this.snaps.length - 1];
    const copy = new Map<string, Sample<F>>();
    for (const [id, s] of entities) {
      const c = {} as Sample<F>;
      for (const f of this.fields) c[f] = s[f];
      copy.set(id, c);
    }
    if (last && t <= last.t) {
      // Same frame (or a clock hiccup): the newer data replaces the older at that time.
      last.entities = copy;
      return;
    }
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

  /** Interpolated value of one entity at render time `now - delayMs`, or null if it is not in the buffer. */
  sample(id: string, now: number): Sample<F> | null {
    const rt = now - this.delayMs;
    const snaps = this.snaps;
    if (snaps.length === 0) return null;
    // Newest snapshot at or before the render time.
    let i = snaps.length - 1;
    while (i > 0 && snaps[i]!.t > rt) i--;
    const a = snaps[i]!;
    const b = snaps[i + 1];
    const va = a.entities.get(id);
    const vb = b?.entities.get(id);
    if (!va) {
      // Not there yet at the render time: show its oldest later sample once one exists.
      for (let k = i + 1; k < snaps.length; k++) {
        const v = snaps[k]!.entities.get(id);
        if (v) return { ...v };
      }
      return null;
    }
    if (!b || !vb || rt <= a.t) return { ...va };
    const u = Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t)));
    const out = {} as Sample<F>;
    for (const f of this.fields) out[f] = va[f] + (vb[f] - va[f]) * u;
    return out;
  }
}
