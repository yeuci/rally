/**
 * Lumber Camp's rules, independent of rendering and frame rate.
 *
 * One shift of `SHIFT_SECONDS`: the sawmill turns logs into planks on its output tray, the player walks over the
 * tray to pick planks up (they stack on their back), drops them on the counter, and builders queue at the register
 * to buy them. Their cash piles up next to the counter; walking over it collects it, and standing on an unlock pad
 * spends it (helpers, upgrades, a second sawmill). Score = money earned over the shift.
 *
 * Modes (`MODE_RULES`): Classic is the 4-minute shift that gets busier as it goes; Rush Hour is 2 minutes that start
 * most of the way into the rush, with a little cash in hand for the first upgrade.
 *
 * Determinism: everything runs in fixed `TICK` steps (30 Hz) from an accumulator, with a seeded RNG, so the same
 * stick input per tick gives the same camp at 30, 60 or 120 fps. Renderers interpolate movers between the previous
 * and the current tick with `alpha`. The fixed step is also what a server room will run for multiplayer.
 */

export const TICK = 1 / 30;
/** A Classic shift. */
export const SHIFT_SECONDS = 240;

export type ModeId = 'classic' | 'rush';

export interface ModeRules {
  /** Shift length. */
  seconds: number;
  /** How far into the rush the shift starts (0 = a quiet start, 1 = flat out from the first second). */
  rushFrom: number;
  /** Money in the player's pocket at the start (not counted as earned). */
  startCash: number;
}

export const MODE_RULES: Record<ModeId, ModeRules> = {
  classic: { seconds: SHIFT_SECONDS, rushFrom: 0, startCash: 0 },
  rush: { seconds: 120, rushFrom: 0.6, startCash: 50 },
};
/** At most this many ticks per `advance` (0.5 s): after a stall the game slows down instead of jumping. */
const MAX_TICKS_PER_ADVANCE = 15;

export const PLAYER_SPEED = 5.2;
export const PLAYER_RADIUS = 0.4;
/** A zone (tray, counter, register, cash, pad) counts the player in when their centre is this close. */
export const ZONE_RADIUS = 0.95;
/** Seconds per plank moved between the player and a tray or the counter. */
const PLAYER_STEP = 0.07;
const BASE_CARRY = 8;

export const MILL_CAP = 16;
const MILL_PERIOD = 1.25;
const BLADE_PERIOD = 0.7;
const MILL2_PERIOD = 0.9;
export const COUNTER_CAP = 40;

/** Seconds per plank handed to the customer at the register. */
const SERVE_STEP = 0.12;
export const QUEUE_MAX = 5;
const PLANK_PRICE = 5;
const CART_PRICE = 6;
const BUILDER_PATIENCE = 20;
const CART_PATIENCE = 40;
const BUILDER_SPEED = 2.6;
const CART_SPEED = 2.0;

const HAULER_SPEED = 3.0;
const HAULER_CAP = 6;
const HAULER_STEP = 0.12;

/** Minimum spend / collect speeds, $ per second. */
const PAY_RATE = 40;
const COLLECT_RATE = 60;

export interface Vec2 {
  x: number;
  z: number;
}

/** Axis-aligned box on the ground: centre (x, z) and size (w along x, d along z). */
export interface Box extends Vec2 {
  w: number;
  d: number;
}

/** The walkable camp (player centre). */
export const BOUNDS = { minX: -4.4, maxX: 4.4, minZ: -5.2, maxZ: 6.6 };

export const COUNTER: Box = { x: 1.2, z: 1.6, w: 3.2, d: 0.9 };
/** Behind the counter: drop planks onto it. */
export const DROP_ZONE: Vec2 = { x: 0.4, z: 0.6 };
/** The till at the counter's east end: someone has to stand here (or a hired cashier) for sales. */
export const REGISTER_ZONE: Vec2 = { x: 2.3, z: 0.6 };
/** Where customers' money lands, beside the counter on the player's side. */
export const CASH_ZONE: Vec2 = { x: -1.6, z: 1.2 };
/** Queue slot 0 faces the register across the counter; later slots run towards the road. */
export const QUEUE_FRONT: Vec2 = { x: 2.3, z: 2.75 };
export const QUEUE_GAP = 0.95;
export const CUSTOMER_SPAWN: Vec2 = { x: 4.6, z: 7.8 };
export const CUSTOMER_EXIT: Vec2 = { x: 0.5, z: 8.6 };

export const MILL_BOXES: readonly Box[] = [
  { x: -2.2, z: -4.4, w: 2.2, d: 1.6 },
  { x: 2.2, z: -4.4, w: 2.2, d: 1.6 },
];
/** Each mill's output tray, in front of it. */
export const MILL_TRAYS: readonly Vec2[] = [
  { x: -2.2, z: -2.9 },
  { x: 2.2, z: -2.9 },
];

export type UnlockId = 'cashier' | 'arms' | 'blade' | 'hauler' | 'mill2' | 'carts' | 'arms2' | 'hauler2';

export interface UnlockDef extends Vec2 {
  id: UnlockId;
  title: string;
  cost: number;
}

/** Unlock pads in the order they appear: the next two still-locked pads are on the ground at any time. */
export const UNLOCKS: readonly UnlockDef[] = [
  { id: 'cashier', title: 'Hire a cashier', cost: 30, x: 3.6, z: -0.7 },
  { id: 'arms', title: 'Bigger arms', cost: 60, x: -3.6, z: 0.5 },
  { id: 'blade', title: 'Sharper blade', cost: 90, x: -3.7, z: -1.3 },
  { id: 'hauler', title: 'Hire a hauler', cost: 140, x: 0, z: -4.3 },
  { id: 'mill2', title: 'Second sawmill', cost: 320, x: 2.2, z: -4.4 },
  { id: 'carts', title: 'Cart orders', cost: 200, x: -3.4, z: 3.6 },
  { id: 'arms2', title: 'Even bigger arms', cost: 260, x: -1.4, z: 5.2 },
  { id: 'hauler2', title: 'Another hauler', cost: 380, x: 3.6, z: -1.3 },
];
export const VISIBLE_PADS = 2;

export type Phase = 'ready' | 'playing' | 'over';

export interface Mover extends Vec2 {
  /** Position at the previous tick, for interpolation. */
  px: number;
  pz: number;
}

export interface Player extends Mover {
  carry: number;
  cap: number;
  /** Facing (radians, atan2(x, z)); kept when standing still. */
  heading: number;
  moving: boolean;
}

export interface Mill {
  built: boolean;
  /** Seconds per plank. */
  period: number;
  timer: number;
  /** Planks waiting on the tray. */
  stock: number;
}

export type CustomerKind = 'builder' | 'cart';

export interface Customer extends Mover {
  id: number;
  kind: CustomerKind;
  wants: number;
  got: number;
  /** Seconds left before they give up (only counts down while nothing has been handed over). */
  patience: number;
  maxPatience: number;
  state: 'queue' | 'happy' | 'angry';
  slot: number;
}

export interface Hauler extends Mover {
  carry: number;
  state: 'fetch' | 'deliver';
  mill: number;
  timer: number;
  heading: number;
}

export interface Pad {
  def: UnlockDef;
  paid: number;
  done: boolean;
}

export type SimEvent =
  | { type: 'pickup' }
  | { type: 'drop' }
  | { type: 'serve' }
  | { type: 'sale'; amount: number; kind: CustomerKind }
  | { type: 'collect'; amount: number }
  | { type: 'pay'; id: UnlockId }
  | { type: 'unlock'; id: UnlockId }
  | { type: 'arrive'; kind: CustomerKind }
  | { type: 'walkout'; turnedAway: boolean }
  | { type: 'over' };

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

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
export const inZone = (p: Vec2, zone: Vec2, r = ZONE_RADIUS) => dist(p, zone) <= r;

export function queueSlot(slot: number): Vec2 {
  return { x: QUEUE_FRONT.x, z: QUEUE_FRONT.z + slot * QUEUE_GAP };
}

/** Seconds between builder arrivals at shift time `t` (before jitter): busier as the shift goes on. */
export function arrivalGap(t: number, mode: ModeId = 'classic'): number {
  const r = MODE_RULES[mode];
  const k = r.rushFrom + (1 - r.rushFrom) * Math.min(1, Math.max(0, t / r.seconds));
  return 3.0 + (0.8 - 3.0) * k;
}

/** Clamp a stick to the unit circle (null for non-finite input). */
export function clampStick(x: number, z: number): Vec2 | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const m = Math.hypot(x, z);
  return m > 1 ? { x: x / m, z: z / m } : { x, z };
}

/** Rate-limited transfer: how many of `available` items move this tick, given a per-item `step` and a timer. */
function transfer(state: { timer: number }, step: number, available: number): number {
  state.timer += TICK;
  let n = 0;
  while (state.timer >= step && n < available) {
    state.timer -= step;
    n++;
  }
  // Nothing (more) to move: hold one step's worth so the next item goes as soon as there is one.
  if (n === available) state.timer = Math.min(state.timer, step);
  return n;
}

/** Move `m` towards `target` at `speed`. Returns true once there. */
function moveTo(m: Mover, target: Vec2, speed: number): boolean {
  const dx = target.x - m.x;
  const dz = target.z - m.z;
  const d = Math.hypot(dx, dz);
  const step = speed * TICK;
  if (d <= step) {
    m.x = target.x;
    m.z = target.z;
    return true;
  }
  m.x += (dx / d) * step;
  m.z += (dz / d) * step;
  return false;
}

/** Push a circle out of a box (in place). */
function pushOut(p: Vec2, b: Box, r: number) {
  const hw = b.w / 2;
  const hd = b.d / 2;
  const cx = Math.max(b.x - hw, Math.min(p.x, b.x + hw));
  const cz = Math.max(b.z - hd, Math.min(p.z, b.z + hd));
  const dx = p.x - cx;
  const dz = p.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > 0) {
    if (d2 >= r * r) return;
    const d = Math.sqrt(d2);
    p.x = cx + (dx / d) * r;
    p.z = cz + (dz / d) * r;
    return;
  }
  // Centre inside the box: out along the shallowest side.
  const left = p.x - (b.x - hw);
  const right = b.x + hw - p.x;
  const top = p.z - (b.z - hd);
  const bottom = b.z + hd - p.z;
  const m = Math.min(left, right, top, bottom);
  if (m === left) p.x = b.x - hw - r;
  else if (m === right) p.x = b.x + hw + r;
  else if (m === top) p.z = b.z - hd - r;
  else p.z = b.z + hd + r;
}

export class LumberSim {
  phase: Phase = 'ready';
  tick = 0;
  /** Seconds of game time not yet simulated (0 ≤ acc < TICK after `advance`). */
  private acc = 0;
  private readonly random: () => number;

  readonly player: Player = {
    x: -0.8,
    z: -1.0,
    px: -0.8,
    pz: -1.0,
    carry: 0,
    cap: BASE_CARRY,
    heading: 0,
    moving: false,
  };
  private stick: Vec2 = { x: 0, z: 0 };
  private playerXfer = { timer: 0 };

  readonly mills: Mill[] = [
    { built: true, period: MILL_PERIOD, timer: 0, stock: 0 },
    { built: false, period: MILL2_PERIOD, timer: 0, stock: 0 },
  ];
  counter = 0;
  /** Money on the floor by the counter, not yet collected. */
  cash = 0;
  /** Money in the player's pocket. */
  wallet = 0;

  customers: Customer[] = [];
  private nextCustomerId = 1;
  private nextArrival = 1.5;
  private nextCart = Infinity;
  private serve = { timer: 0 };

  readonly haulers: Hauler[] = [];
  readonly pads: Pad[] = UNLOCKS.map((def) => ({ def, paid: 0, done: false }));
  readonly unlocked = new Set<UnlockId>();

  // Shift stats.
  earned = 0;
  planksSold = 0;
  served = 0;
  lost = 0;

  /** Events from the last `advance` (sounds, effects). */
  events: SimEvent[] = [];

  readonly mode: ModeId;
  readonly rules: ModeRules;
  private readonly shiftTicks: number;

  constructor(seed = 1, mode: ModeId = 'classic') {
    this.random = rng(seed);
    this.mode = mode;
    this.rules = MODE_RULES[mode];
    this.shiftTicks = Math.round(this.rules.seconds / TICK);
    this.wallet = this.rules.startCash;
  }

  get time(): number {
    return this.tick * TICK;
  }

  get timeLeft(): number {
    return Math.max(0, this.rules.seconds - this.time);
  }

  /** Interpolation factor between the previous and the current tick, for rendering movers. */
  get alpha(): number {
    return this.acc / TICK;
  }

  get cashierHired(): boolean {
    return this.unlocked.has('cashier');
  }

  /** The still-locked pads currently on the ground. */
  get visiblePads(): Pad[] {
    return this.pads.filter((p) => !p.done).slice(0, VISIBLE_PADS);
  }

  /** Customers in line (arriving or waiting), front first. */
  get queue(): Customer[] {
    return this.customers.filter((c) => c.state === 'queue');
  }

  start(): void {
    if (this.phase !== 'ready') return;
    this.phase = 'playing';
  }

  /** The stick for the coming ticks (x right, z down the screen), magnitude ≤ 1. */
  setStick(x: number, z: number): void {
    this.stick = clampStick(x, z) ?? { x: 0, z: 0 };
  }

  /**
   * Advance game time by `dt` seconds (already scaled: 0 while paused). `beforeTick` runs before every fixed tick
   * (bots and tests steer per tick through it).
   */
  advance(dt: number, beforeTick?: (sim: LumberSim) => void): SimEvent[] {
    this.events = [];
    if (this.phase !== 'playing' || !(dt > 0)) return this.events;
    this.acc = Math.min(this.acc + dt, MAX_TICKS_PER_ADVANCE * TICK);
    while (this.acc >= TICK && this.phase === 'playing') {
      this.acc -= TICK;
      beforeTick?.(this);
      this.step();
    }
    return this.events;
  }

  private step(): void {
    this.tick++;
    const t = this.time;
    this.movePlayer();
    this.runMills();
    this.playerActions();
    this.runHaulers();
    this.spawnCustomers(t);
    this.runQueue();
    if (this.tick >= this.shiftTicks) {
      this.phase = 'over';
      this.acc = 0;
      this.events.push({ type: 'over' });
    }
  }

  private obstacles(): Box[] {
    const boxes: Box[] = [COUNTER];
    this.mills.forEach((m, i) => {
      if (m.built) boxes.push(MILL_BOXES[i]!);
    });
    return boxes;
  }

  private movePlayer(): void {
    const p = this.player;
    p.px = p.x;
    p.pz = p.z;
    const s = this.stick;
    const m = Math.hypot(s.x, s.z);
    p.moving = m > 0.05;
    if (p.moving) {
      p.x += s.x * PLAYER_SPEED * TICK;
      p.z += s.z * PLAYER_SPEED * TICK;
      p.heading = Math.atan2(s.x, s.z);
    }
    for (const b of this.obstacles()) pushOut(p, b, PLAYER_RADIUS);
    p.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, p.x));
    p.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, p.z));
  }

  private runMills(): void {
    for (const m of this.mills) {
      if (!m.built) continue;
      if (m.stock >= MILL_CAP) {
        m.timer = Math.min(m.timer, m.period);
        continue;
      }
      m.timer += TICK;
      while (m.timer >= m.period && m.stock < MILL_CAP) {
        m.timer -= m.period;
        m.stock++;
      }
    }
  }

  /** What the player does in the zone they are standing in (zones never overlap). */
  private playerActions(): void {
    const p = this.player;
    const tray = this.mills.findIndex((m, i) => m.built && inZone(p, MILL_TRAYS[i]!));
    if (tray >= 0) {
      const mill = this.mills[tray]!;
      const n = transfer(this.playerXfer, PLAYER_STEP, Math.min(mill.stock, p.cap - p.carry));
      if (n > 0) {
        mill.stock -= n;
        p.carry += n;
        this.events.push({ type: 'pickup' });
      }
      return;
    }
    if (inZone(p, DROP_ZONE)) {
      const n = transfer(this.playerXfer, PLAYER_STEP, Math.min(p.carry, COUNTER_CAP - this.counter));
      if (n > 0) {
        p.carry -= n;
        this.counter += n;
        this.events.push({ type: 'drop' });
      }
      return;
    }
    this.playerXfer.timer = 0;
    if (inZone(p, CASH_ZONE) && this.cash > 0) {
      const n = Math.min(this.cash, Math.ceil(Math.max(COLLECT_RATE, this.cash / 0.35) * TICK));
      this.cash -= n;
      this.wallet += n;
      this.events.push({ type: 'collect', amount: n });
      return;
    }
    for (const pad of this.visiblePads) {
      if (!inZone(p, pad.def, 0.8) || this.wallet <= 0) continue;
      const remaining = pad.def.cost - pad.paid;
      const n = Math.min(this.wallet, remaining, Math.ceil(Math.max(PAY_RATE, pad.def.cost / 1.5) * TICK));
      this.wallet -= n;
      pad.paid += n;
      this.events.push({ type: 'pay', id: pad.def.id });
      if (pad.paid >= pad.def.cost) this.unlock(pad);
      return;
    }
  }

  private unlock(pad: Pad): void {
    pad.done = true;
    const id = pad.def.id;
    this.unlocked.add(id);
    this.events.push({ type: 'unlock', id });
    switch (id) {
      case 'arms':
        this.player.cap = 16;
        break;
      case 'arms2':
        this.player.cap = 28;
        break;
      case 'blade':
        this.mills[0]!.period = BLADE_PERIOD;
        break;
      case 'mill2':
        this.mills[1]!.built = true;
        break;
      case 'carts':
        this.nextCart = this.time + 4;
        break;
      case 'hauler':
      case 'hauler2': {
        const { x, z } = pad.def;
        this.haulers.push({ x, z, px: x, pz: z, carry: 0, state: 'fetch', mill: 0, timer: 0, heading: 0 });
        break;
      }
      case 'cashier':
        break;
    }
  }

  private runHaulers(): void {
    this.haulers.forEach((h, i) => {
      h.px = h.x;
      h.pz = h.z;
      if (h.state === 'fetch') {
        // Head for the fullest tray; re-decide while empty-handed.
        if (h.carry === 0) {
          let best = 0;
          this.mills.forEach((m, j) => {
            if (m.built && m.stock > this.mills[best]!.stock) best = j;
          });
          h.mill = best;
        }
        const tray = MILL_TRAYS[h.mill]!;
        const spot = { x: tray.x + (i === 0 ? -0.5 : 0.5), z: tray.z + 0.2 };
        this.face(h, spot);
        if (!moveTo(h, spot, HAULER_SPEED)) return;
        const mill = this.mills[h.mill]!;
        const n = transfer(h, HAULER_STEP, Math.min(mill.stock, HAULER_CAP - h.carry));
        mill.stock -= n;
        h.carry += n;
        if (h.carry >= HAULER_CAP || (h.carry > 0 && mill.stock === 0)) {
          h.state = 'deliver';
          h.timer = 0;
        }
      } else {
        const spot = { x: DROP_ZONE.x - 0.8 + i * 0.6, z: DROP_ZONE.z - 0.3 };
        this.face(h, spot);
        if (!moveTo(h, spot, HAULER_SPEED)) return;
        const n = transfer(h, HAULER_STEP, Math.min(h.carry, COUNTER_CAP - this.counter));
        h.carry -= n;
        this.counter += n;
        if (h.carry === 0) {
          h.state = 'fetch';
          h.timer = 0;
        }
      }
    });
  }

  private face(h: Hauler, target: Vec2) {
    const dx = target.x - h.x;
    const dz = target.z - h.z;
    if (Math.hypot(dx, dz) > 0.05) h.heading = Math.atan2(dx, dz);
  }

  private spawnCustomers(t: number): void {
    if (t >= this.nextArrival) {
      this.nextArrival = t + arrivalGap(t, this.mode) * (0.75 + this.random() * 0.5);
      this.arrive('builder', 1 + Math.floor(this.random() * 4), BUILDER_PATIENCE);
    }
    if (t >= this.nextCart) {
      this.nextCart = t + 16 + this.random() * 6;
      this.arrive('cart', 8 + Math.floor(this.random() * 5), CART_PATIENCE);
    }
  }

  private arrive(kind: CustomerKind, wants: number, patience: number): void {
    if (this.queue.length >= QUEUE_MAX) {
      this.lost++;
      this.events.push({ type: 'walkout', turnedAway: true });
      return;
    }
    const { x, z } = CUSTOMER_SPAWN;
    this.customers.push({
      id: this.nextCustomerId++,
      kind,
      x,
      z,
      px: x,
      pz: z,
      wants,
      got: 0,
      patience,
      maxPatience: patience,
      state: 'queue',
      slot: this.queue.length,
    });
    this.events.push({ type: 'arrive', kind });
  }

  private runQueue(): void {
    const queue = this.queue;
    queue.forEach((c, i) => {
      c.slot = i;
    });
    for (const c of this.customers) {
      c.px = c.x;
      c.pz = c.z;
      const speed = c.kind === 'cart' ? CART_SPEED : BUILDER_SPEED;
      if (c.state !== 'queue') {
        moveTo(c, CUSTOMER_EXIT, speed);
        continue;
      }
      moveTo(c, queueSlot(c.slot), speed);
      if (c.got === 0) {
        c.patience -= TICK;
        if (c.patience <= 0) {
          c.state = 'angry';
          this.lost++;
          this.events.push({ type: 'walkout', turnedAway: false });
        }
      }
    }
    this.customers = this.customers.filter((c) => c.state === 'queue' || dist(c, CUSTOMER_EXIT) > 0.01);

    const front = this.queue[0];
    const atRegister = front !== undefined && dist(front, queueSlot(0)) < 0.01;
    const cashier = this.cashierHired || inZone(this.player, REGISTER_ZONE);
    if (!front || !atRegister || !cashier) {
      this.serve.timer = 0;
      return;
    }
    const n = transfer(this.serve, SERVE_STEP, Math.min(this.counter, front.wants - front.got));
    if (n > 0) {
      this.counter -= n;
      front.got += n;
      this.events.push({ type: 'serve' });
    }
    if (front.got >= front.wants) {
      const amount = front.got * (front.kind === 'cart' ? CART_PRICE : PLANK_PRICE);
      front.state = 'happy';
      this.cash += amount;
      this.earned += amount;
      this.planksSold += front.got;
      this.served++;
      this.serve.timer = 0;
      this.events.push({ type: 'sale', amount, kind: front.kind });
    }
  }
}
