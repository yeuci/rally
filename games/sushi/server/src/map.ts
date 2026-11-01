import { PLAYER_ACCEL_TAU, PLAYER_RADIUS, PLAYER_SPEED } from './constants.ts';
import {
  pushCircleOutOfAabb,
  pushCircleOutOfCircle,
  pushCircleOutOfStadium,
  type Aabb,
  type Circle,
  type Push,
  type Stadium,
} from './geometry.ts';
import { Kind } from './recipes.ts';
import type { PropName } from './props.gen.ts';
import type { Vec2 } from './vec.ts';

/**
 * The restaurant. Sim axes: x right, y toward the camera (the kitchen is at the back, y < 0; the dining floor and the
 * door at the front). Sketch (one character ≈ 1 unit; see the README for the full map):
 *
 *            x = -12.5      -8                                 0                                8          14
 *   y = -6        ┌ alley ─┬─ fridge │ crates×8 │ sink │ rice ▪ │ oven+pan │ pots │ steamer ▪ ──┬─ dining ─┐
 *                 │ (Sat)  │                    back aisle                                       │  (Wed)   │
 *   y = -3     drop▪  door ▏      │ crates×3 │ board ▪ │ mat ▪ │ plates ▪ │ bin                  ║ table    │
 *                 │ truck  │                    front aisle (the pass)                           ║ table    │
 *   y =  0.4      │        │     ( ═════ the kaiten belt, an oval bar the chefs can't cross ═════ )║ table    │
 *                 │        │     stools ○ ○ ○ ○ ○ ○ ○  (more around the curves)                    ║ (shoji)  │
 *   y =  5.6      └────────┴───────────────────────── door ───────────────────────────────────────┴──────────┘
 *                                    terrace (Sun): two tables, the torii gate, sakura
 *
 * The bar sits in the middle with open ends, so a chef can always walk round it (no dead ends) to the stools to bus
 * dishes; the crates are at the left, the cooking at the right next to the dining room, the board, mat and plates in
 * the middle. Zones open with the week: the dining room on Wednesday (the shoji screens slide away), the alley and its
 * delivery truck on Saturday (the back door opens), the festival terrace on Sunday (the front opens).
 */

/** Zones beyond the bar and kitchen (a bitmask; the main room is always open). */
export const Zone = { dining: 1, alley: 2, terrace: 4 } as const;
export type ZoneBit = (typeof Zone)[keyof typeof Zone];

/** The zones open on a day (1 = Monday). */
export function zonesOn(day: number): number {
  return (day >= 3 ? Zone.dining : 0) | (day >= 6 ? Zone.alley : 0) | (day >= 7 ? Zone.terrace : 0);
}

/** The area each zone covers (camera framing on the client; the bots' grid). */
export const AREAS = {
  main: { x0: -8, y0: -6, x1: 8, y1: 5.6 },
  dining: { x0: 8, y0: -6, x1: 14, y1: 5.6 },
  alley: { x0: -12.5, y0: -6, x1: -8, y1: 2.5 },
  terrace: { x0: -6, y0: 5.6, x1: 6, y1: 9.6 },
} as const satisfies Record<string, Aabb>;

/** The open floor's bounds for a zone mask. */
export function openBounds(zones: number): Aabb {
  const b: Aabb = { ...AREAS.main };
  if (zones & Zone.dining) b.x1 = AREAS.dining.x1;
  if (zones & Zone.alley) b.x0 = AREAS.alley.x0;
  if (zones & Zone.terrace) b.y1 = AREAS.terrace.y1;
  return b;
}

// --- counters and the belt -----------------------------------------------------------------------------------------
/** Counter depth (the pack's 0.864) and the y of the back counter's and the island's middle lines. */
export const COUNTER_DEPTH = 0.864;
export const BACK_Y = -6 + COUNTER_DEPTH / 2;
export const ISLAND_Y = -3.0;
export const ISLAND_X0 = -5;
export const ISLAND_X1 = 3;
/** Counter top height (stations' items sit on it). */
export const COUNTER_TOP = 0.95;

/**
 * The kaiten belt: a stadium-shaped loop (two straights of 2 × BELT_HL, two half circles of BELT_R) round the bar's
 * middle. Plates ride it clockwise on screen: left to right along the kitchen side (the pass), right to left past the
 * stools at the front. The bar (BAR_R from the core line) is solid.
 */
export const BELT = { cx: -0.4, cy: 0.4, hl: 3.6, r: 1.3 } as const;
export const BAR_R = 1.62;
/** Height of the belt's surface (plates sit on it). */
export const BELT_TOP = 0.98;
export const BELT_LENGTH = 4 * BELT.hl + 2 * Math.PI * BELT.r;

/** World position (and heading, radians) of the point `s` units along the belt from the pass's left end. */
export function beltPoint(s: number, out: { x: number; y: number; a: number } = { x: 0, y: 0, a: 0 }) {
  const { cx, cy, hl, r } = BELT;
  const straight = 2 * hl;
  const arc = Math.PI * r;
  let t = ((s % BELT_LENGTH) + BELT_LENGTH) % BELT_LENGTH;
  if (t < straight) {
    out.x = cx - hl + t;
    out.y = cy - r;
    out.a = 0;
    return out;
  }
  t -= straight;
  if (t < arc) {
    const a = -Math.PI / 2 + t / r;
    out.x = cx + hl + Math.cos(a) * r;
    out.y = cy + Math.sin(a) * r;
    out.a = a + Math.PI / 2;
    return out;
  }
  t -= arc;
  if (t < straight) {
    out.x = cx + hl - t;
    out.y = cy + r;
    out.a = Math.PI;
    return out;
  }
  t -= straight;
  const a = Math.PI / 2 + t / r;
  out.x = cx - hl + Math.cos(a) * r;
  out.y = cy + Math.sin(a) * r;
  out.a = a + Math.PI / 2;
  return out;
}

/** The belt position nearest to (x, y). */
export function beltProject(x: number, y: number): number {
  const { cx, cy, hl, r } = BELT;
  const straight = 2 * hl;
  const arc = Math.PI * r;
  if (x >= cx - hl && x <= cx + hl) {
    // Over a straight: the kitchen side or the front.
    return y < cy ? x - (cx - hl) : straight + arc + (cx + hl - x);
  }
  if (x > cx + hl) {
    const a = Math.atan2(y - cy, x - (cx + hl)); // -π/2 … π/2
    return straight + (Math.max(-Math.PI / 2, Math.min(Math.PI / 2, a)) + Math.PI / 2) * r;
  }
  let a = Math.atan2(y - cy, x - (cx - hl)); // π/2 … 3π/2 (mapped)
  if (a < 0) a += 2 * Math.PI;
  return 2 * straight + arc + (Math.max(Math.PI / 2, Math.min((3 * Math.PI) / 2, a)) - Math.PI / 2) * r;
}

/** The bar as a collider. */
export const BAR: Stadium = { x0: BELT.cx - BELT.hl, x1: BELT.cx + BELT.hl, y: BELT.cy, r: BAR_R };

// --- stations --------------------------------------------------------------------------------------------------------
export type StationType =
  'counter' | 'crate' | 'board' | 'mat' | 'rice' | 'pot' | 'steamer' | 'pan' | 'plates' | 'bin' | 'sink' | 'drop';

export interface StationDef {
  id: number;
  type: StationType;
  /** Interaction point: the middle of the counter top (or the bin, the drop pallet). */
  x: number;
  y: number;
  /** The zone it belongs to (0: the main room, always open). */
  zone: number;
  /** Crates: the ingredient. */
  crate?: Kind;
  /** Pots: the dish they cook. */
  dish?: Kind;
  /** A counter spot that becomes a second board / mat with that upgrade. */
  upgrade?: 'board2' | 'mat2';
}

const S = (type: StationType, x: number, y: number, extra: Partial<StationDef> = {}) => ({
  type,
  x,
  y,
  zone: 0,
  ...extra,
});

/** Crates on the back counter, 0.5 apart: four per counter. */
const crate = (k: Kind, x: number, y = BACK_Y) => S('crate', x, y, { crate: k });

export const STATIONS: readonly StationDef[] = [
  // The back counter, left to right: crates, the sink, the rice pot, the stove (the gyoza pan), the noodle pots, the
  // steamer, two spare counter tops.
  crate(Kind.SalmonFish, -5.75),
  crate(Kind.Tuna, -5.25),
  crate(Kind.Nori, -4.75),
  crate(Kind.Cucumber, -4.25),
  crate(Kind.Octopus, -3.75),
  crate(Kind.Ebi, -3.25),
  crate(Kind.SeaUrchin, -2.75),
  crate(Kind.Eel, -2.25),
  S('sink', -1.0, BACK_Y),
  S('rice', 0.6, BACK_Y, { dish: Kind.Rice }),
  S('counter', 1.45, BACK_Y),
  S('pan', 3.0, BACK_Y),
  S('pot', 4.55, BACK_Y, { dish: Kind.Ramen }),
  S('pot', 5.45, BACK_Y, { dish: Kind.Udon }),
  S('steamer', 6.55, BACK_Y, { dish: Kind.Chukaman }),
  S('counter', 7.45, BACK_Y),
  // The island: three crates, the cutting board, the rolling mat, the plate stack; two spots become a second board and
  // a second mat with the upgrades; the bin stands at its right end.
  crate(Kind.GyozaRaw, -4.6, ISLAND_Y),
  crate(Kind.Crabsticks, -4.0, ISLAND_Y),
  crate(Kind.Avocado, -3.4, ISLAND_Y),
  S('board', -2.5, ISLAND_Y),
  S('counter', -1.5, ISLAND_Y, { upgrade: 'board2' }),
  S('mat', -0.5, ISLAND_Y),
  S('counter', 0.5, ISLAND_Y, { upgrade: 'mat2' }),
  S('plates', 1.5, ISLAND_Y),
  S('counter', 2.5, ISLAND_Y),
  S('bin', 3.5, ISLAND_Y),
  // The alley (Saturday on): the truck's boxes wait on a pallet outside the back door.
  S('drop', -9.3, -3.0, { zone: Zone.alley }),
].map((s, id) => ({ id, ...s }));

export const stationsOfType = (type: StationType) => STATIONS.filter((s) => s.type === type);
export const BIN_RADIUS = 0.32;

// --- seats --------------------------------------------------------------------------------------------------------
export interface SeatDef {
  id: number;
  kind: 'stool' | 'table';
  x: number;
  y: number;
  /** The direction the customer faces once seated (radians, sim axes). */
  face: number;
  zone: number;
  /** Stools: the order they open in as the crew grows (0 first). */
  rank: number;
  /** Stools: where along the belt they reach for plates. */
  grab: number;
  /** Tables: which table (for drawing and for "full house"). */
  table: number;
  /** Where served and dirty dishes sit (on the bar's rim, on the table). */
  dish: Vec2;
  /** Waypoints from the front door to the seat (the seat itself last). */
  path: readonly Vec2[];
}

/** The front door (inside), where customers come from (outside), and Sunday's way in through the terrace. */
export const DOOR: Vec2 = { x: 0, y: 5.2 };
export const STREET: Vec2 = { x: 0, y: 7.0 };
export const FESTIVAL_GATE: Vec2 = { x: 0, y: 10.4 };

const STOOL_R = BAR_R + 0.45;
/** Dining room and terrace tables (centre); each has a chair on its left and right. */
export const TABLES: readonly { x: number; y: number; zone: number }[] = [
  { x: 11, y: -3.4, zone: Zone.dining },
  { x: 11, y: -0.4, zone: Zone.dining },
  { x: 11, y: 2.6, zone: Zone.dining },
  { x: -3.0, y: 7.6, zone: Zone.terrace },
  { x: 3.0, y: 7.6, zone: Zone.terrace },
];
export const TABLE_HALF = 0.55;
export const CHAIR_OFFSET = 0.85;

function buildSeats(): SeatDef[] {
  const seats: Omit<SeatDef, 'id'>[] = [];
  const { cx, cy, hl } = BELT;
  // The front straight: seven stools, the middle ones open first.
  const frontRank = [5, 3, 1, 0, 2, 4, 6];
  for (let i = 0; i < 7; i++) {
    const x = cx + (i - 3) * 1.15;
    const y = cy + STOOL_R;
    seats.push({
      kind: 'stool',
      x,
      y,
      face: -Math.PI / 2,
      zone: 0,
      rank: frontRank[i]!,
      grab: beltProject(x, cy + BELT.r),
      table: -1,
      dish: { x, y: cy + BELT.r + 0.28 },
      path: [
        { x, y: 3.6 },
        { x, y: y + 0.5 },
        { x, y },
      ],
    });
  }
  // Round the curves: three each side, from the front toward the ends (the last pair only with extra seating).
  const curve = [
    [Math.PI * 0.64, 7],
    [Math.PI * 0.36, 8],
    [Math.PI * 0.84, 9],
    [Math.PI * 0.16, 10],
    [Math.PI, 11],
    [0, 12],
  ] as const;
  for (const [a, rank] of curve) {
    const left = Math.cos(a) < -1e-6 || a === Math.PI;
    const ccx = left ? cx - hl : cx + hl;
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    const x = ccx + nx * STOOL_R;
    const y = cy + ny * STOOL_R;
    seats.push({
      kind: 'stool',
      x,
      y,
      face: Math.atan2(-ny, -nx),
      zone: 0,
      rank,
      grab: beltProject(ccx + nx * BELT.r, cy + ny * BELT.r),
      table: -1,
      dish: { x: ccx + nx * (BELT.r + 0.28), y: cy + ny * (BELT.r + 0.28) },
      path: [
        { x: x + nx * 0.55, y: 3.6 },
        { x: x + nx * 0.55, y: y + ny * 0.55 },
        { x, y },
      ],
    });
  }
  // Tables: a chair each side.
  TABLES.forEach((t, ti) => {
    for (const side of [-1, 1]) {
      const x = t.x + side * CHAIR_OFFSET;
      const terrace = t.zone === Zone.terrace;
      const lane = t.x + side * (CHAIR_OFFSET + 0.75);
      const path: Vec2[] = terrace
        ? [
            { x: lane, y: 8.8 },
            { x: lane, y: t.y },
            { x, y: t.y },
          ]
        : [
            { x: 7.6, y: 4.3 },
            { x: lane, y: 4.3 },
            { x: lane, y: t.y },
            { x, y: t.y },
          ];
      seats.push({
        kind: 'table',
        x,
        y: t.y,
        face: side < 0 ? 0 : Math.PI,
        zone: t.zone,
        rank: 0,
        grab: 0,
        table: ti,
        dish: { x: t.x + side * 0.28, y: t.y },
        path,
      });
    }
  });
  return seats.map((s, id) => ({ id, ...s }));
}

export const SEATS: readonly SeatDef[] = buildSeats();
export const STOOLS = SEATS.filter((s) => s.kind === 'stool');
export const TABLE_SEATS = SEATS.filter((s) => s.kind === 'table');

/** The stools open for `count` (lowest rank first). */
export function openStools(count: number): SeatDef[] {
  return STOOLS.filter((s) => s.rank < count);
}

// --- colliders ------------------------------------------------------------------------------------------------------
interface WallSpec extends Aabb {
  /** Present only while this zone is closed. */
  unless?: number;
  /** Present only while this zone is open. */
  when?: number;
}

const T = 1; // wall thickness (they are outside the floor)
const WALLS: readonly WallSpec[] = [
  // The back wall, all along.
  { x0: -14, y0: -6 - T, x1: 15, y1: -6 },
  // The main room's left wall, with the back door (y -4…-2) into the alley.
  { x0: -8 - T, y0: -6, x1: -8, y1: -4 },
  { x0: -8 - T, y0: -4, x1: -8, y1: -2, unless: Zone.alley },
  { x0: -8 - T, y0: -2, x1: -8, y1: 5.6 + T },
  // The shoji screens to the dining room (slide away on Wednesday).
  { x0: 8, y0: -6, x1: 8 + T, y1: 5.6 + T, unless: Zone.dining },
  // The front: closed for chefs (customers come and go by the door) until the terrace opens.
  { x0: -8, y0: 5.6, x1: 8, y1: 5.6 + T, unless: Zone.terrace },
  { x0: -8, y0: 5.6, x1: -6, y1: 5.6 + T, when: Zone.terrace },
  { x0: 6, y0: 5.6, x1: 8, y1: 5.6 + T, when: Zone.terrace },
  // The dining room's own walls.
  { x0: 14, y0: -6, x1: 14 + T, y1: 5.6 + T, when: Zone.dining },
  { x0: 8, y0: 5.6, x1: 14, y1: 5.6 + T, when: Zone.dining },
  // The alley's fence.
  { x0: -12.5 - T, y0: -6, x1: -12.5, y1: 2.5 + T, when: Zone.alley },
  { x0: -12.5, y0: 2.5, x1: -8, y1: 2.5 + T, when: Zone.alley },
  // The terrace's edges.
  { x0: -6 - T, y0: 5.6, x1: -6, y1: 9.6 + T, when: Zone.terrace },
  { x0: 6, y0: 5.6, x1: 6 + T, y1: 9.6 + T, when: Zone.terrace },
  { x0: -6, y0: 9.6, x1: 6, y1: 9.6 + T, when: Zone.terrace },
];

/** Counters, appliances and furniture chefs walk round (all zones; the closed ones are walled off anyway). */
const FIXTURES: readonly Aabb[] = [
  // The back counter (the fridge stands a little proud of it at the left).
  { x0: -8, y0: -6, x1: 8, y1: -6 + COUNTER_DEPTH },
  { x0: -8, y0: -6, x1: -6.7, y1: -4.9 },
  // The island.
  { x0: ISLAND_X0, y0: ISLAND_Y - COUNTER_DEPTH / 2, x1: ISLAND_X1, y1: ISLAND_Y + COUNTER_DEPTH / 2 },
  // Dining and terrace tables.
  ...TABLES.map((t) => ({ x0: t.x - TABLE_HALF, y0: t.y - TABLE_HALF, x1: t.x + TABLE_HALF, y1: t.y + TABLE_HALF })),
  // The delivery truck in the alley.
  { x0: -11.7, y0: -0.4, x1: -9.2, y1: 2.5 },
];

/** Round things: the bin, the terrace's sakura trees, the torii posts. */
const POSTS: readonly Circle[] = [
  { x: 3.5, y: ISLAND_Y, r: BIN_RADIUS },
  { x: -5, y: 8.5, r: 0.45 },
  { x: 5, y: 8.5, r: 0.45 },
  { x: -1.25, y: 9.4, r: 0.2 },
  { x: 1.25, y: 9.4, r: 0.2 },
];

export interface Colliders {
  boxes: Aabb[];
  circles: Circle[];
  bar: Stadium;
}

const colliderCache = new Map<number, Colliders>();

/** Everything chefs collide with for a zone mask (cached: it only changes with the days). */
export function collidersFor(zones: number): Colliders {
  let c = colliderCache.get(zones);
  if (!c) {
    const walls = WALLS.filter((w) => !(w.unless && zones & w.unless) && !(w.when && !(zones & w.when)));
    c = { boxes: [...walls, ...FIXTURES], circles: [...POSTS], bar: BAR };
    colliderCache.set(zones, c);
  }
  return c;
}

const push: Push = { nx: 0, ny: 0 };

/** Push a circle out of everything and drop the velocity into what it hit (it slides along). Two passes settle corners. */
export function resolveCircle(b: { x: number; y: number; vx: number; vy: number }, r: number, zones: number): void {
  const c = collidersFor(zones);
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
    for (const o of c.boxes) if (pushCircleOutOfAabb(b, r, o, push)) slide();
    for (const o of c.circles) if (pushCircleOutOfCircle(b, r, o, push)) slide();
    if (pushCircleOutOfStadium(b, r, c.bar, push)) slide();
    if (!moved) break;
  }
  // Belt and braces: never outside the open floor.
  const o = openBounds(zones);
  if (b.x < o.x0 + r) [b.x, b.vx] = [o.x0 + r, Math.max(0, b.vx)];
  else if (b.x > o.x1 - r) [b.x, b.vx] = [o.x1 - r, Math.min(0, b.vx)];
  if (b.y < o.y0 + r) [b.y, b.vy] = [o.y0 + r, Math.max(0, b.vy)];
  else if (b.y > o.y1 - r) [b.y, b.vy] = [o.y1 - r, Math.min(0, b.vy)];
}

/** Whether a chef-sized circle at (x, y) is clear of everything (spawn points, the bots' grid). */
export function isFree(x: number, y: number, zones: number, r = PLAYER_RADIUS): boolean {
  const b = { x, y, vx: 0, vy: 0 };
  resolveCircle(b, r, zones);
  return Math.abs(b.x - x) < 1e-6 && Math.abs(b.y - y) < 1e-6;
}

export interface MoverBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * One step of a chef's movement: velocity eases toward `stick × PLAYER_SPEED × speed`, then the body moves and slides
 * along everything in the open zones. Depends only on the body, the stick, the speed multiplier (the sandals
 * upgrade), the zones and `dt` (chefs never push each other): the client replays it exactly for its own chef.
 */
export function movePlayer(body: MoverBody, stick: Vec2, speed: number, zones: number, dt: number): void {
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
    resolveCircle(body, PLAYER_RADIUS, zones);
  }
}

/** Where chefs (re)appear each morning: the kitchen aisle. */
export const SPAWNS: readonly Vec2[] = [
  { x: -1.5, y: -4.4 },
  { x: 0.5, y: -4.4 },
  { x: -3.5, y: -4.4 },
  { x: 2.5, y: -4.4 },
];

// --- what is drawn ------------------------------------------------------------------------------------------------
export interface Placement {
  prop: PropName;
  x: number;
  y: number;
  /** Yaw in degrees (PlayCanvas: +90 turns the model's front, +z, toward +x). */
  rot?: number;
  /** Height above the floor. */
  h?: number;
  scale?: number;
  /** The zone it belongs to (drawn once the zone opens); 0 = always. */
  zone?: number;
  /** Only while this zone is closed (the shoji screens, the closed back door). */
  unless?: number;
}

/** A wall tile along the back (its face at y = -6), the left (x = -8) or a right wall (x = `at`). */
const backWall = (prop: PropName, x: number, zone = 0): Placement => ({ prop, x, y: -6 + 0.837, zone });
const leftWall = (prop: PropName, y: number, x = -8, zone = 0): Placement => ({
  prop,
  x: x + 0.837,
  y,
  rot: 90,
  zone,
});
const rightWall = (prop: PropName, y: number, at: number, zone = 0): Placement => ({
  prop,
  x: at - 0.837,
  y,
  rot: -90,
  zone,
});
const counter = (prop: PropName, x: number, y = BACK_Y, rot = 0): Placement => ({ prop, x, y, rot });

/**
 * The restaurant's static props (the client batches them per zone). The stations' own props (crates, board, mat, pots,
 * the steamer, the pan, plates, the bin), the stools and tables, the bar and the belt are drawn from STATIONS, SEATS
 * and BELT, since they change state.
 */
export const PLACEMENTS: readonly Placement[] = [
  // Back wall: shoji windows either side, shelves of plates in the middle (as in the pack's preview).
  backWall('Wall_Normal', -7),
  backWall('Wall_Shoji', -5),
  backWall('Wall_Shoji', -3),
  backWall('Wall_Shelves', -1),
  backWall('Wall_Shelves', 1),
  backWall('Wall_Normal', 3),
  backWall('Wall_Shoji', 5),
  backWall('Wall_Shoji', 7),
  // Left wall, with the back door (opens on Saturday).
  leftWall('Wall_Normal', -5),
  { ...leftWall('Wall_Door', -3), unless: Zone.alley },
  leftWall('Wall_Shoji', -1),
  leftWall('Wall_Shoji', 1),
  leftWall('Wall_Shoji', 3),
  leftWall('Wall_Normal', 5),
  // The back counter: the fridge, crate counters, the sink, the stove.
  { prop: 'Fridge', x: -7.33, y: -6 + 0.393, zone: 0 },
  { prop: 'Counter_End', x: -5.73, y: BACK_Y },
  counter('Counter_Doors', -5),
  counter('Counter_Drawers', -3),
  counter('Counter_Sink', -1),
  counter('Counter_Straight', 1),
  // The stove between two end pieces (the oven is narrower than a counter).
  { prop: 'Oven', x: 3.0, y: -6 + 0.349 },
  counter('Counter_End', 3.0),
  counter('Counter_End', 3.0, BACK_Y, 180),
  counter('Counter_Doors', 5),
  counter('Counter_Drawers', 7),
  // The island (its fronts face the bar).
  counter('Counter_Drawers', -4, ISLAND_Y),
  counter('Counter_Straight', -2, ISLAND_Y),
  counter('Counter_Straight', 0, ISLAND_Y),
  counter('Counter_Doors', 2, ISLAND_Y),
  // On the counters and walls: knives, bottles, bamboo, signs, lanterns, paintings.
  { prop: 'KitchenKnives', x: 3.8, y: -5.75, h: COUNTER_TOP },
  { prop: 'Bottles', x: 7.75, y: -5.7, h: COUNTER_TOP },
  { prop: 'Bamboo', x: 1.75, y: -5.8, h: COUNTER_TOP, scale: 0.7 },
  { prop: 'Sign', x: -4, y: -5.95, h: 2.0 },
  { prop: 'Sign', x: 5.5, y: -5.95, h: 2.0 },
  { prop: 'Lantern', x: -7.4, y: -2.2, h: 0, scale: 1.0 },
  { prop: 'Lantern', x: 7.4, y: -2.2, h: 0, scale: 1.0 },
  { prop: 'Plant2', x: -7.4, y: 4.9 },
  { prop: 'Plant2', x: 7.4, y: 4.9 },
  { prop: 'Plant1', x: -7.4, y: 3.6 },
  { prop: 'Painting', x: -7.98, y: 1.4, h: 1.5, rot: 90 },
  { prop: 'WallLight', x: -7.98, y: -0.6, h: 2.1, rot: 90 },
  { prop: 'WallLight', x: -7.98, y: 3.4, h: 2.1, rot: 90 },
  { prop: 'FishDecor', x: 0.2, y: -5.95, h: 2.35 },
  { prop: 'Carpet', x: 0, y: 4.8, rot: 90, scale: 1.0 },
  // The bar's middle: a little garden inside the belt.
  { prop: 'SakuraTree', x: -0.4, y: 0.4, h: 1.0, scale: 0.55 },
  { prop: 'Bamboo', x: -2.6, y: 0.4, h: 1.0, scale: 0.6 },
  { prop: 'Bamboo', x: 1.8, y: 0.4, h: 1.0, scale: 0.6 },
  // The shoji screens to the dining room (slide away on Wednesday).
  ...[-5, -3, -1, 1, 3, 5].map((y) => ({
    prop: 'Wall_Shoji_Interior' as PropName,
    x: 8,
    y,
    rot: 90,
    unless: Zone.dining,
  })),
  // The dining room.
  backWall('Wall_Shoji', 9, Zone.dining),
  backWall('Wall_Shelves', 11, Zone.dining),
  backWall('Wall_Shoji', 13, Zone.dining),
  ...[-5, -3, -1, 1, 3, 5].map((y) => rightWall(y < 0 ? 'Wall_Shoji' : 'Wall_Normal', y, 14, Zone.dining)),
  { prop: 'Painting', x: 13.98, y: 1.5, h: 1.5, rot: -90, zone: Zone.dining },
  { prop: 'PaintingSmall', x: 11, y: -5.95, h: 1.6, zone: Zone.dining },
  { prop: 'Plant2', x: 13.4, y: 4.9, zone: Zone.dining },
  { prop: 'Lantern', x: 13.4, y: -5.3, zone: Zone.dining },
  { prop: 'Sign3', x: 8.4, y: -5.95, h: 2.4, zone: Zone.dining },
  // The alley: a red fence, the truck, the delivery pallet.
  { prop: 'Wall_RedWood', x: -9.1, y: -6.05, zone: Zone.alley },
  { prop: 'Wall_RedWood', x: -11.0, y: -6.05, zone: Zone.alley },
  { prop: 'Wall_RedWood', x: -12.5, y: -5.0, rot: 90, zone: Zone.alley },
  { prop: 'Wall_RedWood', x: -12.5, y: -3.1, rot: 90, zone: Zone.alley },
  { prop: 'Truck', x: -10.5, y: 1.0, zone: Zone.alley },
  { prop: 'WoodenBoard', x: -9.3, y: -3.0, scale: 2.2, zone: Zone.alley },
  // The festival terrace.
  { prop: 'ToriiGate', x: 0, y: 9.4, zone: Zone.terrace },
  { prop: 'SakuraTree', x: -5, y: 8.5, scale: 2.0, zone: Zone.terrace },
  { prop: 'SakuraTree', x: 5, y: 8.5, scale: 2.0, rot: 180, zone: Zone.terrace },
  { prop: 'Lantern', x: -5.6, y: 6.2, zone: Zone.terrace },
  { prop: 'Lantern', x: 5.6, y: 6.2, zone: Zone.terrace },
  { prop: 'Lantern', x: -1.9, y: 9.2, zone: Zone.terrace },
  { prop: 'Lantern', x: 1.9, y: 9.2, zone: Zone.terrace },
];
