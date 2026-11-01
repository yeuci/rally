import {
  BARREL_BLAST,
  BARREL_DAMAGE,
  BARREL_FUSE,
  BARREL_RADIUS,
  BARREL_RESPAWN,
  BLAST_EDGE,
  CHAIN_DELAY,
  FINAL_TIER,
  JOIN_SPAWN_TIME,
  KILLS_PER_TIER,
  KNIFE_SPEED,
  MAX_PLAYERS,
  MED_HEAL,
  MED_REACH,
  MED_RESPAWN,
  MELEE,
  MIN_PLAYERS,
  OVER_TIME,
  PLAYER_HP,
  PLAYER_RADIUS,
  RESPAWN_TIME,
  SELF_DAMAGE,
  SPAWN_PROTECTION,
  STARTING_TIME,
  TIME_LIMIT,
  WEAPONS,
  tierWeapon,
  type WeaponId,
  type WeaponSpec,
} from './constants.ts';
import { rayCircle, rayCircles, rayObstacles, lineOfSight } from './geometry.ts';
import { MAX_REWIND_TICKS, PositionHistory } from './history.ts';
import { NO_INPUT, type PlayerInput } from './input.ts';
import {
  ALL_BARRELS,
  BARRELS,
  BULLET_BOXES,
  MEDS,
  OBSTACLES,
  POSTS,
  SPAWNS,
  barrelCircles,
  circleIsFree,
  movePlayer,
  resolveCircle,
} from './map.ts';
import { Rng } from './rng.ts';
import type { Vec2 } from './vec.ts';

/**
 * - `waiting`: no match yet. Quick-play rooms start one once `minPlayers` are in (bots count); private rooms wait for
 *   `start`. Everyone can run around and shoot (a warm-up: no promotions).
 * - `starting`: "Get ready": everyone respawned at spread-out spawns on the first rung, running but not shooting.
 * - `playing`: the ladder. One kill with the last rung (the knife) wins; the time limit decides by the ladder.
 * - `over`: the winner and the scoreboard, then the next match (or `waiting` when too few are left).
 */
export type Phase = 'waiting' | 'starting' | 'playing' | 'over';

export interface Player {
  id: string;
  name: string;
  /** 0…7: colour and character; the lowest free slot. */
  slot: number;
  /** Join order: processing order and tie-breaks. */
  order: number;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Aim angle, radians. */
  aim: number;
  hp: number;
  alive: boolean;
  /** Seconds until the respawn while dead. */
  respawnIn: number;
  /** Seconds of spawn protection left. */
  protectedFor: number;
  /** Spawns so far (lag compensation never matches an earlier life). */
  life: number;
  /** Rung of the ladder and kills on it. */
  tier: number;
  tierKills: number;
  kills: number;
  deaths: number;
  /** Opponents this player knifed down a rung this match. */
  knifeKills: number;
  /** Opponents killed by barrels this player set off. */
  barrelKills: number;
  /** Most opponents one of this player's rockets / grenades killed. */
  bestBlast: number;
  /** Seconds until the gun / the knife may fire again. */
  fireCd: number;
  meleeCd: number;
  connected: boolean;
  input: PlayerInput;
  /** What the client draws the others at: this many ticks behind the server (lag compensation). */
  viewDelay: number;
  /** Took part in the current match (standings, results). */
  played: boolean;
  history: PositionHistory;
}

export interface Projectile {
  id: number;
  kind: 'rocket' | 'grenade';
  owner: string;
  weapon: WeaponId;
  x: number;
  y: number;
  /** Unit direction of flight. */
  dx: number;
  dy: number;
  speed: number;
  /** Ground distance flown, and the most it flies. */
  flown: number;
  max: number;
  /** Height (grenades arc; rockets fly at gun height). */
  h: number;
}

/** Overridable rules (tests use short timers; private rooms do not start on their own). */
export interface MatchRules {
  minPlayers: number;
  /** Start as soon as `minPlayers` are in (quick play); otherwise wait for `start`. */
  autoStart: boolean;
  startingTime: number;
  overTime: number;
  respawnTime: number;
  protectionTime: number;
  killsPerTier: number;
  timeLimit: number;
}

export const DEFAULT_RULES: MatchRules = {
  minPlayers: MIN_PLAYERS,
  autoStart: true,
  startingTime: STARTING_TIME,
  overTime: OVER_TIME,
  respawnTime: RESPAWN_TIME,
  protectionTime: SPAWN_PROTECTION,
  killsPerTier: KILLS_PER_TIER,
  timeLimit: TIME_LIMIT,
};

const RULE_LIMITS: Record<Exclude<keyof MatchRules, 'autoStart'>, [number, number]> = {
  minPlayers: [1, MAX_PLAYERS],
  startingTime: [0.1, 30],
  overTime: [0.1, 60],
  respawnTime: [0.1, 30],
  protectionTime: [0, 10],
  killsPerTier: [1, 20],
  timeLimit: [5, 3600],
};

/** Keep only known rules with values in range (rules can come from a client in dev/test builds). */
export function sanitizeRules(raw: unknown): Partial<MatchRules> {
  const out: Partial<MatchRules> = {};
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
  bot: boolean;
  tier: number;
  tierKills: number;
  kills: number;
  deaths: number;
  knifeKills: number;
  barrelKills: number;
  bestBlast: number;
  /** 1 = the winner (or the leader by the ladder); equal records share a placement. */
  placement: number;
}

export interface MatchSummary {
  match: number;
  /** Seconds from the start of `playing` to the end. */
  duration: number;
  /** The winner's id (a knife kill on the last rung, or the leader at the time limit), or null. */
  winner: string | null;
  reason: 'knife' | 'time';
  /** Players who took part, best first. */
  standings: Standing[];
}

/** What killed someone: a weapon, or a barrel. */
export type Cause = WeaponId | 'barrel';

export type MatchEvent =
  | { type: 'phase'; phase: Phase }
  /** `rays`: [x0, y0, x1, y1] per ray, flattened. */
  | { type: 'shot'; by: string; weapon: WeaponId; rays: number[] }
  | { type: 'launch'; by: string; weapon: WeaponId; x: number; y: number; angle: number }
  | { type: 'stab'; by: string; x: number; y: number; angle: number; hit: boolean }
  | { type: 'hit'; id: string; by: string | null; x: number; y: number; damage: number; hp: number }
  | { type: 'kill'; id: string; by: string | null; cause: Cause; x: number; y: number; demote: boolean }
  | { type: 'tier'; id: string; tier: number; up: boolean }
  | { type: 'boom'; x: number; y: number; radius: number; by: string | null }
  | { type: 'spawn'; id: string }
  | { type: 'heal'; id: string }
  | { type: 'win'; id: string | null }
  | { type: 'matchOver'; summary: MatchSummary };

export interface MatchOptions {
  rules?: Partial<MatchRules>;
  /** PRNG seed (spawn choice, weapon spread). */
  seed?: number;
}

/** Ranks players by the ladder: rung, kills on it, kills, fewer deaths, then join order. */
export function ladderOrder(a: Player, b: Player): number {
  return b.tier - a.tier || b.tierKills - a.tierKills || b.kills - a.kills || a.deaths - b.deaths || a.order - b.order;
}

/**
 * The whole game, engine- and network-free: players, the ladder, weapons (hitscan with lag compensation, rockets,
 * grenades, the knife), barrels, med kits, respawns and the match flow. The room calls `step(DT)` at a fixed rate and
 * mirrors the fields into its Colyseus schema; tests drive it directly. Deterministic for a seed and the same inputs:
 * every collection is processed in a fixed order and every random number comes from `rng`.
 */
export class GunRunMatch {
  phase: Phase = 'waiting';
  timer = 0;
  tick = 0;
  /** Seconds simulated so far. */
  time = 0;
  /** Matches started in this room. */
  match = 0;
  winner: string | null = null;
  /** Standing barrels and med kits (bits of `BARRELS`, `MEDS`). */
  barrels = ALL_BARRELS;
  meds = (1 << MEDS.length) - 1;
  /** Dev/test: players take no damage. */
  invulnerable = false;
  readonly players = new Map<string, Player>();
  readonly projectiles = new Map<number, Projectile>();
  rules: MatchRules;
  readonly rng: Rng;

  private ordered: Player[] = [];
  private startRequested = false;
  /** A private room keeps playing match after match once it has started one. */
  private started = false;
  private matchTime = 0;
  private nextOrder = 0;
  private nextEntityId = 1;
  /** Fuse left per barrel that was set off (null: idle or down), who set it off, respawn timers of the down ones. */
  private readonly barrelFuse: (number | null)[] = BARRELS.map(() => null);
  private readonly barrelBy: (string | null)[] = BARRELS.map(() => null);
  private readonly barrelBack: number[] = BARRELS.map(() => 0);
  private readonly medBack: number[] = MEDS.map(() => 0);

  constructor(options: MatchOptions = {}) {
    this.rules = { ...DEFAULT_RULES, ...options.rules };
    this.rng = new Rng(options.seed ?? 1);
  }

  // ---- players ---------------------------------------------------------------------------------------------------

  addPlayer(id: string, name: string, bot = false): Player {
    const existing = this.players.get(id);
    if (existing) return existing;
    const used = new Set(this.ordered.map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const others = this.ordered.filter((p) => p.played || this.phase !== 'playing');
    const p: Player = {
      id,
      name,
      slot,
      order: this.nextOrder++,
      bot,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: -Math.PI / 2,
      hp: PLAYER_HP,
      alive: false,
      respawnIn: 0,
      protectedFor: 0,
      life: 0,
      // Catching up: a match under way is joined on the lowest rung anyone is on.
      tier: this.phase === 'playing' && others.length ? Math.min(...others.map((o) => o.tier)) : 0,
      tierKills: 0,
      kills: 0,
      deaths: 0,
      knifeKills: 0,
      barrelKills: 0,
      bestBlast: 0,
      fireCd: 0,
      meleeCd: 0,
      connected: true,
      input: { ...NO_INPUT },
      viewDelay: 0,
      played: this.phase === 'playing' || this.phase === 'starting',
      history: new PositionHistory(),
    };
    this.players.set(id, p);
    this.ordered = [...this.players.values()].sort((a, b) => a.order - b.order);
    if (this.phase === 'playing') p.respawnIn = JOIN_SPAWN_TIME;
    else this.spawn(p, []);
    return p;
  }

  removePlayer(id: string): boolean {
    const had = this.players.delete(id);
    this.ordered = this.ordered.filter((p) => p.id !== id);
    for (let i = 0; i < this.barrelBy.length; i++) if (this.barrelBy[i] === id) this.barrelBy[i] = null;
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
    if (!connected) p.input = { ...NO_INPUT };
  }

  /** `input` must already be validated (see `parseInput`). */
  setInput(id: string, input: PlayerInput): void {
    const p = this.players.get(id);
    if (p && p.connected) p.input = input;
  }

  /**
   * The client was drawing the others at tick `rt` when it sent its latest input: its shots rewind them by the
   * difference (at most `MAX_REWIND_TICKS`).
   */
  setViewTick(id: string, rt: number): void {
    const p = this.players.get(id);
    if (p) p.viewDelay = Math.max(0, Math.min(MAX_REWIND_TICKS, this.tick - rt));
  }

  /** A player of a private room asked to start (only matters in `waiting`). */
  requestStart(): void {
    if (this.phase === 'waiting') this.startRequested = true;
  }

  setRules(rules: Partial<MatchRules>): void {
    this.rules = { ...this.rules, ...rules };
  }

  /** Players in processing order (join order). */
  get playerList(): readonly Player[] {
    return this.ordered;
  }

  /** Seconds into the current match (0 outside `playing`). */
  get elapsed(): number {
    return this.matchTime;
  }

  /** Standings of the players who took part, best first. */
  standings(): Standing[] {
    const list = this.ordered.filter((p) => p.played).sort(ladderOrder);
    if (this.winner) {
      const w = list.findIndex((p) => p.id === this.winner);
      if (w > 0) list.unshift(...list.splice(w, 1));
    }
    // The winner is first; everyone else is placed by the ladder (equal records share a placement).
    const ahead = (q: Player, p: Player) =>
      q.tier > p.tier ||
      (q.tier === p.tier && (q.tierKills > p.tierKills || (q.tierKills === p.tierKills && q.kills > p.kills)));
    const winner = this.winner ? list.find((p) => p.id === this.winner) : undefined;
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      slot: p.slot,
      bot: p.bot,
      tier: p.tier,
      tierKills: p.tierKills,
      kills: p.kills,
      deaths: p.deaths,
      knifeKills: p.knifeKills,
      barrelKills: p.barrelKills,
      bestBlast: p.bestBlast,
      placement:
        p === winner ? 1 : 1 + (winner ? 1 : 0) + list.filter((q) => q !== winner && q !== p && ahead(q, p)).length,
    }));
  }

  /** The weapon a player fires with the trigger (their rung's). */
  weaponOf(p: Player): WeaponSpec {
    return tierWeapon(p.tier);
  }

  /** Speed multiplier of a player (the knife rung runs faster): what `movePlayer` and the client's prediction use. */
  speedOf(p: Pick<Player, 'tier'>): number {
    return p.tier >= FINAL_TIER ? KNIFE_SPEED : 1;
  }

  // ---- the step ------------------------------------------------------------------------------------------------

  /** Advance one fixed step of `dt` seconds. Returns what happened, for effects and result reporting. */
  step(dt: number): MatchEvent[] {
    this.tick++;
    this.time += dt;
    const ev: MatchEvent[] = [];
    switch (this.phase) {
      case 'waiting': {
        const enough = this.players.size >= this.rules.minPlayers;
        if (enough && (this.rules.autoStart || this.startRequested || this.started)) {
          this.startMatch(ev);
          break;
        }
        this.startRequested = false;
        this.world(dt, ev, true, false);
        break;
      }
      case 'starting': {
        this.timer -= dt;
        this.world(dt, ev, false, false);
        if (this.timer <= 1e-9) {
          this.phase = 'playing';
          this.timer = 0;
          this.matchTime = 0;
          ev.push({ type: 'phase', phase: 'playing' });
        }
        break;
      }
      case 'playing': {
        this.matchTime += dt;
        this.timer = this.matchTime;
        this.world(dt, ev, true, true);
        if (this.winner) this.endMatch(ev, 'knife');
        else if (this.matchTime >= this.rules.timeLimit) this.endMatch(ev, 'time');
        else if (this.players.size < this.rules.minPlayers) this.toWaiting(ev);
        break;
      }
      case 'over': {
        this.timer -= dt;
        if (this.timer > 1e-9) break;
        if (this.players.size >= this.rules.minPlayers && (this.rules.autoStart || this.started)) this.startMatch(ev);
        else this.toWaiting(ev);
        break;
      }
    }
    for (const p of this.ordered) p.history.record(this.tick, p.x, p.y, p.alive, p.life);
    return ev;
  }

  // ---- match lifecycle -------------------------------------------------------------------------------------------

  private resetYard() {
    this.projectiles.clear();
    this.barrels = ALL_BARRELS;
    this.meds = (1 << MEDS.length) - 1;
    this.barrelFuse.fill(null);
    this.barrelBy.fill(null);
  }

  private resetPlayer(p: Player) {
    p.tier = 0;
    p.tierKills = 0;
    p.kills = 0;
    p.deaths = 0;
    p.knifeKills = 0;
    p.barrelKills = 0;
    p.bestBlast = 0;
  }

  /** Everyone respawns at spread-out spawn points on the first rung; "Get ready". */
  private startMatch(ev: MatchEvent[]) {
    this.match++;
    this.started = true;
    this.startRequested = false;
    this.winner = null;
    this.matchTime = 0;
    this.resetYard();
    const taken: Vec2[] = [];
    for (const p of this.ordered) {
      this.resetPlayer(p);
      p.played = true;
      const s = this.spawn(p, taken);
      taken.push(s);
    }
    this.phase = 'starting';
    this.timer = this.rules.startingTime;
    ev.push({ type: 'phase', phase: 'starting' });
  }

  private endMatch(ev: MatchEvent[], reason: 'knife' | 'time') {
    if (reason === 'time') this.winner = [...this.ordered].filter((p) => p.played).sort(ladderOrder)[0]?.id ?? null;
    this.phase = 'over';
    this.timer = this.rules.overTime;
    this.projectiles.clear();
    for (const p of this.ordered) p.input = { ...NO_INPUT, aim: p.input.aim };
    const summary: MatchSummary = {
      match: this.match,
      duration: this.matchTime,
      winner: this.winner,
      reason,
      standings: this.standings(),
    };
    ev.push({ type: 'phase', phase: 'over' }, { type: 'win', id: this.winner }, { type: 'matchOver', summary });
  }

  private toWaiting(ev: MatchEvent[]) {
    this.phase = 'waiting';
    this.timer = 0;
    this.winner = null;
    this.matchTime = 0;
    this.startRequested = false;
    this.resetYard();
    for (const p of this.ordered) {
      this.resetPlayer(p);
      p.played = false;
      if (!p.alive) this.spawn(p, []);
    }
    ev.push({ type: 'phase', phase: 'waiting' });
  }

  // ---- spawning --------------------------------------------------------------------------------------------------

  /**
   * The spawn point for `p`: free, and as far as possible from the living (and from `taken`, the points handed out
   * this step); a seeded pick among the best three keeps it from being predictable.
   */
  spawnPoint(p: Player, taken: readonly Vec2[] = []): Vec2 {
    const standing = barrelCircles(this.barrels);
    const enemies = [...this.ordered.filter((o) => o !== p && o.alive), ...taken];
    const scored = SPAWNS.filter((s) => circleIsFree(s.x, s.y, PLAYER_RADIUS, standing)).map((s) => {
      let d = 60;
      for (const e of enemies) d = Math.min(d, Math.hypot(e.x - s.x, e.y - s.y));
      return { s, d };
    });
    scored.sort((a, b) => b.d - a.d);
    const best = scored.slice(0, Math.min(3, scored.length));
    return (best[this.rng.int(best.length)] ?? { s: SPAWNS[0]! }).s;
  }

  private spawn(p: Player, taken: readonly Vec2[]): Vec2 {
    const s = this.spawnPoint(p, taken);
    p.x = s.x;
    p.y = s.y;
    p.vx = 0;
    p.vy = 0;
    // Face the middle of the yard.
    p.aim = Math.atan2(-s.y, -s.x);
    p.hp = PLAYER_HP;
    p.alive = true;
    p.respawnIn = 0;
    p.protectedFor = this.rules.protectionTime;
    p.fireCd = 0;
    p.meleeCd = 0;
    p.life++;
    p.history.clear();
    return s;
  }

  // ---- the world -------------------------------------------------------------------------------------------------

  /** One step of the yard: `combat` = attacks are allowed, `progress` = kills climb the ladder. */
  private world(dt: number, ev: MatchEvent[], combat: boolean, progress: boolean) {
    for (const p of this.ordered) {
      if (!p.alive) {
        p.respawnIn -= dt;
        if (p.respawnIn <= 1e-9) {
          this.spawn(p, []);
          ev.push({ type: 'spawn', id: p.id });
        }
        continue;
      }
      const input = p.connected ? p.input : NO_INPUT;
      if (input.aim) p.aim = Math.atan2(input.aim.y, input.aim.x);
      movePlayer(p, input.move, this.speedOf(p), this.barrels, dt);
      p.protectedFor = Math.max(0, p.protectedFor - dt);
      p.fireCd -= dt;
      p.meleeCd -= dt;
      if (combat) {
        const w = this.weaponOf(p);
        const stab = input.melee || (input.fire && w.kind === 'melee');
        if (stab && p.meleeCd <= 1e-9) {
          p.protectedFor = 0;
          p.meleeCd = MELEE.cooldown;
          this.stab(p, ev, progress);
        } else if (input.fire && w.kind !== 'melee') {
          for (let shots = 0; p.fireCd <= 1e-9 && shots < 4; shots++) {
            p.protectedFor = 0;
            this.fire(p, w, ev, progress);
            p.fireCd += w.cooldown;
          }
        }
      }
      if (p.fireCd < 0) p.fireCd = 0;
      if (p.meleeCd < 0) p.meleeCd = 0;
    }
    this.projectilesStep(dt, ev, progress);
    this.barrelsStep(dt, ev, progress);
    this.medsStep(dt, ev);
  }

  /** Other living players where `shooter` saw them (lag compensation), with their current selves. */
  private targetsFor(shooter: Player): { p: Player; x: number; y: number }[] {
    const rewind = this.tick - shooter.viewDelay;
    const out: { p: Player; x: number; y: number }[] = [];
    for (const o of this.ordered) {
      if (o === shooter || !o.alive) continue;
      const at = shooter.viewDelay > 0 ? o.history.at(rewind, o.life, o, this.tick) : o;
      if (at) out.push({ p: o, x: at.x, y: at.y });
    }
    return out;
  }

  private fire(p: Player, w: WeaponSpec, ev: MatchEvent[], progress: boolean) {
    const dx = Math.cos(p.aim);
    const dy = Math.sin(p.aim);
    if (w.kind === 'rocket' || w.kind === 'grenade') {
      const ox = p.x + dx * 0.5;
      const oy = p.y + dy * 0.5;
      const id = this.nextEntityId++;
      this.projectiles.set(id, {
        id,
        kind: w.kind,
        owner: p.id,
        weapon: w.id,
        x: ox,
        y: oy,
        dx,
        dy,
        speed: w.speed,
        flown: 0,
        max: w.range,
        h: w.kind === 'rocket' ? 1.1 : 1.0,
      });
      ev.push({ type: 'launch', by: p.id, weapon: w.id, x: ox, y: oy, angle: p.aim });
      return;
    }
    const targets = this.targetsFor(p);
    const rays: number[] = [];
    for (let k = 0; k < w.pellets; k++) {
      const off = w.pellets > 1 ? -w.spread / 2 + (w.spread * k) / (w.pellets - 1) : 0;
      const a = p.aim + off + (this.rng.next() * 2 - 1) * w.jitter;
      const rx = Math.cos(a);
      const ry = Math.sin(a);
      const ox = p.x + rx * 0.4;
      const oy = p.y + ry * 0.4;
      const hit = this.castRay(ox, oy, rx, ry, w.range, targets);
      if (hit.player) this.damage(hit.player, w.damage, p, w.id, ox + rx * hit.t, oy + ry * hit.t, ev, progress);
      else if (hit.barrel >= 0) this.setOff(hit.barrel, p.id, BARREL_FUSE);
      rays.push(ox, oy, ox + rx * hit.t, oy + ry * hit.t);
    }
    ev.push({ type: 'shot', by: p.id, weapon: w.id, rays });
  }

  /**
   * What a ray from (ox, oy) along the unit (dx, dy) hits first within `range`: the yard (boxes, posts), a standing
   * barrel, or one of `targets` (players at the positions the shooter saw).
   */
  castRay(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    range: number,
    targets: readonly { p: Player; x: number; y: number }[],
  ): { t: number; player: Player | null; barrel: number } {
    let best = rayObstacles(ox, oy, dx, dy, BULLET_BOXES, range);
    best = rayCircles(ox, oy, dx, dy, POSTS, best);
    let player: Player | null = null;
    let barrel = -1;
    BARRELS.forEach((b, i) => {
      if (!(this.barrels & (1 << i))) return;
      const t = rayCircle(ox, oy, dx, dy, b.x, b.y, BARREL_RADIUS, best);
      if (t !== null && t < best) [best, barrel] = [t, i];
    });
    for (const tg of targets) {
      const t = rayCircle(ox, oy, dx, dy, tg.x, tg.y, PLAYER_RADIUS, best);
      if (t !== null && t < best) [best, player, barrel] = [t, tg.p, -1];
    }
    return { t: best, player, barrel };
  }

  /** The knife: the nearest opponent in reach, inside the arc and not behind a wall, where the stabber saw them. */
  private stab(p: Player, ev: MatchEvent[], progress: boolean) {
    let best: { p: Player; x: number; y: number; d: number } | null = null;
    for (const tg of this.targetsFor(p)) {
      const dx = tg.x - p.x;
      const dy = tg.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > MELEE.range + PLAYER_RADIUS) continue;
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - p.aim), Math.cos(Math.atan2(dy, dx) - p.aim)));
      // Within the arc, or so close the arc does not matter (bodies touching).
      if (off > MELEE.arc && d > PLAYER_RADIUS * 2) continue;
      if (!lineOfSight(p.x, p.y, tg.x, tg.y, OBSTACLES)) continue;
      if (!best || d < best.d) best = { ...tg, d };
    }
    ev.push({ type: 'stab', by: p.id, x: p.x, y: p.y, angle: p.aim, hit: best !== null });
    if (best) this.damage(best.p, MELEE.damage, p, 'knife', best.x, best.y, ev, progress);
  }

  // ---- projectiles, barrels, med kits ------------------------------------------------------------------------------

  private projectilesStep(dt: number, ev: MatchEvent[], progress: boolean) {
    for (const pr of [...this.projectiles.values()]) {
      const step = Math.min(pr.speed * dt, pr.max - pr.flown);
      let t = rayObstacles(pr.x, pr.y, pr.dx, pr.dy, BULLET_BOXES, step);
      t = rayCircles(pr.x, pr.y, pr.dx, pr.dy, POSTS, t);
      let burst = t < step - 1e-9;
      if (pr.kind === 'rocket') {
        // Rockets burst on the first player or barrel in their way (not their owner).
        for (const o of this.ordered) {
          if (!o.alive || o.id === pr.owner) continue;
          const hit = rayCircle(pr.x, pr.y, pr.dx, pr.dy, o.x, o.y, PLAYER_RADIUS, t);
          if (hit !== null && hit < t) [t, burst] = [hit, true];
        }
        for (const c of barrelCircles(this.barrels)) {
          const hit = rayCircle(pr.x, pr.y, pr.dx, pr.dy, c.x, c.y, c.r, t);
          if (hit !== null && hit < t) [t, burst] = [hit, true];
        }
      }
      pr.flown += t;
      // A burst against a wall happens just in front of it (on its face, every line of sight would start inside it).
      const back = burst ? Math.min(t, 0.08) : 0;
      pr.x += pr.dx * (t - back);
      pr.y += pr.dy * (t - back);
      if (pr.kind === 'grenade') {
        // A lob: up and down over the throw, landing at `max`.
        const u = Math.min(1, pr.flown / pr.max);
        pr.h = 1.0 * (1 - u) + 4 * 1.6 * u * (1 - u);
      }
      if (burst || pr.flown >= pr.max - 1e-6) {
        this.projectiles.delete(pr.id);
        const owner = this.players.get(pr.owner) ?? null;
        const w = WEAPONS[pr.weapon];
        this.explode(pr.x, pr.y, w.blast, w.damage, owner, pr.weapon, ev, progress);
      }
    }
  }

  /** Set off barrel `i` (by a shot, a blast or a rocket): it goes off after `fuse` s, credited to `by`. */
  private setOff(i: number, by: string | null, fuse: number) {
    if (!(this.barrels & (1 << i))) return;
    const f = this.barrelFuse[i];
    if (f === null || f === undefined || f > fuse) this.barrelFuse[i] = fuse;
    this.barrelBy[i] ??= by;
  }

  private barrelsStep(dt: number, ev: MatchEvent[], progress: boolean) {
    BARRELS.forEach((b, i) => {
      const bit = 1 << i;
      if (!(this.barrels & bit)) {
        this.barrelBack[i]! -= dt;
        // Back once nobody stands where it goes.
        if (this.barrelBack[i]! <= 0 && this.ordered.every((p) => !p.alive || Math.hypot(p.x - b.x, p.y - b.y) > 1.3)) {
          this.barrels |= bit;
        }
        return;
      }
      const f = this.barrelFuse[i];
      if (f === null || f === undefined) return;
      this.barrelFuse[i] = f - dt;
      if (this.barrelFuse[i]! > 1e-9) return;
      this.barrels &= ~bit;
      this.barrelFuse[i] = null;
      this.barrelBack[i] = BARREL_RESPAWN;
      const by = this.barrelBy[i] ?? null;
      this.barrelBy[i] = null;
      this.explode(
        b.x,
        b.y,
        BARREL_BLAST,
        BARREL_DAMAGE,
        by ? (this.players.get(by) ?? null) : null,
        'barrel',
        ev,
        progress,
      );
    });
  }

  /** A blast: splash damage with falloff (your own hurts you less), other barrels in reach go off next. */
  private explode(
    x: number,
    y: number,
    radius: number,
    damage: number,
    by: Player | null,
    cause: Cause,
    ev: MatchEvent[],
    progress: boolean,
  ) {
    ev.push({ type: 'boom', x, y, radius, by: by?.id ?? null });
    let kills = 0;
    for (const o of this.ordered) {
      if (!o.alive) continue;
      const d = Math.max(0, Math.hypot(o.x - x, o.y - y) - PLAYER_RADIUS * 0.5);
      if (d > radius) continue;
      // Walls shelter: a blast behind a container does not reach you.
      if (!lineOfSight(x, y, o.x, o.y, OBSTACLES)) continue;
      const inner = radius * 0.4;
      const falloff = d <= inner ? 1 : 1 - ((1 - BLAST_EDGE) * (d - inner)) / (radius - inner);
      const amount = damage * falloff * (o === by ? SELF_DAMAGE : 1);
      if (this.damage(o, amount, by, cause, o.x, o.y, ev, progress) && o !== by) kills++;
    }
    if (by && cause !== 'barrel') by.bestBlast = Math.max(by.bestBlast, kills);
    BARRELS.forEach((b, i) => {
      if (Math.hypot(b.x - x, b.y - y) <= radius + BARREL_RADIUS) this.setOff(i, by?.id ?? null, CHAIN_DELAY);
    });
  }

  private medsStep(dt: number, ev: MatchEvent[]) {
    MEDS.forEach((m, i) => {
      const bit = 1 << i;
      if (!(this.meds & bit)) {
        this.medBack[i]! -= dt;
        if (this.medBack[i]! <= 0) this.meds |= bit;
        return;
      }
      for (const p of this.ordered) {
        if (!p.alive || p.hp >= PLAYER_HP || Math.hypot(p.x - m.x, p.y - m.y) > MED_REACH) continue;
        p.hp = Math.min(PLAYER_HP, p.hp + MED_HEAL);
        this.meds &= ~bit;
        this.medBack[i] = MED_RESPAWN;
        ev.push({ type: 'heal', id: p.id });
        break;
      }
    });
  }

  // ---- damage, kills, the ladder ----------------------------------------------------------------------------------

  /**
   * Damage a player (exposed for dev commands and tests). Spawn protection and dev god mode ignore it. Returns true
   * when it killed them.
   */
  damage(
    victim: Player,
    amount: number,
    by: Player | null,
    cause: Cause,
    x: number,
    y: number,
    ev: MatchEvent[],
    progress = this.phase === 'playing',
  ): boolean {
    if (!victim.alive || amount <= 0 || victim.protectedFor > 0 || this.invulnerable) return false;
    victim.hp = Math.max(0, victim.hp - amount);
    ev.push({
      type: 'hit',
      id: victim.id,
      by: by?.id ?? null,
      x,
      y,
      damage: Math.round(amount),
      hp: Math.ceil(victim.hp),
    });
    if (victim.hp > 1e-6) return false;
    this.kill(victim, by, cause, ev, progress);
    return true;
  }

  private kill(victim: Player, by: Player | null, cause: Cause, ev: MatchEvent[], progress: boolean) {
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.respawnIn = this.rules.respawnTime;
    victim.vx = 0;
    victim.vy = 0;
    const knifed = cause === 'knife' && by !== null && by !== victim;
    const demote = progress && knifed && victim.tier > 0;
    ev.push({ type: 'kill', id: victim.id, by: by?.id ?? null, cause, x: victim.x, y: victim.y, demote });
    if (demote) {
      victim.tier--;
      victim.tierKills = 0;
      ev.push({ type: 'tier', id: victim.id, tier: victim.tier, up: false });
    }
    if (!by || by === victim) {
      // A self-kill (or the world) costs the progress on the rung.
      if (progress) victim.tierKills = 0;
      return;
    }
    by.kills++;
    if (cause === 'barrel') by.barrelKills++;
    if (knifed && progress) by.knifeKills++;
    if (progress) this.credit(by, cause, ev);
  }

  /** A kill climbs the ladder: `killsPerTier` promote; on the last rung only the knife counts, and it wins. */
  private credit(p: Player, cause: Cause, ev: MatchEvent[]) {
    if (this.winner) return;
    if (p.tier >= FINAL_TIER) {
      // The step ends the match (endMatch reports the win).
      if (cause === 'knife') this.winner = p.id;
      return;
    }
    p.tierKills++;
    if (p.tierKills >= this.rules.killsPerTier) {
      p.tier++;
      p.tierKills = 0;
      p.fireCd = 0;
      ev.push({ type: 'tier', id: p.id, tier: p.tier, up: true });
    }
  }

  // ---- dev / tests -----------------------------------------------------------------------------------------------

  /** Teleport a player (dev/tests). */
  place(id: string, x: number, y: number, aim?: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    if (aim !== undefined && Number.isFinite(aim)) p.aim = aim;
    resolveCircle(p, PLAYER_RADIUS, barrelCircles(this.barrels));
    p.history.clear();
  }

  /** Put a player on rung `tier` with `kills` on it (dev/tests). */
  setTier(id: string, tier: number, kills = 0): void {
    const p = this.players.get(id);
    if (!p) return;
    p.tier = Math.max(0, Math.min(FINAL_TIER, Math.floor(tier)));
    p.tierKills = Math.max(0, Math.min(this.rules.killsPerTier - 1, Math.floor(kills)));
  }

  /** Credit `n` kills as if earned (dev/tests): promotions as usual, never a win. */
  giveKills(id: string, n: number, ev: MatchEvent[]): void {
    const p = this.players.get(id);
    if (!p) return;
    for (let i = 0; i < n && p.tier < FINAL_TIER; i++) {
      p.kills++;
      this.credit(p, 'pistol', ev);
    }
  }

  /** End the match now; the leader by the ladder wins (dev). */
  forceEnd(ev: MatchEvent[]): void {
    if (this.phase === 'playing') this.endMatch(ev, 'time');
  }

  /** Start now (dev, and private rooms' `start`). */
  forceStart(ev: MatchEvent[]): void {
    if (this.phase === 'waiting' || this.phase === 'over') this.startMatch(ev);
  }

  /** Seconds until barrel `i` stands again (tests). */
  barrelRespawn(i: number): number {
    return this.barrelBack[i] ?? 0;
  }
}
