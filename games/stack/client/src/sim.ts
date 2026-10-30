/**
 * Stack's rules, independent of rendering and frame rate.
 *
 * Determinism: the sliding block's position is an analytic function of *time since its layer spawned*
 * (a triangle wave), never integrated per frame, and a drop is evaluated at the moment of the press — the input
 * layer passes how long ago the press happened (`lateBy`), so a tap is judged at the same block position whether
 * the next frame comes 8, 16 or 33 ms later (iOS Low Power Mode halves rAF to 30 Hz). The next layer starts at
 * the press time, too, so the remaining `lateBy` carries over. Same presses at the same times → same tower.
 */

/** Footprint of the base slab (and the maximum slab size). World units. */
export const BASE_SIZE = 3;
/** Slab thickness. */
export const LAYER_HEIGHT = 0.6;
/** The slider travels from -RANGE to +RANGE (and back) relative to the slab below. */
export const RANGE = 4.6;
/** |offset| at or below this counts as a perfect drop. */
export const PERFECT_TOLERANCE = 0.12;
/** A perfect drop grows the slab back by this much along the sliding axis (capped at BASE_SIZE). */
export const PERFECT_GROWTH = 0.12;
/** After a drop the next slab hovers this long before it starts sliding; presses in between are ignored. */
export const SPAWN_DELAY = 0.25;
const BASE_SPEED = 2.4;
const SPEED_PER_BLOCK = 0.05;
const MAX_SPEED = 5.2;
/** Each perfect in a row speeds the slider up by 3 %, up to 5 in a row (+15 %). */
const STREAK_SPEEDUP = 0.03;
const MAX_STREAK_SPEEDUP_STEPS = 5;

export type Axis = 'x' | 'z';
export type Phase = 'ready' | 'playing' | 'over';

/** An axis-aligned slab: centre (x, z), size (w along x, d along z), layer index (0 = base). */
export interface Slab {
  x: number;
  z: number;
  w: number;
  d: number;
  layer: number;
}

export type DropOutcome =
  | { kind: 'ignored' }
  | { kind: 'perfect'; placed: Slab; streak: number }
  | { kind: 'trim'; placed: Slab; debris: Slab }
  | { kind: 'miss'; debris: Slab };

export function axisOfLayer(layer: number): Axis {
  return layer % 2 === 1 ? 'x' : 'z';
}

/** Slider speed (units/s) for the next layer. */
export function speedFor(score: number, streak: number): number {
  const base = Math.min(BASE_SPEED + score * SPEED_PER_BLOCK, MAX_SPEED);
  return base * (1 + STREAK_SPEEDUP * Math.min(streak, MAX_STREAK_SPEEDUP_STEPS));
}

/** Offset of the slider from the centre of the slab below, `t` seconds after its layer spawned. */
export function sliderOffset(t: number, speed: number): number {
  const travelled = Math.max(0, t - SPAWN_DELAY) * speed;
  const span = 2 * RANGE;
  const m = travelled % (2 * span);
  return -RANGE + (m < span ? m : 2 * span - m);
}

export class StackSim {
  phase: Phase = 'ready';
  tower: Slab[] = [{ x: 0, z: 0, w: BASE_SIZE, d: BASE_SIZE, layer: 0 }];
  /** Game seconds since `start()` (stops at game over). */
  time = 0;
  /** Seconds since the current slider spawned. */
  layerTime = 0;
  speed = speedFor(0, 0);
  streak = 0;
  bestStreak = 0;
  perfects = 0;

  get score(): number {
    return this.tower.length - 1;
  }

  get top(): Slab {
    return this.tower[this.tower.length - 1]!;
  }

  /** Axis the current slider moves along. */
  get axis(): Axis {
    return axisOfLayer(this.tower.length);
  }

  start(): void {
    if (this.phase !== 'ready') return;
    this.phase = 'playing';
    this.time = 0;
    this.layerTime = 0;
  }

  /** Advance game time by `dt` seconds (already scaled: 0 while paused). */
  advance(dt: number): void {
    if (this.phase !== 'playing' || !(dt > 0)) return;
    this.time += dt;
    this.layerTime += dt;
  }

  /** Current slider offset (or at `lateBy` seconds ago). */
  offset(lateBy = 0): number {
    return sliderOffset(this.layerTime - lateBy, this.speed);
  }

  /** The slider as a slab (where it is drawn). Before `start()` it hovers at its spawn point. */
  slider(lateBy = 0): Slab {
    const top = this.top;
    const off = this.phase === 'ready' ? -RANGE : this.offset(lateBy);
    return this.axis === 'x'
      ? { ...top, x: top.x + off, layer: this.tower.length }
      : { ...top, z: top.z + off, layer: this.tower.length };
  }

  /** Drop the slider as of `lateBy` seconds ago (when the press actually happened). */
  drop(lateBy = 0): DropOutcome {
    if (this.phase !== 'playing') return { kind: 'ignored' };
    lateBy = Math.min(Math.max(0, lateBy), this.layerTime);
    const t = this.layerTime - lateBy;
    if (t < SPAWN_DELAY) return { kind: 'ignored' };

    const axis = this.axis;
    const top = this.top;
    const layer = this.tower.length;
    const off = sliderOffset(t, this.speed);
    const size = axis === 'x' ? top.w : top.d;
    const centre = axis === 'x' ? top.x : top.z;
    const overlap = size - Math.abs(off);
    const along = (c: number, s: number): Slab =>
      axis === 'x' ? { x: c, z: top.z, w: s, d: top.d, layer } : { x: top.x, z: c, w: top.w, d: s, layer };

    let outcome: DropOutcome;
    if (overlap <= 0) {
      this.phase = 'over';
      this.streak = 0;
      return { kind: 'miss', debris: along(centre + off, size) };
    }
    if (Math.abs(off) <= PERFECT_TOLERANCE) {
      this.streak += 1;
      this.perfects += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      const placed = along(centre, Math.min(BASE_SIZE, size + PERFECT_GROWTH));
      this.tower.push(placed);
      outcome = { kind: 'perfect', placed, streak: this.streak };
    } else {
      this.streak = 0;
      const placed = along(centre + off / 2, overlap);
      const debris = along(centre + Math.sign(off) * (size / 2) + off / 2, Math.abs(off));
      this.tower.push(placed);
      outcome = { kind: 'trim', placed, debris };
    }
    // The next layer starts at the press, so time already elapsed since then carries over.
    this.layerTime = lateBy;
    this.speed = speedFor(this.score, this.streak);
    return outcome;
  }
}
