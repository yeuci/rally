import { DT, movePlayer, type Phase, type Vec2 } from '@rally/game-sushi-server';

/**
 * Client-side prediction of the LOCAL chef's movement only: `movePlayer`, the exact function the server runs, depends
 * only on the stick, the speed multiplier (the sandals upgrade), the open zones and the static restaurant (chefs never
 * push each other), so your chef answers your thumb at once and the server agrees. Everything else (items, stations,
 * customers, the belt) comes from the server. The prediction is rebased on every authoritative snapshot; small
 * differences blend out over ~100 ms, a large one (a morning teleport to the spawn) snaps.
 *
 * Timeline: a snapshot whose tick is expected at local time `t` already contains the inputs sent up to ≈ `t − rtt`;
 * replaying it over `now − t + rtt` with the sticks sent from `t − rtt` on gives where the server will have us.
 */
export interface OwnSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  zones: number;
}

/** The server moves chefs in these phases. */
export function shouldPredict(phase: Phase): boolean {
  return phase === 'lobby' || phase === 'morning' || phase === 'open' || phase === 'closing';
}

const SNAP_DISTANCE = 2.5;
const BLEND_MS = 100;
const MAX_REPLAY_MS = 400;
const STEP_MS = DT * 1000;

export class Predictor {
  private readonly sticks: { t: number; stick: Vec2 }[] = [];
  private base: { s: OwnSnapshot; t: number } | null = null;
  private offset = { x: 0, y: 0 };
  private offsetAt = 0;
  rttMs = 0;

  recordStick(t: number, stick: Vec2): void {
    const last = this.sticks[this.sticks.length - 1];
    if (last && last.stick.x === stick.x && last.stick.y === stick.y) return;
    this.sticks.push({ t, stick: { x: stick.x, y: stick.y } });
    while (this.sticks.length > 2 && this.sticks[1]!.t < t - 2000) this.sticks.shift();
  }

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

  sample(now: number): { x: number; y: number; vx: number; vy: number } | null {
    if (!this.base) return null;
    const p = this.predict(now);
    const k = Math.exp(-Math.max(0, now - this.offsetAt) / BLEND_MS);
    return { x: p.x + this.offset.x * k, y: p.y + this.offset.y * k, vx: p.vx, vy: p.vy };
  }

  predict(now: number): { x: number; y: number; vx: number; vy: number } {
    const base = this.base!;
    const body = { x: base.s.x, y: base.s.y, vx: base.s.vx, vy: base.s.vy };
    const total = Math.min(MAX_REPLAY_MS, Math.max(0, now - base.t + this.rttMs));
    const start = now - total;
    let done = 0;
    while (done < total) {
      const h = Math.min(STEP_MS, total - done);
      movePlayer(body, this.stickAt(start + done), base.s.speed, base.s.zones, h / 1000);
      done += h;
    }
    return body;
  }
}
