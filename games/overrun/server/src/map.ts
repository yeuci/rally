import { ARENA_HALF_H, ARENA_HALF_W, DOWN_SPEED, PLAYER_ACCEL_TAU, PLAYER_RADIUS, PLAYER_SPEED } from './constants.ts';
import { pushCircleOutOfAabb, type Aabb, type Push } from './geometry.ts';
import type { Vec2 } from './vec.ts';

/**
 * The one hand-designed arena, "Depot": a 48 × 32 yard with a pillared plaza in the middle, broken walls that funnel
 * the horde into lanes, and crate stacks in the corners. Zombies come in through six gates on the outer fence.
 */
export type ObstacleKind = 'crate' | 'pillar' | 'wall';

export interface Obstacle extends Aabb {
  kind: ObstacleKind;
  /** Drawn height (rendering only). */
  height: number;
}

function box(cx: number, cy: number, hw: number, hh: number, kind: ObstacleKind): Obstacle {
  const height = kind === 'wall' ? 1.5 : kind === 'pillar' ? 2.2 : hw * hh > 0.6 ? 1.3 : 0.9;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh, kind, height };
}

/** Point symmetric about the centre, so neither half of the yard is safer. */
function pair(cx: number, cy: number, hw: number, hh: number, kind: ObstacleKind): Obstacle[] {
  return [box(cx, cy, hw, hh, kind), box(-cx, -cy, hw, hh, kind)];
}

export const OBSTACLES: readonly Obstacle[] = [
  // The plaza: four pillars around the spawn.
  ...pair(-4.5, -3.2, 0.6, 0.6, 'pillar'),
  ...pair(4.5, -3.2, 0.6, 0.6, 'pillar'),
  // North and south walls, each broken in the middle.
  ...pair(-4, -8, 3, 0.3, 'wall'),
  ...pair(4, -8, 3, 0.3, 'wall'),
  // East and west walls with a gap at the centre line.
  ...pair(-13, -3.2, 0.3, 2.2, 'wall'),
  ...pair(-13, 3.2, 0.3, 2.2, 'wall'),
  // Crate stacks.
  ...pair(-18.5, -10, 1, 1, 'crate'),
  ...pair(-16.6, -10.7, 0.5, 0.5, 'crate'),
  ...pair(18, -10.5, 0.8, 0.8, 'crate'),
  ...pair(-8.5, -12.5, 0.6, 0.6, 'crate'),
  ...pair(7, -12.3, 1.6, 0.55, 'crate'),
  ...pair(20.5, -4, 0.7, 0.7, 'crate'),
  ...pair(-8.8, 0, 0.55, 1.1, 'crate'),
];

/** The outer fence as four boxes just outside the arena: bullets stop there. */
export const FENCE: readonly Aabb[] = [
  { x0: -ARENA_HALF_W - 2, y0: -ARENA_HALF_H - 2, x1: ARENA_HALF_W + 2, y1: -ARENA_HALF_H },
  { x0: -ARENA_HALF_W - 2, y0: ARENA_HALF_H, x1: ARENA_HALF_W + 2, y1: ARENA_HALF_H + 2 },
  { x0: -ARENA_HALF_W - 2, y0: -ARENA_HALF_H, x1: -ARENA_HALF_W, y1: ARENA_HALF_H },
  { x0: ARENA_HALF_W, y0: -ARENA_HALF_H, x1: ARENA_HALF_W + 2, y1: ARENA_HALF_H },
];

/** What a bullet can hit besides zombies and barrels: obstacles and the fence. */
export const BULLET_BLOCKERS: readonly Aabb[] = [...OBSTACLES, ...FENCE];

export interface Gate {
  /** Where the doorway is drawn, on the fence. */
  x: number;
  y: number;
  /** Where zombies appear (just inside), and the direction along the fence to scatter them. */
  sx: number;
  sy: number;
  ax: number;
  ay: number;
}

export const GATES: readonly Gate[] = [
  { x: -14, y: -ARENA_HALF_H, sx: -14, sy: -ARENA_HALF_H + 0.6, ax: 1, ay: 0 },
  { x: 14, y: -ARENA_HALF_H, sx: 14, sy: -ARENA_HALF_H + 0.6, ax: 1, ay: 0 },
  { x: ARENA_HALF_W, y: 0, sx: ARENA_HALF_W - 0.6, sy: 0, ax: 0, ay: 1 },
  { x: 14, y: ARENA_HALF_H, sx: 14, sy: ARENA_HALF_H - 0.6, ax: 1, ay: 0 },
  { x: -14, y: ARENA_HALF_H, sx: -14, sy: ARENA_HALF_H - 0.6, ax: 1, ay: 0 },
  { x: -ARENA_HALF_W, y: 0, sx: -ARENA_HALF_W + 0.6, sy: 0, ax: 0, ay: 1 },
];

/** Player spawn points by slot, around the plaza. */
export const SPAWNS: readonly Vec2[] = [
  { x: -1.3, y: -1.1 },
  { x: 1.3, y: -1.1 },
  { x: -1.3, y: 1.1 },
  { x: 1.3, y: 1.1 },
];

/** Keep a circle inside the fence. */
export function clampToArena(p: { x: number; y: number }, r: number): boolean {
  let hit = false;
  const maxX = ARENA_HALF_W - r;
  const maxY = ARENA_HALF_H - r;
  if (p.x < -maxX) [p.x, hit] = [-maxX, true];
  else if (p.x > maxX) [p.x, hit] = [maxX, true];
  if (p.y < -maxY) [p.y, hit] = [-maxY, true];
  else if (p.y > maxY) [p.y, hit] = [maxY, true];
  return hit;
}

/** Whether a circle sits inside the fence and clear of every obstacle (placement checks). */
export function circleIsFree(x: number, y: number, r: number, boxes: readonly Aabb[] = OBSTACLES): boolean {
  if (Math.abs(x) > ARENA_HALF_W - r || Math.abs(y) > ARENA_HALF_H - r) return false;
  const p = { x, y };
  for (const b of boxes) if (pushCircleOutOfAabb(p, r, b)) return false;
  return true;
}

const push: Push = { nx: 0, ny: 0 };

/**
 * Push a moving circle out of every obstacle and back inside the fence, and drop the part of its velocity that
 * points into whatever it hit (so it slides along walls). Two passes settle corners.
 */
export function resolveCircle(
  b: { x: number; y: number; vx: number; vy: number },
  r: number,
  boxes: readonly Aabb[] = OBSTACLES,
): void {
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const o of boxes) {
      if (!pushCircleOutOfAabb(b, r, o, push)) continue;
      moved = true;
      const into = b.vx * push.nx + b.vy * push.ny;
      if (into < 0) {
        b.vx -= into * push.nx;
        b.vy -= into * push.ny;
      }
    }
    if (!moved) break;
  }
  const maxX = ARENA_HALF_W - r;
  const maxY = ARENA_HALF_H - r;
  if (b.x < -maxX) [b.x, b.vx] = [-maxX, Math.max(0, b.vx)];
  else if (b.x > maxX) [b.x, b.vx] = [maxX, Math.min(0, b.vx)];
  if (b.y < -maxY) [b.y, b.vy] = [-maxY, Math.max(0, b.vy)];
  else if (b.y > maxY) [b.y, b.vy] = [maxY, Math.min(0, b.vy)];
}

export interface MoverBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * One step of a player's movement: velocity eases toward `stick × speed` (crawl speed while down), then the body
 * moves and slides along obstacles. Depends only on the body, the stick, `down`, `dt` and the static map: no other
 * player, zombie or barrel ever pushes a player. That is what lets the client replay it exactly for its own player
 * (prediction). Steps longer than a tick are split, so any `dt` gives the server's answer for the same inputs.
 */
export function movePlayer(body: MoverBody, stick: Vec2, down: boolean, dt: number): void {
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(left, 1 / 30);
    left -= h;
    const speed = down ? DOWN_SPEED : PLAYER_SPEED;
    const k = 1 - Math.exp(-h / PLAYER_ACCEL_TAU);
    body.vx += (stick.x * speed - body.vx) * k;
    body.vy += (stick.y * speed - body.vy) * k;
    if (Math.abs(body.vx) < 1e-4 && stick.x === 0) body.vx = 0;
    if (Math.abs(body.vy) < 1e-4 && stick.y === 0) body.vy = 0;
    body.x += body.vx * h;
    body.y += body.vy * h;
    resolveCircle(body, PLAYER_RADIUS);
  }
}
