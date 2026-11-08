/**
 * Fold's rules, independent of rendering and frame rate.
 *
 * A paper plane flies left to right through an endless house. It has three shapes, and the player refolds it with one
 * thumb: the dart (swipe down) is fast and drops steeply, the glider (swipe up) floats a long way and turns a dive's
 * extra speed into lift, the crane (tap) is slow and climbs a little with every flap. Rooms are side-on boxes, 6 units
 * high, joined by doorways you pass below; inside them are bookshelves to climb over, hanging lamps to duck under,
 * tables to go over or under (kettles on them steam: soggy paper flies heavy), stairwells to glide across, ceiling
 * fans that push down and radiators that lift. Touching the floor is a skid that costs speed; hitting furniture, or
 * dropping into a stairwell, ends the run. Score = distance in metres (1 unit = 1 m); stamps on the way are a side
 * collection.
 *
 * Determinism: fixed 60 Hz ticks from an accumulator; inputs are queued and applied at the next tick; every room is
 * generated from the run's seed and its own index alone, so the same seed builds the same house however it is played
 * (a daily seed and ghost runs need nothing more).
 */

export const TICK = 1 / 60;
/** At most this many ticks per `advance` (a stalled frame slows the game instead of jumping it). */
const MAX_TICKS_PER_ADVANCE = 12;

// --- the house --------------------------------------------------------------------------------------
export const ROOM_H = 6;
/** Doorways: the wall between two rooms comes down to this height. */
export const DOOR_H = 4.2;
export const WALL_T = 0.5;
/** Rooms are kept generated this far ahead of the plane, and dropped this far behind it. */
const KEEP_AHEAD = 48;
const KEEP_BEHIND = 24;

// --- the plane --------------------------------------------------------------------------------------
export type Form = 'dart' | 'glider' | 'crane';
export const FORMS: readonly Form[] = ['dart', 'glider', 'crane'];

export interface FormRules {
  /** Forward speed it settles at (before the run's speed-up), m/s. */
  speed: number;
  /** How fast forward speed moves toward that, m/s². */
  accel: number;
  /** Downward acceleration, m/s². */
  gravity: number;
  /** Fastest sink, m/s. */
  maxFall: number;
}

export const FORM_RULES: Record<Form, FormRules> = {
  dart: { speed: 8.5, accel: 3, gravity: 12, maxFall: 9 },
  glider: { speed: 5.6, accel: 2, gravity: 3, maxFall: 1.3 },
  crane: { speed: 4.2, accel: 4, gravity: 10, maxFall: 4 },
};
/** A crane flap sets the climb rate to this (m/s). */
export const FLAP_SPEED = 4.8;
const FLAP_COOLDOWN = 0.16;
/** Refolding into the glider from a faster shape turns the extra speed into this much lift per m/s (capped). */
const PULL_UP = 0.8;
const PULL_UP_MAX = 4.5;
const MAX_RISE = 6.5;
/** Sliding along the floor slows the plane this much per second; below STALL_SPEED it stops: the run ends. */
const FLOOR_DRAG = 2.5;
const STALL_SPEED = 1.2;
/** Fans push down, radiators lift (m/s²). */
const FAN_PUSH = 9;
const HEAT_LIFT = 10;
/** A fan also lets the plane sink this much faster than its shape normally does (m/s). */
const FAN_SINK = 4;
/** Steam soaks the paper for this long: gravity ×1.5, flaps ×0.75. */
const SOGGY_SECONDS = 3;
/** The plane's collision box (half sizes). */
export const PLANE_HW = 0.34;
export const PLANE_HH = 0.12;
const STAMP_RADIUS = 0.55;
/** Where a run starts, and what counts as distance. */
export const START_X = 2;
const START_Y = 3.2;
/** The run speeds up from ×1 to ×SPEED_MAX over RAMP_METRES. */
const SPEED_MAX = 1.3;
const RAMP_METRES = 1500;

// --- the world's pieces -----------------------------------------------------------------------------
export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export type ObstacleKind = 'doorway' | 'shelf' | 'lamp' | 'table' | 'kettle' | 'radiator' | 'fan';
export interface Obstacle extends Box {
  id: number;
  kind: ObstacleKind;
}
/** Areas that push the plane or soak it. */
export type ZoneKind = 'fan' | 'heat' | 'steam';
export interface Zone extends Box {
  kind: ZoneKind;
}
/** A stairwell: no floor between x0 and x1. */
export interface Pit {
  id: number;
  x0: number;
  x1: number;
}
export interface Stamp {
  id: number;
  x: number;
  y: number;
  taken: boolean;
}
export interface Room {
  index: number;
  x0: number;
  x1: number;
  /** Wallpaper / furniture palette for the renderer (0…ROOM_THEMES-1). */
  theme: number;
  obstacles: Obstacle[];
  zones: Zone[];
  pits: Pit[];
  stamps: Stamp[];
}
export const ROOM_THEMES = 6;

export interface Plane {
  x: number;
  y: number;
  /** Position at the previous tick (renderers interpolate with `alpha`). */
  px: number;
  py: number;
  vx: number;
  vy: number;
  form: Form;
  /** Seconds of sogginess left. */
  soggy: number;
  flapCooldown: number;
  /** Sliding on the floor. */
  grounded: boolean;
}

export type Input = 'dart' | 'glider' | 'flap';
export type CrashCause = ObstacleKind | 'stall' | 'stairwell';

export type SimEvent =
  | { type: 'form'; form: Form; from: Form }
  | { type: 'flap' }
  | { type: 'stamp'; x: number; y: number; total: number }
  | { type: 'room'; index: number }
  | { type: 'soggy' }
  | { type: 'skid' }
  | { type: 'bonk' }
  | { type: 'stairwell'; total: number }
  | { type: 'crash'; cause: CrashCause; x: number; y: number }
  | { type: 'over' };

export type Phase = 'ready' | 'playing' | 'over';

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** How hard the house is at `metres` (0…1). */
export function difficulty(metres: number): number {
  return clamp(metres / RAMP_METRES, 0, 1);
}

/** The run's speed multiplier at `metres`. */
export function speedScale(metres: number): number {
  return lerp(1, SPEED_MAX, difficulty(metres));
}

// --- room generation ----------------------------------------------------------------------------------

type Feature = 'shelf' | 'lamp' | 'table' | 'pit' | 'fan' | 'radiator';

/** Room `index` of the house with `seed`, starting at `x0`. Depends on nothing else. */
export function generateRoom(seed: number, index: number, x0: number): Room {
  const r = rng((Math.imul(seed >>> 0, 2654435761) ^ Math.imul(index + 1, 40503)) >>> 0);
  const room: Room = { index, x0, x1: x0, theme: index % ROOM_THEMES, obstacles: [], zones: [], pits: [], stamps: [] };
  let nextId = index * 1000;
  const id = () => nextId++;
  const add = (kind: ObstacleKind, x0b: number, x1b: number, y0: number, y1: number) =>
    room.obstacles.push({ id: id(), kind, x0: x0b, x1: x1b, y0, y1 });
  const stamp = (x: number, y: number) => room.stamps.push({ id: id(), x, y, taken: false });

  // The doorway into this room (the first room has none: the plane starts inside it).
  if (index > 0) add('doorway', x0, x0 + WALL_T, DOOR_H, ROOM_H);

  if (index === 0) {
    // The first room teaches the three shapes: climb over a shelf (crane), duck under a lamp (dart), glide a stairwell.
    room.x1 = x0 + 40;
    add('shelf', x0 + 12, x0 + 13.3, 0, 3.4);
    stamp(x0 + 12.65, 4.2);
    add('lamp', x0 + 21, x0 + 22, 2.4, ROOM_H);
    stamp(x0 + 21.5, 1.6);
    room.pits.push({ id: id(), x0: x0 + 28, x1: x0 + 33 });
    for (let i = 0; i < 3; i++) stamp(x0 + 29 + i * 1.5, 3 - i * 0.3);
    return room;
  }

  const d = difficulty(x0 - START_X);
  const length = 26 + Math.floor(r() * 10);
  room.x1 = x0 + length;
  const spacingScale = lerp(1.25, 0.85, d);
  let prev: Feature | null = null;
  // The band of heights the plane can be in after the last feature: the doorway into the room leaves it below the
  // door frame. Each feature sets it again (above a shelf, below a lamp, low after a stairwell …).
  let lastEnd = x0 + WALL_T;
  let afterLow = 0;
  let afterHigh = DOOR_H;

  const pick = (): Feature => {
    const weights: [Feature, number][] = [
      ['shelf', 3],
      ['lamp', 3],
      ['table', 2.5],
      ['pit', prev === 'pit' || prev === 'fan' ? 0 : lerp(1, 2, d)],
      ['fan', prev === 'pit' ? 0 : lerp(0.6, 1.6, d)],
      ['radiator', 1],
    ];
    let total = 0;
    for (const [, w] of weights) total += w;
    let t = r() * total;
    for (const [f, w] of weights) {
      t -= w;
      if (t <= 0) return f;
    }
    return 'shelf';
  };

  while (true) {
    const f = pick();
    // The feature's size, the bands it can be passed in ([above, below]: a table has two, over or under) and the band
    // it can leave the plane in (low … high; after a table that is the worst of both sides: as high as its top, as
    // low as its underside).
    let width = 1.3;
    let passes: [number, number][] = [[0, ROOM_H]];
    let low = 0;
    let high = ROOM_H;
    let h = 0;
    let kettle = false;
    if (f === 'shelf') {
      h = lerp(2.6, 4.5, r() * lerp(0.6, 1, d));
      passes = [[h, ROOM_H]];
      low = h;
    } else if (f === 'lamp') {
      width = 1;
      h = lerp(3.2, 1.6, r() * lerp(0.6, 1, d));
      passes = [[0, h]];
      high = h;
    } else if (f === 'table') {
      width = 3.2 + r();
      h = 1.8 + r() * 0.6;
      kettle = r() < 0.45;
      // A kettle's steam makes "over" a bad choice: count the table as under-only.
      passes = kettle
        ? [[0, h]]
        : [
            [0, h],
            [h + 0.22, ROOM_H],
          ];
      low = kettle ? 0 : h + 0.22;
      high = h;
    } else if (f === 'pit') {
      width = (4 + r() * 3) * lerp(0.85, 1.1, d);
      passes = [[2.4, ROOM_H]];
      high = 2.8;
    } else if (f === 'fan') {
      width = 3.2;
      passes = [[0, ROOM_H - 0.9]];
      // It pushes the plane down: expect it low afterwards.
      high = 3.2;
    } else {
      width = 1.4;
      passes = [[1, ROOM_H]];
      // Its heat can lift a glider most of the way to the ceiling.
      low = 2.6;
    }
    // Room to change height between the two: dropping from above a shelf to below a lamp, climbing back up … The
    // change is measured with the clearance a person keeps (a corridor under 1.2 m tall counts as a climb), takes the
    // easier pass, and the room it needs grows with the run's speed-up.
    let climb = Infinity;
    for (const [above, below] of passes) {
      const change = Math.max(afterLow - below, above - afterHigh);
      climb = Math.min(climb, change > -1.2 ? change + 1.2 : 0);
    }
    let gap = (3.6 + r() * 2.4) * spacingScale + climb * 1.6 * speedScale(x0 - START_X);
    if (prev === 'pit') gap += 1.5;
    const fx = lastEnd + gap;
    if (fx + width > room.x1 - 4) break;
    if (f === 'shelf') {
      add('shelf', fx, fx + width, 0, h);
      if (r() < 0.6) stamp(fx + width / 2, h + 0.75);
    } else if (f === 'lamp') {
      add('lamp', fx, fx + width, h, ROOM_H);
      if (h > 1.4 && r() < 0.6) stamp(fx + width / 2, h - 0.75);
    } else if (f === 'table') {
      add('table', fx, fx + width, h, h + 0.22);
      for (let i = 0; i < 2; i++) stamp(fx + width * (0.33 + i * 0.34), h / 2);
      if (kettle) {
        const kx = fx + width * 0.65;
        add('kettle', kx, kx + 0.5, h + 0.22, h + 0.82);
        room.zones.push({ kind: 'steam', x0: kx - 0.1, x1: kx + 0.7, y0: h + 0.82, y1: ROOM_H });
      }
    } else if (f === 'pit') {
      room.pits.push({ id: id(), x0: fx, x1: fx + width });
      const n = Math.max(2, Math.floor(width / 1.6));
      for (let i = 0; i < n; i++) stamp(fx + ((i + 0.5) * width) / n, 3.2 - (i / n) * 0.8);
    } else if (f === 'fan') {
      const cx = fx + width / 2;
      add('fan', cx - 0.3, cx + 0.3, ROOM_H - 0.5, ROOM_H);
      room.zones.push({ kind: 'fan', x0: fx, x1: fx + width, y0: 0, y1: ROOM_H - 0.5 });
      if (r() < 0.6) stamp(cx, 3.2);
    } else {
      add('radiator', fx, fx + width, 0, 1);
      room.zones.push({ kind: 'heat', x0: fx - 0.2, x1: fx + width + 0.2, y0: 1, y1: ROOM_H });
      stamp(fx + width / 2, 4.6);
    }
    lastEnd = fx + width;
    prev = f;
    afterLow = low;
    afterHigh = high;
  }
  // Room before the next doorway: more when the last feature left the plane above the door frame.
  room.x1 = Math.max(room.x1, lastEnd + 4 + Math.max(0, afterLow + 0.6 - DOOR_H) * 2.5);
  return room;
}

// --- the simulation -----------------------------------------------------------------------------------

export class FoldSim {
  phase: Phase = 'ready';
  tick = 0;
  readonly seed: number;
  private acc = 0;
  private queued: Input[] = [];

  readonly plane: Plane = {
    x: START_X,
    y: START_Y,
    px: START_X,
    py: START_Y,
    vx: FORM_RULES.glider.speed,
    vy: 0,
    form: 'glider',
    soggy: 0,
    flapCooldown: 0,
    grounded: false,
  };
  /** Generated rooms, in order, from just behind the plane to KEEP_AHEAD in front of it. */
  readonly rooms: Room[] = [];
  private nextRoom = 0;
  private nextRoomX = 0;
  private roomIndex = 0;

  // Run stats.
  stamps = 0;
  stairwells = 0;
  readonly formsUsed = new Set<Form>(['glider']);
  crash: { cause: CrashCause; x: number; y: number } | null = null;

  /** Events from the last `advance` (or `input`). */
  events: SimEvent[] = [];

  /** A look-ahead copy (`fork`): shares the real sim's rooms, so it never takes their stamps. */
  private readonly ghost: boolean;

  constructor(seed = 1, ghost = false) {
    this.seed = seed >>> 0;
    this.ghost = ghost;
    if (!ghost) this.fillRooms();
  }

  /**
   * A copy that flies on by itself from here (bots try a move in one before making it). It shares the rooms (they are
   * the same whoever generates them) but leaves their stamps alone.
   */
  fork(): FoldSim {
    const f = new FoldSim(this.seed, true);
    f.phase = this.phase;
    f.tick = this.tick;
    f.queued = [...this.queued];
    Object.assign(f.plane, this.plane);
    f.rooms.push(...this.rooms);
    f.nextRoom = this.nextRoom;
    f.nextRoomX = this.nextRoomX;
    f.roomIndex = this.roomIndex;
    f.stamps = this.stamps;
    f.stairwells = this.stairwells;
    return f;
  }

  get time(): number {
    return this.tick * TICK;
  }

  /** Metres flown. */
  get distance(): number {
    return Math.max(0, this.plane.x - START_X);
  }

  get alpha(): number {
    return this.acc / TICK;
  }

  get speedScale(): number {
    return speedScale(this.distance);
  }

  /** The room the plane is in. */
  get room(): Room {
    return this.roomAt(this.plane.x) ?? this.rooms[0]!;
  }

  roomAt(x: number): Room | undefined {
    return this.rooms.find((r) => x >= r.x0 && x < r.x1);
  }

  start(): void {
    if (this.phase !== 'ready') return;
    this.phase = 'playing';
  }

  /** Queue a command for the next tick (a 'ready' sim starts on it). */
  input(cmd: Input): void {
    if (this.phase === 'ready') this.start();
    if (this.phase !== 'playing') return;
    this.queued.push(cmd);
  }

  /**
   * Advance game time by `dt` seconds (already scaled: 0 while paused). `beforeTick` runs before every fixed tick
   * (bots and tests steer through it).
   */
  advance(dt: number, beforeTick?: (sim: FoldSim) => void): SimEvent[] {
    this.events = [];
    if (this.phase !== 'playing' || !(dt > 0)) return this.events;
    this.acc = Math.min(this.acc + dt, MAX_TICKS_PER_ADVANCE * TICK);
    while (this.acc >= TICK && this.phase === 'playing') {
      this.acc -= TICK;
      beforeTick?.(this);
      this.step();
    }
    if (this.phase !== 'playing') this.acc = 0;
    return this.events;
  }

  private fillRooms(): void {
    while (this.nextRoomX < this.plane.x + KEEP_AHEAD) {
      const room = generateRoom(this.seed, this.nextRoom, this.nextRoomX);
      this.rooms.push(room);
      this.nextRoom++;
      this.nextRoomX = room.x1;
    }
    while (this.rooms.length > 1 && this.rooms[0]!.x1 < this.plane.x - KEEP_BEHIND) this.rooms.shift();
  }

  private refold(form: Form): void {
    const p = this.plane;
    if (p.form === form) return;
    const from = p.form;
    p.form = form;
    this.formsUsed.add(form);
    if (form === 'glider') {
      const target = FORM_RULES.glider.speed * this.speedScale;
      if (p.vx > target) p.vy = Math.min(MAX_RISE, p.vy + clamp((p.vx - target) * PULL_UP, 0, PULL_UP_MAX));
    }
    this.events.push({ type: 'form', form, from });
  }

  private applyInput(cmd: Input): void {
    const p = this.plane;
    if (cmd === 'dart' || cmd === 'glider') {
      this.refold(cmd);
      return;
    }
    this.refold('crane');
    if (p.flapCooldown > 0) return;
    p.vy = FLAP_SPEED * (p.soggy > 0 ? 0.75 : 1);
    p.flapCooldown = FLAP_COOLDOWN;
    p.grounded = false;
    this.events.push({ type: 'flap' });
  }

  private step(): void {
    this.tick++;
    const p = this.plane;
    p.px = p.x;
    p.py = p.y;
    for (const cmd of this.queued) this.applyInput(cmd);
    this.queued = [];
    p.flapCooldown = Math.max(0, p.flapCooldown - TICK);
    if (p.soggy > 0) p.soggy = Math.max(0, p.soggy - TICK);

    const rules = FORM_RULES[p.form];
    const soggy = p.soggy > 0;
    // Forward speed settles toward the shape's speed.
    const target = rules.speed * this.speedScale;
    p.vx += clamp(target - p.vx, -rules.accel * TICK, rules.accel * TICK);
    // Vertical: gravity, then whatever the plane is flying through.
    let ay = -rules.gravity * (soggy ? 1.5 : 1);
    const box = this.box();
    let fan = false;
    for (const room of this.nearRooms()) {
      for (const z of room.zones) {
        if (!overlaps(box, z)) continue;
        if (z.kind === 'fan') {
          ay -= FAN_PUSH;
          fan = true;
        } else if (z.kind === 'heat') ay += HEAT_LIFT;
        else if (!soggy) {
          p.soggy = SOGGY_SECONDS;
          this.events.push({ type: 'soggy' });
        } else p.soggy = SOGGY_SECONDS;
      }
    }
    p.vy += ay * TICK;
    const maxFall = rules.maxFall * (soggy ? 1.4 : 1) + (fan ? FAN_SINK : 0);
    if (p.vy < -maxFall) p.vy = Math.min(-maxFall, p.vy + (rules.gravity + 20) * TICK);
    p.vy = Math.min(p.vy, MAX_RISE);

    p.x += p.vx * TICK;
    p.y += p.vy * TICK;

    // The ceiling stops a climb.
    if (p.y > ROOM_H - PLANE_HH) {
      p.y = ROOM_H - PLANE_HH;
      if (p.vy > 0) {
        p.vy = 0;
        this.events.push({ type: 'bonk' });
      }
    }
    // The floor is a skid, unless there is a stairwell under the plane.
    const pit = this.pitAt(p.x);
    if (!pit && p.y < PLANE_HH) {
      p.y = PLANE_HH;
      if (p.vy < 0) p.vy = 0;
      if (!p.grounded) this.events.push({ type: 'skid' });
      p.grounded = true;
      p.vx = Math.max(0, p.vx - (FLOOR_DRAG + rules.accel) * TICK);
      if (p.vx < STALL_SPEED) return this.end('stall');
    } else if (p.y > PLANE_HH + 0.02) p.grounded = false;
    if (pit && p.y < -0.6) return this.end('stairwell');

    // Furniture.
    const hit = this.box();
    for (const room of this.nearRooms()) {
      for (const o of room.obstacles) if (overlaps(hit, o)) return this.end(o.kind);
      for (const s of room.stamps) {
        if (this.ghost || s.taken || Math.abs(s.x - p.x) > STAMP_RADIUS || Math.abs(s.y - p.y) > STAMP_RADIUS) continue;
        s.taken = true;
        this.stamps++;
        this.events.push({ type: 'stamp', x: s.x, y: s.y, total: this.stamps });
      }
      for (const pt of room.pits) {
        if (p.px < pt.x1 && p.x >= pt.x1) {
          this.stairwells++;
          this.events.push({ type: 'stairwell', total: this.stairwells });
        }
      }
    }

    const before = this.roomIndex;
    this.roomIndex = this.room.index;
    if (this.roomIndex !== before) this.events.push({ type: 'room', index: this.roomIndex });
    this.fillRooms();
  }

  private end(cause: CrashCause): void {
    const p = this.plane;
    this.crash = { cause, x: p.x, y: p.y };
    this.phase = 'over';
    this.events.push({ type: 'crash', cause, x: p.x, y: p.y });
    this.events.push({ type: 'over' });
  }

  private box(): Box {
    const p = this.plane;
    return { x0: p.x - PLANE_HW, x1: p.x + PLANE_HW, y0: p.y - PLANE_HH, y1: p.y + PLANE_HH };
  }

  private pitAt(x: number): Pit | undefined {
    for (const room of this.nearRooms()) {
      for (const pt of room.pits) if (x > pt.x0 + 0.15 && x < pt.x1 - 0.15) return pt;
    }
    return undefined;
  }

  /** Rooms that can touch the plane this tick (the one it is in and its neighbours). */
  private nearRooms(): Room[] {
    const x = this.plane.x;
    return this.rooms.filter((r) => r.x1 > x - 2 && r.x0 < x + 2);
  }
}
