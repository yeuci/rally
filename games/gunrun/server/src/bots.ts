import { ARENA_HALF_H, ARENA_HALF_W, MELEE, PLAYER_HP, PLAYER_RADIUS, type WeaponSpec } from './constants.ts';
import { lineOfSight } from './geometry.ts';
import { MEDS, OBSTACLES, POSTS, circleIsFree } from './map.ts';
import type { GunRunMatch, Player } from './match.ts';
import { Rng } from './rng.ts';
import type { Vec2 } from './vec.ts';
import { onTheirScreen } from './view.ts';

/**
 * Server-side bots for quick play (the room fills rooms with them while few humans are in): simple on purpose, and
 * steady. Each bot commits to one opponent for a while (a med kit instead when hurt), walks a grid path toward it,
 * keeps a weapon-dependent distance once it can see it and strafes, turning its aim at a capped rate and smoothing
 * its steps. It fires only after a reaction delay, with an aim error, and only from where its target's screen shows
 * it (and with a clear line): a phone shows a small part of the yard, and a shot from off screen is no fun. The knife
 * rung rushes in. Bots play by the same inputs as everyone (`setInput`), so the rules treat them like players.
 */

/** Bot names (the HUD marks them as bots). */
export const BOT_NAMES = ['Ace', 'Bolt', 'Cobra', 'Dash', 'Echo', 'Fox', 'Gunner', 'Hawk'] as const;

const CELL = 1;
const COLS = ARENA_HALF_W * 2;
const ROWS = ARENA_HALF_H * 2;
/** Seconds between path recomputations per bot. */
const REPATH = 0.5;
/** Seconds a bot needs to see someone before it shoots. */
const REACTION = [0.3, 0.6] as const;
/** Aim error (radians, ± uniform), re-rolled a few times a second. */
const AIM_ERROR = 0.14;
/** A bot keeps its target at least this long (s) unless it dies, hides, or a much closer threat shows up. */
export const BOT_COMMIT = 1.75;
/** Out of sight this long (s), a target is let go when someone else is in sight. */
const LOST_SIGHT = 0.6;
/** "Much closer": a rival's distance under this fraction of the target's switches at once. */
const CLEARLY_CLOSER = 0.6;
/** After the commitment, a rival must still be this much closer (fraction) to take over (hysteresis). */
const CLOSER = 0.85;
/** Aim turn rate, radians per second (a half turn takes about half a second: a sweep, not a snap). */
export const BOT_TURN_RATE = 6;
/** Fires only when the aim is within this of the target (before the aim error). */
const ON_TARGET = 0.3;
/** Time constant of the movement smoothing, s. */
const STEER_TAU = 0.22;
/** Preferred fighting distances are capped here: inside a phone's view of the target, where a bot may fire. */
const MAX_RANGE = 7;

const cellOf = (x: number, y: number) => {
  const cx = Math.max(0, Math.min(COLS - 1, Math.floor((x + ARENA_HALF_W) / CELL)));
  const cy = Math.max(0, Math.min(ROWS - 1, Math.floor((y + ARENA_HALF_H) / CELL)));
  return cy * COLS + cx;
};
const centreOf = (c: number): Vec2 => ({
  x: -ARENA_HALF_W + ((c % COLS) + 0.5) * CELL,
  y: -ARENA_HALF_H + (Math.floor(c / COLS) + 0.5) * CELL,
});
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Walkable cells of the yard (a player-sized circle fits at the centre). Barrels are left to the collisions. */
let walkable: Uint8Array | null = null;
function grid(): Uint8Array {
  if (!walkable) {
    walkable = new Uint8Array(COLS * ROWS);
    for (let c = 0; c < COLS * ROWS; c++) {
      const p = centreOf(c);
      walkable[c] = circleIsFree(p.x, p.y, PLAYER_RADIUS + 0.05) ? 1 : 0;
    }
  }
  return walkable;
}

/** Breadth-first distances (8-neighbour, no corner cutting) from `goal` over walkable cells. */
function distancesTo(goal: number): Int32Array {
  const g = grid();
  const dist = new Int32Array(COLS * ROWS).fill(-1);
  const queue = new Int32Array(COLS * ROWS);
  let head = 0;
  let tail = 0;
  dist[goal] = 0;
  queue[tail++] = goal;
  while (head < tail) {
    const c = queue[head++]!;
    const cx = c % COLS;
    const cy = Math.floor(c / COLS);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const n = ny * COLS + nx;
        if (!g[n] || dist[n]! >= 0) continue;
        if (dx && dy && (!g[cy * COLS + nx] || !g[ny * COLS + cx])) continue;
        dist[n] = dist[c]! + 1;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}

/** The neighbouring cell closest to the goal of `dist` from cell `c`, or -1. */
function downhill(dist: Int32Array, c: number): number {
  const cx = c % COLS;
  const cy = Math.floor(c / COLS);
  let best = dist[c]! >= 0 ? dist[c]! : Infinity;
  let pick = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const d = dist[ny * COLS + nx]!;
      if (d >= 0 && d < best) [best, pick] = [d, ny * COLS + nx];
    }
  }
  return pick;
}

/**
 * Where to head toward the goal of `dist` from `at`: the farthest of the next few path cells in a straight, clear
 * line (so a bot walks lanes, not a staircase of cell centres), or null.
 */
function nextStep(dist: Int32Array, at: Vec2): Vec2 | null {
  let c = cellOf(at.x, at.y);
  let step: Vec2 | null = null;
  for (let i = 0; i < 4; i++) {
    const n = downhill(dist, c);
    if (n < 0) break;
    const p = centreOf(n);
    if (step && !lineOfSight(at.x, at.y, p.x, p.y, OBSTACLES, POSTS)) break;
    step = p;
    c = n;
  }
  return step;
}

interface Brain {
  target: string | null;
  /** Seconds on the current target; seconds it has been out of sight. */
  held: number;
  hidden: number;
  goal: number;
  dist: Int32Array | null;
  repath: number;
  /** Seconds the current target has been in sight. */
  seen: number;
  reaction: number;
  /** Where the bot aims (it turns toward the target at `BOT_TURN_RATE`). */
  aim: number;
  aimError: number;
  aimTimer: number;
  /** The smoothed move stick. */
  move: Vec2;
  strafe: 1 | -1;
  strafeTimer: number;
  /** Unsticking: where it was a moment ago, and a detour while stuck. */
  last: Vec2;
  stuckTimer: number;
  detour: Vec2 | null;
  detourTimer: number;
}

/** Preferred distance to an opponent with this weapon. */
function preferred(w: WeaponSpec): number {
  if (w.kind === 'melee') return 0;
  if (w.kind === 'rocket' || w.kind === 'grenade') return Math.min(MAX_RANGE, w.range * 0.7);
  if (w.pellets > 1) return 3.5;
  return Math.min(MAX_RANGE, w.range * 0.55);
}

export class BotDriver {
  /** Dev/test: bots stand still and hold fire. */
  frozen = false;
  private readonly brains = new Map<string, Brain>();
  private readonly rng: Rng;
  private readonly match: GunRunMatch;

  constructor(match: GunRunMatch, seed = 7) {
    this.match = match;
    this.rng = new Rng(seed);
  }

  /** The opponent a bot is after (tests and the dev probe), or null. */
  targetOf(id: string): string | null {
    return this.brains.get(id)?.target ?? null;
  }

  /** Where a bot aims, radians (tests). */
  aimOf(id: string): number | null {
    return this.brains.get(id)?.aim ?? null;
  }

  /** Set every bot's input for the next step. */
  think(dt: number): void {
    const m = this.match;
    for (const id of [...this.brains.keys()]) if (!m.players.get(id)?.bot) this.brains.delete(id);
    for (const p of m.playerList) {
      if (!p.bot) continue;
      let b = this.brains.get(p.id);
      if (!b) {
        b = {
          target: null,
          held: 0,
          hidden: 0,
          goal: -1,
          dist: null,
          repath: 0,
          seen: 0,
          reaction: REACTION[0],
          aim: p.aim,
          aimError: 0,
          aimTimer: 0,
          move: { x: 0, y: 0 },
          strafe: this.rng.next() < 0.5 ? 1 : -1,
          strafeTimer: 1,
          last: { x: p.x, y: p.y },
          stuckTimer: 0,
          detour: null,
          detourTimer: 0,
        };
        this.brains.set(p.id, b);
      }
      if (this.frozen || !p.alive || m.phase === 'over') {
        m.setInput(p.id, { move: { x: 0, y: 0 }, aim: null, fire: false, melee: false });
        b.seen = 0;
        b.move = { x: 0, y: 0 };
        b.aim = p.aim;
        if (!p.alive) b.target = null;
        continue;
      }
      // "Get ready": walk into position, no shooting yet.
      this.drive(p, b, dt, m.phase === 'starting');
    }
  }

  /**
   * The target, with commitment and hysteresis: kept for `BOT_COMMIT` s unless it dies, stays out of sight while
   * someone else is in sight, or a rival is clearly closer; after that a rival must still be closer by a margin.
   */
  private pickTarget(p: Player, b: Brain, dt: number): Player | null {
    const m = this.match;
    let best: Player | null = null;
    let bestScore = Infinity;
    let bestVisible = false;
    let current: Player | null = null;
    let currentScore = Infinity;
    let currentVisible = false;
    for (const o of m.playerList) {
      if (o === p || !o.alive) continue;
      const visible = lineOfSight(p.x, p.y, o.x, o.y, OBSTACLES, POSTS);
      const score = Math.hypot(o.x - p.x, o.y - p.y) * (visible ? 0.6 : 1);
      if (score < bestScore) [best, bestScore, bestVisible] = [o, score, visible];
      if (o.id === b.target) [current, currentScore, currentVisible] = [o, score, visible];
    }
    b.held += dt;
    b.hidden = current && !currentVisible ? b.hidden + dt : 0;
    const keep =
      current !== null &&
      !(b.hidden > LOST_SIGHT && bestVisible && best !== current) &&
      !(bestScore < currentScore * CLEARLY_CLOSER) &&
      !(b.held >= BOT_COMMIT && bestScore < currentScore * CLOSER);
    const target = keep ? current : best;
    if (target?.id !== b.target) {
      b.target = target?.id ?? null;
      b.held = 0;
      b.hidden = 0;
      b.seen = 0;
      b.reaction = REACTION[0] + this.rng.next() * (REACTION[1] - REACTION[0]);
    }
    return target;
  }

  private drive(p: Player, b: Brain, dt: number, holdFire: boolean) {
    const m = this.match;
    const w = m.weaponOf(p);
    const target = this.pickTarget(p, b, dt);
    // Hurt: a med kit on the ground instead (when one is closer than the fight).
    let goal: Vec2 | null = target;
    if (p.hp < PLAYER_HP * 0.4) {
      let near = Infinity;
      MEDS.forEach((med, i) => {
        if (!(m.meds & (1 << i))) return;
        const d = Math.hypot(med.x - p.x, med.y - p.y);
        if (d < near && d < 14) [near, goal] = [d, med];
      });
    }
    const sees = !!target && lineOfSight(p.x, p.y, target.x, target.y, OBSTACLES, POSTS);
    // Seen by the target: inside what their screen shows (the only place a bot may shoot from).
    const shown = !!target && onTheirScreen(target, p);
    b.seen = sees ? b.seen + dt : 0;
    const dist = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;

    // Movement: the path toward the goal, or holding a distance and strafing once in sight.
    let want: Vec2 = { x: 0, y: 0 };
    b.repath -= dt;
    if (goal) {
      const cell = cellOf(goal.x, goal.y);
      if (b.repath <= 0 || cell !== b.goal || !b.dist) {
        b.goal = cell;
        b.dist = distancesTo(cell);
        b.repath = REPATH;
      }
      const chasing = goal === target;
      if (chasing && sees && target) {
        const tx = (target.x - p.x) / (dist || 1);
        const ty = (target.y - p.y) / (dist || 1);
        // Off their screen: close in until it shows you. Else hold the weapon's distance.
        const keep = shown ? preferred(w) : 0;
        const radial = dist > keep + 1 ? 1 : dist < keep - 1 ? -0.8 : 0;
        b.strafeTimer -= dt;
        if (b.strafeTimer <= 0) {
          b.strafe = this.rng.next() < 0.5 ? 1 : -1;
          b.strafeTimer = 1.2 + this.rng.next() * 1.4;
        }
        const side = w.kind === 'melee' ? 0 : 0.7;
        want = { x: tx * radial - ty * b.strafe * side, y: ty * radial + tx * b.strafe * side };
      } else {
        const step = nextStep(b.dist, p);
        want = step ? { x: step.x - p.x, y: step.y - p.y } : { x: goal.x - p.x, y: goal.y - p.y };
      }
    }
    // Stuck against something (a barrel, another body): take a short detour.
    b.stuckTimer += dt;
    if (b.stuckTimer >= 0.8) {
      const moved = Math.hypot(p.x - b.last.x, p.y - b.last.y);
      if (moved < 0.4 && Math.hypot(b.move.x, b.move.y) > 0.3) {
        const a = this.rng.next() * Math.PI * 2;
        b.detour = { x: Math.cos(a), y: Math.sin(a) };
        b.detourTimer = 0.5;
      }
      b.last = { x: p.x, y: p.y };
      b.stuckTimer = 0;
    }
    if (b.detour && b.detourTimer > 0) {
      b.detourTimer -= dt;
      want = b.detour;
    }
    // Full speed toward anything but a near stop.
    const wl = Math.hypot(want.x, want.y);
    if (wl > 0.15) want = { x: want.x / wl, y: want.y / wl };
    // Smoothed steps: the stick eases toward what the bot wants instead of flipping every tick.
    const k = 1 - Math.exp(-dt / STEER_TAU);
    b.move = { x: b.move.x + (want.x - b.move.x) * k, y: b.move.y + (want.y - b.move.y) * k };
    const ml = Math.hypot(b.move.x, b.move.y);
    const move = ml > 1 ? { x: b.move.x / ml, y: b.move.y / ml } : ml < 0.05 ? { x: 0, y: 0 } : b.move;

    // Aim: turn toward the target (or the way it walks) at a capped rate; fire when on target and shown.
    b.aimTimer -= dt;
    if (b.aimTimer <= 0) {
      b.aimError = (this.rng.next() * 2 - 1) * AIM_ERROR;
      b.aimTimer = 0.3 + this.rng.next() * 0.3;
    }
    const exact = target && sees ? Math.atan2(target.y - p.y, target.x - p.x) : null;
    const desired = exact !== null ? exact + b.aimError : ml > 0.3 ? Math.atan2(move.y, move.x) : b.aim;
    const turn = wrap(desired - b.aim);
    const maxTurn = BOT_TURN_RATE * dt;
    b.aim = wrap(b.aim + Math.max(-maxTurn, Math.min(maxTurn, turn)));
    let fire = false;
    let melee = false;
    if (exact !== null && target) {
      const ready = b.seen >= b.reaction && !holdFire;
      const onTarget = Math.abs(wrap(exact - b.aim)) <= ON_TARGET;
      const tooClose = (w.kind === 'rocket' || w.kind === 'grenade') && dist < 2.4;
      fire = ready && shown && onTarget && w.kind !== 'melee' && dist <= w.range * 0.95 && !tooClose;
      melee = ready && onTarget && dist <= MELEE.range + PLAYER_RADIUS * 0.8;
    }
    m.setInput(p.id, { move, aim: { x: Math.cos(b.aim), y: Math.sin(b.aim) }, fire, melee });
  }
}
