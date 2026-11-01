import {
  ColliderGrid,
  pushCircleOutOfAabb,
  pushCircleOutOfCircle,
  type Aabb,
  type Circle,
  type Push,
} from './geometry.ts';
import { PROP_BOUNDS, type PropName } from './props.gen.ts';
import { Rng } from './rng.ts';
import {
  GOO_RADIUS,
  GOO_SLOW,
  PLAYER_ACCEL_TAU,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  ZONE_INNER,
  ZONE_MIDDLE,
} from './tuning.ts';
import type { Vec2 } from './vec.ts';

/**
 * The town of Northdale: 6 × 6 blocks on a grid of streets, 276 units across (a minute's run), shared by the rules
 * (colliders, loot spots, spawn points, the safehouse) and the client (which draws exactly these placements). Built
 * once at module load from the hand-written layout below and a fixed seed, so server and client agree to the last
 * traffic cone.
 *
 *            0          1          2          3          4          5        ← block columns (west → east)
 *      ┌──────────────────────────── highway ═══ NORTHDALE gantry (x 0) ═══ ────────────────────────┐
 *   0  │ buildings  buildings  N. lot     buildings  buildings  buildings                            │
 *   1  │ PIPE WORKS buildings  buildings  bldg ╲      ╱ bldg    CONTAINER YARD                       │
 *   2  │ buildings  buildings  buildings  bldg ╱ JUNC ╲ bldg    buildings                            │
 *   3  │ buildings  W. lot     SAFEHOUSE  buildings  buildings  buildings                            │
 *   4  │ buildings  buildings  buildings  S. lot     BACK ALLEYS buildings                           │
 *   5  │ WATER TOWER buildings buildings  buildings  buildings  buildings                            │
 *      └─────────── every other street end is walled off with containers ─────────────────────────────┘
 *
 * Streets ("corridors") are 12 wide: an 8-wide road of the pack's street tiles and a 2-wide sidewalk either side.
 * Blocks are 32 × 32: dark building boxes (impassable) or open lots and landmarks you can walk into. The Junction is
 * the crossing of street 4 (x 44) and street 2 (y -44), its four corner buildings cut back into a 32 × 32 plaza.
 * Loot quality and zombie density rise with distance from the safehouse (zones: inner < 62, middle < 118, outer).
 */

export const TOWN_HALF = 138;
export const CORRIDOR = 12;
export const STREET = 8;
export const SIDEWALK = 2;
export const BLOCK = 32;
export const PITCH = BLOCK + CORRIDOR;
export const BLOCKS = 6;
/** Centre line of street `i` (0…6), x for the north–south streets, y for the east–west ones. */
export const corridorCenter = (i: number) => -TOWN_HALF + CORRIDOR / 2 + i * PITCH;
/** West (or north) edge of block column (or row) `i` (0…5). */
export const blockMin = (i: number) => -TOWN_HALF + CORRIDOR + i * PITCH;

/**
 * B buildings · J buildings cut back at the Junction · L open lot · S safehouse · C container yard · W water tower lot
 * · P pipe works · A back alleys.
 */
export type BlockType = 'B' | 'J' | 'L' | 'S' | 'C' | 'W' | 'P' | 'A';
export const LAYOUT: readonly string[] = ['BBLBBB', 'PBBJJC', 'BBBJJB', 'BLSBBB', 'BBBLAB', 'WBBBBB'];
export const blockType = (i: number, j: number): BlockType => LAYOUT[j]![i]! as BlockType;

/** The Junction: the crossing at street 4 / street 2, a 32 × 32 plaza. */
export const JUNCTION = { x: corridorCenter(4), y: corridorCenter(2), cut: 10 };
export const PLAZA: Aabb = {
  x0: JUNCTION.x - CORRIDOR / 2 - JUNCTION.cut,
  y0: JUNCTION.y - CORRIDOR / 2 - JUNCTION.cut,
  x1: JUNCTION.x + CORRIDOR / 2 + JUNCTION.cut,
  y1: JUNCTION.y + CORRIDOR / 2 + JUNCTION.cut,
};

export const rectOf = (i: number, j: number): Aabb => ({
  x0: blockMin(i),
  y0: blockMin(j),
  x1: blockMin(i) + BLOCK,
  y1: blockMin(j) + BLOCK,
});

// ---- what the town is made of ------------------------------------------------------------------------------------

export interface Building extends Aabb {
  /** Roof height. */
  h: number;
  /** Block index (j × 6 + i) and which half of it (0 north, 1 south): the client lowers a row in front of you. */
  block: number;
  row: 0 | 1;
  /** Seed for its windows (lit or dark). */
  seed: number;
}

/** A prop of the pack placed in the town (the client draws it; the rules collide with some). */
export interface Placement {
  prop: PropName;
  x: number;
  y: number;
  /** Yaw about the vertical (radians, PlayCanvas' convention: +z turns toward +x). */
  yaw: number;
  /** Lifted this far (stacked containers, pallets). */
  h?: number;
  /** Outside the town or flat: drawn only. */
  decor?: boolean;
  /** Collider override: a circle of this radius at the placement (poles, barrels) instead of the rotated bounds. */
  r?: number;
  /** Posts at the corners of the footprint instead of a box (the water tower stands on legs). */
  legs?: boolean;
}

export type LootKind = 'chest' | 'special' | 'search';

/** Something you open or search: a chest, a special chest, a trash bag, a wreck, a couch. */
export interface LootSpot {
  id: number;
  x: number;
  y: number;
  kind: LootKind;
  zone: 0 | 1 | 2;
  /** The placement drawn for it (index into `PLACEMENTS`). */
  placement: number;
}

/** A barricade socket in a safehouse opening: 3 wide, across the opening. */
export interface Socket extends Aabb {
  x: number;
  y: number;
  /** Along x (north and south openings) or along y. */
  horizontal: boolean;
}

/** A street sign painted on the road: an arrow toward the safehouse (night navigation). */
export interface Arrow {
  x: number;
  y: number;
  /** Direction it points (radians, sim axes: 0 = +x east, π/2 = +y south). */
  angle: number;
}

/** A flat ground patch the client paints (lots, the plaza, the safehouse yard). */
export interface Ground extends Aabb {
  kind: 'asphalt' | 'concrete' | 'dirt' | 'plaza';
}

// ---- generation --------------------------------------------------------------------------------------------------

const rng = new Rng(0x6e6f7274); // "nort": the town's fixed seed
const buildings: Building[] = [];
const placements: Placement[] = [];
const loot: LootSpot[] = [];
const grounds: Ground[] = [];
const decorBuildings: Building[] = [];
/** Extra static colliders that are not props: safehouse walls. */
const walls: (Aabb & { h: number })[] = [];

const zoneOf = (x: number, y: number): 0 | 1 | 2 => {
  const d = Math.hypot(x - SAFE_CENTER.x, y - SAFE_CENTER.y);
  return d < ZONE_INNER ? 0 : d < ZONE_MIDDLE ? 1 : 2;
};

function place(p: Placement): number {
  placements.push(p);
  return placements.length - 1;
}

function lootAt(kind: LootKind, p: Placement): void {
  const placement = place(p);
  loot.push({ id: loot.length, x: p.x, y: p.y, kind, zone: zoneOf(p.x, p.y), placement });
}

/** Split a rectangle into building footprints (1–2 cuts along the long side), heights 6–15. */
function addBuildings(r: Aabb, block: number, centerY: number, minH: number, maxH: number, depth = 0): void {
  const w = r.x1 - r.x0;
  const d = r.y1 - r.y0;
  if (depth < 2 && Math.max(w, d) > 13 && (depth === 0 || rng.next() < 0.7)) {
    const k = rng.range(0.38, 0.62);
    if (w >= d) {
      const x = Math.round((r.x0 + w * k) * 2) / 2;
      addBuildings({ ...r, x1: x }, block, centerY, minH, maxH, depth + 1);
      addBuildings({ ...r, x0: x }, block, centerY, minH, maxH, depth + 1);
    } else {
      const y = Math.round((r.y0 + d * k) * 2) / 2;
      addBuildings({ ...r, y1: y }, block, centerY, minH, maxH, depth + 1);
      addBuildings({ ...r, y0: y }, block, centerY, minH, maxH, depth + 1);
    }
    return;
  }
  const h = Math.round(rng.range(minH, maxH) * 2) / 2;
  const row: 0 | 1 = (r.y0 + r.y1) / 2 < centerY ? 0 : 1;
  buildings.push({ ...r, h, block, row, seed: rng.int(1 << 30) });
}

/** A building block: the whole rectangle, or (J) the rectangle minus the corner toward the Junction. */
function buildingBlock(i: number, j: number, type: BlockType): void {
  const r = rectOf(i, j);
  const cy = (r.y0 + r.y1) / 2;
  const block = j * BLOCKS + i;
  // Taller toward the middle of town: the skyline rises behind the safehouse.
  const central = 1 - Math.min(1, Math.hypot(i - 2.5, j - 2.5) / 3.6);
  const minH = 6 + central * 3;
  const maxH = 11 + central * 5;
  if (type !== 'J') {
    // Split north / south first, so each building belongs to one row.
    addBuildings({ ...r, y1: cy }, block, cy, minH, maxH, 1);
    addBuildings({ ...r, y0: cy }, block, cy, minH, maxH, 1);
    return;
  }
  const c = JUNCTION.cut;
  const east = JUNCTION.x > r.x1;
  const south = JUNCTION.y > r.y1;
  // The part away from the plaza (full width), and the part next to it (minus the cut corner).
  const far: Aabb = south ? { ...r, y1: r.y1 - c } : { ...r, y0: r.y0 + c };
  const near: Aabb = south
    ? { y0: r.y1 - c, y1: r.y1, x0: east ? r.x0 : r.x0 + c, x1: east ? r.x1 - c : r.x1 }
    : { y0: r.y0, y1: r.y0 + c, x0: east ? r.x0 : r.x0 + c, x1: east ? r.x1 - c : r.x1 };
  addBuildings(far, block, cy, minH, maxH, 1);
  addBuildings(near, block, cy, minH, maxH, 2);
}

// ---- the safehouse -------------------------------------------------------------------------------------------------

const SAFE_I = 2;
const SAFE_J = 3;
const safeRect = rectOf(SAFE_I, SAFE_J);
/** The safehouse lot: a walled yard with an opening (two barricade sockets) in the middle of each side. */
export const SAFE: Aabb = {
  x0: safeRect.x0 + 0.4,
  y0: safeRect.y0 + 0.4,
  x1: safeRect.x1 - 0.4,
  y1: safeRect.y1 - 0.4,
};
export const SAFE_CENTER: Vec2 = { x: (SAFE.x0 + SAFE.x1) / 2, y: (SAFE.y0 + SAFE.y1) / 2 };
const WALL = 0.6;
const OPENING = 6;
const WALL_H = 1.3;
const sockets: Socket[] = [];

function safehouse(): void {
  const { x0, y0, x1, y1 } = SAFE;
  const cx = SAFE_CENTER.x;
  const cy = SAFE_CENTER.y;
  const half = OPENING / 2;
  // North and south walls (along x) and west and east walls (along y), each broken by its opening.
  for (const [ya, yb] of [
    [y0, y0 + WALL],
    [y1 - WALL, y1],
  ] as const) {
    walls.push({ x0, y0: ya, x1: cx - half, y1: yb, h: WALL_H });
    walls.push({ x0: cx + half, y0: ya, x1, y1: yb, h: WALL_H });
    for (const s of [-1, 1]) {
      const sx = cx + (s * half) / 2;
      const sy = (ya + yb) / 2;
      sockets.push({ x: sx, y: sy, horizontal: true, x0: sx - 1.5, x1: sx + 1.5, y0: sy - 0.45, y1: sy + 0.45 });
    }
  }
  for (const [xa, xb] of [
    [x0, x0 + WALL],
    [x1 - WALL, x1],
  ] as const) {
    walls.push({ x0: xa, y0: y0 + WALL, x1: xb, y1: cy - half, h: WALL_H });
    walls.push({ x0: xa, y0: cy + half, x1: xb, y1: y1 - WALL, h: WALL_H });
    for (const s of [-1, 1]) {
      const sy = cy + (s * half) / 2;
      const sx = (xa + xb) / 2;
      sockets.push({ x: sx, y: sy, horizontal: false, x0: sx - 0.45, x1: sx + 0.45, y0: sy - 1.5, y1: sy + 1.5 });
    }
  }
  grounds.push({ ...SAFE, kind: 'concrete' });
  // Cover and dressing inside: two containers along the walls, barrels, pallets, a couch, a lamp.
  place({ prop: 'Container_Green', x: x0 + 2.2, y: cy - 8.5, yaw: Math.PI / 2 });
  place({ prop: 'Container_Red', x: x1 - 2.2, y: cy + 8.5, yaw: Math.PI / 2 });
  place({ prop: 'Container_Red', x: x1 - 2.2, y: cy + 8.5, yaw: Math.PI / 2, h: 2.56, decor: true });
  place({ prop: 'Barrel', x: x0 + 1.6, y: y1 - 1.8, yaw: 0, r: 0.36 });
  place({ prop: 'Barrel', x: x0 + 2.5, y: y1 - 1.5, yaw: 1, r: 0.36 });
  place({ prop: 'Pallet', x: x1 - 2, y: y0 + 2, yaw: 0.3, decor: true });
  place({ prop: 'Pallet', x: x1 - 2, y: y0 + 2, yaw: 0.5, h: 0.14, decor: true });
  place({ prop: 'Wheels_Stack', x: x0 + 1.6, y: y0 + 1.6, yaw: 0, r: 0.35 });
  place({ prop: 'Couch', x: cx + 7, y: y0 + 1.6, yaw: Math.PI, decor: false });
  place({ prop: 'StreetLights', x: cx - 6, y: cy - 1, yaw: Math.PI / 2, r: 0.22 });
  lootAt('chest', { prop: 'Chest', x: cx + 4, y: y1 - 1.6, yaw: Math.PI });
}

/** The armored truck the survivors repair: parked inside the safehouse, facing north. */
export const TRUCK = { x: SAFE_CENTER.x + 1, y: SAFE_CENTER.y + 6, yaw: Math.PI };
/** Survivors spawn here (and come back here at dawn). */
export const SPAWNS: readonly Vec2[] = [
  { x: SAFE_CENTER.x - 4, y: SAFE_CENTER.y - 5 },
  { x: SAFE_CENTER.x + 3, y: SAFE_CENTER.y - 5 },
  { x: SAFE_CENTER.x - 4, y: SAFE_CENTER.y - 1 },
  { x: SAFE_CENTER.x + 3, y: SAFE_CENTER.y - 1 },
];

// ---- landmarks -----------------------------------------------------------------------------------------------------

/** Where the truck parts lie at the start of a run: wheels at the Junction and the Container Yard, fuel at the Pipe Works. */
export const PART_SPOTS: { item: 'wheel' | 'fuel'; x: number; y: number }[] = [];
/** The stray dog waits here (the Back Alleys). */
export const DOG_SPOT: Vec2 = { x: 0, y: 0 };

function containerYard(i: number, j: number): void {
  const r = rectOf(i, j);
  grounds.push({ ...r, kind: 'concrete' });
  const at = (dx: number, dy: number) => ({ x: r.x0 + dx, y: r.y0 + dy });
  const cont = (dx: number, dy: number, vertical: boolean, red: boolean, stack = false) => {
    const p = at(dx, dy);
    const prop: PropName = red ? 'Container_Red' : 'Container_Green';
    const yaw = vertical ? Math.PI / 2 : 0;
    place({ prop, x: p.x, y: p.y, yaw });
    if (stack) place({ prop: red ? 'Container_Green' : 'Container_Red', x: p.x, y: p.y, yaw, h: 2.56, decor: true });
  };
  // A maze of rows and stacks with 2.5–4 wide paths; the way in is from the west and south streets.
  cont(4, 3, false, true, true);
  cont(10, 3, false, false);
  cont(22, 3, false, true, true);
  cont(28, 3, false, false, true);
  cont(4.5, 12, true, false);
  cont(13, 9.5, false, true);
  cont(16, 15, true, false, true);
  cont(25, 10, false, false);
  cont(29.5, 16, true, true, true);
  cont(8, 21, false, true, true);
  cont(21, 21.5, false, true);
  cont(13, 27, true, false);
  cont(25, 28.5, false, false, true);
  place({ prop: 'Wheels_Stack', ...at(9.5, 15.5), yaw: 0.4, r: 0.35 });
  place({ prop: 'Wheels_Stack', ...at(26.5, 23.5), yaw: 1.2, r: 0.35 });
  place({ prop: 'Barrel', ...at(19, 6.2), yaw: 0, r: 0.36 });
  place({ prop: 'Pallet_Broken', ...at(5, 28), yaw: 0.7, decor: true });
  place({ prop: 'TrafficCone_2', ...at(1.6, 17), yaw: 0, r: 0.3 });
  lootAt('special', { prop: 'Chest_Special', ...at(20.5, 15.5), yaw: -Math.PI / 2 });
  lootAt('chest', { prop: 'Chest', ...at(8.5, 7.2), yaw: 0 });
  lootAt('chest', { prop: 'Chest', ...at(28, 22.5), yaw: Math.PI });
  PART_SPOTS.push({ item: 'wheel', ...at(17, 25) });
}

function waterTowerLot(i: number, j: number): void {
  const r = rectOf(i, j);
  grounds.push({ ...r, kind: 'dirt' });
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  // The tower stands on four legs: you can walk under it, to the rare chest.
  place({ prop: 'WaterTower', x: cx, y: cy - 2, yaw: 0, legs: true });
  lootAt('special', { prop: 'Chest_Special', x: cx, y: cy - 2, yaw: 0.25 });
  place({ prop: 'Vehicle_Pickup', x: cx - 9, y: cy + 8, yaw: 2.4 });
  place({ prop: 'Pallet', x: cx + 7, y: cy - 9, yaw: 0, decor: true });
  place({ prop: 'Pallet', x: cx + 7, y: cy - 9, yaw: 0.2, h: 0.14, decor: true });
  place({ prop: 'Pallet', x: cx + 8.4, y: cy - 9, yaw: 0, decor: true });
  place({ prop: 'Barrel', x: cx + 9, y: cy + 6, yaw: 0, r: 0.36 });
  place({ prop: 'Barrel', x: cx + 9.8, y: cy + 6.8, yaw: 0, r: 0.36 });
  place({ prop: 'TrafficBarrier_1', x: cx - 4, y: cy + 12, yaw: 0.2 });
  place({ prop: 'TrafficCone_1', x: cx - 11, y: cy - 10, yaw: 0, r: 0.26 });
  place({ prop: 'TrafficCone_1', x: cx - 10, y: cy - 11.5, yaw: 0, r: 0.26 });
  lootAt('chest', { prop: 'Chest', x: cx + 11, y: cy - 4, yaw: -Math.PI / 2 });
  lootAt('search', { prop: 'Vehicle_Sports', x: cx + 4, y: cy + 10, yaw: -0.6 });
  lootAt('search', { prop: 'TrashBag_2', x: cx - 13, y: cy + 1, yaw: 1 });
}

function pipeWorks(i: number, j: number): void {
  const r = rectOf(i, j);
  grounds.push({ ...r, kind: 'concrete' });
  const at = (dx: number, dy: number) => ({ x: r.x0 + dx, y: r.y0 + dy });
  // Stacks of pipes (three wide, some two high) with lanes between them, pallets, and barrels everywhere.
  const pipes = (dx: number, dy: number, along: boolean, high: boolean) => {
    for (let k = -1; k <= 1; k++) {
      const p = along ? at(dx + k * 0.75, dy) : at(dx, dy + k * 0.75);
      place({ prop: 'Pipes', ...p, yaw: along ? 0 : Math.PI / 2 });
      if (high && k < 1) {
        const q = along ? at(dx + (k + 0.5) * 0.75, dy) : at(dx, dy + (k + 0.5) * 0.75);
        place({ prop: 'Pipes', ...q, yaw: along ? 0 : Math.PI / 2, h: 0.62, decor: true });
      }
    }
  };
  pipes(5, 6, true, true);
  pipes(12, 6, true, false);
  pipes(24, 5, false, true);
  pipes(6, 17, false, false);
  pipes(18, 15, true, true);
  pipes(27, 16, true, false);
  pipes(9, 26, false, true);
  pipes(24, 26, false, false);
  for (const [dx, dy] of [
    [15, 22],
    [16.2, 22.3],
    [15.5, 23.2],
    [3, 11],
    [3.8, 11.8],
    [29, 9],
    [28.2, 9.6],
    [20, 28.5],
  ] as const) {
    place({ prop: 'Barrel', ...at(dx, dy), yaw: dx, r: 0.36 });
  }
  for (const [dx, dy, n] of [
    [19, 9, 3],
    [11, 21, 2],
    [29, 22, 4],
  ] as const) {
    for (let k = 0; k < n; k++) place({ prop: 'Pallet', ...at(dx, dy), yaw: k * 0.15, h: k * 0.14, decor: k > 0 });
  }
  lootAt('special', { prop: 'Chest_Special', ...at(18.5, 19.5), yaw: 0 });
  lootAt('chest', { prop: 'Chest', ...at(2.5, 28.5), yaw: Math.PI / 2 });
  PART_SPOTS.push({ item: 'fuel', ...at(11, 12.5) });
  PART_SPOTS.push({ item: 'fuel', ...at(22, 21) });
}

function backAlleys(i: number, j: number): void {
  const r = rectOf(i, j);
  const block = j * BLOCKS + i;
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const a = 2.5; // half an alley
  grounds.push({ x0: r.x0, y0: cy - a, x1: r.x1, y1: cy + a, kind: 'asphalt' });
  grounds.push({ x0: cx - a, y0: r.y0, x1: cx + a, y1: r.y1, kind: 'asphalt' });
  for (const [x0, x1] of [
    [r.x0, cx - a],
    [cx + a, r.x1],
  ] as const) {
    for (const [y0, y1, row] of [
      [r.y0, cy - a, 0],
      [cy + a, r.y1, 1],
    ] as const) {
      buildings.push({ x0, y0, x1, y1, h: Math.round(rng.range(6, 9) * 2) / 2, block, row, seed: rng.int(1 << 30) });
    }
  }
  // Trash bags and couches along the walls, a dumpster-ish container, and the dog at the crossing of the alleys.
  for (const [x, y, prop, yaw, search] of [
    [cx - 6, cy - a + 0.5, 'TrashBag_2', 0.2, true],
    [cx - 8.5, cy - a + 0.4, 'TrashBag_1', 0, false],
    [cx + 9, cy + a - 0.5, 'TrashBag_2', 2.8, true],
    [cx + 7, cy + a - 0.4, 'TrashBag_1', 1, false],
    [cx - a + 0.5, cy + 9, 'TrashBag_2', 1.6, true],
    [cx + a - 0.5, cy - 10, 'TrashBag_2', -1.4, false],
    [cx + a - 0.4, cy - 8.4, 'TrashBag_1', 0, true],
    [cx - a + 0.4, cy - 12, 'TrashBag_1', 0, false],
  ] as const) {
    const p: Placement = { prop, x, y, yaw, decor: true };
    if (search) lootAt('search', p);
    else place(p);
  }
  lootAt('search', { prop: 'Couch', x: cx - 11, y: cy + a - 0.75, yaw: Math.PI });
  lootAt('search', { prop: 'Couch', x: cx + a - 0.75, y: cy + 11.5, yaw: -Math.PI / 2 });
  place({ prop: 'Wheels_Stack', x: cx + 12.5, y: cy - a + 0.6, yaw: 0.5, r: 0.35 });
  lootAt('chest', { prop: 'Chest', x: cx - a + 0.6, y: cy - 6, yaw: Math.PI / 2 });
  place({ prop: 'Blood_2', x: cx + 1, y: cy + 3, yaw: 0.8, decor: true });
  DOG_SPOT.x = cx + 0.4;
  DOG_SPOT.y = cy + 7.5;
}

/** Wrecks (searchable), cones and chests on an open lot. */
function openLot(i: number, j: number): void {
  const r = rectOf(i, j);
  grounds.push({ ...r, kind: 'asphalt' });
  const cars: PropName[] = ['Vehicle_Sports', 'Vehicle_Pickup', 'Vehicle_Truck', 'Vehicle_Sports_Armored'];
  // Parking rows: cars nose in along two lines, some missing, some skewed.
  for (const [row, yaw] of [
    [r.y0 + 6, 0],
    [r.y1 - 6, Math.PI],
  ] as const) {
    for (let k = 0; k < 5; k++) {
      if (rng.next() < 0.45) continue;
      const x = r.x0 + 4 + k * 6;
      const prop = cars[rng.int(cars.length)]!;
      const p: Placement = { prop, x, y: row, yaw: yaw + rng.range(-0.25, 0.25) };
      if (rng.next() < 0.6) lootAt('search', p);
      else place(p);
    }
  }
  place({ prop: 'StreetLights', x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, yaw: rng.range(0, 6), r: 0.22 });
  for (let k = 0; k < 4; k++) {
    place({
      prop: 'TrafficCone_1',
      x: rng.range(r.x0 + 3, r.x1 - 3),
      y: rng.range(r.y0 + 12, r.y1 - 12),
      yaw: 0,
      r: 0.26,
    });
  }
  lootAt('chest', { prop: 'Chest', x: r.x0 + 1.5, y: (r.y0 + r.y1) / 2 + rng.range(-4, 4), yaw: Math.PI / 2 });
  lootAt('chest', { prop: 'Chest', x: r.x1 - 1.5, y: (r.y0 + r.y1) / 2 + rng.range(-4, 4), yaw: -Math.PI / 2 });
  place({ prop: 'Blood_1', x: rng.range(r.x0 + 5, r.x1 - 5), y: (r.y0 + r.y1) / 2, yaw: rng.range(0, 6), decor: true });
}

function junction(): void {
  const { x, y } = JUNCTION;
  grounds.push({ ...PLAZA, kind: 'plaza' });
  // Wrecks piled across the crossing, traffic lights at the corners, cones and barriers, a wheel to take home.
  for (const [dx, dy, prop, yaw, search] of [
    [-3.5, -2.5, 'Vehicle_Sports', 0.6, true],
    [3, 1.5, 'Vehicle_Truck', 2.0, true],
    [-1, 5.5, 'Vehicle_Pickup', -1.2, false],
    [8.5, -8, 'Vehicle_Sports_Armored', 0.3, true],
    [-9, 9, 'Vehicle_Pickup_Armored', -0.5, false],
  ] as const) {
    const p: Placement = { prop, x: x + dx, y: y + dy, yaw };
    if (search) lootAt('search', p);
    else place(p);
  }
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const px = x + sx * 6.6;
    const py = y + sy * 6.6;
    // TrafficLight_2's long arm reaches along -x over the road: turn it toward the crossing.
    place({ prop: 'TrafficLight_2', x: px, y: py, yaw: Math.atan2(-sy, sx), r: 0.22 });
  }
  for (const [dx, dy] of [
    [-6, 3],
    [-5.2, 3.8],
    [5, -4],
    [6, -4.6],
    [0.5, -8],
    [10, 4],
    [-10, -6],
  ] as const) {
    place({ prop: 'TrafficCone_2', x: x + dx, y: y + dy, yaw: dx, r: 0.3 });
  }
  place({ prop: 'TrafficBarrier_1', x: x - 8, y: y - 1, yaw: Math.PI / 2 });
  place({ prop: 'TrafficBarrier_2', x: x + 9, y: y + 9.5, yaw: 0.3 });
  place({ prop: 'PlasticBarrier', x: x + 1, y: y - 11, yaw: 0 });
  place({ prop: 'Wheels_Stack', x: x + 12, y: y - 12, yaw: 0, r: 0.35 });
  place({ prop: 'Blood_3', x: x - 2, y: y + 1, yaw: 1, decor: true });
  place({ prop: 'Blood_1', x: x + 6, y: y + 7, yaw: 2, decor: true });
  lootAt('chest', { prop: 'Chest', x: x - 12.5, y: y - 12, yaw: Math.PI / 4 });
  lootAt('chest', { prop: 'Chest', x: x + 12.5, y: y + 12.5, yaw: -Math.PI * 0.75 });
  PART_SPOTS.push({ item: 'wheel', x: x + 11.5, y: y - 9.5 });
}

// ---- streets -------------------------------------------------------------------------------------------------------

/** Every street-end in the town walled off (containers), and the barricaded highway exit. */
export const GANTRY: Vec2 = { x: corridorCenter(3), y: -TOWN_HALF - 5 };

function inPlaza(x: number, y: number, margin = 0): boolean {
  return x > PLAZA.x0 - margin && x < PLAZA.x1 + margin && y > PLAZA.y0 - margin && y < PLAZA.y1 + margin;
}

function streets(): void {
  const cars: PropName[] = ['Vehicle_Sports', 'Vehicle_Pickup', 'Vehicle_Truck', 'Vehicle_Sports_Armored'];
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i <= BLOCKS; i++) {
      const c = corridorCenter(i);
      for (let k = 0; k < BLOCKS; k++) {
        const a = blockMin(k);
        const b = a + BLOCK;
        // `along` runs the length of the segment; `across` = c ± offset. Sim point for (along, across):
        const pt = (along: number, across: number): Vec2 =>
          axis === 0 ? { x: across, y: along } : { x: along, y: across };
        const mid = pt((a + b) / 2, c);
        if (inPlaza(mid.x, mid.y)) continue;
        // Yaw of something pointing across the street, toward +across (vertical streets: +x; horizontal: +y).
        const acrossYaw = axis === 0 ? Math.PI / 2 : 0;
        // Street lights at a quarter and three quarters, on alternate sidewalks, their arm over the road.
        for (let q = 0; q < 2; q++) {
          const side = (k + q + i) % 2 === 0 ? -1 : 1;
          const p = pt(a + BLOCK * (q === 0 ? 0.25 : 0.75), c + side * (STREET / 2 + 1.1));
          place({ prop: 'StreetLights', ...p, yaw: side < 0 ? acrossYaw : acrossYaw + Math.PI, r: 0.2 });
        }
        if (rng.next() < 0.3) {
          const side = rng.next() < 0.5 ? -1 : 1;
          place({
            prop: 'FireHydrant',
            ...pt(rng.range(a + 3, b - 3), c + side * (STREET / 2 + 0.7)),
            yaw: 0,
            r: 0.24,
          });
        }
        // Trash against the building line (one of them searchable).
        const n = rng.int(3);
        for (let t = 0; t < n; t++) {
          const side = rng.next() < 0.5 ? -1 : 1;
          const p = pt(rng.range(a + 2, b - 2), c + side * (CORRIDOR / 2 - 0.4));
          const prop: PropName = rng.next() < 0.5 ? 'TrashBag_1' : 'TrashBag_2';
          const spot: Placement = { prop, ...p, yaw: rng.range(0, 6.28), decor: true };
          if (t === 0 && rng.next() < 0.7) lootAt('search', spot);
          else place(spot);
        }
        // A wreck on the road, skewed (searchable), sometimes with cones around it.
        if (rng.next() < 0.38) {
          const along = rng.range(a + 6, b - 6);
          const across = c + rng.range(-1.6, 1.6);
          const prop = cars[rng.int(cars.length)]!;
          const roadYaw = axis === 0 ? 0 : Math.PI / 2;
          const spot: Placement = {
            prop,
            ...pt(along, across),
            yaw: roadYaw + rng.range(-0.5, 0.5) + (rng.next() < 0.5 ? Math.PI : 0),
          };
          if (rng.next() < 0.75) lootAt('search', spot);
          else place(spot);
          if (rng.next() < 0.4) {
            for (let t = 0; t < 3; t++) {
              place({
                prop: 'TrafficCone_1',
                ...pt(along + rng.range(-4, 4), c + rng.range(-3.5, 3.5)),
                yaw: 0,
                r: 0.26,
              });
            }
          }
        }
        // A chest on the sidewalk against a building (not next to the safehouse: it has its own).
        if (rng.next() < 0.16) {
          const side = rng.next() < 0.5 ? -1 : 1;
          const p = pt(rng.range(a + 4, b - 4), c + side * (CORRIDOR / 2 - 0.45));
          if (Math.hypot(p.x - SAFE_CENTER.x, p.y - SAFE_CENTER.y) > 30) {
            lootAt('chest', { prop: 'Chest', ...p, yaw: acrossYaw + (side < 0 ? 0 : Math.PI) });
          }
        }
        if (rng.next() < 0.14) {
          place({
            prop: ('Blood_' + (1 + rng.int(3))) as PropName,
            ...pt(rng.range(a + 3, b - 3), c + rng.range(-3, 3)),
            yaw: rng.range(0, 6),
            decor: true,
          });
        }
      }
    }
  }
  // Traffic lights at a few crossings (a pole on one corner).
  for (let j = 1; j < BLOCKS; j++) {
    for (let i = 1; i < BLOCKS; i++) {
      const x = corridorCenter(i);
      const y = corridorCenter(j);
      if (inPlaza(x, y) || rng.next() > 0.35) continue;
      const sx = rng.next() < 0.5 ? -1 : 1;
      const sy = rng.next() < 0.5 ? -1 : 1;
      place({
        prop: 'TrafficLight_1',
        x: x + sx * 5.2,
        y: y + sy * 5.2,
        yaw: Math.atan2(-sx, -sy) - Math.PI / 4,
        r: 0.2,
      });
    }
  }
}

/** Containers across every street-end at the edge of town, and the barricaded highway with the gantry. */
function perimeter(): void {
  const e = TOWN_HALF + 1.4;
  for (let i = 1; i < BLOCKS; i++) {
    const c = corridorCenter(i);
    for (const side of [-1, 1]) {
      // East and west ends of street i (horizontal), north and south ends (vertical).
      for (const vertical of [false, true]) {
        if (vertical && side < 0 && i === 3) continue; // the highway
        for (let k = 0; k < 2; k++) {
          const off = (k === 0 ? -1 : 1) * 2.95;
          const red = (i + k + (vertical ? 1 : 0)) % 2 === 0;
          const prop: PropName = red ? 'Container_Red' : 'Container_Green';
          const p = vertical ? { x: c + off, y: side * e } : { x: side * e, y: c + off };
          place({ prop, ...p, yaw: vertical ? 0 : Math.PI / 2, decor: true });
          if ((i + k) % 3 === 0)
            place({
              prop: red ? 'Container_Green' : 'Container_Red',
              ...p,
              yaw: vertical ? 0.05 : Math.PI / 2 - 0.05,
              h: 2.56,
              decor: true,
            });
        }
      }
    }
  }
  // The highway north: the road on, the gantry over it, barricades across until the escape.
  const hx = GANTRY.x;
  for (let k = 0; k < 7; k++) place({ prop: 'Street_Straight', x: hx, y: -TOWN_HALF - 4 - k * 8, yaw: 0, decor: true });
  place({ prop: 'TownSign', x: hx + 4.6, y: GANTRY.y, yaw: 0, decor: true });
  for (const [dx, prop] of [
    [-3.2, 'TrafficBarrier_1'],
    [-1.1, 'PlasticBarrier'],
    [0.6, 'TrafficBarrier_1'],
    [2.7, 'TrafficBarrier_1'],
  ] as const) {
    place({ prop, x: hx + dx, y: -TOWN_HALF - 1, yaw: 0, decor: true });
  }
  place({ prop: 'TrafficCone_2', x: hx - 4.8, y: -TOWN_HALF - 2, yaw: 0, decor: true });
  place({ prop: 'TrafficCone_2', x: hx + 4.6, y: -TOWN_HALF - 1.6, yaw: 0, decor: true });
  // Water towers beyond the corners, over the skyline.
  place({ prop: 'WaterTower', x: -TOWN_HALF - 9, y: TOWN_HALF + 10, yaw: 0.4, decor: true });
  place({ prop: 'WaterTower', x: TOWN_HALF + 11, y: -TOWN_HALF - 8, yaw: 1.1, decor: true });
  // The skyline: tall dark blocks all round the town (drawn only).
  const band = (x0: number, y0: number, x1: number, y1: number) => {
    const horizontal = x1 - x0 > y1 - y0;
    let at = horizontal ? x0 : y0;
    const end = horizontal ? x1 : y1;
    while (at < end - 2) {
      const w = Math.min(end - at, rng.range(9, 18));
      const depth = rng.range(10, 18);
      const h = rng.range(13, 30);
      const b: Building = horizontal
        ? {
            x0: at,
            x1: at + w,
            y0: y0 < 0 ? y1 - depth : y0,
            y1: y0 < 0 ? y1 : y0 + depth,
            h,
            block: -1,
            row: 0,
            seed: rng.int(1 << 30),
          }
        : {
            y0: at,
            y1: at + w,
            x0: x0 < 0 ? x1 - depth : x0,
            x1: x0 < 0 ? x1 : x0 + depth,
            h,
            block: -1,
            row: 0,
            seed: rng.int(1 << 30),
          };
      // The highway runs north between the blocks.
      if (!(horizontal && y0 < 0 && b.x1 > hx - 9 && b.x0 < hx + 9)) decorBuildings.push(b);
      at += w + rng.range(0, 1.5);
    }
  };
  const o = TOWN_HALF + 4;
  band(-o - 20, -o - 20, o + 20, -o);
  band(-o - 20, o, o + 20, o + 20);
  band(-o - 20, -o, -o, o);
  band(o, -o, o + 20, o);
}

// ---- build ------------------------------------------------------------------------------------------------------

for (let j = 0; j < BLOCKS; j++) {
  for (let i = 0; i < BLOCKS; i++) {
    const type = blockType(i, j);
    switch (type) {
      case 'B':
      case 'J':
        buildingBlock(i, j, type);
        break;
      case 'S':
        safehouse();
        break;
      case 'C':
        containerYard(i, j);
        break;
      case 'W':
        waterTowerLot(i, j);
        break;
      case 'P':
        pipeWorks(i, j);
        break;
      case 'A':
        backAlleys(i, j);
        break;
      case 'L':
        openLot(i, j);
        break;
    }
  }
}
junction();
streets();
perimeter();

export const BUILDINGS: readonly Building[] = buildings;
/** The skyline around the town (drawn only). */
export const SKYLINE: readonly Building[] = decorBuildings;
export const PLACEMENTS: readonly Placement[] = placements;
export const LOOT_SPOTS: readonly LootSpot[] = loot;
export const SOCKETS: readonly Socket[] = sockets;
export const SAFE_WALLS: readonly (Aabb & { h: number })[] = walls;
export const GROUNDS: readonly Ground[] = grounds;
export const zone = zoneOf;

// ---- colliders -------------------------------------------------------------------------------------------------------

/** A placement's footprint corners in the sim plane (its bounds turned by its yaw). */
export function footprint(p: Placement): Vec2[] {
  const [x0, z0, x1, z1] = PROP_BOUNDS[p.prop];
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ].map(([x, z]) => ({ x: p.x + x! * c + z! * s, y: p.y - x! * s + z! * c }));
}

/** Props with no collider (flat, tiny, or walked through). */
const WALK_THROUGH = new Set<PropName>([
  'Street_4Way',
  'Street_Straight',
  'Street_Straight_Crack1',
  'Street_Straight_Crack2',
  'Street_T',
  'Street_Turn',
  'Blood_1',
  'Blood_2',
  'Blood_3',
  'Pallet',
  'Pallet_Broken',
  'TrashBag_1',
  'TrashBag_2',
  'CinderBlock',
  'Wheel',
]);

function buildColliders(): { boxes: Aabb[]; circles: Circle[] } {
  const boxes: Aabb[] = buildings.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
  const circles: Circle[] = [];
  for (const w of walls) boxes.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
  // The truck (drawn by the client with its repair state, not a placement).
  const t = footprint({ prop: 'Vehicle_Truck_Armored', x: TRUCK.x, y: TRUCK.y, yaw: TRUCK.yaw });
  boxes.push({
    x0: Math.min(...t.map((q) => q.x)) + 0.1,
    y0: Math.min(...t.map((q) => q.y)) + 0.1,
    x1: Math.max(...t.map((q) => q.x)) - 0.1,
    y1: Math.max(...t.map((q) => q.y)) - 0.1,
  });
  for (const p of placements) {
    if (p.decor || WALK_THROUGH.has(p.prop) || (p.h ?? 0) > 0) continue;
    if (p.r !== undefined) {
      circles.push({ x: p.x, y: p.y, r: p.r });
      continue;
    }
    const pts = footprint(p);
    if (p.legs) {
      // Legs a little inside the footprint's corners.
      for (const q of pts) circles.push({ x: p.x + (q.x - p.x) * 0.82, y: p.y + (q.y - p.y) * 0.82, r: 0.2 });
      continue;
    }
    // A skewed prop collides with the box around its turned footprint, trimmed a little (cars are rounded).
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    const skew = Math.abs(Math.sin(2 * p.yaw)) > 0.2 ? 0.25 : 0.05;
    boxes.push({
      x0: Math.min(...xs) + skew,
      y0: Math.min(...ys) + skew,
      x1: Math.max(...xs) - skew,
      y1: Math.max(...ys) - skew,
    });
  }
  return { boxes, circles };
}

const built = buildColliders();
/** Static boxes (buildings, walls, props): they stop survivors, zombies and bullets. */
export const OBSTACLES: readonly Aabb[] = built.boxes;
/** Static circles (poles, barrels, the water tower's legs): the same. */
export const POSTS: readonly Circle[] = built.circles;

/** Everything static, by grid cell (movement, rays and lines of sight look up only what is near). */
export const GRID = new ColliderGrid(TOWN_HALF + 2, 8);
for (const b of OBSTACLES) GRID.addBox(b);
for (const c of POSTS) GRID.addCircle(c);

/** Whether a circle sits inside the town and clear of every static collider. */
export function circleIsFree(x: number, y: number, r: number): boolean {
  if (Math.abs(x) > TOWN_HALF - r || Math.abs(y) > TOWN_HALF - r) return false;
  const { boxes, circles } = GRID.query(x - r, y - r, x + r, y + r);
  const p = { x, y };
  for (const b of boxes) if (pushCircleOutOfAabb({ ...p }, r, b)) return false;
  for (const c of circles) if (pushCircleOutOfCircle({ ...p }, r, c)) return false;
  return true;
}

const push: Push = { nx: 0, ny: 0 };

/**
 * Push a moving circle out of the static colliders and `extra` boxes (barricades, for zombies) and back inside the
 * town, dropping the part of its velocity that points into what it hit (it slides along walls). Two passes settle
 * corners. Returns the index of an `extra` box it touched (or -1).
 */
export function resolveCircle(
  b: { x: number; y: number; vx: number; vy: number },
  r: number,
  extra: readonly Aabb[] = [],
): number {
  let touched = -1;
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
    const { boxes, circles } = GRID.query(b.x - r - 0.5, b.y - r - 0.5, b.x + r + 0.5, b.y + r + 0.5);
    for (const o of boxes) if (pushCircleOutOfAabb(b, r, o, push)) slide();
    for (const c of circles) if (pushCircleOutOfCircle(b, r, c, push)) slide();
    for (let k = 0; k < extra.length; k++) {
      if (pushCircleOutOfAabb(b, r, extra[k]!, push)) {
        slide();
        touched = k;
      }
    }
    if (!moved) break;
  }
  const m = TOWN_HALF - r;
  if (b.x < -m) [b.x, b.vx] = [-m, Math.max(0, b.vx)];
  else if (b.x > m) [b.x, b.vx] = [m, Math.min(0, b.vx)];
  if (b.y < -m) [b.y, b.vy] = [-m, Math.max(0, b.vy)];
  else if (b.y > m) [b.y, b.vy] = [m, Math.min(0, b.vy)];
  return touched;
}

export interface MoverBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** The speed factor at a point wading through goo pools (`goo`: centres). */
export function gooFactor(x: number, y: number, goo: readonly Vec2[]): number {
  for (const g of goo) if ((g.x - x) ** 2 + (g.y - y) ** 2 < GOO_RADIUS * GOO_RADIUS) return GOO_SLOW;
  return 1;
}

/**
 * One step of a survivor's movement: velocity eases toward `stick × PLAYER_SPEED × speed` (slower in goo), then the
 * body moves and slides along the town's static colliders. Depends only on the body, the stick, the speed multiplier
 * (carrying, crawling), the goo pools and `dt`: zombies never push a survivor and barricades let survivors through.
 * That is what lets the client replay it exactly for its own survivor (prediction). Steps longer than a tick are
 * split, so any `dt` gives the server's answer for the same inputs.
 */
export function movePlayer(body: MoverBody, stick: Vec2, speed: number, goo: readonly Vec2[], dt: number): void {
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(left, 1 / 30);
    left -= h;
    const top = PLAYER_SPEED * speed * (goo.length ? gooFactor(body.x, body.y, goo) : 1);
    const k = 1 - Math.exp(-h / PLAYER_ACCEL_TAU);
    body.vx += (stick.x * top - body.vx) * k;
    body.vy += (stick.y * top - body.vy) * k;
    if (Math.abs(body.vx) < 1e-4 && stick.x === 0) body.vx = 0;
    if (Math.abs(body.vy) < 1e-4 && stick.y === 0) body.vy = 0;
    body.x += body.vx * h;
    body.y += body.vy * h;
    resolveCircle(body, PLAYER_RADIUS);
  }
}

// ---- spawn points, navigation ---------------------------------------------------------------------------------------

/** A point on a road or in an open lot where a zombie can appear, with its zone. */
export interface StreetPoint extends Vec2 {
  zone: 0 | 1 | 2;
  /** Distance from the safehouse centre (hordes come from the outskirts first). */
  out: number;
}

function streetPoints(): StreetPoint[] {
  const out: StreetPoint[] = [];
  const add = (x: number, y: number) => {
    if (x > SAFE.x0 - 2 && x < SAFE.x1 + 2 && y > SAFE.y0 - 2 && y < SAFE.y1 + 2) return;
    if (!circleIsFree(x, y, 0.7)) return;
    out.push({ x, y, zone: zoneOf(x, y), out: Math.hypot(x - SAFE_CENTER.x, y - SAFE_CENTER.y) });
  };
  for (let i = 0; i <= BLOCKS; i++) {
    const c = corridorCenter(i);
    for (let t = -TOWN_HALF + 3; t <= TOWN_HALF - 3; t += 4) {
      add(c - 1.5, t);
      add(t, c + 1.5);
    }
  }
  for (let j = 0; j < BLOCKS; j++) {
    for (let i = 0; i < BLOCKS; i++) {
      const t = blockType(i, j);
      if (t === 'B' || t === 'J' || t === 'S') continue;
      const r = rectOf(i, j);
      for (let y = r.y0 + 3; y < r.y1 - 2; y += 5) for (let x = r.x0 + 3; x < r.x1 - 2; x += 5) add(x, y);
    }
  }
  return out;
}

/** Every place a zombie may appear (roads, lots, alleys; never in the safehouse). */
export const STREET_POINTS: readonly StreetPoint[] = streetPoints();

/**
 * Arrows painted on the road at every crossing, pointing along the shortest street route to the safehouse (a
 * breadth-first search over the crossings), and into the safehouse from the four streets around it.
 */
function arrows(): Arrow[] {
  const n = BLOCKS + 1;
  const dist = new Int32Array(n * n).fill(-1);
  const queue: number[] = [];
  // The four crossings around the safehouse block.
  for (const [i, j] of [
    [SAFE_I, SAFE_J],
    [SAFE_I + 1, SAFE_J],
    [SAFE_I, SAFE_J + 1],
    [SAFE_I + 1, SAFE_J + 1],
  ] as const) {
    dist[j * n + i] = 0;
    queue.push(j * n + i);
  }
  while (queue.length) {
    const k = queue.shift()!;
    const i = k % n;
    const j = (k - i) / n;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n || dist[b * n + a]! >= 0) continue;
      dist[b * n + a] = dist[k]! + 1;
      queue.push(b * n + a);
    }
  }
  const out: Arrow[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const d = dist[j * n + i]!;
      const x = corridorCenter(i);
      const y = corridorCenter(j);
      if (d === 0) {
        // Toward the safehouse opening on the street between this crossing and the next.
        const ox = i === SAFE_I ? 1 : -1;
        const oy = j === SAFE_J ? 1 : -1;
        out.push({ x: x + ox * 9, y: y + 1.6, angle: Math.atan2(0, ox) });
        out.push({ x: x - 1.6, y: y + oy * 9, angle: Math.atan2(oy, 0) });
        continue;
      }
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= n || b >= n || dist[b * n + a] !== d - 1) continue;
        out.push({ x: x + di * 8.5 + dj * 1.6, y: y + dj * 8.5 - di * 1.6, angle: Math.atan2(dj, di) });
        break;
      }
    }
  }
  return out;
}

export const ARROWS: readonly Arrow[] = arrows();
