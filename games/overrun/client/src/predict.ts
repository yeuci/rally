import { DT, movePlayer, type Phase, type Vec2 } from '@rally/game-overrun-server';

/**
 * Client-side prediction of the LOCAL player's movement only — what is and is not predicted:
 *
 * - Predicted: your own walking (or crawling while down) and sliding along obstacles: `movePlayer`, the exact
 *   function the server runs, which depends only on your stick and the static map (zombies, barrels and other
 *   players never push a player). So your player answers your thumb immediately, and the server's answer matches.
 * - Not predicted: going down, revives, teleports (respawns between runs). They arrive from the server; the
 *   prediction is rebased on every authoritative snapshot and small differences blend out over ~100 ms (a large
 *   one, like a respawn, snaps).
 * - Shooting: your muzzle flash and tracer are drawn at once (see localgun.ts), but hits and kills only ever come
 *   from the server. Zombies and the other players are interpolated 2–3 patch intervals in the past.
 *
 * Timeline (as in Sumo): a snapshot whose tick is expected to arrive at local time `t` already contains the inputs
 * we sent up to ≈ `t − rtt`; replaying it over `now − t + rtt` with the sticks we sent from `t − rtt` on gives where
 * the server will have us once everything sent so far is applied.
 */
export interface OwnSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  down: boolean;
}

/** Phases in which the server moves players (`OverrunMatch.world` runs in waiting practice, breathers and waves). */
export function shouldPredict(phase: Phase, active: boolean): boolean {
  return active && (phase === 'waiting' || phase === 'breather' || phase === 'wave');
}

/** Corrections larger than this (units) are snapped, not blended. */
const SNAP_DISTANCE = 2.5;
/** Time constant of the correction blend, ms. */
const BLEND_MS = 100;
/** Never replay more than this (a stalled tab or a huge RTT would otherwise run away). */
const MAX_REPLAY_MS = 400;
const STEP_MS = DT * 1000;

export class Predictor {
  private readonly sticks: { t: number; stick: Vec2 }[] = [];
  private base: { s: OwnSnapshot; t: number } | null = null;
  private offset = { x: 0, y: 0 };
  private offsetAt = 0;
  rttMs = 0;

  /** Record the move stick we just sent to the server, at local time `t` (ms). */
  recordStick(t: number, stick: Vec2): void {
    const last = this.sticks[this.sticks.length - 1];
    if (last && last.stick.x === stick.x && last.stick.y === stick.y) return;
    this.sticks.push({ t, stick: { x: stick.x, y: stick.y } });
    while (this.sticks.length > 2 && this.sticks[1]!.t < t - 2000) this.sticks.shift();
  }

  /** Stick in effect at local time `t`. */
  stickAt(t: number): Vec2 {
    let s: Vec2 = { x: 0, y: 0 };
    for (const e of this.sticks) {
      if (e.t > t) break;
      s = e.stick;
    }
    return s;
  }

  reset(): void {
    this.base = null;
    this.offset = { x: 0, y: 0 };
  }

  get active(): boolean {
    return this.base !== null;
  }

  /**
   * An authoritative snapshot of our player; `t` is its content time on the local clock (see the class comment),
   * `now` when it arrived. The drawn position stays continuous at `now`.
   */
  rebase(s: OwnSnapshot, t: number, now = t): void {
    const before = this.base ? this.sample(now) : null;
    this.base = { s: { ...s }, t };
    this.offsetAt = now;
    if (!before) {
      this.offset = { x: 0, y: 0 };
      return;
    }
    const after = this.predict(now);
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    this.offset = Math.hypot(dx, dy) > SNAP_DISTANCE ? { x: 0, y: 0 } : { x: dx, y: dy };
  }

  /** Where to draw our player at local time `now`, or null before any snapshot. */
  sample(now: number): { x: number; y: number; vx: number; vy: number } | null {
    if (!this.base) return null;
    const p = this.predict(now);
    const k = Math.exp(-Math.max(0, now - this.offsetAt) / BLEND_MS);
    return { x: p.x + this.offset.x * k, y: p.y + this.offset.y * k, vx: p.vx, vy: p.vy };
  }

  /** Pure replay from the base snapshot to `now` (no visual correction). */
  predict(now: number): { x: number; y: number; vx: number; vy: number } {
    const base = this.base!;
    const body = { x: base.s.x, y: base.s.y, vx: base.s.vx, vy: base.s.vy };
    const total = Math.min(MAX_REPLAY_MS, Math.max(0, now - base.t + this.rttMs));
    const start = now - total;
    let done = 0;
    while (done < total) {
      const h = Math.min(STEP_MS, total - done);
      movePlayer(body, this.stickAt(start + done), base.s.down, h / 1000);
      done += h;
    }
    return body;
  }
}
