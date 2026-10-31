import { BULLET_BLOCKERS, WEAPONS, rayCircle, rayObstacles } from '@rally/game-overrun-server';

/**
 * Your own shots, drawn the moment you fire (pure, unit-tested): mirrors the server's fire cadence (`cooldown` per
 * weapon, accumulated so an uzi fires ~12 times a second at any frame rate) so the muzzle flash, tracer and sound
 * answer the trigger at once. What a shot hit is only ever shown from the server's `hit` / `kill` effects.
 */
export class LocalGun {
  private cd = 0;
  private lastNow: number | null = null;

  /** Shots to draw this frame (0…4). `firing`: trigger held and allowed (standing, in the run, ammo left). */
  update(now: number, firing: boolean, weapon: number): number {
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(0.25, (now - this.lastNow) / 1000));
    this.lastNow = now;
    const w = WEAPONS[weapon];
    this.cd -= dt;
    let shots = 0;
    if (firing && w && w.kind === 'gun') {
      while (this.cd <= 1e-9 && shots < 4) {
        shots++;
        this.cd += w.cooldown;
      }
    }
    if (this.cd < 0) this.cd = 0;
    return shots;
  }

  reset(): void {
    this.cd = 0;
    this.lastNow = null;
  }
}

/** Ray directions (radians) of one shot of `weapon` aimed at `aim`: the shotgun's fan, otherwise the aim. */
export function shotAngles(weapon: number, aim: number, jitter = 0): number[] {
  const w = WEAPONS[weapon];
  if (!w || w.kind !== 'gun') return [];
  const out: number[] = [];
  for (let k = 0; k < w.pellets; k++) {
    const off = w.pellets > 1 ? -w.spread / 2 + (w.spread * k) / (w.pellets - 1) : 0;
    out.push(aim + off + jitter * w.jitter);
  }
  return out;
}

/**
 * How far a tracer goes (visual only): to the first obstacle, the fence or a drawn zombie (`targets`, at their
 * rendered positions), capped at the weapon's range.
 */
export function tracerLength(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  range: number,
  targets: Iterable<{ x: number; y: number; r: number }>,
): number {
  let best = rayObstacles(ox, oy, dx, dy, BULLET_BLOCKERS, range);
  for (const z of targets) {
    const t = rayCircle(ox, oy, dx, dy, z.x, z.y, z.r, best);
    if (t !== null && t < best) best = t;
  }
  return best;
}
