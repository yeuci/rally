import {
  AMMO_DROP_CHANCE,
  BARREL_BLAST_RADIUS,
  BARREL_DAMAGE,
  BARREL_RADIUS,
  BLAST_KNOCK,
  BREATHER_TIME,
  CHAIN_DELAY,
  COMBO_WINDOW,
  ExplosiveKind,
  FIRST_BREATHER_TIME,
  FLOW_TICKS,
  HEALTH_DROP_CHANCE,
  HEALTH_PICKUP_HP,
  KILL_POINTS,
  MAX_ALIVE_ZOMBIES,
  MAX_COMBO,
  MAX_EXPLOSIVES,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MELEE_REACH,
  MINE_ARM_TIME,
  MINE_BLAST_RADIUS,
  MINE_DAMAGE,
  MINE_RADIUS,
  MINE_TRIGGER_REACH,
  MIN_PLAYERS,
  PICKUP_HEALTH,
  PICKUP_RADIUS,
  PICKUP_TTL,
  PLAYER_HP,
  PLAYER_RADIUS,
  REVIVE_HP,
  REVIVE_RADIUS,
  REVIVE_TIME,
  RUN_OVER_TIME,
  SPIT_APEX,
  SPIT_COOLDOWN,
  SPIT_DAMAGE,
  SPIT_KEEP_MAX,
  SPIT_KEEP_MIN,
  SPIT_RADIUS,
  SPIT_RANGE,
  SPIT_SPEED,
  WEAPONS,
  WEAPON_COUNT,
  ZOMBIES,
  ZombieKind,
  waveSpec,
} from './constants.ts';
import { FlowField } from './flowfield.ts';
import { lineOfSight, rayCircle, rayObstacles } from './geometry.ts';
import { NO_INPUT, type PlayerInput } from './input.ts';
import { BULLET_BLOCKERS, GATES, OBSTACLES, SPAWNS, circleIsFree, movePlayer, resolveCircle } from './map.ts';
import { Rng } from './rng.ts';
import type { Vec2 } from './vec.ts';

/**
 * - `waiting`: no run yet. Public rooms start one as soon as someone is in; private rooms wait for `start` (or a
 *   full room). Players can walk around and try the pistol.
 * - `breather`: the quiet seconds before wave `wave` ("Wave N" banner). Players who joined mid-wave spawn now.
 * - `wave`: zombies pour in from the gates until all `waveSpec(wave).total` are dead, then the next breather. The run
 *   ends when every player in it is down.
 * - `over`: the run's result is shown, then a new run starts (public) or the room goes back to `waiting` (private).
 */
export type Phase = 'waiting' | 'breather' | 'wave' | 'over';

export interface Player {
  id: string;
  name: string;
  /** 0…3: colour and spawn point; the lowest free slot. */
  slot: number;
  /** Join order: processing order and tie-breaks. */
  order: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Aim angle, radians. */
  aim: number;
  hp: number;
  down: boolean;
  /** Seconds of revive progress while down. */
  revive: number;
  weapon: number;
  /** Ammo per weapon index (`ammo[0]` is the pistol's: Infinity). */
  ammo: number[];
  /** Seconds until the current weapon may fire again (≤ 0: ready). */
  fireCd: number;
  connected: boolean;
  /** Spawned in the current run (false while waiting for the next breather or run). */
  active: boolean;
  /** Took part in the current run (standings, results). */
  played: boolean;
  /** Current input (validated). */
  input: PlayerInput;
  kills: number;
  score: number;
  revives: number;
  downs: number;
  /** In the wave from its first second / hurt during the current wave (untouchable). */
  fullWave: boolean;
  hurtThisWave: boolean;
  /** Waves cleared without taking damage this run. */
  cleanWaves: number;
  /** Most zombies one barrel explosion this player set off has killed. */
  bestBlast: number;
}

export interface Zombie {
  id: number;
  kind: ZombieKind;
  x: number;
  y: number;
  /** Steering velocity. */
  vx: number;
  vy: number;
  /** Knockback velocity (decays). */
  kx: number;
  ky: number;
  hp: number;
  maxHp: number;
  speed: number;
  attackCd: number;
  spitCd: number;
  /** Which way a spitter circles its target. */
  side: 1 | -1;
}

export interface Projectile {
  id: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  x: number;
  y: number;
  h: number;
  t: number;
  dur: number;
}

export interface Explosive {
  id: number;
  kind: ExplosiveKind;
  x: number;
  y: number;
  /** Who placed it. */
  owner: string;
  /** Who set it off (a shot, or the chain that reached it); kills are credited to them, else to the owner. */
  trigger: string | null;
  /** Mines: seconds until armed. */
  armIn: number;
  /** Seconds until it explodes, once set off; null while idle. */
  fuse: number | null;
}

export interface Pickup {
  id: number;
  /** `PICKUP_HEALTH` or a weapon index (ammo). */
  kind: number;
  x: number;
  y: number;
  ttl: number;
}

/** Overridable rules (tests use short breathers; private rooms do not auto-start). */
export interface RunRules {
  minPlayers: number;
  /** Start a run as soon as `minPlayers` are in (public rooms); otherwise wait for `start` or a full room. */
  autoStart: boolean;
  firstBreatherTime: number;
  breatherTime: number;
  overTime: number;
  maxAlive: number;
  /** Zombies per wave when > 0 (tests and dev), instead of the wave curve. */
  waveSize: number;
  /** The first wave of a run. */
  startWave: number;
}

export const DEFAULT_RULES: RunRules = {
  minPlayers: MIN_PLAYERS,
  autoStart: true,
  firstBreatherTime: FIRST_BREATHER_TIME,
  breatherTime: BREATHER_TIME,
  overTime: RUN_OVER_TIME,
  maxAlive: MAX_ALIVE_ZOMBIES,
  waveSize: 0,
  startWave: 1,
};

const RULE_LIMITS: Record<Exclude<keyof RunRules, 'autoStart'>, [number, number]> = {
  minPlayers: [1, MAX_PLAYERS],
  firstBreatherTime: [0.1, 60],
  breatherTime: [0.1, 60],
  overTime: [0.1, 60],
  maxAlive: [1, MAX_ALIVE_ZOMBIES],
  waveSize: [0, 500],
  startWave: [1, 50],
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
  score: number;
  kills: number;
  revives: number;
  downs: number;
  /** 1 = best score; equal scores share a placement. */
  placement: number;
  cleanWaves: number;
  bestBlast: number;
}

export interface RunSummary {
  run: number;
  /** Highest wave the run started. */
  wave: number;
  /** Seconds from the first breather to the end. */
  duration: number;
  teamScore: number;
  teamKills: number;
  /** Players who took part, best score first. */
  standings: Standing[];
}

export type MatchEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'wave'; wave: number }
  | { type: 'waveCleared'; wave: number }
  /** `rays`: [x0, y0, x1, y1] per ray, flattened. */
  | { type: 'shot'; by: string; weapon: number; rays: number[] }
  | { type: 'hit'; zombie: number; by: string; x: number; y: number }
  | { type: 'kill'; zombie: number; kind: ZombieKind; x: number; y: number; by: string | null; mult: number }
  | { type: 'boom'; x: number; y: number; radius: number; by: string | null; kills: number }
  | { type: 'hurt'; id: string; hp: number }
  | { type: 'down'; id: string }
  | { type: 'revive'; id: string; by: string }
  | { type: 'spit'; x: number; y: number }
  | { type: 'splash'; x: number; y: number }
  | { type: 'place'; by: string; kind: ExplosiveKind }
  | { type: 'pickup'; by: string; kind: number }
  | { type: 'unlock'; weapon: number }
  | { type: 'runOver'; summary: RunSummary };

export interface MatchOptions {
  rules?: Partial<RunRules>;
  /** PRNG seed (spawns, variety, weapon spread, drops). */
  seed?: number;
}

/** Spatial hash cell for zombie separation (≥ the largest pair of radii). */
const SEP_CELL = 1.6;
const SEP_COLS = Math.ceil(48 / SEP_CELL) + 2;
const SEP_ROWS = Math.ceil(32 / SEP_CELL) + 2;
/** A zombie sees (and walks straight at) a player within this distance with a clear line. */
const SIGHT = 10;

/**
 * The whole game, engine- and network-free: players, waves, zombies, weapons, explosives, pickups, revives, scoring.
 * The server room calls `step(DT)` at a fixed rate and mirrors the fields into its Colyseus schema; tests drive it
 * directly. Deterministic for a seed and the same inputs: every collection is processed in a fixed order and every
 * random number comes from `rng`.
 */
export class OverrunMatch {
  phase: Phase = 'waiting';
  timer = 0;
  wave = 0;
  reached = 0;
  tick = 0;
  /** Seconds simulated so far (the combo clock). */
  time = 0;
  /** Seconds of the current run. */
  runTime = 0;
  run = 0;
  teamScore = 0;
  teamKills = 0;
  /** Weapons unlocked for the team: `WEAPONS[0 … unlocked-1]`. */
  unlocked = 1;
  /** Dev/test: zombies neither move, attack, spit nor spawn. */
  frozen = false;
  /** Dev/test: players take no damage (perf measurements with a horde on the move). */
  invulnerable = false;
  readonly players = new Map<string, Player>();
  readonly zombies = new Map<number, Zombie>();
  readonly projectiles = new Map<number, Projectile>();
  readonly explosives = new Map<number, Explosive>();
  readonly pickups = new Map<number, Pickup>();
  readonly flow = new FlowField(OBSTACLES);
  rules: RunRules;
  readonly rng: Rng;

  private ordered: Player[] = [];
  private spawnQueue: ZombieKind[] = [];
  private spawnTimer = 0;
  private spawnInterval = 0.5;
  private chain = 0;
  private lastKillAt = -Infinity;
  private startRequested = false;
  private flowDirty = true;
  private nextZombieId = 1;
  private nextEntityId = 1;
  private nextOrder = 0;
  private readonly sepHead = new Int32Array(SEP_COLS * SEP_ROWS);
  private sepNext = new Int32Array(MAX_ALIVE_ZOMBIES * 2);

  constructor(options: MatchOptions = {}) {
    this.rules = { ...DEFAULT_RULES, ...options.rules };
    this.rng = new Rng(options.seed ?? 1);
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
      down: false,
      revive: 0,
      weapon: 0,
      ammo: [Infinity, 0, 0, 0, 0],
      fireCd: 0,
      connected: true,
      active: false,
      played: false,
      input: { ...NO_INPUT },
      kills: 0,
      score: 0,
      revives: 0,
      downs: 0,
      fullWave: false,
      hurtThisWave: false,
      cleanWaves: 0,
      bestBlast: 0,
    };
    this.players.set(id, p);
    this.ordered = [...this.players.values()].sort((a, b) => a.order - b.order);
    // Between waves (and before a run) you spawn at once; mid-wave you wait for the next breather.
    if (this.phase === 'waiting' || this.phase === 'breather') this.activate(p);
    return p;
  }

  removePlayer(id: string): boolean {
    const had = this.players.delete(id);
    this.ordered = this.ordered.filter((p) => p.id !== id);
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
    if (!connected) p.input = { ...NO_INPUT, move: { x: 0, y: 0 }, weapon: p.weapon };
  }

  /** `input` must already be validated (see `parseInput`). */
  setInput(id: string, input: PlayerInput): void {
    const p = this.players.get(id);
    if (p && p.connected) p.input = input;
  }

  /** A player of a private room asked to start (only matters in `waiting`). */
  requestStart(): void {
    if (this.phase === 'waiting') this.startRequested = true;
  }

  setRules(rules: Partial<RunRules>): void {
    this.rules = { ...this.rules, ...rules };
  }

  /** Players in processing order (join order). */
  get playerList(): readonly Player[] {
    return this.ordered;
  }

  /** Current combo multiplier (1 when the chain has lapsed). */
  get combo(): number {
    return this.time - this.lastKillAt <= COMBO_WINDOW ? Math.min(MAX_COMBO, this.chain) : 1;
  }

  /** Fraction of the combo window left, 0…1 (0 when there is no combo). */
  get comboLeft(): number {
    if (this.combo <= 1) return 0;
    return Math.max(0, 1 - (this.time - this.lastKillAt) / COMBO_WINDOW);
  }

  /** Zombies of the current wave still to kill (alive + queued). */
  get remaining(): number {
    return this.phase === 'wave' ? this.zombies.size + this.spawnQueue.length : 0;
  }

  /** Standings of the players who took part in this run, best first. */
  standings(): Standing[] {
    const list = this.ordered.filter((p) => p.played).sort((a, b) => b.score - a.score || a.order - b.order);
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      score: p.score,
      kills: p.kills,
      revives: p.revives,
      downs: p.downs,
      placement: 1 + list.filter((q) => q.score > p.score).length,
      cleanWaves: p.cleanWaves,
      bestBlast: p.bestBlast,
    }));
  }

  // ---- the step ------------------------------------------------------------------------------------------------

  /** Advance one fixed step of `dt` seconds. Returns what happened, for effects and result reporting. */
  step(dt: number): MatchEvent[] {
    this.tick++;
    this.time += dt;
    const ev: MatchEvent[] = [];
    switch (this.phase) {
      case 'waiting': {
        const full = this.players.size >= MAX_PLAYERS;
        if (this.players.size >= this.rules.minPlayers && (this.rules.autoStart || this.startRequested || full)) {
          this.startRun(ev);
          break;
        }
        this.world(dt, ev, false);
        break;
      }
      case 'breather': {
        this.runTime += dt;
        this.timer -= dt;
        this.world(dt, ev, false);
        if (this.allDown()) this.endRun(ev);
        else if (this.timer <= 1e-9) this.startWave(ev);
        break;
      }
      case 'wave': {
        this.runTime += dt;
        this.timer += dt;
        this.world(dt, ev, true);
        if (this.allDown()) this.endRun(ev);
        else if (this.spawnQueue.length === 0 && this.zombies.size === 0) this.clearWave(ev);
        break;
      }
      case 'over': {
        this.timer -= dt;
        if (this.timer > 1e-9) break;
        if (this.players.size > 0 && this.rules.autoStart) this.startRun(ev);
        else this.toWaiting(ev);
        break;
      }
    }
    return ev;
  }

  /** Every player in the run is down (or nobody is left in it while others wait). */
  private allDown(): boolean {
    if (this.players.size === 0) return false;
    for (const p of this.ordered) if (p.active && !p.down) return false;
    return true;
  }

  // ---- run / wave lifecycle --------------------------------------------------------------------------------------

  private clearWorld() {
    this.zombies.clear();
    this.projectiles.clear();
    this.explosives.clear();
    this.pickups.clear();
    this.spawnQueue = [];
    this.flowDirty = true;
  }

  private resetTeam() {
    this.teamScore = 0;
    this.teamKills = 0;
    this.unlocked = 1;
    this.chain = 0;
    this.lastKillAt = -Infinity;
    this.runTime = 0;
    this.reached = 0;
  }

  private resetPlayer(p: Player) {
    p.kills = 0;
    p.score = 0;
    p.revives = 0;
    p.downs = 0;
    p.cleanWaves = 0;
    p.bestBlast = 0;
    p.played = false;
    p.ammo = [Infinity, 0, 0, 0, 0];
    p.weapon = 0;
    p.active = false;
  }

  /** Spawn a player into the current run, at their slot's spawn point, at full health. */
  private activate(p: Player) {
    const s = SPAWNS[p.slot % SPAWNS.length]!;
    p.x = s.x;
    p.y = s.y;
    p.vx = 0;
    p.vy = 0;
    p.hp = PLAYER_HP;
    p.down = false;
    p.revive = 0;
    p.fireCd = 0;
    p.active = true;
    p.played = true;
    p.fullWave = false;
    p.hurtThisWave = false;
    for (let w = 1; w < this.unlocked; w++) p.ammo[w] = Math.max(p.ammo[w] ?? 0, WEAPONS[w]!.startAmmo);
    this.flowDirty = true;
  }

  private startRun(ev: MatchEvent[]) {
    this.run++;
    this.startRequested = false;
    this.clearWorld();
    this.resetTeam();
    this.wave = this.rules.startWave - 1;
    for (const p of this.ordered) {
      this.resetPlayer(p);
      this.activate(p);
    }
    this.beginBreather(ev, this.rules.firstBreatherTime);
  }

  private beginBreather(ev: MatchEvent[], seconds: number) {
    this.phase = 'breather';
    this.wave++;
    this.timer = seconds;
    for (const p of this.ordered) if (!p.active) this.activate(p);
    ev.push({ type: 'phase', phase: 'breather' });
  }

  private startWave(ev: MatchEvent[]) {
    this.phase = 'wave';
    this.timer = 0;
    this.reached = Math.max(this.reached, this.wave);
    const spec = waveSpec(this.wave);
    const total = this.rules.waveSize > 0 ? Math.round(this.rules.waveSize) : spec.total;
    const brutes = this.rules.waveSize > 0 ? 0 : spec.brutes;
    const spitters = this.rules.waveSize > 0 ? 0 : spec.spitters;
    const queue: ZombieKind[] = [];
    for (let i = 0; i < total; i++) {
      queue.push(i < brutes ? ZombieKind.brute : i < brutes + spitters ? ZombieKind.spitter : ZombieKind.walker);
    }
    // Shuffle, but keep the first few plain so a wave never opens with a brute at the door.
    const head = queue.splice(queue.length - Math.min(4, total - brutes - spitters));
    this.spawnQueue = [...head, ...this.rng.shuffle(queue)];
    this.spawnInterval = spec.spawnInterval;
    this.spawnTimer = 0.4;
    for (const p of this.ordered) {
      p.hurtThisWave = false;
      p.fullWave = p.active && !p.down;
    }
    ev.push({ type: 'phase', phase: 'wave' }, { type: 'wave', wave: this.wave });
  }

  private clearWave(ev: MatchEvent[]) {
    ev.push({ type: 'waveCleared', wave: this.wave });
    for (const p of this.ordered) {
      if (p.active && p.fullWave && !p.hurtThisWave) p.cleanWaves++;
      // Second wind: everyone still down gets back up between waves.
      if (p.active && p.down) {
        p.down = false;
        p.hp = REVIVE_HP;
        p.revive = 0;
      }
    }
    this.projectiles.clear();
    this.beginBreather(ev, this.rules.breatherTime);
  }

  private endRun(ev: MatchEvent[]) {
    this.phase = 'over';
    this.timer = this.rules.overTime;
    this.spawnQueue = [];
    const summary: RunSummary = {
      run: this.run,
      wave: this.reached,
      duration: this.runTime,
      teamScore: this.teamScore,
      teamKills: this.teamKills,
      standings: this.standings(),
    };
    ev.push({ type: 'phase', phase: 'over' }, { type: 'runOver', summary });
  }

  private toWaiting(ev: MatchEvent[]) {
    this.phase = 'waiting';
    this.timer = 0;
    this.wave = 0;
    this.startRequested = false;
    this.clearWorld();
    this.resetTeam();
    for (const p of this.ordered) {
      this.resetPlayer(p);
      this.activate(p);
      p.played = false;
    }
    ev.push({ type: 'phase', phase: 'waiting' });
  }

  // ---- the world -------------------------------------------------------------------------------------------------

  private world(dt: number, ev: MatchEvent[], spawning: boolean) {
    if (this.flowDirty || this.tick % FLOW_TICKS === 0) {
      const targets: Vec2[] = [];
      for (const p of this.ordered) if (p.active && !p.down) targets.push(p);
      this.flow.compute(targets);
      this.flowDirty = false;
    }
    this.playersStep(dt, ev);
    if (spawning && !this.frozen) this.spawnStep(dt);
    this.zombiesStep(dt, ev);
    this.projectilesStep(dt, ev);
    this.explosivesStep(dt, ev);
    this.pickupsStep(dt, ev);
    this.reviveStep(dt, ev);
  }

  private playersStep(dt: number, ev: MatchEvent[]) {
    for (const p of this.ordered) {
      if (!p.active) continue;
      const input = p.connected ? p.input : NO_INPUT;
      if (input.aim) p.aim = Math.atan2(input.aim.y, input.aim.x);
      this.trySwitch(p, input.weapon);
      movePlayer(p, input.move, p.down, dt);
      p.fireCd -= dt;
      if (!p.down && input.fire) {
        for (let shots = 0; p.fireCd <= 1e-9 && shots < 4; shots++) {
          const w = WEAPONS[p.weapon]!;
          if (!this.fire(p, ev)) break;
          p.fireCd += w.cooldown;
        }
      }
      if (p.fireCd < 0) p.fireCd = 0;
    }
  }

  /** Switch to `want` when it is unlocked and loaded; fall back to the pistol when the current weapon is empty. */
  private trySwitch(p: Player, want: number) {
    if (want !== p.weapon && want < this.unlocked && (want === 0 || (p.ammo[want] ?? 0) > 0)) p.weapon = want;
    if (p.weapon !== 0 && !((p.ammo[p.weapon] ?? 0) > 0)) p.weapon = 0;
  }

  /** One shot or placement with the current weapon. False when nothing happened (a refused placement). */
  private fire(p: Player, ev: MatchEvent[]): boolean {
    const w = WEAPONS[p.weapon]!;
    if (w.kind === 'place') {
      const kind = w.id === 'barrel' ? ExplosiveKind.barrel : ExplosiveKind.mine;
      if (!this.placeExplosive(p, kind)) return false;
      ev.push({ type: 'place', by: p.id, kind });
    } else {
      const rays: number[] = [];
      for (let k = 0; k < w.pellets; k++) {
        const off = w.pellets > 1 ? -w.spread / 2 + (w.spread * k) / (w.pellets - 1) : 0;
        const a = p.aim + off + (this.rng.next() * 2 - 1) * w.jitter;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const ox = p.x + dx * 0.35;
        const oy = p.y + dy * 0.35;
        const t = this.shootRay(p, ox, oy, dx, dy, w.range, w.damage, w.knock, ev);
        rays.push(ox, oy, ox + dx * t, oy + dy * t);
      }
      ev.push({ type: 'shot', by: p.id, weapon: p.weapon, rays });
    }
    if (Number.isFinite(p.ammo[p.weapon]!)) {
      p.ammo[p.weapon] = Math.max(0, (p.ammo[p.weapon] ?? 0) - 1);
      if (p.ammo[p.weapon] === 0) p.weapon = 0;
    }
    return true;
  }

  /**
   * A hitscan ray: the first of obstacle/fence, zombie or barrel along it takes the hit. Returns how far it went.
   * Exposed for tests (`castRay` without damage).
   */
  private shootRay(
    p: Player,
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    range: number,
    damage: number,
    knock: number,
    ev: MatchEvent[],
  ): number {
    const hit = this.castRay(ox, oy, dx, dy, range);
    if (hit.zombie) {
      const z = hit.zombie;
      const spec = ZOMBIES[z.kind]!;
      z.hp -= damage;
      z.kx += dx * knock * (1 - spec.knockResist);
      z.ky += dy * knock * (1 - spec.knockResist);
      ev.push({ type: 'hit', zombie: z.id, by: p.id, x: ox + dx * hit.t, y: oy + dy * hit.t });
      if (z.hp <= 0) this.kill(z, p.id, ev);
    } else if (hit.explosive) {
      const e = hit.explosive;
      e.trigger ??= p.id;
      if (e.fuse === null || e.fuse > 0) e.fuse = 0;
    }
    return hit.t;
  }

  /** What a ray from (ox, oy) along the unit (dx, dy) hits first within `range`. */
  castRay(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    range: number,
  ): { t: number; zombie: Zombie | null; explosive: Explosive | null } {
    let best = rayObstacles(ox, oy, dx, dy, BULLET_BLOCKERS, range);
    let zombie: Zombie | null = null;
    let explosive: Explosive | null = null;
    for (const z of this.zombies.values()) {
      const t = rayCircle(ox, oy, dx, dy, z.x, z.y, ZOMBIES[z.kind]!.radius, best);
      if (t !== null && t < best) [best, zombie] = [t, z];
    }
    for (const e of this.explosives.values()) {
      if (e.kind !== ExplosiveKind.barrel) continue;
      const t = rayCircle(ox, oy, dx, dy, e.x, e.y, BARREL_RADIUS, best);
      if (t !== null && t < best) [best, zombie, explosive] = [t, null, e];
    }
    return { t: best, zombie, explosive };
  }

  private placeExplosive(p: Player, kind: ExplosiveKind): boolean {
    if (this.explosives.size >= MAX_EXPLOSIVES) return false;
    const r = kind === ExplosiveKind.barrel ? BARREL_RADIUS : MINE_RADIUS;
    const ax = Math.cos(p.aim);
    const ay = Math.sin(p.aim);
    const reach = PLAYER_RADIUS + r + 0.1;
    for (const [x, y] of [
      [p.x + ax * reach, p.y + ay * reach],
      [p.x, p.y],
    ] as const) {
      if (!circleIsFree(x, y, r)) continue;
      let clear = true;
      for (const e of this.explosives.values()) {
        const er = e.kind === ExplosiveKind.barrel ? BARREL_RADIUS : MINE_RADIUS;
        if ((e.x - x) ** 2 + (e.y - y) ** 2 < (er + r) ** 2) clear = false;
      }
      if (!clear) continue;
      const id = this.nextEntityId++;
      this.explosives.set(id, {
        id,
        kind,
        x,
        y,
        owner: p.id,
        trigger: null,
        armIn: kind === ExplosiveKind.mine ? MINE_ARM_TIME : 0,
        fuse: null,
      });
      return true;
    }
    return false;
  }

  // ---- zombies ---------------------------------------------------------------------------------------------------

  private spawnStep(dt: number) {
    this.spawnTimer -= dt;
    while (this.spawnTimer <= 0 && this.spawnQueue.length > 0) {
      if (this.zombies.size >= this.rules.maxAlive) {
        this.spawnTimer = 0;
        return;
      }
      const kind = this.spawnQueue.shift()!;
      let gate = GATES[this.rng.int(GATES.length)]!;
      for (let tries = 0; tries < 3; tries++) {
        const near = this.ordered.some((p) => p.active && Math.hypot(p.x - gate.x, p.y - gate.y) < 5);
        if (!near) break;
        gate = GATES[this.rng.int(GATES.length)]!;
      }
      const s = this.rng.range(-1.2, 1.2);
      this.spawnZombie(kind, gate.sx + gate.ax * s, gate.sy + gate.ay * s);
      this.spawnTimer += this.spawnInterval;
    }
  }

  /** Add a zombie of `kind` at (x, y) with the current wave's HP and speed. */
  spawnZombie(kind: ZombieKind, x: number, y: number): Zombie {
    const spec = ZOMBIES[kind]!;
    const ws = waveSpec(Math.max(1, this.wave));
    const id = this.nextZombieId++;
    const hp = Math.round(spec.hp * ws.hpMul);
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
      speed: spec.speed * ws.speedMul * this.rng.range(0.9, 1.1),
      attackCd: 0.5,
      spitCd: SPIT_COOLDOWN * this.rng.range(0.4, 1),
      side: this.rng.next() < 0.5 ? -1 : 1,
    };
    this.zombies.set(id, z);
    return z;
  }

  private zombiesStep(dt: number, ev: MatchEvent[]) {
    const targets = this.ordered.filter((p) => p.active && !p.down);
    const steer = Math.min(1, dt * 6);
    const knockDecay = Math.exp(-dt * 7);
    for (const z of this.zombies.values()) {
      const spec = ZOMBIES[z.kind]!;
      z.attackCd -= dt;
      z.spitCd -= dt;
      let target: Player | null = null;
      let dist = Infinity;
      for (const p of targets) {
        const d = Math.hypot(p.x - z.x, p.y - z.y);
        if (d < dist) [dist, target] = [d, p];
      }
      let wx = 0;
      let wy = 0;
      if (target && !this.frozen) {
        const tx = (target.x - z.x) / (dist || 1);
        const ty = (target.y - z.y) / (dist || 1);
        const sees = dist < SIGHT && lineOfSight(z.x, z.y, target.x, target.y, OBSTACLES);
        const dir = sees ? { x: tx, y: ty } : (this.flow.direction(z.x, z.y) ?? { x: tx, y: ty });
        if (z.kind === ZombieKind.spitter && sees) {
          if (dist < SPIT_KEEP_MIN) [wx, wy] = [-dir.x * z.speed * 0.8, -dir.y * z.speed * 0.8];
          else if (dist <= SPIT_KEEP_MAX)
            [wx, wy] = [-dir.y * z.side * z.speed * 0.35, dir.x * z.side * z.speed * 0.35];
          else [wx, wy] = [dir.x * z.speed, dir.y * z.speed];
          if (z.spitCd <= 0 && dist <= SPIT_RANGE) {
            this.spit(z, target.x, target.y);
            ev.push({ type: 'spit', x: z.x, y: z.y });
            z.spitCd = SPIT_COOLDOWN * this.rng.range(0.8, 1.2);
          }
        } else {
          [wx, wy] = [dir.x * z.speed, dir.y * z.speed];
        }
        if (z.attackCd <= 0 && dist <= spec.radius + PLAYER_RADIUS + MELEE_REACH) {
          z.attackCd = spec.attackCooldown;
          this.hurt(target, spec.damage, ev);
        }
      }
      z.vx += (wx - z.vx) * steer;
      z.vy += (wy - z.vy) * steer;
      z.x += (z.vx + z.kx) * dt;
      z.y += (z.vy + z.ky) * dt;
      z.kx *= knockDecay;
      z.ky *= knockDecay;
    }
    this.separate();
    const blockers = [...this.explosives.values()].filter((e) => e.kind === ExplosiveKind.barrel);
    for (const z of this.zombies.values()) {
      const r = ZOMBIES[z.kind]!.radius;
      for (const e of blockers) pushCircleOutOfCircle(z, r, e.x, e.y, BARREL_RADIUS);
      for (const p of this.ordered) if (p.active) pushCircleOutOfCircle(z, r, p.x, p.y, PLAYER_RADIUS);
      resolveCircle(z, r);
    }
  }

  /** Separation: overlapping zombies push each other apart (heavier ones move less), via a spatial hash. */
  private separate() {
    const list = [...this.zombies.values()];
    const n = list.length;
    if (this.sepNext.length < n) this.sepNext = new Int32Array(n * 2);
    const head = this.sepHead;
    const next = this.sepNext;
    head.fill(-1);
    const cellOf = (z: Zombie) => {
      const cx = Math.min(SEP_COLS - 1, Math.max(0, Math.floor((z.x + 24) / SEP_CELL) + 1));
      const cy = Math.min(SEP_ROWS - 1, Math.max(0, Math.floor((z.y + 16) / SEP_CELL) + 1));
      return [cx, cy] as const;
    };
    for (let i = 0; i < n; i++) {
      const [cx, cy] = cellOf(list[i]!);
      const c = cy * SEP_COLS + cx;
      next[i] = head[c]!;
      head[c] = i;
    }
    for (let i = 0; i < n; i++) {
      const a = list[i]!;
      const sa = ZOMBIES[a.kind]!;
      const [cx, cy] = cellOf(a);
      for (let oy = -1; oy <= 1; oy++) {
        const y = cy + oy;
        if (y < 0 || y >= SEP_ROWS) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const x = cx + ox;
          if (x < 0 || x >= SEP_COLS) continue;
          for (let j = head[y * SEP_COLS + x]!; j !== -1; j = next[j]!) {
            if (j <= i) continue;
            const b = list[j]!;
            const sb = ZOMBIES[b.kind]!;
            const min = sa.radius + sb.radius;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-6) [dx, dy, d] = [1, 0, 1]; // exactly stacked: a fixed axis keeps it deterministic
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
  }

  private spit(z: Zombie, tx: number, ty: number) {
    const id = this.nextEntityId++;
    const dur = Math.max(0.5, Math.hypot(tx - z.x, ty - z.y) / SPIT_SPEED);
    this.projectiles.set(id, { id, sx: z.x, sy: z.y, tx, ty, x: z.x, y: z.y, h: 0, t: 0, dur });
  }

  private projectilesStep(dt: number, ev: MatchEvent[]) {
    for (const pr of [...this.projectiles.values()]) {
      pr.t += dt;
      const u = Math.min(1, pr.t / pr.dur);
      pr.x = pr.sx + (pr.tx - pr.sx) * u;
      pr.y = pr.sy + (pr.ty - pr.sy) * u;
      pr.h = 4 * SPIT_APEX * u * (1 - u) + 0.6 * (1 - u);
      if (u < 1) continue;
      this.projectiles.delete(pr.id);
      ev.push({ type: 'splash', x: pr.x, y: pr.y });
      for (const p of this.ordered) {
        if (p.active && !p.down && Math.hypot(p.x - pr.x, p.y - pr.y) <= SPIT_RADIUS + PLAYER_RADIUS * 0.5) {
          this.hurt(p, SPIT_DAMAGE, ev);
        }
      }
    }
  }

  // ---- explosives ------------------------------------------------------------------------------------------------

  private explosivesStep(dt: number, ev: MatchEvent[]) {
    const due: Explosive[] = [];
    for (const e of this.explosives.values()) {
      if (e.kind === ExplosiveKind.mine && e.fuse === null) {
        e.armIn -= dt;
        if (e.armIn <= 0) {
          for (const z of this.zombies.values()) {
            const reach = MINE_RADIUS + ZOMBIES[z.kind]!.radius + MINE_TRIGGER_REACH;
            if ((z.x - e.x) ** 2 + (z.y - e.y) ** 2 <= reach * reach) {
              e.fuse = 0.05;
              break;
            }
          }
        }
      }
      if (e.fuse !== null) {
        e.fuse -= dt;
        if (e.fuse <= 1e-9) due.push(e);
      }
    }
    for (const e of due) if (this.explosives.has(e.id)) this.explode(e, ev);
  }

  private explode(e: Explosive, ev: MatchEvent[]) {
    this.explosives.delete(e.id);
    const barrel = e.kind === ExplosiveKind.barrel;
    const radius = barrel ? BARREL_BLAST_RADIUS : MINE_BLAST_RADIUS;
    const damage = barrel ? BARREL_DAMAGE : MINE_DAMAGE;
    const credit = e.trigger ?? e.owner;
    const by = this.players.has(credit) ? credit : null;
    let kills = 0;
    for (const z of [...this.zombies.values()]) {
      const spec = ZOMBIES[z.kind]!;
      const dx = z.x - e.x;
      const dy = z.y - e.y;
      const centre = Math.hypot(dx, dy);
      const d = Math.max(0, centre - spec.radius * 0.5);
      if (d > radius) continue;
      const inner = radius * 0.4;
      const falloff = d <= inner ? 1 : 1 - (0.6 * (d - inner)) / (radius - inner);
      const nx = centre > 1e-6 ? dx / centre : 1;
      const ny = centre > 1e-6 ? dy / centre : 0;
      z.kx += nx * BLAST_KNOCK * falloff * (1 - spec.knockResist);
      z.ky += ny * BLAST_KNOCK * falloff * (1 - spec.knockResist);
      z.hp -= damage * falloff;
      if (z.hp <= 0) {
        this.kill(z, by, ev);
        kills++;
      }
    }
    for (const o of this.explosives.values()) {
      if ((o.x - e.x) ** 2 + (o.y - e.y) ** 2 > radius * radius) continue;
      if (o.fuse === null || o.fuse > CHAIN_DELAY) o.fuse = CHAIN_DELAY;
      o.trigger ??= credit;
    }
    if (barrel && by) {
      const p = this.players.get(by)!;
      p.bestBlast = Math.max(p.bestBlast, kills);
    }
    ev.push({ type: 'boom', x: e.x, y: e.y, radius, by, kills });
  }

  // ---- pickups, revives, damage, kills ----------------------------------------------------------------------------

  private pickupsStep(dt: number, ev: MatchEvent[]) {
    for (const pk of [...this.pickups.values()]) {
      pk.ttl -= dt;
      if (pk.ttl <= 0) {
        this.pickups.delete(pk.id);
        continue;
      }
      for (const p of this.ordered) {
        if (!p.active || p.down || Math.hypot(p.x - pk.x, p.y - pk.y) > PICKUP_RADIUS) continue;
        if (pk.kind === PICKUP_HEALTH) {
          if (p.hp >= PLAYER_HP) continue;
          p.hp = Math.min(PLAYER_HP, p.hp + HEALTH_PICKUP_HP);
        } else {
          const w = WEAPONS[pk.kind]!;
          const have = p.ammo[pk.kind] ?? 0;
          if (pk.kind >= this.unlocked || have >= w.maxAmmo) continue;
          p.ammo[pk.kind] = Math.min(w.maxAmmo, have + w.pickupAmmo);
        }
        this.pickups.delete(pk.id);
        ev.push({ type: 'pickup', by: p.id, kind: pk.kind });
        break;
      }
    }
  }

  private reviveStep(dt: number, ev: MatchEvent[]) {
    for (const d of this.ordered) {
      if (!d.active || !d.down) continue;
      let reviver: Player | null = null;
      let best = REVIVE_RADIUS;
      for (const p of this.ordered) {
        if (p === d || !p.active || p.down) continue;
        const dist = Math.hypot(p.x - d.x, p.y - d.y);
        if (dist <= best) [best, reviver] = [dist, p];
      }
      if (!reviver) {
        d.revive = Math.max(0, d.revive - 2 * dt);
        continue;
      }
      d.revive += dt;
      if (d.revive + 1e-9 >= REVIVE_TIME) {
        d.down = false;
        d.hp = REVIVE_HP;
        d.revive = 0;
        reviver.revives++;
        this.flowDirty = true;
        ev.push({ type: 'revive', id: d.id, by: reviver.id });
      }
    }
  }

  /** Damage a standing player (exposed for dev commands and tests). */
  hurt(p: Player, damage: number, ev: MatchEvent[]): void {
    if (!p.active || p.down || damage <= 0 || this.invulnerable) return;
    p.hp = Math.max(0, p.hp - damage);
    p.hurtThisWave = true;
    ev.push({ type: 'hurt', id: p.id, hp: p.hp });
    if (p.hp <= 0) {
      p.down = true;
      p.revive = 0;
      p.downs++;
      p.vx *= 0.3;
      p.vy *= 0.3;
      this.flowDirty = true;
      ev.push({ type: 'down', id: p.id });
    }
  }

  private kill(z: Zombie, by: string | null, ev: MatchEvent[]) {
    if (!this.zombies.delete(z.id)) return;
    this.chain = this.time - this.lastKillAt <= COMBO_WINDOW ? this.chain + 1 : 1;
    this.lastKillAt = this.time;
    const mult = Math.min(MAX_COMBO, this.chain);
    const points = KILL_POINTS * mult;
    this.teamScore += points;
    this.teamKills++;
    const killer = by ? this.players.get(by) : undefined;
    if (killer) {
      killer.kills++;
      killer.score += points;
    }
    ev.push({ type: 'kill', zombie: z.id, kind: z.kind, x: z.x, y: z.y, by: killer ? killer.id : null, mult });
    while (this.unlocked < WEAPON_COUNT && this.teamKills >= WEAPONS[this.unlocked]!.unlockKills) {
      const w = this.unlocked++;
      for (const p of this.ordered) {
        if (p.active) p.ammo[w] = Math.max(p.ammo[w] ?? 0, WEAPONS[w]!.startAmmo);
      }
      ev.push({ type: 'unlock', weapon: w });
    }
    this.maybeDrop(z.x, z.y);
  }

  private maybeDrop(x: number, y: number) {
    const roll = this.rng.next();
    if (this.pickups.size >= MAX_PICKUPS) return;
    let kind = -1;
    if (roll < AMMO_DROP_CHANCE && this.unlocked > 1) kind = 1 + this.rng.int(this.unlocked - 1);
    else if (roll >= 1 - HEALTH_DROP_CHANCE) kind = PICKUP_HEALTH;
    if (kind < 0) return;
    const id = this.nextEntityId++;
    this.pickups.set(id, { id, kind, x, y, ttl: PICKUP_TTL });
  }

  // ---- dev / tests -----------------------------------------------------------------------------------------------

  /** Remove every zombie and the rest of the spawn queue. */
  clearZombies(): void {
    this.zombies.clear();
    this.spawnQueue = [];
    this.projectiles.clear();
  }

  /** Teleport a player (dev/tests). */
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

  /** Drop a pickup of `kind` at a point (dev/tests): the same pickup a kill drops, with its usual lifetime. */
  drop(kind: number, x: number, y: number): void {
    if (!Number.isInteger(kind) || kind < 0 || kind >= WEAPONS.length || this.pickups.size >= MAX_PICKUPS) return;
    const id = this.nextEntityId++;
    this.pickups.set(id, { id, kind, x, y, ttl: PICKUP_TTL });
  }

  /** Zombies still queued for this wave (tests). */
  get queued(): number {
    return this.spawnQueue.length;
  }
}

/** Push a circle (centre `b`, radius `r`) out of a fixed circle. */
function pushCircleOutOfCircle(b: { x: number; y: number }, r: number, cx: number, cy: number, cr: number): void {
  const dx = b.x - cx;
  const dy = b.y - cy;
  const min = r + cr;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    b.x = cx + min;
    return;
  }
  b.x = cx + (dx / d) * min;
  b.y = cy + (dy / d) * min;
}
