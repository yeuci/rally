import {
  ARENA_HALF_H,
  ARENA_HALF_W,
  BARREL_RADIUS,
  PLAYER_ACCEL_TAU,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from './constants.ts';
import { pushCircleOutOfAabb, pushCircleOutOfCircle, type Aabb, type Circle, type Push } from './geometry.ts';
import { PROP_BOUNDS, type PropName } from './props.gen.ts';
import type { Vec2 } from './vec.ts';

/**
 * The one arena, "the Yard": a sunny container yard on grass, 40 × 28 inside a chain-link fence on concrete bases.
 * Built from the kit's props (placements below); each prop's colliders come from its bounds (props.gen.ts, written by
 * the model pipeline) or a hand-fitted shape. Tall props (the two container stacks, the water tower) stand along the
 * north edge, so the tilted camera never loses a player behind them; the middle and south are lanes between
 * containers, a wrecked car and low cover (sandbags, concrete barriers, crates), mirrored left to right.
 */
export type Quarter = 0 | 1 | 2 | 3;

export interface Placement {
  prop: PropName;
  x: number;
  y: number;
  /** Quarter turns about the vertical: yaw = rot × 90° (PlayCanvas' convention, y up). */
  rot?: Quarter;
  /** Paint (sRGB `#rrggbb`) for the prop's paint material (containers): rendering only. */
  paint?: string;
  /** Outside the fence: decoration, no colliders. */
  decor?: boolean;
}

/** A prop's colliders in its own space (sim axes: x, and z as y), before rotation. */
interface Shape {
  boxes?: readonly (readonly [number, number, number, number])[];
  circles?: readonly (readonly [number, number, number])[];
}

/**
 * Hand-fitted colliders where the bounds would be wrong: the container stacks without their overhanging railings, tree
 * trunks (the canopies are above everyone's head), the street light's pole. `null` = walk over it (flat debris).
 */
const SHAPES: Partial<Record<PropName, Shape | null>> = {
  Structure_1: {
    boxes: [
      [-3.97, -2.17, 3.97, 2.17],
      [-5.57, -1.81, -3.97, 1.53],
      [-2.61, 2.08, 3.76, 3.26],
    ],
  },
  Structure_3: {
    boxes: [
      [-3.97, -2.17, 3.97, 2.29],
      [-5.44, -1.69, -3.97, 1.53],
      [-2.61, 2.08, 3.76, 3.26],
    ],
  },
  Tree_1: { circles: [[-0.33, -0.1, 0.55]] },
  Tree_2: { circles: [[0, 0, 0.35]] },
  Tree_3: { circles: [[0.09, 0, 0.45]] },
  Tree_4: { circles: [[0.15, 0, 0.45]] },
  StreetLight: { circles: [[0, 0, 0.3]] },
  GasTank: { circles: [[0, 0, 0.6]] },
  TrafficCone: { circles: [[0, 0, 0.35]] },
  Pallet: null,
  Debris_Pile: null,
  Debris_Papers_1: null,
  Debris_Papers_2: null,
};

/** Where the painted containers get their paint from (the material the kit paints them with). */
export const PAINTABLE: Partial<Record<PropName, string>> = {
  Container_Long: 'Red',
  Container_Small: 'Blue',
};

/** The yard's paints, as in the kit's promo render. */
export const PAINT = { red: '#b8342b', blue: '#2f5fb0', green: '#3f8f3a', yellow: '#e0a21a' } as const;

const fence = (): Placement[] => {
  // Barrier_Large: 4.57 long, the hazard-striped base on its +z side; the stripes face the yard.
  const out: Placement[] = [];
  const W = ARENA_HALF_W + 0.42;
  const H = ARENA_HALF_H + 0.42;
  for (let i = 0; i < 9; i++) {
    const x = -ARENA_HALF_W + 2.22 + i * 4.445;
    out.push({ prop: 'Barrier_Large', x, y: -H, rot: 0, decor: true });
    out.push({ prop: 'Barrier_Large', x, y: H, rot: 2, decor: true });
  }
  for (let i = 0; i < 7; i++) {
    const y = -ARENA_HALF_H + 2 + i * 4;
    out.push({ prop: 'Barrier_Large', x: -W, y, rot: 1, decor: true });
    out.push({ prop: 'Barrier_Large', x: W, y, rot: 3, decor: true });
  }
  return out;
};

export const PLACEMENTS: readonly Placement[] = [
  // North: the container stacks and the water tower.
  { prop: 'Structure_3', x: -11.6, y: -10.9 },
  { prop: 'Structure_1', x: 11.6, y: -10.9, rot: 2 },
  { prop: 'WaterTank_Platform', x: 0, y: -12.2 },
  { prop: 'Barrier_Single', x: -3.6, y: -8.6 },
  { prop: 'Barrier_Single', x: 3.6, y: -8.6 },
  { prop: 'CardboardBoxes_3', x: -2.2, y: -12.6 },
  { prop: 'Crate', x: 2.2, y: -12.8 },
  { prop: 'Crate', x: 2.9, y: -12.0, rot: 1 },
  // The middle: two containers either side of the centre lane, sandbags south of it.
  { prop: 'Container_Long', x: -4.8, y: -3.6, paint: PAINT.red },
  { prop: 'Container_Small', x: 4.3, y: -3.6, paint: PAINT.blue },
  { prop: 'SackTrench', x: 0, y: 2.4 },
  { prop: 'Crate', x: -8.4, y: -4.6 },
  { prop: 'Crate', x: 7.0, y: -2.4, rot: 1 },
  // West and east edges: a green and a yellow container on end.
  { prop: 'Container_Long', x: -17.6, y: -2.2, rot: 1, paint: PAINT.green },
  { prop: 'Container_Long', x: 17.6, y: -2.2, rot: 1, paint: PAINT.yellow },
  { prop: 'CardboardBoxes_4', x: -17.9, y: 2.0 },
  { prop: 'CardboardBoxes_2', x: 18.2, y: 1.6 },
  // The wreck on the west side, sandbags and tyres on the east.
  { prop: 'Debris_BrokenCar', x: -11.4, y: 2.6, rot: 1 },
  { prop: 'SackTrench_Small', x: 11.2, y: 1.8, rot: 1 },
  { prop: 'Debris_Tires', x: 13.0, y: 4.2 },
  // South: two long containers, concrete barriers between them, crates in the corners.
  { prop: 'Container_Long', x: -8.4, y: 8.8, paint: PAINT.blue },
  { prop: 'Container_Long', x: 8.4, y: 8.8, paint: PAINT.yellow },
  { prop: 'Barrier_Single', x: -1.9, y: 9.4 },
  { prop: 'Barrier_Single', x: 1.9, y: 9.4 },
  { prop: 'CardboardBoxes_1', x: -15.4, y: 10.4 },
  { prop: 'Crate', x: -16.4, y: 11.4 },
  { prop: 'Crate', x: 15.8, y: 10.8, rot: 1 },
  { prop: 'SackTrench_Small', x: 15.6, y: 7.4 },
  { prop: 'SackTrench_Small', x: -15.6, y: 6.6 },
  { prop: 'TrafficCone', x: -5.4, y: 7.0 },
  { prop: 'TrafficCone', x: 5.6, y: 6.8 },
  // Flat debris (walked over).
  { prop: 'Pallet', x: 6.0, y: 12.4, rot: 1 },
  { prop: 'Debris_Pile', x: -6.4, y: 4.8 },
  { prop: 'Debris_Papers_1', x: 2.8, y: -6.4 },
  { prop: 'Debris_Papers_2', x: -12.6, y: -5.8 },
  // Street lights inside the corners.
  { prop: 'StreetLight', x: -19.0, y: 13.0, rot: 2 },
  { prop: 'StreetLight', x: 19.0, y: 13.0, rot: 2 },
  ...fence(),
  // Outside the fence: trees, a tank, pipes, a gas tank.
  { prop: 'Tree_1', x: -23.6, y: -12, decor: true },
  { prop: 'Tree_2', x: -24.2, y: -3, decor: true },
  { prop: 'Tree_3', x: -23.8, y: 7, decor: true },
  { prop: 'Tree_4', x: 23.6, y: -9, decor: true },
  { prop: 'Tree_1', x: 24.0, y: 2, decor: true, rot: 2 },
  { prop: 'Tree_2', x: 23.4, y: 11, decor: true },
  { prop: 'Tree_3', x: -14, y: 17.6, decor: true },
  { prop: 'Tree_4', x: 5, y: 17.8, decor: true },
  { prop: 'Tree_2', x: 15, y: 17.4, decor: true },
  { prop: 'Tree_4', x: -6, y: -17.6, decor: true },
  { prop: 'Tree_2', x: 7, y: -17.4, decor: true },
  { prop: 'Tank', x: -4.0, y: 17.8, rot: 2, decor: true },
  { prop: 'Pipes', x: 24.0, y: -2.0, decor: true },
  { prop: 'GasTank', x: 22.8, y: 5.6, decor: true },
  { prop: 'StreetLight', x: -21.6, y: 0, rot: 1, decor: true },
];

/** Exploding barrels: they stand here (and stand again `BARREL_RESPAWN` s after going off). */
export const BARRELS: readonly Vec2[] = [
  { x: -7.4, y: -1.6 },
  { x: 7.4, y: -1.0 },
  { x: -14.2, y: -6.6 },
  { x: 14.2, y: -6.6 },
  { x: -3.6, y: 6.4 },
  { x: 3.6, y: 6.6 },
  { x: -16.6, y: 9.0 },
  { x: 16.4, y: 9.0 },
];

/** Med kits (+`MED_HEAL` HP; back after `MED_RESPAWN` s). */
export const MEDS: readonly Vec2[] = [
  { x: 0, y: -6.8 },
  { x: 0, y: 12.0 },
  { x: -17.8, y: 5.0 },
  { x: 17.8, y: 4.6 },
];

/** Spawn points, spread over the whole yard (respawns pick the one farthest from the living). */
export const SPAWNS: readonly Vec2[] = [
  { x: -18, y: -12 },
  { x: 18, y: -12 },
  { x: -6, y: -11 },
  { x: 6, y: -11 },
  { x: -13.8, y: -4 },
  { x: 13.8, y: -4 },
  { x: 0, y: -1 },
  { x: -7.5, y: 0.5 },
  { x: 7.5, y: 0.5 },
  { x: -18.2, y: 4.2 },
  { x: 18.2, y: 3.4 },
  { x: -12, y: 7 },
  { x: 12, y: 6.4 },
  { x: 0, y: 6.2 },
  { x: -12.5, y: 12.4 },
  { x: 12.5, y: 12.4 },
  { x: -2.5, y: 12.5 },
  { x: 2.5, y: 12.5 },
];

// ---- colliders from the placements ----------------------------------------------------------------------------

/** A prop-space point (x, z) turned by `rot` quarter turns about +y (x' = x cos θ + z sin θ, z' = -x sin θ + z cos θ). */
export function rotateQuarter(x: number, z: number, rot: Quarter): [number, number] {
  switch (rot) {
    case 1:
      return [z, -x];
    case 2:
      return [-x, -z];
    case 3:
      return [-z, x];
    default:
      return [x, z];
  }
}

export interface Obstacle extends Aabb {
  /** Drawn height (rendering hints: lighting the colliders in dev views). */
  height: number;
  prop: PropName;
}

function shapeOf(prop: PropName): Shape | null {
  if (prop in SHAPES) return SHAPES[prop] ?? null;
  const [x0, z0, x1, z1] = PROP_BOUNDS[prop];
  return { boxes: [[x0, z0, x1, z1]] };
}

function buildColliders(): { boxes: Obstacle[]; circles: Circle[] } {
  const boxes: Obstacle[] = [];
  const circles: Circle[] = [];
  for (const p of PLACEMENTS) {
    if (p.decor) continue;
    const shape = shapeOf(p.prop);
    if (!shape) continue;
    const rot = p.rot ?? 0;
    for (const [x0, z0, x1, z1] of shape.boxes ?? []) {
      const [ax, ay] = rotateQuarter(x0, z0, rot);
      const [bx, by] = rotateQuarter(x1, z1, rot);
      boxes.push({
        x0: p.x + Math.min(ax, bx),
        y0: p.y + Math.min(ay, by),
        x1: p.x + Math.max(ax, bx),
        y1: p.y + Math.max(ay, by),
        height: PROP_BOUNDS[p.prop][4],
        prop: p.prop,
      });
    }
    for (const [cx, cz, r] of shape.circles ?? []) {
      const [x, y] = rotateQuarter(cx, cz, rot);
      circles.push({ x: p.x + x, y: p.y + y, r });
    }
  }
  return { boxes, circles };
}

const built = buildColliders();
/** Static boxes: they stop players, bullets and rockets. */
export const OBSTACLES: readonly Obstacle[] = built.boxes;
/** Static circles (tree trunks, poles, cones): the same. */
export const POSTS: readonly Circle[] = built.circles;

/** The fence as four boxes just outside the yard: bullets stop there. */
export const FENCE: readonly Aabb[] = [
  { x0: -ARENA_HALF_W - 2, y0: -ARENA_HALF_H - 2, x1: ARENA_HALF_W + 2, y1: -ARENA_HALF_H },
  { x0: -ARENA_HALF_W - 2, y0: ARENA_HALF_H, x1: ARENA_HALF_W + 2, y1: ARENA_HALF_H + 2 },
  { x0: -ARENA_HALF_W - 2, y0: -ARENA_HALF_H, x1: -ARENA_HALF_W, y1: ARENA_HALF_H },
  { x0: ARENA_HALF_W, y0: -ARENA_HALF_H, x1: ARENA_HALF_W + 2, y1: ARENA_HALF_H },
];

/** What a bullet can hit besides players and barrels. */
export const BULLET_BOXES: readonly Aabb[] = [...OBSTACLES, ...FENCE];

/** Standing barrels as circles (`up`: a bit per entry of `BARRELS`). */
export function barrelCircles(up: number): Circle[] {
  const out: Circle[] = [];
  BARRELS.forEach((b, i) => {
    if (up & (1 << i)) out.push({ x: b.x, y: b.y, r: BARREL_RADIUS });
  });
  return out;
}

export const ALL_BARRELS = (1 << BARRELS.length) - 1;

/** Whether a circle sits inside the fence and clear of every obstacle (spawn checks). */
export function circleIsFree(x: number, y: number, r: number, extra: readonly Circle[] = []): boolean {
  if (Math.abs(x) > ARENA_HALF_W - r || Math.abs(y) > ARENA_HALF_H - r) return false;
  const p = { x, y };
  for (const b of OBSTACLES) if (pushCircleOutOfAabb({ ...p }, r, b)) return false;
  for (const c of [...POSTS, ...extra]) if (pushCircleOutOfCircle({ ...p }, r, c)) return false;
  return true;
}

const push: Push = { nx: 0, ny: 0 };

/**
 * Push a moving circle out of every obstacle, post and `extra` circle (standing barrels) and back inside the fence,
 * and drop the part of its velocity that points into whatever it hit (so it slides along walls). Two passes settle
 * corners.
 */
export function resolveCircle(
  b: { x: number; y: number; vx: number; vy: number },
  r: number,
  extra: readonly Circle[] = [],
): void {
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    const slide = () => {
      moved = true;
      const into = b.vx * push.nx + b.vy * push.ny;
      if (into < 0) {
        b.vx -= into * push.nx;
        b.vy -= into * push.ny;
      }
    };
    for (const o of OBSTACLES) if (pushCircleOutOfAabb(b, r, o, push)) slide();
    for (const c of POSTS) if (pushCircleOutOfCircle(b, r, c, push)) slide();
    for (const c of extra) if (pushCircleOutOfCircle(b, r, c, push)) slide();
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
 * One step of a player's movement: velocity eases toward `stick × PLAYER_SPEED × speed`, then the body moves and
 * slides along obstacles, posts and the standing barrels (`barrels`, a bitmask of `BARRELS`). Depends only on the
 * body, the stick, the speed multiplier (the knife tier runs faster), the barrels and `dt`: other players never push
 * a player. That is what lets the client replay it exactly for its own player (prediction). Steps longer than a tick
 * are split, so any `dt` gives the server's answer for the same inputs.
 */
export function movePlayer(body: MoverBody, stick: Vec2, speed: number, barrels: number, dt: number): void {
  const extra = barrels ? barrelCircles(barrels) : [];
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(left, 1 / 30);
    left -= h;
    const top = PLAYER_SPEED * speed;
    const k = 1 - Math.exp(-h / PLAYER_ACCEL_TAU);
    body.vx += (stick.x * top - body.vx) * k;
    body.vy += (stick.y * top - body.vy) * k;
    if (Math.abs(body.vx) < 1e-4 && stick.x === 0) body.vx = 0;
    if (Math.abs(body.vy) < 1e-4 && stick.y === 0) body.vy = 0;
    body.x += body.vx * h;
    body.y += body.vy * h;
    resolveCircle(body, PLAYER_RADIUS, extra);
  }
}
