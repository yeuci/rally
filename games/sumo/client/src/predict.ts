import { DT, SUBSTEPS, integrate, type Body, type Phase, type Vec2 } from '@rally/game-sumo-server';

/**
 * Client-side prediction of the LOCAL puck only — what is and is not predicted:
 *
 * - Predicted: your own acceleration, friction and speed cap (`integrate`, the exact function the server runs),
 *   so your puck answers your finger/keys immediately instead of one round trip + interpolation delay later.
 * - Not predicted: collisions with other pucks, knock-back, falling off, the shrinking edge, round resets. Those
 *   arrive from the server; the prediction is rebased on every authoritative snapshot, and the difference is
 *   blended out over ~120 ms so a hit shows as a quick shove rather than a teleport.
 * - Other players are never predicted: they are interpolated ~100 ms in the past (SnapshotBuffer).
 *
 * Timeline: a snapshot received at local time `t` describes the server ≈ rtt/2 earlier and already contains the
 * inputs we sent up to ≈ `t - rtt`. Replaying from it over `now - t + rtt` with the sticks we sent from `t - rtt`
 * onward gives where the server will have us once everything we have sent so far is applied.
 */
export interface OwnSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Phases in which the server moves pucks from inputs (`SumoMatch.step` runs physics in `waiting` practice, `playing`
 * and the `roundOver` slide-out). In `countdown` and `matchOver` pucks are frozen, so predicting there would show
 * our puck sliding away under a held stick and snapping back on every patch.
 */
export function shouldPredict(phase: Phase): boolean {
  return phase === 'waiting' || phase === 'playing' || phase === 'roundOver';
}

/** Corrections larger than this (units) are snapped, not blended (respawns, round starts). */
const SNAP_DISTANCE = 3;
/** Time constant of the correction blend, ms. */
const BLEND_MS = 120;
/** Never replay more than this (a stalled tab or a huge RTT would otherwise run away). */
const MAX_REPLAY_MS = 400;
const STEP_MS = (DT * 1000) / SUBSTEPS;

export class Predictor {
  private readonly sticks: { t: number; stick: Vec2 }[] = [];
  private base: { s: OwnSnapshot; t: number } | null = null;
  private offset = { x: 0, y: 0 };
  private offsetAt = 0;
  rttMs = 0;

  /** Record the stick we just sent to the server, at local time `t` (ms). */
  recordStick(t: number, stick: Vec2): void {
    const last = this.sticks[this.sticks.length - 1];
    if (last && last.stick.x === stick.x && last.stick.y === stick.y) return;
    this.sticks.push({ t, stick: { x: stick.x, y: stick.y } });
    // Keep ~2 s of history, but always the entry in effect at the start of that window.
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

  /** Forget the visual correction (call when switching from interpolated to predicted rendering). */
  reset(): void {
    this.base = null;
    this.offset = { x: 0, y: 0 };
  }

  /** An authoritative snapshot of our puck arrived at local time `t`. The rendered position stays continuous. */
  rebase(s: OwnSnapshot, t: number): void {
    const before = this.base ? this.predict(t) : null;
    this.base = { s: { ...s }, t };
    if (!before) return;
    const after = this.predict(t);
    const shown = { x: before.x + this.currentOffset(t).x, y: before.y + this.currentOffset(t).y };
    const dx = shown.x - after.x;
    const dy = shown.y - after.y;
    if (Math.hypot(dx, dy) > SNAP_DISTANCE) this.offset = { x: 0, y: 0 };
    else this.offset = { x: dx, y: dy };
    this.offsetAt = t;
  }

  /** Where to draw our puck at local time `now` (prediction + decaying correction), or null before any snapshot. */
  sample(now: number): { x: number; y: number } | null {
    if (!this.base) return null;
    const p = this.predict(now);
    const o = this.currentOffset(now);
    return { x: p.x + o.x, y: p.y + o.y };
  }

  private currentOffset(now: number) {
    const k = Math.exp(-Math.max(0, now - this.offsetAt) / BLEND_MS);
    return { x: this.offset.x * k, y: this.offset.y * k };
  }

  /** Pure replay from the base snapshot to `now` (no visual correction). */
  predict(now: number): { x: number; y: number } {
    const base = this.base!;
    const body: Body = { id: 'me', ...base.s, alive: true };
    const total = Math.min(MAX_REPLAY_MS, Math.max(0, now - base.t + this.rttMs));
    const start = now - total; // local time whose stick the server applies first
    let done = 0;
    while (done < total) {
      const h = Math.min(STEP_MS, total - done);
      integrate(body, this.stickAt(start + done), h / 1000);
      done += h;
    }
    return { x: body.x, y: body.y };
  }
}
