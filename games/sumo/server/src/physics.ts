import { ACCEL, DAMPING, MAX_SPEED, PUCK_RADIUS, RESTITUTION } from './constants.ts';
import type { Vec2 } from './vec.ts';

/**
 * Puck physics: point masses with equal mass on a flat disc, seen from above (x right, y "down" the screen).
 *
 * Deterministic given the same starting bodies, inputs and dt on the same JS engine: plain IEEE doubles, no
 * randomness, no wall clock, bodies always processed in sorted-id order. That is what lets the client re-run
 * `integrate` for its own puck (prediction) and get the server's answer when nothing else touches it.
 */
export interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** False once the puck has left the platform (or before it spawned). Dead bodies are not simulated. */
  alive: boolean;
}

export interface Contact {
  a: string;
  b: string;
  /** Impulse magnitude along the contact normal (≈ closing speed); drives sound/shake strength. */
  impulse: number;
  /** Contact point. */
  x: number;
  y: number;
}

export interface StepResult {
  /** Collisions this step, strongest per pair. */
  contacts: Contact[];
  /** Bodies that left the platform this step (now `alive = false`), in id order. */
  fallen: string[];
}

/** Advance one body by `dt` under a stick input (|input| ≤ 1): accelerate, damp ("friction"), cap, move. */
export function integrate(body: Body, input: Vec2, dt: number): void {
  body.vx += input.x * ACCEL * dt;
  body.vy += input.y * ACCEL * dt;
  const damp = Math.exp(-DAMPING * dt);
  body.vx *= damp;
  body.vy *= damp;
  const speed2 = body.vx * body.vx + body.vy * body.vy;
  if (speed2 > MAX_SPEED * MAX_SPEED) {
    const k = MAX_SPEED / Math.sqrt(speed2);
    body.vx *= k;
    body.vy *= k;
  }
  body.x += body.vx * dt;
  body.y += body.vy * dt;
}

/**
 * Resolve a puck–puck overlap: separate the two (half each) and exchange an impulse along the normal, so a hit
 * pushes both pucks. Returns the impulse (0 when they do not touch or are already separating).
 */
export function collide(a: Body, b: Body): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const minDist = PUCK_RADIUS * 2;
  const dist2 = dx * dx + dy * dy;
  if (dist2 >= minDist * minDist) return 0;
  const dist = Math.sqrt(dist2);
  // Exactly on top of each other: pick a fixed axis so the outcome stays deterministic.
  const nx = dist > 1e-9 ? dx / dist : 1;
  const ny = dist > 1e-9 ? dy / dist : 0;
  const push = (minDist - dist) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (closing >= 0) return 0;
  const j = (-(1 + RESTITUTION) * closing) / 2; // equal masses
  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;
  return j;
}

/** A puck is out once its centre is past the platform's edge (it tips over). */
export function isOut(body: Pick<Body, 'x' | 'y'>, radius: number): boolean {
  return body.x * body.x + body.y * body.y > radius * radius;
}

/** Stable processing order for determinism, independent of insertion order. */
export function byId(a: Body, b: Body): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One fixed step of the whole platform: `substeps` × (integrate every live body, then resolve every live pair),
 * then the fall-off check against `radius`. `inputs(id)` returns that body's current stick (zero if none).
 */
export function stepWorld(
  bodies: readonly Body[],
  inputs: (id: string) => Vec2,
  radius: number,
  dt: number,
  substeps = 1,
): StepResult {
  const live = bodies.filter((b) => b.alive).sort(byId);
  const h = dt / substeps;
  const strongest = new Map<string, Contact>();
  for (let s = 0; s < substeps; s++) {
    for (const b of live) integrate(b, inputs(b.id), h);
    for (let i = 0; i < live.length; i++) {
      for (let k = i + 1; k < live.length; k++) {
        const a = live[i]!;
        const b = live[k]!;
        const impulse = collide(a, b);
        if (impulse <= 0) continue;
        const key = `${a.id}|${b.id}`;
        const prev = strongest.get(key);
        if (!prev || impulse > prev.impulse) {
          strongest.set(key, { a: a.id, b: b.id, impulse, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
    }
  }
  const fallen: string[] = [];
  for (const b of live) {
    if (isOut(b, radius)) {
      b.alive = false;
      fallen.push(b.id);
    }
  }
  return { contacts: [...strongest.values()], fallen };
}

/** Spawn point `index` of `count`, evenly spaced on a ring at 60 % of `radius`; `turn` rotates the ring per round. */
export function spawnPoint(index: number, count: number, radius: number, turn = 0): Vec2 {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 + turn * 0.7 - Math.PI / 2;
  const r = radius * 0.6;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}
