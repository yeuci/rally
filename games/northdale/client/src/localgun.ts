import { FISTS, GRID, GUNS, MELEE, rayCircle, type GunSpec, type MeleeSpec } from '@rally/game-northdale-server';

/**
 * Your own shots and swings, drawn the moment you fire (pure; tested): mirrors the server's cadence (`cooldown` per
 * shot, a swing per melee cooldown) so the flash, tracer and sound match what the server does a round trip later.
 * Hits and kills only ever come from the server.
 */
export class LocalGun {
  private fireCd = 0;
  private meleeCd = 0;
  private last = -1;

  /** Shots and swings due at `now` (ms) for the held gun (null: none / empty / carrying) and melee weapon. */
  update(
    now: number,
    gun: GunSpec | null,
    melee: MeleeSpec,
    firing: boolean,
    swinging: boolean,
  ): { shots: number; swings: number } {
    const dt = this.last < 0 ? 0 : Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.fireCd = Math.max(-0.05, this.fireCd - dt);
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    let swings = 0;
    let shots = 0;
    if (swinging && this.meleeCd <= 1e-9) {
      swings = 1;
      this.meleeCd = melee.cooldown;
    } else if (firing && gun) {
      while (this.fireCd <= 1e-9 && shots < 4) {
        shots++;
        this.fireCd += gun.cooldown;
      }
    }
    if (!firing && this.fireCd < 0) this.fireCd = 0;
    return { shots, swings };
  }

  reset(): void {
    this.fireCd = 0;
    this.meleeCd = 0;
    this.last = -1;
  }
}

export const gunOf = (code: number): GunSpec | null => GUNS[code] ?? null;
export const meleeOf = (code: number): MeleeSpec => MELEE[code] ?? FISTS;

/** Pellet directions of a shot (the fan of a shotgun, plus a little jitter `r` in -1…1). */
export function shotAngles(gun: GunSpec, aim: number, r: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < gun.pellets; k++) {
    const off = gun.pellets > 1 ? -gun.spread / 2 + (gun.spread * k) / (gun.pellets - 1) : 0;
    out.push(aim + off + r * gun.jitter * (k % 2 ? -1 : 1));
  }
  return out;
}

/** How far a local tracer goes: to the first wall, or the first zombie drawn in its way (pierce: the n-th). */
export function tracerLength(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  range: number,
  targets: readonly { x: number; y: number; r: number }[],
  pierce = 1,
): number {
  const wall = GRID.ray(ox, oy, dx, dy, range);
  const hits: number[] = [];
  for (const t of targets) {
    const d = rayCircle(ox, oy, dx, dy, t.x, t.y, t.r, wall);
    if (d !== null) hits.push(d);
  }
  hits.sort((a, b) => a - b);
  return hits.length >= pierce ? hits[pierce - 1]! : wall;
}
