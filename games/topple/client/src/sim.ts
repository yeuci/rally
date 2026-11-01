/**
 * Topple's rules: players take turns dropping odd-shaped pieces onto one shared tower. Whoever's drop leads to any
 * piece falling off the pedestal is out; the tower is rebuilt and the others play on. Last player standing wins.
 *
 * Physics is Rapier's cross-platform deterministic build stepped at a fixed 60 Hz from an accumulator, and every other
 * random choice comes from a seeded RNG, so the same drops give the same tower on any device. That makes bots simple
 * (they try candidate drops on a snapshot of the world and keep the safest) and lets a server room run this exact code
 * for online play later.
 *
 * Call `initPhysics()` once (it instantiates the WebAssembly module) before creating a `ToppleSim`.
 */
import RAPIER from '@dimforge/rapier3d-deterministic-compat';

export const TICK = 1 / 60;
/** At most this many ticks per `advance`: after a stall the game slows down instead of jumping. */
const MAX_TICKS_PER_ADVANCE = 8;

/** Seconds a player has to aim before their piece drops where it is. */
export const TURN_SECONDS = 15;
/** After a drop: wait at least this long, then until everything is still for SETTLE_STILL seconds (or SETTLE_MAX). */
const SETTLE_MIN = 0.5;
const SETTLE_STILL = 0.35;
const SETTLE_MAX = 6;
const STILL_LINEAR = 0.04;
const STILL_ANGULAR = 0.08;
/** After a topple the crash plays out for this long before the next round. */
export const CRASH_SECONDS = 2.5;

/** The pedestal's top is the plane y = 0; its half size across. */
export const PEDESTAL_HALF = 1.6;
export const PEDESTAL_DEPTH = 3;
/** A piece whose centre drops below this has fallen off. */
export const FALL_Y = -0.6;
/** Aim limits (piece centre), a little beyond the pedestal: dropping off the edge is allowed (and fatal). */
export const AIM_LIMIT = 2.2;
/** The held piece hovers this far above the top of the tower. */
const HOVER_GAP = 0.55;

const FRICTION = 0.9;
const RESTITUTION = 0;
const BORDER = 0.025;

export type PieceKind = 'plank' | 'brick' | 'cube' | 'beam' | 'el' | 'tee' | 'log';

/** A piece is built from parts in its local frame: rounded boxes (half extents) or a cylinder lying along x. */
export type Part =
  | { shape: 'box'; hx: number; hy: number; hz: number; x: number; y: number; z: number }
  | { shape: 'log'; r: number; hl: number; x: number; y: number; z: number };

export const PIECES: Record<PieceKind, { parts: Part[]; weight: number; label: string }> = {
  plank: { label: 'Plank', weight: 3, parts: [{ shape: 'box', hx: 0.8, hy: 0.11, hz: 0.26, x: 0, y: 0, z: 0 }] },
  brick: { label: 'Brick', weight: 3, parts: [{ shape: 'box', hx: 0.42, hy: 0.2, hz: 0.2, x: 0, y: 0, z: 0 }] },
  cube: { label: 'Cube', weight: 2, parts: [{ shape: 'box', hx: 0.28, hy: 0.28, hz: 0.28, x: 0, y: 0, z: 0 }] },
  beam: { label: 'Beam', weight: 2, parts: [{ shape: 'box', hx: 1.1, hy: 0.12, hz: 0.12, x: 0, y: 0, z: 0 }] },
  el: {
    label: 'L',
    weight: 2,
    parts: [
      { shape: 'box', hx: 0.5, hy: 0.14, hz: 0.2, x: 0, y: -0.15, z: 0 },
      { shape: 'box', hx: 0.14, hy: 0.22, hz: 0.2, x: -0.36, y: 0.21, z: 0 },
    ],
  },
  tee: {
    label: 'T',
    weight: 2,
    parts: [
      { shape: 'box', hx: 0.6, hy: 0.13, hz: 0.2, x: 0, y: 0.16, z: 0 },
      { shape: 'box', hx: 0.14, hy: 0.2, hz: 0.2, x: 0, y: -0.17, z: 0 },
    ],
  },
  log: { label: 'Log', weight: 1, parts: [{ shape: 'log', r: 0.2, hl: 0.6, x: 0, y: 0, z: 0 }] },
};
const KINDS = Object.keys(PIECES) as PieceKind[];

export type SeatKind = 'human' | 'bot';
export type BotLevel = 'easy' | 'normal' | 'hard';

export interface Seat {
  name: string;
  kind: SeatKind;
  level?: BotLevel;
}

export interface Player extends Seat {
  index: number;
  alive: boolean;
  /** 1 = winner; set when eliminated (last out = 2nd) or on winning. */
  place: number | null;
  drops: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Piece {
  id: number;
  kind: PieceKind;
  owner: number;
  body: RAPIER.RigidBody;
}

export interface Aim {
  x: number;
  z: number;
  /** Yaw in 45° steps (0–7). */
  yaw: number;
  /** Flipped onto its side / end (rolled 90° about its length). */
  flip: boolean;
}

export type Phase = 'aim' | 'falling' | 'crash' | 'over';

export type SimEvent =
  | { type: 'turn'; player: number }
  | { type: 'drop'; player: number; auto: boolean }
  | { type: 'settled'; standing: number; height: number }
  | { type: 'topple'; player: number }
  | { type: 'out'; player: number; place: number }
  | { type: 'round'; round: number }
  | { type: 'win'; player: number };

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

let ready: Promise<void> | null = null;

/** Instantiate the physics module (once; later calls share the same promise). */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

// --- small quaternion helpers (engine-free) ---------------------------------------------------------
export function quatAxis(ax: number, ay: number, az: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  // v' = q v q*, expanded.
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/** The piece's orientation for an aim: yaw about y (45° steps) after an optional 90° roll about its length (x). */
export function aimRotation(aim: Pick<Aim, 'yaw' | 'flip'>): Quat {
  const yaw = quatAxis(0, 1, 0, (aim.yaw * Math.PI) / 4);
  return aim.flip ? quatMul(yaw, quatAxis(1, 0, 0, Math.PI / 2)) : yaw;
}

/** Lowest and highest y of a piece's parts (as boxes) when rotated by `q`, relative to its centre. */
export function verticalExtent(kind: PieceKind, q: Quat): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of PIECES[kind].parts) {
    const [hx, hy, hz] = p.shape === 'box' ? [p.hx, p.hy, p.hz] : [p.hl, p.r, p.r];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const c = rotate(q, { x: p.x + sx * hx, y: p.y + sy * hy, z: p.z + sz * hz });
          min = Math.min(min, c.y);
          max = Math.max(max, c.y);
        }
      }
    }
  }
  return { min, max };
}

const clampAim = (v: number) => Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, v));

/** The world: static pedestal and floor, plus a dynamic body per piece. */
function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.numSolverIterations = 8;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(PEDESTAL_HALF, PEDESTAL_DEPTH / 2, PEDESTAL_HALF)
      .setTranslation(0, -PEDESTAL_DEPTH / 2, 0)
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(30, 0.5, 30)
      .setTranslation(0, -PEDESTAL_DEPTH - 0.5, 0)
      .setFriction(FRICTION),
  );
  return world;
}

/** Add a piece's body (with its part colliders) to a world at a pose. */
function addPieceBody(world: RAPIER.World, kind: PieceKind, pos: Vec3, rot: Quat): RAPIER.RigidBody {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation(rot)
      .setLinearDamping(0.05)
      .setAngularDamping(0.15),
  );
  for (const p of PIECES[kind].parts) {
    const desc =
      p.shape === 'box'
        ? RAPIER.ColliderDesc.roundCuboid(p.hx - BORDER, p.hy - BORDER, p.hz - BORDER, BORDER)
        : RAPIER.ColliderDesc.cylinder(p.hl, p.r).setRotation(quatAxis(0, 0, 1, Math.PI / 2));
    desc.setTranslation(p.x, p.y, p.z).setFriction(FRICTION).setRestitution(RESTITUTION).setDensity(1);
    world.createCollider(desc, body);
  }
  return body;
}

/** Is everything (dynamic) in the world still? */
function still(world: RAPIER.World): boolean {
  let calm = true;
  world.forEachRigidBody((b) => {
    if (!calm || !b.isDynamic() || b.isSleeping()) return;
    const v = b.linvel();
    const w = b.angvel();
    if (Math.hypot(v.x, v.y, v.z) > STILL_LINEAR || Math.hypot(w.x, w.y, w.z) > STILL_ANGULAR) calm = false;
  });
  return calm;
}

function anyFallen(world: RAPIER.World): boolean {
  let fallen = false;
  world.forEachRigidBody((b) => {
    if (!fallen && b.isDynamic() && b.translation().y < FALL_Y) fallen = true;
  });
  return fallen;
}

/** Bot settings: how many drops it tries, and how much it misses its chosen spot by. */
const BOT = {
  easy: { candidates: 6, noise: 0.18, think: 0.9 },
  normal: { candidates: 12, noise: 0.06, think: 0.7 },
  hard: { candidates: 20, noise: 0, think: 0.5 },
} as const;
/** Physics steps a bot may simulate per tick (spreads planning over frames). */
const BOT_STEPS_PER_TICK = 20;
/** Seconds a candidate drop is simulated for. */
const BOT_HORIZON = 2.5;

interface Candidate {
  aim: Aim;
  score: number;
}

/**
 * Plans one bot drop incrementally: for each candidate aim, restore the world from a snapshot, drop the piece there
 * and simulate it; reject drops where anything falls, prefer ones that disturb the tower least and stay near the
 * middle. Runs a fixed number of physics steps per tick, so it is deterministic and never stalls a frame.
 */
class BotPlanner {
  private readonly snapshot: Uint8Array;
  private readonly before: Map<number, Vec3>;
  private readonly candidates: Aim[];
  private index = 0;
  private world: RAPIER.World | null = null;
  private piece: RAPIER.RigidBody | null = null;
  private steps = 0;
  private best: Candidate | null = null;
  private readonly kind: PieceKind;
  /** The tower top when planning began (the held piece hovers above it). */
  private readonly hoverAbove: number;
  done = false;

  constructor(sim: ToppleSim, kind: PieceKind, count: number, random: () => number) {
    this.kind = kind;
    this.hoverAbove = sim.towerTop;
    this.snapshot = sim.world.takeSnapshot();
    this.before = new Map();
    sim.world.forEachRigidBody((b) => {
      if (b.isDynamic()) this.before.set(b.handle, { ...b.translation() });
    });
    // Candidates: around the middle of the pedestal, every yaw, sometimes flipped.
    this.candidates = [];
    for (let i = 0; i < count; i++) {
      this.candidates.push({
        x: (random() - 0.5) * PEDESTAL_HALF * 1.3,
        z: (random() - 0.5) * PEDESTAL_HALF * 1.3,
        yaw: Math.floor(random() * 8),
        flip: random() < 0.2,
      });
    }
  }

  /** Advance planning by up to `budget` physics steps. */
  step(budget: number): void {
    while (budget > 0 && !this.done) {
      if (!this.world) {
        const aim = this.candidates[this.index]!;
        this.world = RAPIER.World.restoreSnapshot(this.snapshot);
        const rot = aimRotation(aim);
        const ext = verticalExtent(this.kind, rot);
        this.piece = addPieceBody(
          this.world,
          this.kind,
          { x: aim.x, y: this.hoverAbove + HOVER_GAP - ext.min, z: aim.z },
          rot,
        );
        this.steps = 0;
      }
      const world = this.world;
      const n = Math.min(budget, Math.round(BOT_HORIZON / TICK) - this.steps);
      for (let i = 0; i < n; i++) world.step();
      this.steps += n;
      budget -= n;
      if (this.steps >= Math.round(BOT_HORIZON / TICK)) this.finishCandidate();
    }
  }

  private finishCandidate(): void {
    const world = this.world!;
    const aim = this.candidates[this.index]!;
    let score = -Infinity;
    if (!anyFallen(world)) {
      let moved = 0;
      world.forEachRigidBody((b) => {
        const was = this.before.get(b.handle);
        if (!was || !b.isDynamic()) return;
        const t = b.translation();
        moved += Math.hypot(t.x - was.x, t.y - was.y, t.z - was.z);
      });
      const p = this.piece!.translation();
      // Disturbing the tower is bad; landing far off-centre is risky; a piece still moving is a warning sign.
      const v = this.piece!.linvel();
      score = -moved * 10 - Math.hypot(p.x, p.z) * 0.6 - Math.hypot(v.x, v.y, v.z) * 2;
    }
    if (!this.best || score > this.best.score) this.best = { aim, score };
    world.free();
    this.world = null;
    this.piece = null;
    this.index++;
    if (this.index >= this.candidates.length) this.done = true;
  }

  /** The chosen aim (the best candidate, or the middle if every candidate toppled). */
  get choice(): Aim {
    return this.best && Number.isFinite(this.best.score) ? this.best.aim : { x: 0, z: 0, yaw: 0, flip: false };
  }

  dispose(): void {
    this.world?.free();
    this.world = null;
  }
}

export class ToppleSim {
  readonly world: RAPIER.World;
  readonly players: Player[];
  phase: Phase = 'aim';
  tick = 0;
  round = 1;
  /** Whose turn it is. */
  current: number;
  /** The player whose drop the tower is currently "on" (blamed for a collapse until the next drop). */
  lastDropper = -1;
  aim: Aim = { x: 0, z: 0, yaw: 0, flip: false };
  piece: PieceKind;
  next: PieceKind;
  pieces: Piece[] = [];
  /** Seconds left to aim (aim phase). */
  turnLeft = TURN_SECONDS;
  /** Seconds since the drop / since the crash began. */
  phaseTime = 0;
  private stillFor = 0;
  private acc = 0;
  private nextPieceId = 1;
  private readonly random: () => number;
  private readonly botRandom: () => number;
  private planner: BotPlanner | null = null;
  /** Bot: where it is heading, and when it lets go. */
  private botTarget: Aim | null = null;
  private botWait = 0;
  private dropRequested = false;
  /** Who knocked the tower over (during the crash). */
  private toppler = -1;

  // Match stats.
  maxStanding = 0;
  maxHeight = 0;
  winner: number | null = null;

  events: SimEvent[] = [];

  constructor(seats: Seat[], seed = 1) {
    if (seats.length < 2 || seats.length > 6) throw new Error('Topple needs 2–6 seats');
    this.random = rng(seed);
    this.botRandom = rng(seed ^ 0x9e3779b9);
    this.world = createWorld();
    this.players = seats.map((s, index) => ({ ...s, index, alive: true, place: null, drops: 0 }));
    this.current = 0;
    this.piece = this.draw();
    this.next = this.draw();
    this.startTurn();
  }

  /** The match is over (a winner is decided). */
  get finished(): boolean {
    return this.phase === 'over';
  }

  get alive(): Player[] {
    return this.players.filter((p) => p.alive);
  }

  get currentPlayer(): Player {
    return this.players[this.current]!;
  }

  /** Top of the tower: the highest point of any piece still on the pedestal (0 when empty). */
  get towerTop(): number {
    let top = 0;
    for (const p of this.pieces) {
      const t = p.body.translation();
      if (t.y > FALL_Y) top = Math.max(top, t.y + verticalExtent(p.kind, p.body.rotation()).max);
    }
    return top;
  }

  /** Where the held piece hovers (its centre) and how it is turned. */
  get held(): { pos: Vec3; rot: Quat } {
    const rot = aimRotation(this.aim);
    const ext = verticalExtent(this.piece, rot);
    return { pos: { x: this.aim.x, y: this.towerTop + HOVER_GAP - ext.min, z: this.aim.z }, rot };
  }

  /** Pieces standing on the pedestal. */
  get standing(): number {
    return this.pieces.filter((p) => p.body.translation().y > FALL_Y).length;
  }

  /** True while the current player is a person who may aim and drop. */
  get humanAiming(): boolean {
    return this.phase === 'aim' && this.currentPlayer.kind === 'human';
  }

  // --- input (human turns) ---------------------------------------------------------------------------
  setAim(x: number, z: number): void {
    if (!this.humanAiming) return;
    this.aim.x = clampAim(x);
    this.aim.z = clampAim(z);
  }

  turn(steps = 1): void {
    if (!this.humanAiming) return;
    this.aim.yaw = (((this.aim.yaw + steps) % 8) + 8) % 8;
  }

  flip(): void {
    if (!this.humanAiming) return;
    this.aim.flip = !this.aim.flip;
  }

  drop(): void {
    if (this.humanAiming) this.dropRequested = true;
  }

  // --- time ------------------------------------------------------------------------------------------
  /**
   * Advance game time by `dt` seconds (already scaled: 0 while paused). `beforeTick` runs before every fixed tick
   * (tests and replays give input at exact ticks through it).
   */
  advance(dt: number, beforeTick?: (sim: ToppleSim) => void): SimEvent[] {
    this.events = [];
    if (this.finished || !(dt > 0)) return this.events;
    this.acc = Math.min(this.acc + dt, MAX_TICKS_PER_ADVANCE * TICK);
    while (this.acc >= TICK && !this.finished) {
      this.acc -= TICK;
      beforeTick?.(this);
      this.step();
    }
    return this.events;
  }

  private step(): void {
    this.tick++;
    this.world.step();
    switch (this.phase) {
      case 'aim':
        this.runAim();
        // A collapse while the next player aims is on whoever dropped last.
        if (this.phase === 'aim' && this.lastDropper >= 0 && anyFallen(this.world)) this.topple(this.lastDropper);
        break;
      case 'falling':
        this.phaseTime += TICK;
        if (anyFallen(this.world)) {
          this.topple(this.lastDropper);
          break;
        }
        this.stillFor = still(this.world) ? this.stillFor + TICK : 0;
        if ((this.phaseTime >= SETTLE_MIN && this.stillFor >= SETTLE_STILL) || this.phaseTime >= SETTLE_MAX)
          this.settle();
        break;
      case 'crash':
        this.phaseTime += TICK;
        if (this.phaseTime >= CRASH_SECONDS) this.afterCrash();
        break;
      case 'over':
        break;
    }
  }

  private runAim(): void {
    const p = this.currentPlayer;
    this.turnLeft -= TICK;
    if (p.kind === 'bot') {
      this.runBot();
      return;
    }
    if (this.dropRequested) {
      this.release(false);
    } else if (this.turnLeft <= 0) {
      this.release(true);
    }
  }

  private runBot(): void {
    const p = this.currentPlayer;
    const cfg = BOT[p.level ?? 'normal'];
    if (this.planner && !this.planner.done) {
      this.planner.step(BOT_STEPS_PER_TICK);
      return;
    }
    if (this.planner && !this.botTarget) {
      const c = this.planner.choice;
      this.planner.dispose();
      const miss = () => (this.botRandom() - 0.5) * 2 * cfg.noise;
      this.botTarget = { ...c, x: clampAim(c.x + miss()), z: clampAim(c.z + miss()) };
      this.aim.yaw = c.yaw;
      this.aim.flip = c.flip;
      this.botWait = cfg.think;
    }
    if (!this.botTarget) return;
    // Glide the held piece to the chosen spot, pause, let go.
    const t = this.botTarget;
    const k = 1 - Math.exp(-TICK * 6);
    this.aim.x += (t.x - this.aim.x) * k;
    this.aim.z += (t.z - this.aim.z) * k;
    this.botWait -= TICK;
    if (this.botWait <= 0 && Math.hypot(t.x - this.aim.x, t.z - this.aim.z) < 0.02) {
      this.aim.x = t.x;
      this.aim.z = t.z;
      this.release(false);
    }
  }

  private release(auto: boolean): void {
    const { pos, rot } = this.held;
    const body = addPieceBody(this.world, this.piece, pos, rot);
    this.pieces.push({ id: this.nextPieceId++, kind: this.piece, owner: this.current, body });
    this.currentPlayer.drops++;
    this.lastDropper = this.current;
    this.dropRequested = false;
    this.phase = 'falling';
    this.phaseTime = 0;
    this.stillFor = 0;
    this.events.push({ type: 'drop', player: this.current, auto });
  }

  private settle(): void {
    const standing = this.standing;
    const height = this.towerTop;
    this.maxStanding = Math.max(this.maxStanding, standing);
    this.maxHeight = Math.max(this.maxHeight, height);
    this.events.push({ type: 'settled', standing, height });
    this.piece = this.next;
    this.next = this.draw();
    this.current = this.nextAlive(this.current);
    this.startTurn();
  }

  private topple(player: number): void {
    this.events.push({ type: 'topple', player });
    this.phase = 'crash';
    this.phaseTime = 0;
    this.planner?.dispose();
    this.planner = null;
    this.botTarget = null;
    this.toppler = player;
  }

  private afterCrash(): void {
    const out = this.players[this.toppler]!;
    out.alive = false;
    out.place = this.alive.length + 1;
    this.events.push({ type: 'out', player: out.index, place: out.place });
    if (this.alive.length === 1) {
      const w = this.alive[0]!;
      w.place = 1;
      this.winner = w.index;
      this.phase = 'over';
      this.events.push({ type: 'win', player: w.index });
      return;
    }
    // Fresh tower; the player after the one who knocked it over starts.
    for (const p of this.pieces) this.world.removeRigidBody(p.body);
    this.pieces = [];
    this.lastDropper = -1;
    this.round++;
    this.events.push({ type: 'round', round: this.round });
    this.piece = this.draw();
    this.next = this.draw();
    this.current = this.nextAlive(out.index);
    this.startTurn();
  }

  private startTurn(): void {
    this.phase = 'aim';
    this.turnLeft = TURN_SECONDS;
    this.aim = { x: 0, z: 0, yaw: 0, flip: false };
    this.dropRequested = false;
    this.botTarget = null;
    this.planner?.dispose();
    this.planner = null;
    const p = this.currentPlayer;
    if (p.kind === 'bot')
      this.planner = new BotPlanner(this, this.piece, BOT[p.level ?? 'normal'].candidates, this.botRandom);
    this.events.push({ type: 'turn', player: this.current });
  }

  private nextAlive(from: number): number {
    for (let i = 1; i <= this.players.length; i++) {
      const j = (from + i) % this.players.length;
      if (this.players[j]!.alive) return j;
    }
    return from;
  }

  private draw(): PieceKind {
    const total = KINDS.reduce((n, k) => n + PIECES[k].weight, 0);
    let r = this.random() * total;
    for (const k of KINDS) {
      r -= PIECES[k].weight;
      if (r < 0) return k;
    }
    return 'brick';
  }

  /** Free the physics world (WASM memory). The sim is unusable afterwards. */
  dispose(): void {
    this.planner?.dispose();
    this.world.free();
  }
}
