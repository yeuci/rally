import { Action, barricadeOption, chooseAction, type ActionChoice, type ActionContext } from './actions.ts';
import { DT, HISTORY_TICKS, MAX_REWIND_MS } from './constants.ts';
import { FlowField } from './flowfield.ts';
import { pushCircleOutOfCircle, rayCircle, type Aabb } from './geometry.ts';
import { NO_INPUT, type PlayerInput } from './input.ts';
import { Rng } from './rng.ts';
import {
  DOG_SPOT,
  GANTRY,
  GRID,
  LOOT_SPOTS,
  OBSTACLES,
  PART_SPOTS,
  POSTS,
  SAFE,
  SAFE_CENTER,
  SOCKETS,
  SPAWNS,
  STREET_POINTS,
  TOWN_HALF,
  TRUCK,
  circleIsFree,
  movePlayer,
  resolveCircle,
} from './town.ts';
import {
  AMMO,
  ARMOR_MAX,
  ARMOR_SOAK,
  type AmmoType,
  BARRICADES,
  BLEED_OUT,
  CARRY_SPEED,
  DAWN_HEAL,
  DAY_LOSE,
  DAY_SIGHT,
  DAY_TIME,
  DOG_ALERT,
  DOG_BARK_CD,
  DOG_BITE,
  DOG_BITE_CD,
  DOG_BITE_RANGE,
  DOG_FINDERS,
  DOG_FOLLOW,
  DOG_HP,
  DOG_RADIUS,
  DOG_RUN,
  DOG_WALK,
  DOWN_SPEED,
  DROP_CHANCE_DAY,
  DROP_CHANCE_NIGHT,
  DUSK_TIME,
  ESCAPE_FROM_NIGHT,
  ESCAPE_TIME,
  FIRST_DAY_TIME,
  FISTS,
  GOO_TIME,
  GUNS,
  HEAL,
  HOLDOUT_TIME,
  ITEMS,
  Item,
  LOOT,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_ZOMBIES,
  MELEE,
  MIN_PLAYERS,
  NIGHT_SIGHT,
  NIGHT_TIME,
  PICKUP_RADIUS,
  PICKUP_TTL,
  PLAYER_HP,
  PLAYER_RADIUS,
  REVIVE_HP,
  ROCK_COOLDOWN,
  ROCK_DAMAGE,
  ROCK_FLIGHT,
  ROCK_MAX,
  ROCK_MIN,
  ROCK_RADIUS,
  ROCK_WINDUP,
  SCRAP_PER_PICKUP,
  TRUCK_FUEL,
  TRUCK_SCRAP,
  TRUCK_WHEELS,
  ZOMBIES,
  ZombieKind,
  dayPopulation,
  dayStrength,
  effectiveNight,
  hordeMix,
  hordeSize,
  isBloodMoon,
  itemKind,
  nightStrength,
  spawnInterval,
  type GunSpec,
  type LootLine,
  type MeleeSpec,
  type Strength,
} from './tuning.ts';
import type { Vec2 } from './vec.ts';

/**
 * - `waiting`: a private room before its run (walk round the safehouse; no zombies).
 * - `day` → `dusk` → `night` → (dawn) `day` …: the run. Day: scavenge among few, slow wanderers. Dusk: a warning.
 *   Night N: the horde, stronger every night. Dawn heals, revives, respawns and restocks.
 * - `holdout`: the truck is warming up: the full horde for `HOLDOUT_TIME`.
 * - `escape`: the drive out through the gantry (a short scripted exit), then the run is won.
 * - `over`: the result, then a new run (public rooms) or back to `waiting` (private rooms).
 */
export type Phase = 'waiting' | 'day' | 'dusk' | 'night' | 'holdout' | 'escape' | 'over';
export type Life = 'alive' | 'down' | 'dead';

export interface ActionState extends ActionChoice {
  progress: number;
}

export interface Player {
  id: string;
  name: string;
  /** 0…3: survivor model and colour; the lowest free slot. */
  slot: number;
  order: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  hp: number;
  armor: number;
  life: Life;
  /** Seconds down (bleeding out at BLEED_OUT). */
  downFor: number;
  /** A teammate's revive progress on this survivor, seconds. */
  revive: number;
  /** A solo survivor's self-revive, once per night. */
  secondWind: boolean;
  gun: number;
  melee: number;
  /** Swings left of the melee weapon. */
  durability: number;
  ammo: number[];
  items: number[];
  /** A truck part in the arms (no guns, slower). */
  carry: number;
  fireCd: number;
  meleeCd: number;
  action: ActionState | null;
  /** A finished hold waits for the button to be released. */
  actLatch: boolean;
  lastUse: number;
  input: PlayerInput;
  connected: boolean;
  /** Part of the current run (late joiners join at once, at the safehouse). */
  inRun: boolean;
  played: boolean;
  kills: number;
  guitarKills: number;
  revives: number;
  downs: number;
  foundDog: boolean;
  /** Ticks behind the server this client draws the zombies (lag compensation). */
  viewDelay: number;
}

export interface Zombie {
  id: number;
  kind: ZombieKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Knockback velocity (decays). */
  kx: number;
  ky: number;
  hp: number;
  maxHp: number;
  /** Chasing and shambling speeds with the curve applied. */
  run: number;
  walk: number;
  damage: number;
  attackCd: number;
  /** Part of a night's horde (hunts by the flow field) rather than a day wanderer (hunts by sight). */
  horde: boolean;
  /** A horde zombie that heads for the safehouse when nobody is near. */
  siege: boolean;
  /** Survivor id, 'dog', or null. */
  target: string | null;
  thinkCd: number;
  wx: number;
  wy: number;
  wanderCd: number;
  /** The brute: seconds of wind-up left (0: not throwing), where the rock goes, and the cooldown. */
  windup: number;
  tx: number;
  ty: number;
  rockCd: number;
  /** Accumulated time of a zombie far from everyone (simulated coarsely). */
  idle: number;
  facing: number;
  born: number;
  hx: Float32Array;
  hy: Float32Array;
}

export interface Rock {
  id: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  x: number;
  y: number;
  h: number;
  t: number;
  damage: number;
}

export interface Goo {
  id: number;
  x: number;
  y: number;
  ttl: number;
}

export interface Pickup {
  id: number;
  kind: number;
  x: number;
  y: number;
  ttl: number;
}

export interface Barricade {
  tier: number;
  hp: number;
  maxHp: number;
}

export interface Dog {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  /** 0 stray (waiting in the Back Alleys), 1 following, 2 down. */
  state: 0 | 1 | 2;
  hp: number;
  owner: string | null;
  biteCd: number;
  barkCd: number;
  /** The dog bit a moment ago (the client plays its attack). */
  biting: number;
}

export interface Truck {
  wheels: number;
  fuel: number;
  scrap: number;
  /** Where it is drawn (it drives during the escape). */
  x: number;
  y: number;
  yaw: number;
}

/** Overridable rules (tests use short phases; private rooms do not start on their own). */
export interface RunRules {
  minPlayers: number;
  autoStart: boolean;
  dayTime: number;
  firstDayTime: number;
  duskTime: number;
  nightTime: number;
  overTime: number;
  holdoutTime: number;
  escapeTime: number;
  maxZombies: number;
  /** Multiplies the horde and the day population (0: no spawns at all; tests place their own zombies). */
  spawnScale: number;
}

export const DEFAULT_RULES: RunRules = {
  minPlayers: MIN_PLAYERS,
  autoStart: true,
  dayTime: DAY_TIME,
  firstDayTime: FIRST_DAY_TIME,
  duskTime: DUSK_TIME,
  nightTime: NIGHT_TIME,
  overTime: 12,
  holdoutTime: HOLDOUT_TIME,
  escapeTime: ESCAPE_TIME,
  maxZombies: MAX_ZOMBIES,
  spawnScale: 1,
};

const RULE_LIMITS: Record<Exclude<keyof RunRules, 'autoStart'>, [number, number]> = {
  minPlayers: [1, MAX_PLAYERS],
  dayTime: [1, 900],
  firstDayTime: [1, 900],
  duskTime: [0.5, 120],
  nightTime: [1, 900],
  overTime: [0.5, 60],
  holdoutTime: [1, 300],
  escapeTime: [1, 30],
  maxZombies: [0, MAX_ZOMBIES],
  spawnScale: [0, 4],
};

/** Keep only known rules with values in range (rules can come from a client in dev/test builds). */
export function sanitizeRules(raw: unknown): Partial<RunRules> {
  const out: Partial<RunRules> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.autoStart === 'boolean') out.autoStart = r.autoStart;
  for (const [key, [lo, hi]] of Object.entries(RULE_LIMITS) as [keyof typeof RULE_LIMITS, [number, number]][]) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

export interface Standing {
  id: string;
  name: string;
  slot: number;
  kills: number;
  guitarKills: number;
  revives: number;
  downs: number;
  foundDog: boolean;
  /** 1 = most kills; equal kills share a placement. */
  placement: number;
}

export interface RunSummary {
  run: number;
  /** Nights the group lived to see the dawn of. */
  nights: number;
  /** Seconds from the first day to the end. */
  duration: number;
  escaped: boolean;
  /** Blood Moons survived (to dawn, or escaped during one). */
  bloodMoons: number;
  teamKills: number;
  standings: Standing[];
}

/** What killed or hurt: an item code (guns, melee weapons), 0 fists, 'dog'. */
export type Cause = number | 'dog' | 'truck';

export type MatchEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'night'; night: number; blood: boolean }
  | { type: 'dawn'; nights: number }
  | { type: 'shot'; by: string; item: number; rays: number[] }
  | { type: 'empty'; by: string }
  | { type: 'swing'; by: string; item: number; x: number; y: number; angle: number; hits: number }
  | { type: 'hit'; zombie: number; by: string | null; x: number; y: number }
  | { type: 'kill'; zombie: number; kind: ZombieKind; x: number; y: number; by: string | null; cause: Cause }
  | { type: 'hurt'; id: string; hp: number; damage: number }
  | { type: 'down'; id: string }
  | { type: 'revive'; id: string; by: string | null }
  | { type: 'dead'; id: string }
  | { type: 'respawn'; id: string }
  | { type: 'open'; spot: number; by: string; items: number }
  | { type: 'loot'; by: string; item: number }
  | { type: 'use'; by: string; item: number }
  | { type: 'broke'; by: string; item: number }
  | { type: 'windup'; zombie: number; x: number; y: number }
  | { type: 'rock'; x: number; y: number }
  | { type: 'goo'; x: number; y: number }
  | { type: 'bark'; x: number; y: number }
  | { type: 'dog'; state: number; by: string | null }
  | { type: 'build'; socket: number; tier: number; by: string }
  | { type: 'smash'; socket: number; hp: number }
  | { type: 'breach'; socket: number }
  | { type: 'part'; item: number; by: string }
  | { type: 'scrap'; amount: number; by: string }
  | { type: 'holdout' }
  | { type: 'escape' }
  | { type: 'runOver'; summary: RunSummary };

export interface MatchOptions {
  rules?: Partial<RunRules>;
  /** PRNG seed (spawns, loot, weapon spread). */
  seed?: number;
}

/** Spatial hash for zombie separation. */
const SEP_CELL = 2;
const SEP_COLS = Math.ceil((TOWN_HALF * 2) / SEP_CELL) + 2;
/** Zombies further than this from every survivor are simulated coarsely (every SLEEP_STEP seconds). */
export const ACTIVE_RADIUS = 46;
const SLEEP_STEP = 0.2;
/** Flow-field recomputation (ticks) and how far it searches (path units × 10). */
const FLOW_TICKS = 7;
const FLOW_RANGE = 700;
/** Barricade sockets cost the horde's pathfinding this much extra per cell (they would rather go round). */
const BARRICADE_COST = 60;
const MAX_REWIND_TICKS = MAX_REWIND_MS / 1000 / DT;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The escape drive: out of the safehouse's north gate, east to the main street, north through the gantry. */
export const ESCAPE_PATH: readonly Vec2[] = [
  { x: TRUCK.x, y: TRUCK.y },
  { x: TRUCK.x, y: 0 },
  { x: GANTRY.x, y: 0 },
  { x: GANTRY.x, y: -TOWN_HALF - 50 },
];

/** A point `u` (0…1) of the way along a polyline, and its heading. */
export function alongPath(path: readonly Vec2[], u: number): { x: number; y: number; yaw: number } {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  let left = Math.max(0, Math.min(1, u)) * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i === path.length - 1) {
      const k = len > 0 ? Math.min(1, left / len) : 0;
      // Yaw (PlayCanvas): the model faces +z; heading (dx, dy) in sim axes is yaw atan2(dx, dy).
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, yaw: Math.atan2(b.x - a.x, b.y - a.y) };
    }
    left -= len;
  }
  const last = path[path.length - 1]!;
  return { x: last.x, y: last.y, yaw: 0 };
}

/**
 * The whole game, engine- and network-free: survivors, the day/night cycle, scavenging, weapons, zombies, the dog,
 * barricades, the truck and the escape. The room calls `step(DT)` at a fixed rate and mirrors the fields into its
 * Colyseus schema; tests drive it directly. Deterministic for a seed and the same inputs: collections are processed in
 * a fixed order and every random number comes from `rng`.
 */
export class NorthdaleMatch {
  phase: Phase = 'waiting';
  /** Seconds left in the current phase (counting up in `waiting` and `over`'s countdown). */
  timer = 0;
  /** Length of the current phase (the HUD's clock runs over it). */
  phaseLength = 0;
  tick = 0;
  time = 0;
  run = 0;
  runTime = 0;
  /** The night in progress or the last one (0 before the first). */
  night = 0;
  /** Day number (1 before night 1). */
  day = 1;
  nightsSurvived = 0;
  bloodMoons = 0;
  /** A Blood Moon tonight. */
  blood = false;
  teamKills = 0;
  scrap = 0;
  escaped = false;
  /** Dev/test: zombies neither move, attack nor spawn. */
  frozen = false;
  /** Dev/test: survivors take no damage. */
  invulnerable = false;
  readonly players = new Map<string, Player>();
  readonly zombies = new Map<number, Zombie>();
  readonly rocks = new Map<number, Rock>();
  readonly goo = new Map<number, Goo>();
  readonly pickups = new Map<number, Pickup>();
  /** Opened / searched loot spots (by id). */
  readonly opened: boolean[] = LOOT_SPOTS.map(() => false);
  readonly barricades: (Barricade | null)[] = SOCKETS.map(() => null);
  readonly dog: Dog = {
    x: DOG_SPOT.x,
    y: DOG_SPOT.y,
    vx: 0,
    vy: 0,
    facing: 0,
    state: 0,
    hp: DOG_HP,
    owner: null,
    biteCd: 0,
    barkCd: 0,
    biting: 0,
  };
  readonly truck: Truck = { wheels: 0, fuel: 0, scrap: 0, x: TRUCK.x, y: TRUCK.y, yaw: TRUCK.yaw };
  /** Toward the nearest standing survivor, and toward the safehouse (the siege). */
  readonly flow = new FlowField(TOWN_HALF, 1, OBSTACLES, POSTS);
  readonly siege = new FlowField(TOWN_HALF, 1, OBSTACLES, POSTS);
  rules: RunRules;
  readonly rng: Rng;

  private ordered: Player[] = [];
  private startRequested = false;
  private hordeQueue: ZombieKind[] = [];
  private spawnTimer = 0;
  private spawnEvery = 1;
  private flowDirty = true;
  private siegeDirty = true;
  private nextZombieId = 1;
  private nextEntityId = 1;
  private nextOrder = 0;
  private readonly sepHead = new Int32Array(SEP_COLS * SEP_COLS);
  private sepNext = new Int32Array(MAX_ZOMBIES * 2);
  private sepList: Zombie[] = [];

  constructor(options: MatchOptions = {}) {
    this.rules = { ...DEFAULT_RULES, ...options.rules };
    this.rng = new Rng(options.seed ?? 1);
    this.resetWorld();
  }

  // ---- players ---------------------------------------------------------------------------------------------------

  addPlayer(id: string, name: string): Player {
    const existing = this.players.get(id);
    if (existing) return existing;
    const used = new Set(this.ordered.map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const p: Player = {
      id,
      name,
      slot,
      order: this.nextOrder++,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: -Math.PI / 2,
      hp: PLAYER_HP,
      armor: 0,
      life: 'alive',
      downFor: 0,
      revive: 0,
      secondWind: true,
      gun: Item.pistol,
      melee: Item.knife,
      durability: MELEE[Item.knife]!.durability,
      ammo: AMMO.map((a) => a.start),
      items: [Item.none, Item.none],
      carry: Item.none,
      fireCd: 0,
      meleeCd: 0,
      action: null,
      actLatch: false,
      lastUse: 0,
      input: { ...NO_INPUT },
      connected: true,
      inRun: false,
      played: false,
      kills: 0,
      guitarKills: 0,
      revives: 0,
      downs: 0,
      foundDog: false,
      viewDelay: 0,
    };
    this.players.set(id, p);
    this.ordered = [...this.players.values()].sort((a, b) => a.order - b.order);
    // Late joiners spawn at the safehouse at once (any phase but the result screen).
    this.spawn(p);
    if (this.inRun) p.inRun = p.played = true;
    this.flowDirty = true;
    return p;
  }

  removePlayer(id: string): boolean {
    const p = this.players.get(id);
    if (p?.carry) this.drop(p.carry, p.x, p.y);
    const had = this.players.delete(id);
    this.ordered = this.ordered.filter((q) => q.id !== id);
    if (this.dog.owner === id) this.dog.owner = null;
    this.flowDirty = true;
    if (had && this.players.size === 0) this.toWaiting([]);
    return had;
  }

  setName(id: string, name: string): void {
    const p = this.players.get(id);
    if (p) p.name = name;
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (!connected) p.input = { ...NO_INPUT, use: p.lastUse, slot: p.input.slot };
  }

  /** `input` must already be validated (see `parseInput`). */
  setInput(id: string, input: PlayerInput): void {
    const p = this.players.get(id);
    if (p && p.connected) p.input = input;
  }

  /** The client was drawing the zombies at tick `rt`: its shots rewind them by the difference (capped). */
  setViewTick(id: string, rt: number): void {
    const p = this.players.get(id);
    if (p) p.viewDelay = Math.max(0, Math.min(MAX_REWIND_TICKS, this.tick - rt));
  }

  requestStart(): void {
    if (this.phase === 'waiting') this.startRequested = true;
  }

  setRules(rules: Partial<RunRules>): void {
    this.rules = { ...this.rules, ...rules };
  }

  get playerList(): readonly Player[] {
    return this.ordered;
  }

  /** A run is under way (players who join now are part of it). */
  get inRun(): boolean {
    return this.phase !== 'waiting' && this.phase !== 'over';
  }

  /** Survivors in the run. */
  get runners(): Player[] {
    return this.ordered.filter((p) => p.inRun);
  }

  /** The truck has everything it needs. */
  get repaired(): boolean {
    return this.truck.wheels >= TRUCK_WHEELS && this.truck.fuel >= TRUCK_FUEL && this.truck.scrap >= TRUCK_SCRAP;
  }

  /** The escape can be started now. */
  get canStart(): boolean {
    return (
      this.repaired &&
      this.night >= ESCAPE_FROM_NIGHT &&
      (this.phase === 'day' || this.phase === 'dusk' || this.phase === 'night')
    );
  }

  /** The strength zombies spawning now get. */
  get strength(): Strength {
    if (this.phase === 'night' || this.phase === 'holdout' || this.phase === 'escape')
      return nightStrength(effectiveNight(Math.max(1, this.night)));
    return dayStrength(this.day);
  }

  standings(): Standing[] {
    const list = this.ordered.filter((p) => p.played).sort((a, b) => b.kills - a.kills || a.order - b.order);
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      kills: p.kills,
      guitarKills: p.guitarKills,
      revives: p.revives,
      downs: p.downs,
      foundDog: p.foundDog,
      placement: 1 + list.filter((q) => q.kills > p.kills).length,
    }));
  }

  // ---- the step ------------------------------------------------------------------------------------------------

  step(dt: number): MatchEvent[] {
    this.tick++;
    this.time += dt;
    const ev: MatchEvent[] = [];
    switch (this.phase) {
      case 'waiting':
        if (this.players.size >= this.rules.minPlayers && (this.rules.autoStart || this.startRequested)) {
          this.startRun(ev);
          break;
        }
        this.startRequested = false;
        this.timer += dt;
        this.world(dt, ev, false);
        break;
      case 'day':
      case 'dusk':
      case 'night':
      case 'holdout': {
        this.runTime += dt;
        this.timer -= dt;
        this.world(dt, ev, true);
        if (this.allDown()) {
          this.endRun(ev, false);
          break;
        }
        if (this.timer > 1e-9) break;
        if (this.phase === 'day') this.toDusk(ev);
        else if (this.phase === 'dusk') this.toNight(ev);
        else if (this.phase === 'night') this.toDawn(ev);
        else this.toEscape(ev);
        break;
      }
      case 'escape':
        this.runTime += dt;
        this.timer -= dt;
        this.escapeStep(dt, ev);
        if (this.timer <= 1e-9) this.endRun(ev, true);
        break;
      case 'over':
        this.timer -= dt;
        if (this.timer > 1e-9) break;
        if (this.players.size > 0 && this.rules.autoStart) this.startRun(ev);
        else this.toWaiting(ev);
        break;
    }
    this.record();
    return ev;
  }

  /** Every survivor in the run is down or dead (a solo survivor with a second wind left still can get up). */
  private allDown(): boolean {
    const run = this.runners;
    if (run.length === 0) return false;
    if (run.some((p) => p.life === 'alive')) return false;
    if (run.length === 1 && run[0]!.life === 'down' && run[0]!.secondWind) return false;
    return true;
  }

  // ---- run lifecycle ---------------------------------------------------------------------------------------------

  private resetWorld() {
    this.zombies.clear();
    this.rocks.clear();
    this.goo.clear();
    this.pickups.clear();
    this.opened.fill(false);
    this.barricades.fill(null);
    this.hordeQueue = [];
    Object.assign(this.dog, {
      x: DOG_SPOT.x,
      y: DOG_SPOT.y,
      vx: 0,
      vy: 0,
      facing: Math.PI,
      state: 0,
      hp: DOG_HP,
      owner: null,
      biteCd: 0,
      barkCd: 0,
      biting: 0,
    });
    Object.assign(this.truck, { wheels: 0, fuel: 0, scrap: 0, x: TRUCK.x, y: TRUCK.y, yaw: TRUCK.yaw });
    for (const s of PART_SPOTS) this.addPickup(s.item === 'wheel' ? Item.wheel : Item.fuel, s.x, s.y, Infinity);
    this.updateCosts();
  }

  private resetPlayer(p: Player) {
    Object.assign(p, {
      hp: PLAYER_HP,
      armor: 0,
      life: 'alive' as Life,
      downFor: 0,
      revive: 0,
      secondWind: true,
      gun: Item.pistol,
      melee: Item.knife,
      durability: MELEE[Item.knife]!.durability,
      ammo: AMMO.map((a) => a.start),
      items: [Item.none, Item.none],
      carry: Item.none,
      action: null,
      actLatch: false,
      kills: 0,
      guitarKills: 0,
      revives: 0,
      downs: 0,
      foundDog: false,
    });
  }

  /** At a safehouse spawn point, standing, facing north. */
  private spawn(p: Player) {
    const s = SPAWNS[p.slot % SPAWNS.length]!;
    p.x = s.x;
    p.y = s.y;
    p.vx = 0;
    p.vy = 0;
    p.aim = -Math.PI / 2;
    p.fireCd = 0;
    p.meleeCd = 0;
  }

  private startRun(ev: MatchEvent[]) {
    this.run++;
    this.startRequested = false;
    this.resetWorld();
    this.runTime = 0;
    this.night = 0;
    this.day = 1;
    this.nightsSurvived = 0;
    this.bloodMoons = 0;
    this.blood = false;
    this.teamKills = 0;
    this.scrap = 0;
    this.escaped = false;
    for (const p of this.ordered) {
      this.resetPlayer(p);
      this.spawn(p);
      p.inRun = true;
      p.played = true;
    }
    this.setPhase('day', this.rules.firstDayTime, ev);
    this.flowDirty = true;
  }

  private setPhase(phase: Phase, seconds: number, ev: MatchEvent[]) {
    this.phase = phase;
    this.timer = seconds;
    this.phaseLength = seconds;
    ev.push({ type: 'phase', phase });
  }

  private toDusk(ev: MatchEvent[]) {
    this.setPhase('dusk', this.rules.duskTime, ev);
  }

  /** Night `night + 1` falls: the horde is queued, day wanderers join the hunt. */
  private toNight(ev: MatchEvent[]) {
    this.night++;
    this.blood = isBloodMoon(this.night);
    this.setPhase('night', this.rules.nightTime, ev);
    for (const p of this.ordered) p.secondWind ||= this.runners.length === 1;
    const s = nightStrength(effectiveNight(this.night));
    for (const z of this.zombies.values()) {
      const spec = ZOMBIES[z.kind]!;
      const frac = z.hp / z.maxHp;
      z.horde = true;
      z.maxHp = Math.round(spec.hp * s.hp);
      z.hp = Math.max(1, z.maxHp * frac);
      z.run = spec.run * s.speed;
      z.walk = spec.walk * s.speed;
      z.damage = spec.damage * s.damage;
    }
    this.queueHorde(this.night, this.blood);
    ev.push({ type: 'night', night: this.night, blood: this.blood });
  }

  /** The horde for night `n`: its size and mix, shuffled, the first few always basic. */
  private queueHorde(n: number, _blood: boolean) {
    const total = Math.round(hordeSize(n, this.runners.length) * this.rules.spawnScale);
    const mix = hordeMix(n);
    const brutes = Math.min(mix.brutes, Math.floor(total / 6));
    const chubby = Math.round(total * mix.chubby);
    const crawler = Math.round(total * mix.crawler);
    const queue: ZombieKind[] = [];
    for (let i = 0; i < total; i++) {
      queue.push(
        i < brutes
          ? ZombieKind.brute
          : i < brutes + chubby
            ? ZombieKind.chubby
            : i < brutes + chubby + crawler
              ? ZombieKind.crawler
              : ZombieKind.basic,
      );
    }
    const head = queue.splice(queue.length - Math.min(4, total - brutes - chubby - crawler));
    this.hordeQueue = [...head, ...this.rng.shuffle(queue)];
    this.spawnEvery = spawnInterval(n, this.runners.length) / Math.max(0.25, this.rules.spawnScale);
    this.spawnTimer = 1;
  }

  /**
   * Dawn: the night is survived. The living heal, the downed get up, the dead come back at the safehouse, second
   * winds return, the dog gets up, the outer zone restocks, and the horde out of sight melts away.
   */
  private toDawn(ev: MatchEvent[]) {
    this.nightsSurvived = this.night;
    if (this.blood) this.bloodMoons++;
    this.blood = false;
    this.day++;
    this.hordeQueue = [];
    for (const p of this.runners) {
      if (p.life === 'alive') p.hp = Math.min(PLAYER_HP, p.hp + DAWN_HEAL);
      else if (p.life === 'down') {
        p.life = 'alive';
        p.hp = REVIVE_HP;
        ev.push({ type: 'revive', id: p.id, by: null });
      } else {
        p.life = 'alive';
        p.hp = PLAYER_HP;
        this.spawn(p);
        ev.push({ type: 'respawn', id: p.id });
      }
      p.downFor = 0;
      p.revive = 0;
      p.secondWind = true;
    }
    if (this.dog.state === 2) {
      this.dog.state = 1;
      this.dog.hp = DOG_HP;
    }
    LOOT_SPOTS.forEach((s) => {
      if (s.zone === 2) this.opened[s.id] = false;
    });
    for (const z of [...this.zombies.values()]) {
      if (this.nearestRunner(z.x, z.y).d > 18) this.zombies.delete(z.id);
      else z.horde = false;
    }
    this.flowDirty = true;
    this.setPhase('day', this.rules.dayTime, ev);
    ev.push({ type: 'dawn', nights: this.nightsSurvived });
  }

  private startHoldout(ev: MatchEvent[]) {
    this.setPhase('holdout', this.rules.holdoutTime, ev);
    this.hordeQueue = [];
    this.spawnTimer = 0.5;
    ev.push({ type: 'holdout' });
  }

  private toEscape(ev: MatchEvent[]) {
    this.setPhase('escape', this.rules.escapeTime, ev);
    this.rocks.clear();
    for (const p of this.runners) {
      p.input = { ...NO_INPUT, use: p.lastUse };
      p.action = null;
    }
    ev.push({ type: 'escape' });
  }

  /** The drive out: the truck speeds up along the path; zombies in its way are run over. */
  private escapeStep(_dt: number, ev: MatchEvent[]) {
    const u = 1 - this.timer / this.rules.escapeTime;
    const at = alongPath(ESCAPE_PATH, u ** 1.7);
    this.truck.x = at.x;
    this.truck.y = at.y;
    this.truck.yaw = at.yaw;
    for (const p of this.runners) {
      p.x = at.x;
      p.y = at.y;
      p.vx = 0;
      p.vy = 0;
    }
    for (const z of [...this.zombies.values()]) {
      if (Math.hypot(z.x - at.x, z.y - at.y) < 3.2) this.killZombie(z, null, 'truck', ev);
    }
    // The rest of the horde gives up as the truck leaves.
    if (u > 0.5) for (const z of [...this.zombies.values()]) if (this.rng.next() < 0.05) this.zombies.delete(z.id);
  }

  private endRun(ev: MatchEvent[], escaped: boolean) {
    this.escaped = escaped;
    if (escaped && this.blood) this.bloodMoons++;
    this.setPhase('over', this.rules.overTime, ev);
    this.hordeQueue = [];
    for (const p of this.ordered) {
      p.input = { ...NO_INPUT, use: p.lastUse, aim: p.input.aim };
      p.action = null;
    }
    const summary: RunSummary = {
      run: this.run,
      nights: this.nightsSurvived,
      duration: this.runTime,
      escaped,
      bloodMoons: this.bloodMoons,
      teamKills: this.teamKills,
      standings: this.standings(),
    };
    ev.push({ type: 'runOver', summary });
  }

  private toWaiting(ev: MatchEvent[]) {
    this.phase = 'waiting';
    this.timer = 0;
    this.phaseLength = 0;
    this.night = 0;
    this.day = 1;
    this.startRequested = false;
    this.resetWorld();
    for (const p of this.ordered) {
      this.resetPlayer(p);
      this.spawn(p);
      p.inRun = false;
      p.played = false;
    }
    ev.push({ type: 'phase', phase: 'waiting' });
  }

  // ---- the world -------------------------------------------------------------------------------------------------

  private world(dt: number, ev: MatchEvent[], running: boolean) {
    if (this.siegeDirty) {
      this.siege.compute([SAFE_CENTER]);
      this.siegeDirty = false;
    }
    if (this.flowDirty || this.tick % FLOW_TICKS === 0) {
      const targets: Vec2[] = [];
      for (const p of this.ordered) if (p.inRun && p.life === 'alive') targets.push(p);
      this.flow.compute(targets, FLOW_RANGE);
      this.flowDirty = false;
    }
    this.playersStep(dt, ev);
    if (running && !this.frozen) this.spawnStep(dt);
    this.zombiesStep(dt, ev);
    this.rocksStep(dt, ev);
    this.gooStep(dt);
    this.dogStep(dt, ev);
    this.pickupsStep(dt, ev);
    this.downedStep(dt, ev);
  }

  private gooCenters(): Vec2[] {
    return [...this.goo.values()];
  }

  /** Speed multiplier of a survivor: crawling, carrying, or running (goo is applied by `movePlayer`). */
  speedOf(p: Pick<Player, 'life' | 'carry'>): number {
    return p.life === 'down' ? DOWN_SPEED : p.carry ? CARRY_SPEED : 1;
  }

  private playersStep(dt: number, ev: MatchEvent[]) {
    const goo = this.gooCenters();
    for (const p of this.ordered) {
      if (p.life === 'dead') continue;
      const input = p.connected ? p.input : NO_INPUT;
      if (input.aim && p.life === 'alive') p.aim = Math.atan2(input.aim.y, input.aim.x);
      movePlayer(p, input.move, this.speedOf(p), goo, dt);
      p.fireCd -= dt;
      p.meleeCd -= dt;
      if (p.life === 'alive' && this.phase !== 'over') {
        if (input.use !== p.lastUse) {
          p.lastUse = input.use;
          this.useItem(p, input.slot, ev);
        }
        if (input.melee && p.meleeCd <= 1e-9 && !p.carry) {
          this.swing(p, ev);
        } else if (input.fire && p.gun && !p.carry) {
          const gun = GUNS[p.gun]!;
          for (let shots = 0; p.fireCd <= 1e-9 && shots < 4; shots++) {
            if (!this.fire(p, gun, ev)) {
              if (p.fireCd <= 1e-9) p.fireCd = 0.5;
              break;
            }
            p.fireCd += gun.cooldown;
          }
        }
      }
      if (p.fireCd < 0) p.fireCd = 0;
      if (p.meleeCd < 0) p.meleeCd = 0;
      this.actionStep(p, input.act && this.phase !== 'over' && this.phase !== 'escape', dt, ev);
    }
  }

  // ---- weapons ---------------------------------------------------------------------------------------------------

  /** One shot. False when there is no ammo (an empty click). */
  private fire(p: Player, gun: GunSpec, ev: MatchEvent[]): boolean {
    if ((p.ammo[gun.ammo] ?? 0) <= 0) {
      ev.push({ type: 'empty', by: p.id });
      return false;
    }
    p.ammo[gun.ammo]!--;
    const rays: number[] = [];
    for (let k = 0; k < gun.pellets; k++) {
      const off = gun.pellets > 1 ? -gun.spread / 2 + (gun.spread * k) / (gun.pellets - 1) : 0;
      const a = p.aim + off + (this.rng.next() * 2 - 1) * gun.jitter;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const ox = p.x + dx * 0.35;
      const oy = p.y + dy * 0.35;
      const wall = GRID.ray(ox, oy, dx, dy, gun.range);
      const hits: { z: Zombie; t: number }[] = [];
      for (const z of this.zombies.values()) {
        const at = this.zombieAt(z, this.tick - p.viewDelay);
        const t = rayCircle(ox, oy, dx, dy, at.x, at.y, ZOMBIES[z.kind]!.radius + 0.08, wall);
        if (t !== null) hits.push({ z, t });
      }
      hits.sort((u, v) => u.t - v.t || u.z.id - v.z.id);
      let end = wall;
      const pierced = hits.slice(0, gun.pierce);
      for (const h of pierced) this.damageZombie(h.z, gun.damage, dx * gun.knock, dy * gun.knock, p, gun.item, ev);
      if (pierced.length >= gun.pierce && pierced.length > 0) end = pierced[pierced.length - 1]!.t;
      rays.push(ox, oy, ox + dx * end, oy + dy * end);
    }
    ev.push({ type: 'shot', by: p.id, item: gun.item, rays });
    return true;
  }

  /** The melee weapon in hand (fists without one). */
  meleeOf(p: Pick<Player, 'melee'>): MeleeSpec {
    return MELEE[p.melee] ?? FISTS;
  }

  /** A swing: every zombie in reach inside the arc (where the swinger saw it), nearest first, up to `maxHits`. */
  private swing(p: Player, ev: MatchEvent[]) {
    const spec = this.meleeOf(p);
    p.meleeCd = spec.cooldown;
    const found: { z: Zombie; d: number }[] = [];
    for (const z of this.zombies.values()) {
      const at = this.zombieAt(z, this.tick - p.viewDelay);
      const dx = at.x - p.x;
      const dy = at.y - p.y;
      const d = Math.hypot(dx, dy);
      const r = ZOMBIES[z.kind]!.radius;
      if (d > spec.range + r) continue;
      const off = Math.abs(wrap(Math.atan2(dy, dx) - p.aim));
      if (off > spec.arc && d > r + PLAYER_RADIUS + 0.15) continue;
      if (!GRID.clear(p.x, p.y, at.x, at.y)) continue;
      found.push({ z, d });
    }
    found.sort((a, b) => a.d - b.d || a.z.id - b.z.id);
    const hits = found.slice(0, spec.maxHits);
    const dx = Math.cos(p.aim);
    const dy = Math.sin(p.aim);
    for (const h of hits) this.damageZombie(h.z, spec.damage, dx * spec.knock, dy * spec.knock, p, p.melee, ev);
    ev.push({ type: 'swing', by: p.id, item: p.melee, x: p.x, y: p.y, angle: p.aim, hits: hits.length });
    if (hits.length > 0 && p.melee && Number.isFinite(spec.durability)) {
      p.durability--;
      if (p.durability <= 0) {
        ev.push({ type: 'broke', by: p.id, item: p.melee });
        p.melee = Item.none;
        p.durability = 0;
      }
    }
  }

  /** Damage a zombie (exposed for tests and dev commands). */
  damageZombie(
    z: Zombie,
    amount: number,
    kx: number,
    ky: number,
    by: Player | null,
    cause: Cause,
    ev: MatchEvent[],
  ): void {
    if (!this.zombies.has(z.id)) return;
    const spec = ZOMBIES[z.kind]!;
    z.hp -= amount;
    z.kx += kx * (1 - spec.knockResist);
    z.ky += ky * (1 - spec.knockResist);
    // Hit from out of the dark: it turns on whoever hit it.
    if (by && !z.target) z.target = by.id;
    ev.push({ type: 'hit', zombie: z.id, by: by?.id ?? null, x: z.x, y: z.y });
    if (z.hp <= 1e-6) this.killZombie(z, by, cause, ev);
  }

  private killZombie(z: Zombie, by: Player | null, cause: Cause, ev: MatchEvent[]) {
    if (!this.zombies.delete(z.id)) return;
    this.teamKills++;
    if (by) {
      by.kills++;
      if (cause === Item.guitar) by.guitarKills++;
    }
    ev.push({ type: 'kill', zombie: z.id, kind: z.kind, x: z.x, y: z.y, by: by?.id ?? null, cause });
    if (z.kind === ZombieKind.chubby) {
      const id = this.nextEntityId++;
      this.goo.set(id, { id, x: z.x, y: z.y, ttl: GOO_TIME });
      ev.push({ type: 'goo', x: z.x, y: z.y });
    }
    const night = this.phase === 'night' || this.phase === 'holdout';
    if (cause !== 'truck' && this.rng.next() < (night ? DROP_CHANCE_NIGHT : DROP_CHANCE_DAY)) {
      this.drop(this.rng.next() < 0.6 ? this.ammoFor(by) : Item.scrap, z.x, z.y);
    }
  }

  // ---- items -----------------------------------------------------------------------------------------------------

  private useItem(p: Player, slot: number, ev: MatchEvent[]) {
    const code = p.items[slot] ?? Item.none;
    const heal = HEAL[code];
    if (heal !== undefined) {
      if (p.hp >= PLAYER_HP) return;
      p.hp = Math.min(PLAYER_HP, p.hp + heal);
      p.items[slot] = Item.none;
      ev.push({ type: 'use', by: p.id, item: code });
    }
    // Kits are placed with the context button at a socket.
  }

  /** An ammo pickup: mostly for the gun you hold, else any. */
  private ammoFor(p: Player | null): number {
    if (p?.gun && this.rng.next() < 0.6) return AMMO[GUNS[p.gun]!.ammo]!.item;
    const r = this.rng.next();
    return r < 0.4 ? Item.ammo_pistol : r < 0.65 ? Item.ammo_smg : r < 0.85 ? Item.ammo_shells : Item.ammo_rifle;
  }

  private addPickup(kind: number, x: number, y: number, ttl = PICKUP_TTL): Pickup | null {
    if (this.pickups.size >= MAX_PICKUPS && ttl !== Infinity) return null;
    const id = this.nextEntityId++;
    const pk = { id, kind, x, y, ttl };
    this.pickups.set(id, pk);
    return pk;
  }

  /** Something dropped on the ground near (x, y) (a free spot). */
  private drop(kind: number, x: number, y: number) {
    for (let k = 0; k < 6; k++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = k === 0 ? 0 : 0.4 + k * 0.15;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (circleIsFree(px, py, 0.25)) {
        this.addPickup(kind, px, py, itemKind(kind) === 'part' ? Infinity : PICKUP_TTL);
        return;
      }
    }
    this.addPickup(kind, x, y, itemKind(kind) === 'part' ? Infinity : PICKUP_TTL);
  }

  /** Walking over ammo, scrap, heals, kits and armor picks them up (if there is room). */
  private pickupsStep(dt: number, ev: MatchEvent[]) {
    for (const pk of [...this.pickups.values()]) {
      pk.ttl -= dt;
      if (pk.ttl <= 0) {
        this.pickups.delete(pk.id);
        continue;
      }
      const kind = itemKind(pk.kind);
      if (kind === 'gun' || kind === 'melee' || kind === 'part') continue;
      for (const p of this.ordered) {
        if (p.life !== 'alive' || !p.inRun) continue;
        if ((p.x - pk.x) ** 2 + (p.y - pk.y) ** 2 > PICKUP_RADIUS * PICKUP_RADIUS) continue;
        if (!this.take(p, pk.kind)) continue;
        this.pickups.delete(pk.id);
        ev.push({ type: 'loot', by: p.id, item: pk.kind });
        break;
      }
    }
  }

  /** Put an auto-picked item in `p`'s pockets; false when there is no room. */
  private take(p: Player, code: number): boolean {
    const kind = itemKind(code);
    if (kind === 'ammo') {
      const type = AMMO.findIndex((a) => a.item === code);
      const a = AMMO[type]!;
      if (p.ammo[type]! >= a.max) return false;
      p.ammo[type] = Math.min(a.max, p.ammo[type]! + a.pickup);
      return true;
    }
    if (kind === 'scrap') {
      this.scrap += SCRAP_PER_PICKUP;
      return true;
    }
    if (kind === 'armor') {
      if (p.armor >= ARMOR_MAX) return false;
      p.armor = ARMOR_MAX;
      return true;
    }
    if (kind === 'use' || kind === 'kit') {
      const slot = p.items.indexOf(Item.none);
      if (slot < 0) return false;
      p.items[slot] = code;
      return true;
    }
    return false;
  }

  // ---- the context button ----------------------------------------------------------------------------------------

  /** What the context chooser sees for survivor `p`. */
  actionContext(p: Player): ActionContext {
    return {
      me: {
        x: p.x,
        y: p.y,
        alive: p.life === 'alive',
        down: p.life === 'down',
        carry: p.carry,
        items: p.items,
        secondWind: p.secondWind && this.runners.length === 1,
      },
      others: this.ordered
        .filter((o) => o !== p && o.inRun && o.life !== 'dead')
        .map((o) => ({ id: o.id, name: o.name, x: o.x, y: o.y, down: o.life === 'down' })),
      dog: this.inRun ? { x: this.dog.x, y: this.dog.y, state: this.dog.state } : null,
      opened: (id) => this.opened[id] ?? true,
      pickups: [...this.pickups.values()],
      sockets: this.barricades.map((b) => b?.tier ?? 0),
      scrap: this.scrap,
      truck: this.truck,
      canStart: this.canStart,
    };
  }

  private actionStep(p: Player, held: boolean, dt: number, ev: MatchEvent[]) {
    if (!held) {
      p.action = null;
      p.actLatch = false;
      return;
    }
    if (p.actLatch || p.life === 'dead') return;
    const choice = chooseAction(this.actionContext(p));
    if (!choice) {
      p.action = null;
      return;
    }
    if (!p.action || p.action.kind !== choice.kind || p.action.target !== choice.target) {
      p.action = { ...choice, progress: 0 };
    }
    p.action.progress += dt;
    if (p.action.progress + 1e-9 < choice.time) return;
    p.action = null;
    p.actLatch = true;
    this.perform(p, choice, ev);
  }

  private perform(p: Player, a: ActionChoice, ev: MatchEvent[]) {
    switch (a.kind) {
      case Action.revive: {
        const o = this.players.get(a.target as string);
        if (!o || o.life !== 'down') return;
        this.getUp(o, p, ev);
        p.revives++;
        return;
      }
      case Action.selfRevive:
        p.secondWind = false;
        this.getUp(p, null, ev);
        return;
      case Action.reviveDog:
        this.dog.state = 1;
        this.dog.hp = DOG_HP / 2;
        ev.push({ type: 'dog', state: 1, by: p.id });
        return;
      case Action.recruitDog: {
        this.dog.state = 1;
        this.dog.owner = p.id;
        for (const o of this.runners) {
          if (Math.hypot(o.x - this.dog.x, o.y - this.dog.y) <= DOG_FINDERS) o.foundDog = true;
        }
        p.foundDog = true;
        ev.push({ type: 'dog', state: 1, by: p.id });
        return;
      }
      case Action.pickupPart: {
        const pk = this.pickups.get(a.target as number);
        if (!pk) return;
        this.pickups.delete(pk.id);
        if (p.carry) this.drop(p.carry, p.x, p.y);
        p.carry = pk.kind;
        p.action = null;
        ev.push({ type: 'loot', by: p.id, item: pk.kind });
        return;
      }
      case Action.installPart:
        if (p.carry === Item.wheel && this.truck.wheels < TRUCK_WHEELS) this.truck.wheels++;
        else if (p.carry === Item.fuel && this.truck.fuel < TRUCK_FUEL) this.truck.fuel++;
        else return;
        ev.push({ type: 'part', item: p.carry, by: p.id });
        p.carry = Item.none;
        return;
      case Action.addScrap: {
        const amount = Math.min(this.scrap, TRUCK_SCRAP - this.truck.scrap);
        if (amount <= 0) return;
        this.scrap -= amount;
        this.truck.scrap += amount;
        ev.push({ type: 'scrap', amount, by: p.id });
        return;
      }
      case Action.startTruck:
        if (this.canStart) this.startHoldout(ev);
        return;
      case Action.build: {
        const socket = a.target as number;
        const current = this.barricades[socket]?.tier ?? 0;
        const opt = barricadeOption(current, p.items, this.scrap);
        if (!opt) return;
        if (opt.kitSlot >= 0) p.items[opt.kitSlot] = Item.none;
        else this.scrap -= opt.cost;
        const hp = BARRICADES[opt.tier - 1]!.hp;
        this.barricades[socket] = { tier: opt.tier, hp, maxHp: hp };
        this.updateCosts();
        ev.push({ type: 'build', socket, tier: opt.tier, by: p.id });
        return;
      }
      case Action.open:
      case Action.search: {
        const spot = LOOT_SPOTS[a.target as number];
        if (!spot || this.opened[spot.id]) return;
        this.opened[spot.id] = true;
        const items = this.rollLoot(spot.kind, spot.zone, p);
        // The loot pops out at the opener's feet (ammo, scrap and heals go straight into the pockets).
        for (const code of items) this.drop(code, p.x + Math.cos(p.aim) * 0.3, p.y + Math.sin(p.aim) * 0.3);
        ev.push({ type: 'open', spot: spot.id, by: p.id, items: items.length });
        return;
      }
      case Action.pickup: {
        const pk = this.pickups.get(a.target as number);
        if (!pk) return;
        const kind = itemKind(pk.kind);
        this.pickups.delete(pk.id);
        if (kind === 'gun') {
          if (p.gun) this.addPickup(p.gun, pk.x, pk.y);
          p.gun = pk.kind;
        } else if (kind === 'melee') {
          if (p.melee) this.addPickup(p.melee, pk.x, pk.y);
          p.melee = pk.kind;
          p.durability = MELEE[pk.kind]!.durability;
        }
        ev.push({ type: 'loot', by: p.id, item: pk.kind });
        return;
      }
      case Action.dropPart:
        if (p.carry) this.drop(p.carry, p.x, p.y);
        p.carry = Item.none;
        return;
    }
  }

  /** What a container gives (see `LOOT`): at least one item from a chest. */
  rollLoot(kind: 'chest' | 'special' | 'search', zone: 0 | 1 | 2, p: Player | null): number[] {
    const spec = LOOT[kind];
    const table = spec.table[zone]!;
    const rolls = spec.rolls[zone]!;
    const out: number[] = [];
    const pick = (lines: readonly LootLine[]) => {
      const total = lines.reduce((s, l) => s + l[1], 0);
      let r = this.rng.next() * total;
      for (const l of lines) {
        r -= l[1];
        if (r < 0) return l[0];
      }
      return lines[lines.length - 1]![0];
    };
    for (let i = 0; i < rolls; i++) {
      // Chests never come up empty: re-roll a "nothing".
      let line = pick(table);
      if (kind !== 'search' && line === 'nothing') line = 'ammo';
      if (line === 'nothing') continue;
      out.push(line === 'ammo' ? this.ammoFor(p) : line);
    }
    if (kind === 'special' && !out.some((c) => itemKind(c) === 'gun')) {
      out[0] = [Item.shotgun, Item.rifle, Item.smg][this.rng.int(3)]!;
    }
    return out;
  }

  private getUp(p: Player, by: Player | null, ev: MatchEvent[]) {
    p.life = 'alive';
    p.hp = REVIVE_HP;
    p.downFor = 0;
    p.revive = 0;
    this.flowDirty = true;
    ev.push({ type: 'revive', id: p.id, by: by?.id ?? null });
  }

  /** Downed survivors bleed out; their revive progress is the best of their rescuers'. */
  private downedStep(dt: number, ev: MatchEvent[]) {
    for (const p of this.ordered) {
      if (p.life !== 'down') {
        p.revive = 0;
        continue;
      }
      let best = 0;
      for (const o of this.ordered) {
        if (o.action?.kind === Action.revive && o.action.target === p.id) best = Math.max(best, o.action.progress);
      }
      p.revive = p.action?.kind === Action.selfRevive ? p.action.progress : best;
      if (best > 0) continue; // a rescuer at work stops the bleeding
      p.downFor += dt;
      if (p.downFor >= BLEED_OUT) {
        p.life = 'dead';
        p.action = null;
        ev.push({ type: 'dead', id: p.id });
      }
    }
  }

  /** Damage a standing survivor (exposed for dev commands and tests). Armor soaks part of it. */
  hurt(p: Player, damage: number, ev: MatchEvent[]): void {
    if (p.life !== 'alive' || damage <= 0 || this.invulnerable || !p.inRun) return;
    let d = damage;
    if (p.armor > 0) {
      const soak = Math.min(p.armor, d * ARMOR_SOAK);
      p.armor -= soak;
      d -= soak;
    }
    p.hp = Math.max(0, p.hp - d);
    ev.push({ type: 'hurt', id: p.id, hp: p.hp, damage: Math.round(d) });
    if (p.hp <= 1e-6) this.knockDown(p, ev);
  }

  /** Down: crawling, no attacks; a teammate can revive (or a solo survivor's second wind). */
  knockDown(p: Player, ev: MatchEvent[]): void {
    if (p.life !== 'alive') return;
    p.life = 'down';
    p.hp = 0;
    p.downFor = 0;
    p.revive = 0;
    p.downs++;
    p.action = null;
    p.vx *= 0.3;
    p.vy *= 0.3;
    if (p.carry) {
      this.drop(p.carry, p.x, p.y);
      p.carry = Item.none;
    }
    this.flowDirty = true;
    ev.push({ type: 'down', id: p.id });
  }

  // ---- zombies ---------------------------------------------------------------------------------------------------

  /** The nearest survivor in the run (any state but dead) and its distance. */
  private nearestRunner(x: number, y: number): { p: Player | null; d: number } {
    let best: Player | null = null;
    let d = Infinity;
    for (const p of this.ordered) {
      if (!p.inRun || p.life === 'dead') continue;
      const dd = Math.hypot(p.x - x, p.y - y);
      if (dd < d) [d, best] = [dd, p];
    }
    return { p: best, d };
  }

  private spawnStep(dt: number) {
    const cap = this.rules.maxZombies;
    const runners = this.runners.filter((p) => p.life !== 'dead');
    if (runners.length === 0) return;
    this.spawnTimer -= dt;
    if (this.phase === 'day' || this.phase === 'dusk') {
      const want = Math.round(dayPopulation(this.day, this.runners.length) * this.rules.spawnScale);
      let wanderers = 0;
      for (const z of this.zombies.values()) if (!z.horde) wanderers++;
      if (wanderers < want && this.zombies.size < cap && this.spawnTimer <= 0) {
        const kind = this.day >= 4 && this.rng.next() < 0.2 ? ZombieKind.crawler : ZombieKind.basic;
        const at = this.spawnPoint(runners, 34, 72, false);
        if (at) this.spawnZombie(kind, at.x, at.y, false);
        this.spawnTimer = 0.5;
      }
      // Wanderers nobody is near are recycled (the town feels populated where you are).
      for (const z of [...this.zombies.values()]) {
        if (!z.horde && this.nearestRunner(z.x, z.y).d > 100) this.zombies.delete(z.id);
      }
      return;
    }
    if (this.phase === 'night') {
      while (this.spawnTimer <= 0 && this.hordeQueue.length > 0) {
        if (this.zombies.size >= cap) {
          this.spawnTimer = 0.2;
          return;
        }
        const at = this.spawnPoint(runners, 30, 54, true);
        if (!at) {
          this.spawnTimer = 0.2;
          return;
        }
        const z = this.spawnZombie(this.hordeQueue.shift()!, at.x, at.y, true);
        z.siege = this.rng.next() < 0.3;
        this.spawnTimer += this.spawnEvery;
      }
      return;
    }
    if (this.phase === 'holdout') {
      // The full horde, endlessly: as fast as the cap allows, from all round the safehouse.
      const n = Math.max(ESCAPE_FROM_NIGHT, this.night);
      const mix = hordeMix(n);
      while (this.spawnTimer <= 0) {
        if (this.zombies.size >= cap || this.rules.spawnScale <= 0) {
          this.spawnTimer = 0.25;
          return;
        }
        const r = this.rng.next();
        let brutes = 0;
        for (const z of this.zombies.values()) if (z.kind === ZombieKind.brute) brutes++;
        const kind =
          brutes < mix.brutes && r < 0.05
            ? ZombieKind.brute
            : r < 0.05 + mix.chubby
              ? ZombieKind.chubby
              : r < 0.05 + mix.chubby + mix.crawler
                ? ZombieKind.crawler
                : ZombieKind.basic;
        const at = this.spawnPoint([SAFE_CENTER], 26, 48, true, runners);
        if (at) {
          const z = this.spawnZombie(kind, at.x, at.y, true);
          z.siege = true;
        }
        this.spawnTimer += 0.22 / Math.max(0.25, this.rules.spawnScale);
      }
    }
  }

  /**
   * A street point between `min` and `max` from an anchor (a random one of `anchors`) and at least 24 from every
   * survivor (`away`, default the anchors), out of sight. `outskirts` favours points far from the safehouse (the horde
   * comes in from the edge of town); day wanderers favour the outer zones.
   */
  private spawnPoint(
    anchors: readonly Vec2[],
    min: number,
    max: number,
    outskirts: boolean,
    away: readonly Vec2[] = anchors,
  ): Vec2 | null {
    const a = anchors[this.rng.int(anchors.length)]!;
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    for (let tries = 0; tries < 24; tries++) {
      const pt = STREET_POINTS[this.rng.int(STREET_POINTS.length)]!;
      const d = Math.hypot(pt.x - a.x, pt.y - a.y);
      if (d < min || d > max) continue;
      if (away.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < 24)) continue;
      const score = outskirts ? pt.out + this.rng.next() * 30 : pt.zone * 30 + this.rng.next() * 40;
      if (score > bestScore) [bestScore, best] = [score, pt];
    }
    if (best) return best;
    // Fall back to any free point in the ring.
    for (const pt of STREET_POINTS) {
      const d = Math.hypot(pt.x - a.x, pt.y - a.y);
      if (d >= min && d <= max && !away.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < 20)) return pt;
    }
    return null;
  }

  /** A zombie of `kind` at (x, y) with the strength of now (exposed for dev commands and tests). */
  spawnZombie(
    kind: ZombieKind,
    x: number,
    y: number,
    horde = this.phase === 'night' || this.phase === 'holdout',
  ): Zombie {
    const spec = ZOMBIES[kind]!;
    const s = horde ? nightStrength(effectiveNight(Math.max(1, this.night))) : dayStrength(this.day);
    const id = this.nextZombieId++;
    const hp = Math.round(spec.hp * s.hp);
    const vary = this.rng.range(0.9, 1.1);
    const z: Zombie = {
      id,
      kind,
      x,
      y,
      vx: 0,
      vy: 0,
      kx: 0,
      ky: 0,
      hp,
      maxHp: hp,
      run: spec.run * s.speed * vary,
      walk: spec.walk * s.speed * vary,
      damage: spec.damage * s.damage,
      attackCd: 0.6,
      horde,
      siege: false,
      target: null,
      thinkCd: this.rng.range(0, 0.3),
      wx: x,
      wy: y,
      wanderCd: 0,
      windup: 0,
      tx: 0,
      ty: 0,
      rockCd: ROCK_COOLDOWN * this.rng.range(0.3, 0.8),
      idle: 0,
      facing: this.rng.range(-Math.PI, Math.PI),
      born: this.tick,
      hx: new Float32Array(HISTORY_TICKS).fill(x),
      hy: new Float32Array(HISTORY_TICKS).fill(y),
    };
    this.zombies.set(id, z);
    return z;
  }

  /** Where zombie `z` was at (fractional) tick `t` (lag compensation); now for anything newer or unknown. */
  zombieAt(z: Zombie, t: number): Vec2 {
    if (t >= this.tick - 1e-6) return z;
    const oldest = Math.max(z.born, this.tick - HISTORY_TICKS + 1);
    const tt = Math.max(oldest, t);
    const a = Math.floor(tt);
    const k = tt - a;
    const ia = ((a % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    const pa = { x: z.hx[ia]!, y: z.hy[ia]! };
    if (k < 1e-6 || a + 1 > this.tick) return pa;
    const ib = (((a + 1) % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    const pb = a + 1 >= this.tick ? { x: z.x, y: z.y } : { x: z.hx[ib]!, y: z.hy[ib]! };
    return { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
  }

  private record() {
    const i = this.tick % HISTORY_TICKS;
    for (const z of this.zombies.values()) {
      z.hx[i] = z.x;
      z.hy[i] = z.y;
    }
  }

  /** The boxes of standing barricades (zombies collide with them; survivors walk through). */
  barricadeBoxes(): { box: Aabb; socket: number }[] {
    const out: { box: Aabb; socket: number }[] = [];
    this.barricades.forEach((b, i) => {
      if (b) out.push({ box: SOCKETS[i]!, socket: i });
    });
    return out;
  }

  private updateCosts() {
    SOCKETS.forEach((s, i) => {
      const cost = this.barricades[i] ? BARRICADE_COST : 0;
      this.flow.setCost(s, cost);
      this.siege.setCost(s, cost);
    });
    this.flowDirty = true;
    this.siegeDirty = true;
  }

  private zombiesStep(dt: number, ev: MatchEvent[]) {
    const knockDecay = (h: number) => Math.exp(-h * 7);
    const bars = this.barricadeBoxes();
    const barBoxes = bars.map((b) => b.box);
    const runners = this.ordered.filter((p) => p.inRun && p.life !== 'dead');
    const night = this.phase === 'night' || this.phase === 'holdout' || this.phase === 'escape';
    for (const z of this.zombies.values()) {
      const spec = ZOMBIES[z.kind]!;
      const near = this.nearestRunner(z.x, z.y);
      let h = dt;
      if (near.d > ACTIVE_RADIUS) {
        // Far from everyone: a coarse step now and then (no separation, no attacks).
        z.idle += dt;
        if (z.idle < SLEEP_STEP) continue;
        h = z.idle;
      }
      z.idle = 0;
      z.attackCd -= h;
      z.rockCd -= h;
      z.thinkCd -= h;
      if (this.frozen) continue;
      if (z.thinkCd <= 0) {
        z.thinkCd = 0.25;
        this.think(z, runners, night);
      }
      const target = this.targetOf(z);
      let wx = 0;
      let wy = 0;
      let speed = z.walk;
      if (z.windup > 0) {
        // Winding up a throw: plant the feet; the rock leaves at the end.
        z.windup -= h;
        z.facing = Math.atan2(z.ty - z.y, z.tx - z.x);
        if (z.windup <= 0) {
          z.windup = 0;
          this.throwRock(z);
        }
      } else if (target) {
        const dx = target.x - z.x;
        const dy = target.y - z.y;
        const dist = Math.hypot(dx, dy) || 1;
        speed = z.run;
        const sees = dist < 12 && GRID.clear(z.x, z.y, target.x, target.y);
        let dir: Vec2 | null = sees ? { x: dx / dist, y: dy / dist } : null;
        if (!dir && z.target !== 'dog') dir = this.flow.direction(z.x, z.y);
        dir ??= { x: dx / dist, y: dy / dist };
        // The brute throws from range at what it can see.
        if (
          z.kind === ZombieKind.brute &&
          z.rockCd <= 0 &&
          dist >= ROCK_MIN &&
          dist <= ROCK_MAX &&
          GRID.clear(z.x, z.y, target.x, target.y)
        ) {
          z.windup = ROCK_WINDUP;
          z.tx = target.x;
          z.ty = target.y;
          z.rockCd = ROCK_COOLDOWN * this.rng.range(0.85, 1.15);
          ev.push({ type: 'windup', zombie: z.id, x: z.tx, y: z.ty });
        } else {
          [wx, wy] = [dir.x * speed, dir.y * speed];
        }
        const reach = spec.radius + (z.target === 'dog' ? DOG_RADIUS : PLAYER_RADIUS) + spec.reach;
        if (z.attackCd <= 0 && dist <= reach) {
          z.attackCd = spec.attackCooldown;
          if (z.target === 'dog') this.hurtDog(z.damage, ev);
          else this.hurt(target as Player, z.damage, ev);
        }
      } else if (z.horde && z.siege) {
        const dir = this.siege.direction(z.x, z.y);
        speed = z.run * 0.8;
        if (dir) [wx, wy] = [dir.x * speed, dir.y * speed];
      } else if (z.horde && runners.length) {
        const dir = this.flow.direction(z.x, z.y);
        speed = z.run;
        if (dir) [wx, wy] = [dir.x * speed, dir.y * speed];
        else {
          const dx = near.p!.x - z.x;
          const dy = near.p!.y - z.y;
          const len = Math.hypot(dx, dy) || 1;
          [wx, wy] = [(dx / len) * speed, (dy / len) * speed];
        }
      } else {
        // Shambling about.
        z.wanderCd -= h;
        if (z.wanderCd <= 0 || Math.hypot(z.wx - z.x, z.wy - z.y) < 0.6) {
          z.wanderCd = this.rng.range(3, 7);
          const a = this.rng.next() * Math.PI * 2;
          const r = this.rng.range(2, 8);
          z.wx = z.x + Math.cos(a) * r;
          z.wy = z.y + Math.sin(a) * r;
        }
        const dx = z.wx - z.x;
        const dy = z.wy - z.y;
        const len = Math.hypot(dx, dy);
        if (len > 0.3) [wx, wy] = [(dx / len) * z.walk, (dy / len) * z.walk];
      }
      const steer = Math.min(1, h * 6);
      z.vx += (wx - z.vx) * steer;
      z.vy += (wy - z.vy) * steer;
      z.x += (z.vx + z.kx) * h;
      z.y += (z.vy + z.ky) * h;
      const decay = knockDecay(h);
      z.kx *= decay;
      z.ky *= decay;
      if (Math.hypot(z.vx, z.vy) > 0.3 && z.windup <= 0) z.facing = Math.atan2(z.vy, z.vx);
    }
    if (!this.frozen) this.separate();
    for (const z of this.zombies.values()) {
      const r = ZOMBIES[z.kind]!.radius;
      for (const p of runners) pushCircleOutOfCircle(z, r, { x: p.x, y: p.y, r: PLAYER_RADIUS });
      const touched = resolveCircle(z, r, barBoxes);
      if (touched >= 0 && !this.frozen && z.attackCd <= 0 && (z.target || z.horde)) {
        z.attackCd = ZOMBIES[z.kind]!.attackCooldown;
        this.smash(bars[touched]!.socket, z.damage * ZOMBIES[z.kind]!.smash, ev);
      }
    }
  }

  /** Choose what `z` goes for: a survivor it can see (or smell, at night), the dog if it is closer, or nothing. */
  private think(z: Zombie, runners: readonly Player[], night: boolean) {
    const sight = z.horde || night ? 28 : DAY_SIGHT;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const p of runners) {
      if (p.life !== 'alive') continue;
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (d < bestD) [bestD, best] = [d, p];
    }
    const current = z.target && z.target !== 'dog' ? this.players.get(z.target) : null;
    if (current && current.life === 'alive') {
      const d = Math.hypot(current.x - z.x, current.y - z.y);
      // Day wanderers give up; anyone switches to a much closer survivor.
      if (!z.horde && d > DAY_LOSE) z.target = null;
      else if (best && best !== current && bestD < d * 0.6) z.target = best.id;
    } else {
      z.target = null;
    }
    if (!z.target && best) {
      if (z.horde) {
        // The horde hunts by the flow field: every horde zombie heads for the nearest survivor within sight (and
        // siege zombies keep for the safehouse unless one is close).
        if (!z.siege || bestD < 20) z.target = bestD < sight ? best.id : null;
      } else if (bestD < (night ? NIGHT_SIGHT : DAY_SIGHT) && GRID.clear(z.x, z.y, best.x, best.y)) {
        z.target = best.id;
      }
    }
    // The dog: bitten zombies and zombies that brush past it turn on it.
    const dog = this.dog;
    if (dog.state === 1) {
      const dd = Math.hypot(dog.x - z.x, dog.y - z.y);
      const pd = z.target && z.target !== 'dog' ? Math.hypot(best!.x - z.x, best!.y - z.y) : Infinity;
      if (dd < 2.2 && dd < pd * 0.5) z.target = 'dog';
      else if (z.target === 'dog' && dd > 4) z.target = null;
    } else if (z.target === 'dog') {
      z.target = null;
    }
  }

  private targetOf(z: Zombie): Vec2 | null {
    if (z.target === 'dog') return this.dog.state === 1 ? this.dog : null;
    if (!z.target) return null;
    const p = this.players.get(z.target);
    return p && p.life === 'alive' ? p : null;
  }

  /** Separation: overlapping zombies push each other apart (heavier ones move less), via a spatial hash. */
  private separate() {
    const list = this.sepList;
    list.length = 0;
    for (const z of this.zombies.values()) if (z.idle === 0) list.push(z);
    const n = list.length;
    if (this.sepNext.length < n) this.sepNext = new Int32Array(n * 2);
    const head = this.sepHead;
    const next = this.sepNext;
    const cellOf = (z: Zombie) => {
      const cx = Math.min(SEP_COLS - 1, Math.max(0, Math.floor((z.x + TOWN_HALF) / SEP_CELL) + 1));
      const cy = Math.min(SEP_COLS - 1, Math.max(0, Math.floor((z.y + TOWN_HALF) / SEP_CELL) + 1));
      return [cx, cy] as const;
    };
    const used: number[] = [];
    for (let i = 0; i < n; i++) {
      const [cx, cy] = cellOf(list[i]!);
      const c = cy * SEP_COLS + cx;
      if (head[c] === 0) used.push(c);
      next[i] = head[c]! - 1;
      head[c] = i + 1;
    }
    for (let i = 0; i < n; i++) {
      const a = list[i]!;
      const sa = ZOMBIES[a.kind]!;
      const [cx, cy] = cellOf(a);
      for (let oy = -1; oy <= 1; oy++) {
        const y = cy + oy;
        if (y < 0 || y >= SEP_COLS) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const x = cx + ox;
          if (x < 0 || x >= SEP_COLS) continue;
          for (let j = head[y * SEP_COLS + x]! - 1; j !== -1; j = next[j]!) {
            if (j <= i) continue;
            const b = list[j]!;
            const sb = ZOMBIES[b.kind]!;
            const min = sa.radius + sb.radius;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-6) [dx, dy, d] = [1, 0, 1];
            const push = (min - Math.min(d, min)) * 0.6;
            const nx = dx / d;
            const ny = dy / d;
            const wa = sb.mass / (sa.mass + sb.mass);
            const wb = 1 - wa;
            a.x -= nx * push * wa;
            a.y -= ny * push * wa;
            b.x += nx * push * wb;
            b.y += ny * push * wb;
          }
        }
      }
    }
    for (const c of used) head[c] = 0;
  }

  private throwRock(z: Zombie) {
    const id = this.nextEntityId++;
    this.rocks.set(id, {
      id,
      sx: z.x,
      sy: z.y,
      tx: z.tx,
      ty: z.ty,
      x: z.x,
      y: z.y,
      h: 2.6,
      t: 0,
      damage: ROCK_DAMAGE * (z.damage / ZOMBIES[ZombieKind.brute]!.damage),
    });
  }

  private rocksStep(dt: number, ev: MatchEvent[]) {
    for (const r of [...this.rocks.values()]) {
      r.t += dt;
      const u = Math.min(1, r.t / ROCK_FLIGHT);
      r.x = r.sx + (r.tx - r.sx) * u;
      r.y = r.sy + (r.ty - r.sy) * u;
      r.h = 2.6 * (1 - u) + 4 * 3 * u * (1 - u);
      if (u < 1) continue;
      this.rocks.delete(r.id);
      ev.push({ type: 'rock', x: r.x, y: r.y });
      for (const p of this.ordered) {
        if (p.life === 'alive' && Math.hypot(p.x - r.x, p.y - r.y) <= ROCK_RADIUS + PLAYER_RADIUS * 0.5) {
          this.hurt(p, r.damage, ev);
        }
      }
      if (this.dog.state === 1 && Math.hypot(this.dog.x - r.x, this.dog.y - r.y) <= ROCK_RADIUS) {
        this.hurtDog(r.damage, ev);
      }
      this.barricades.forEach((b, i) => {
        if (b && Math.hypot(SOCKETS[i]!.x - r.x, SOCKETS[i]!.y - r.y) <= ROCK_RADIUS + 1.5) {
          this.smash(i, r.damage * 3, ev);
        }
      });
    }
  }

  /** A barricade takes damage; at 0 it breaks and the socket is open again. */
  private smash(socket: number, damage: number, ev: MatchEvent[]) {
    const b = this.barricades[socket];
    if (!b) return;
    b.hp -= damage;
    if (b.hp > 0) {
      ev.push({ type: 'smash', socket, hp: b.hp });
      return;
    }
    this.barricades[socket] = null;
    this.updateCosts();
    ev.push({ type: 'breach', socket });
  }

  private gooStep(dt: number) {
    for (const g of [...this.goo.values()]) {
      g.ttl -= dt;
      if (g.ttl <= 0) this.goo.delete(g.id);
    }
  }

  // ---- the dog ---------------------------------------------------------------------------------------------------

  private hurtDog(damage: number, ev: MatchEvent[]) {
    const dog = this.dog;
    if (dog.state !== 1 || this.invulnerable) return;
    dog.hp -= damage;
    if (dog.hp > 0) return;
    dog.hp = 0;
    dog.state = 2;
    dog.vx = 0;
    dog.vy = 0;
    ev.push({ type: 'dog', state: 2, by: null });
  }

  /**
   * The dog follows its owner (or whoever is nearest), keeps a couple of units behind, barks at zombies coming near
   * (a minimap ping), and bites the ones in reach. Downed, it waits for a survivor or for dawn; it never dies.
   */
  private dogStep(dt: number, ev: MatchEvent[]) {
    const dog = this.dog;
    dog.biteCd -= dt;
    dog.barkCd -= dt;
    dog.biting = Math.max(0, dog.biting - dt);
    if (dog.state !== 1 || !this.inRun) return;
    let lead = dog.owner ? this.players.get(dog.owner) : undefined;
    if (!lead || !lead.inRun || lead.life === 'dead') {
      lead = this.nearestRunner(dog.x, dog.y).p ?? undefined;
      if (lead) dog.owner = lead.id;
    }
    if (!lead) return;
    // Zombies near: the nearest one within bite range is bitten, within alert range barked at.
    let foe: Zombie | null = null;
    let foeD = Infinity;
    for (const z of this.zombies.values()) {
      const d = Math.hypot(z.x - dog.x, z.y - dog.y) - ZOMBIES[z.kind]!.radius;
      if (d < foeD) [foeD, foe] = [d, z];
    }
    if (foe && foeD < DOG_ALERT && dog.barkCd <= 0 && this.phase !== 'escape') {
      dog.barkCd = DOG_BARK_CD;
      ev.push({ type: 'bark', x: foe.x, y: foe.y });
    }
    const leadD = Math.hypot(lead.x - dog.x, lead.y - dog.y);
    if (leadD > 34) {
      // Out of sight of the group: it catches up off screen.
      dog.x = lead.x - Math.cos(lead.aim) * DOG_FOLLOW;
      dog.y = lead.y - Math.sin(lead.aim) * DOG_FOLLOW;
      resolveCircle(dog, DOG_RADIUS);
      return;
    }
    let gx = lead.x - Math.cos(lead.aim) * DOG_FOLLOW;
    let gy = lead.y - Math.sin(lead.aim) * DOG_FOLLOW;
    let speed = leadD > 6 ? DOG_RUN : DOG_WALK;
    if (foe && foeD < 5 && leadD < 10) {
      gx = foe.x;
      gy = foe.y;
      speed = DOG_RUN;
    }
    if (foe && foeD <= DOG_BITE_RANGE) {
      speed = 0;
      dog.facing = Math.atan2(foe.y - dog.y, foe.x - dog.x);
      if (dog.biteCd <= 0) {
        dog.biteCd = DOG_BITE_CD;
        dog.biting = 0.5;
        this.damageZombie(foe, DOG_BITE, 0, 0, null, 'dog', ev);
      }
    }
    const dx = gx - dog.x;
    const dy = gy - dog.y;
    const len = Math.hypot(dx, dy);
    const wx = len > 0.5 ? (dx / len) * speed : 0;
    const wy = len > 0.5 ? (dy / len) * speed : 0;
    const k = Math.min(1, dt * 8);
    dog.vx += (wx - dog.vx) * k;
    dog.vy += (wy - dog.vy) * k;
    dog.x += dog.vx * dt;
    dog.y += dog.vy * dt;
    if (Math.hypot(dog.vx, dog.vy) > 0.4) dog.facing = Math.atan2(dog.vy, dog.vx);
    resolveCircle(dog, DOG_RADIUS);
  }

  // ---- dev / tests -----------------------------------------------------------------------------------------------

  /** Remove every zombie and what is left of tonight's horde. */
  clearZombies(): void {
    this.zombies.clear();
    this.hordeQueue = [];
    this.rocks.clear();
  }

  /** Teleport a survivor (dev/tests). */
  place(id: string, x: number, y: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    resolveCircle(p, PLAYER_RADIUS);
    this.flowDirty = true;
  }

  /** Give a survivor an item (dev/tests): guns and melee into the hand, ammo and scrap counted, items in a slot. */
  give(id: string, code: number, n = 1): void {
    const p = this.players.get(id);
    if (!p || !ITEMS[code]) return;
    for (let i = 0; i < Math.max(1, Math.min(20, n)); i++) {
      const kind = itemKind(code);
      if (kind === 'gun') p.gun = code;
      else if (kind === 'melee') {
        p.melee = code;
        p.durability = MELEE[code]!.durability;
      } else if (kind === 'part') p.carry = code;
      else this.take(p, code);
    }
  }

  /** Skip the clock (dev/tests): to `phase` with `left` seconds of it. Night N via `skipToNight`. */
  setPhase_(phase: 'day' | 'dusk' | 'night', left: number | undefined, ev: MatchEvent[]): void {
    if (!this.inRun || this.phase === 'holdout' || this.phase === 'escape') return;
    if (phase === 'night' && this.phase !== 'night') this.toNight(ev);
    else if (phase === 'dusk' && this.phase !== 'dusk') this.toDusk(ev);
    else if (phase === 'day' && this.phase !== 'day') {
      if (this.phase === 'night') this.toDawn(ev);
      else this.setPhase('day', this.rules.dayTime, ev);
    }
    if (left !== undefined && Number.isFinite(left)) this.timer = Math.max(0.1, Math.min(this.phaseLength, left));
  }

  /** Jump to the start of night `n` (dev/tests): the counter is set so the night that falls now is `n`. */
  skipToNight(n: number, ev: MatchEvent[]): void {
    if (!this.inRun || this.phase === 'holdout' || this.phase === 'escape') return;
    this.night = Math.max(0, Math.floor(n) - 1);
    this.day = this.night + 1;
    this.nightsSurvived = Math.max(this.nightsSurvived, this.night);
    this.toNight(ev);
  }

  /** Set the truck's repair (dev/tests). */
  setTruck(wheels: number, fuel: number, scrap: number): void {
    this.truck.wheels = Math.max(0, Math.min(TRUCK_WHEELS, Math.floor(wheels)));
    this.truck.fuel = Math.max(0, Math.min(TRUCK_FUEL, Math.floor(fuel)));
    this.truck.scrap = Math.max(0, Math.min(TRUCK_SCRAP, Math.floor(scrap)));
  }

  /** End the run now (dev). */
  forceEnd(ev: MatchEvent[]): void {
    if (this.inRun) this.endRun(ev, false);
  }

  /** Start now (dev, and private rooms' `start`). */
  forceStart(ev: MatchEvent[]): void {
    if (this.phase === 'waiting' || this.phase === 'over') this.startRun(ev);
  }

  /** Zombies still queued for tonight (tests). */
  get queued(): number {
    return this.hordeQueue.length;
  }

  /** The kinds still queued for tonight (tests). */
  get queuedKinds(): readonly ZombieKind[] {
    return this.hordeQueue;
  }

  /** Where the safehouse is (tests, bots). */
  get safehouse(): Aabb {
    return SAFE;
  }

  /** The kind of ammo each gun uses (HUD convenience). */
  static ammoOf(gun: number): AmmoType | null {
    return GUNS[gun]?.ammo ?? null;
  }
}
