import { DT, HISTORY_TICKS, MAX_REWIND_MS } from './constants.ts';
import type { Vec2 } from './vec.ts';

/** The most a client's view may be rewound, in ticks. */
export const MAX_REWIND_TICKS = MAX_REWIND_MS / 1000 / DT;

/**
 * Lag compensation: where a player was over the last `HISTORY_TICKS` server ticks, so a shot can be checked against
 * what the shooter saw. A client draws the others 2–3 patch intervals in the past (interpolation) and its input
 * reaches the server half a round trip later; it says which tick it was drawing (`rt` in the input), the server keeps
 * `tick − rt` as that client's view delay (at most `MAX_REWIND_TICKS`), and its hitscan shots and stabs test the
 * others where they were `delay` ticks ago, interpolated between the recorded ticks.
 *
 * `life` counts a player's spawns: a position from an earlier life (before a respawn teleported them) never answers,
 * so nobody is hit where they died.
 */
export class PositionHistory {
  private readonly ticks = new Int32Array(HISTORY_TICKS).fill(-1);
  private readonly xs = new Float64Array(HISTORY_TICKS);
  private readonly ys = new Float64Array(HISTORY_TICKS);
  private readonly lives = new Int32Array(HISTORY_TICKS);
  private readonly present = new Uint8Array(HISTORY_TICKS);

  /** Record the end of `tick`: where the player is, whether they are alive (hittable), and their life. */
  record(tick: number, x: number, y: number, alive: boolean, life: number): void {
    const i = tick % HISTORY_TICKS;
    this.ticks[i] = tick;
    this.xs[i] = x;
    this.ys[i] = y;
    this.lives[i] = life;
    this.present[i] = alive ? 1 : 0;
  }

  clear(): void {
    this.ticks.fill(-1);
  }

  private slot(tick: number): number {
    const i = ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    return this.ticks[i] === tick ? i : -1;
  }

  /**
   * Where the player was at (fractional) tick `t`, in life `life`, or null when they were not there then (dead, not
   * yet spawned, an earlier life). Ticks after the newest record answer with `now` (the current, unrecorded tick);
   * ticks older than the history answer with the oldest record (the rewind is capped anyway).
   */
  at(t: number, life: number, now: Vec2, nowTick: number): Vec2 | null {
    if (t >= nowTick) return now;
    const a = Math.floor(t);
    const k = t - a;
    const pa = this.sample(a, life, now, nowTick);
    if (!pa) return null;
    if (k < 1e-6) return pa;
    const pb = this.sample(a + 1, life, now, nowTick);
    if (!pb) return pa;
    return { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
  }

  private sample(tick: number, life: number, now: Vec2, nowTick: number): Vec2 | null {
    if (tick >= nowTick) return now;
    let i = this.slot(tick);
    if (i < 0) {
      // Older than the history: the oldest record of this life still standing in for it.
      let oldest = -1;
      for (let j = 0; j < HISTORY_TICKS; j++) {
        if (this.ticks[j]! >= 0 && this.ticks[j]! > tick && (oldest < 0 || this.ticks[j]! < this.ticks[oldest]!))
          oldest = j;
      }
      if (oldest < 0 || this.ticks[oldest]! - tick > HISTORY_TICKS) return null;
      i = oldest;
    }
    if (!this.present[i] || this.lives[i] !== life) return null;
    return { x: this.xs[i]!, y: this.ys[i]! };
  }
}
