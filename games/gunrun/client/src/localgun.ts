import {
  BULLET_BOXES,
  MELEE,
  POSTS,
  rayCircle,
  rayCircles,
  rayObstacles,
  type WeaponSpec,
} from '@rally/game-gunrun-server';

/**
 * Your own attacks, drawn the moment you attack (pure, unit-tested): mirrors the server's cadence (each weapon's
 * `cooldown`, accumulated so an SMG fires ~12 times a second at any frame rate; the knife's own cooldown) so the
 * muzzle flash, tracer, swing and sound answer the thumb at once. What a shot hit is only ever shown from the
 * server's `hit` / `kill` effects.
 */
export class LocalGun {
  private cd = 0;
  private knifeCd = 0;
  private lastNow: number | null = null;

  /**
   * Shots and stabs to draw this frame. `firing`: trigger held and allowed (alive, in a phase with combat);
   * `stabbing`: the knife button (or the trigger on the knife rung).
   */
  update(now: number, weapon: WeaponSpec, firing: boolean, stabbing: boolean): { shots: number; stabs: number } {
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(0.25, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.cd -= dt;
    this.knifeCd -= dt;
    let shots = 0;
    let stabs = 0;
    const stab = stabbing || (firing && weapon.kind === 'melee');
    if (stab && this.knifeCd <= 1e-9) {
      stabs = 1;
      this.knifeCd = MELEE.cooldown;
    } else if (firing && weapon.kind !== 'melee') {
      while (this.cd <= 1e-9 && shots < 4) {
        shots++;
        this.cd += weapon.cooldown;
      }
    }
    if (this.cd < 0) this.cd = 0;
    if (this.knifeCd < 0) this.knifeCd = 0;
    return { shots, stabs };
  }

  /** A new gun (promotion): it is ready at once, as on the server. */
  ready(): void {
    this.cd = 0;
  }

  reset(): void {
    this.cd = 0;
    this.knifeCd = 0;
    this.lastNow = null;
  }
}

/** Ray directions (radians) of one shot of `weapon` aimed at `aim`: the shotgun's fan, otherwise the aim. */
export function shotAngles(weapon: WeaponSpec, aim: number, jitter = 0): number[] {
  if (weapon.kind !== 'hitscan') return [];
  const out: number[] = [];
  for (let k = 0; k < weapon.pellets; k++) {
    const off = weapon.pellets > 1 ? -weapon.spread / 2 + (weapon.spread * k) / (weapon.pellets - 1) : 0;
    out.push(aim + off + jitter * weapon.jitter);
  }
  return out;
}

/**
 * How far a tracer goes (visual only): to the first obstacle, post, standing barrel or drawn player (`targets`, at
 * their rendered positions), capped at the weapon's range.
 */
export function tracerLength(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  range: number,
  targets: Iterable<{ x: number; y: number; r: number }>,
): number {
  let best = rayObstacles(ox, oy, dx, dy, BULLET_BOXES, range);
  best = rayCircles(ox, oy, dx, dy, POSTS, best);
  for (const z of targets) {
    const t = rayCircle(ox, oy, dx, dy, z.x, z.y, z.r, best);
    if (t !== null && t < best) best = t;
  }
  return best;
}
