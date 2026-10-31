import { ARENA_HALF_H, ARENA_HALF_W, MELEE, PLAYER_HP, PLAYER_RADIUS, type WeaponSpec } from './constants.ts';
import { lineOfSight } from './geometry.ts';
import { MEDS, OBSTACLES, POSTS, circleIsFree } from './map.ts';
import type { GunRunMatch, Player } from './match.ts';
import { Rng } from './rng.ts';
import type { Vec2 } from './vec.ts';

/**
 * Server-side bots for quick play (the room fills rooms with them while few humans are in): simple on purpose. Each
 * bot picks the nearest opponent (a med kit instead when hurt), walks a grid path toward it, keeps a weapon-dependent
 * distance once it can see it, strafes, and shoots with a reaction delay and an aim error; the knife rung rushes in.
 * They play by the same inputs as everyone (`setInput`), so the rules treat them like players.
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

const cellOf = (x: number, y: number) => {
  const cx = Math.max(0, Math.min(COLS - 1, Math.floor((x + ARENA_HALF_W) / CELL)));
  const cy = Math.max(0, Math.min(ROWS - 1, Math.floor((y + ARENA_HALF_H) / CELL)));
  return cy * COLS + cx;
};
const centreOf = (c: number): Vec2 => ({
  x: -ARENA_HALF_W + ((c % COLS) + 0.5) * CELL,
  y: -ARENA_HALF_H + (Math.floor(c / COLS) + 0.5) * CELL,
});

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

/** Where to step next toward the goal of `dist` from `at`: the neighbouring cell's centre closest to it. */
function nextStep(dist: Int32Array, at: Vec2): Vec2 | null {
  const c = cellOf(at.x, at.y);
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
  return pick < 0 ? null : centreOf(pick);
}

interface Brain {
  target: string | null;
  goal: number;
  dist: Int32Array | null;
  repath: number;
  /** Seconds the current target has been in sight. */
  seen: number;
  aimError: number;
  aimTimer: number;
  strafe: 1 | -1;
  strafeTimer: number;
  /** Unsticking: where it was a moment ago, and a detour while stuck. */
  last: Vec2;
  stuckTimer: number;
  detour: Vec2 | null;
  detourTimer: number;
  reaction: number;
}

/** Preferred distance to an opponent with this weapon. */
function preferred(w: WeaponSpec): number {
  if (w.kind === 'melee') return 0;
  if (w.kind === 'rocket' || w.kind === 'grenade') return Math.min(8, w.range * 0.7);
  if (w.pellets > 1) return 3.5;
  return Math.min(10, w.range * 0.55);
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
          goal: -1,
          dist: null,
          repath: 0,
          seen: 0,
          aimError: 0,
          aimTimer: 0,
          strafe: this.rng.next() < 0.5 ? 1 : -1,
          strafeTimer: 1,
          last: { x: p.x, y: p.y },
          stuckTimer: 0,
          detour: null,
          detourTimer: 0,
          reaction: REACTION[0],
        };
        this.brains.set(p.id, b);
      }
      if (this.frozen || !p.alive || m.phase === 'over') {
        m.setInput(p.id, { move: { x: 0, y: 0 }, aim: null, fire: false, melee: false });
        b.seen = 0;
        continue;
      }
      // "Get ready": walk into position, no shooting yet.
      this.drive(p, b, dt, m.phase === 'starting');
    }
  }

  private drive(p: Player, b: Brain, dt: number, holdFire: boolean) {
    const m = this.match;
    const w = m.weaponOf(p);
    // The nearest opponent, preferring one in sight.
    let target: Player | null = null;
    let best = Infinity;
    for (const o of m.playerList) {
      if (o === p || !o.alive) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y) * (lineOfSight(p.x, p.y, o.x, o.y, OBSTACLES, POSTS) ? 0.6 : 1);
      if (d < best) [best, target] = [d, o];
    }
    if (target?.id !== b.target) {
      b.target = target?.id ?? null;
      b.seen = 0;
      b.reaction = REACTION[0] + this.rng.next() * (REACTION[1] - REACTION[0]);
    }
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
    b.seen = sees ? b.seen + dt : 0;
    const dist = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;

    // Movement: the path toward the goal, or holding a distance and strafing once in sight.
    let move: Vec2 = { x: 0, y: 0 };
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
        const want = preferred(w);
        const tx = (target.x - p.x) / (dist || 1);
        const ty = (target.y - p.y) / (dist || 1);
        const radial = dist > want + 1 ? 1 : dist < want - 1 ? -0.8 : 0;
        b.strafeTimer -= dt;
        if (b.strafeTimer <= 0) {
          b.strafe = this.rng.next() < 0.5 ? 1 : -1;
          b.strafeTimer = 0.8 + this.rng.next() * 1.2;
        }
        const side = w.kind === 'melee' ? 0 : 0.7;
        move = { x: tx * radial - ty * b.strafe * side, y: ty * radial + tx * b.strafe * side };
      } else {
        const step = nextStep(b.dist, p);
        if (step) move = { x: step.x - p.x, y: step.y - p.y };
        else move = { x: goal.x - p.x, y: goal.y - p.y };
      }
    }
    // Stuck against something (a barrel, another body): take a short detour.
    b.stuckTimer += dt;
    if (b.stuckTimer >= 0.8) {
      const moved = Math.hypot(p.x - b.last.x, p.y - b.last.y);
      if (moved < 0.4 && Math.hypot(move.x, move.y) > 0.1) {
        const a = this.rng.next() * Math.PI * 2;
        b.detour = { x: Math.cos(a), y: Math.sin(a) };
        b.detourTimer = 0.5;
      }
      b.last = { x: p.x, y: p.y };
      b.stuckTimer = 0;
    }
    if (b.detour && b.detourTimer > 0) {
      b.detourTimer -= dt;
      move = b.detour;
    }
    const len = Math.hypot(move.x, move.y);
    if (len > 1e-6) move = { x: move.x / len, y: move.y / len };

    // Aim and fire.
    b.aimTimer -= dt;
    if (b.aimTimer <= 0) {
      b.aimError = (this.rng.next() * 2 - 1) * AIM_ERROR;
      b.aimTimer = 0.3 + this.rng.next() * 0.3;
    }
    let aim: Vec2 | null = null;
    let fire = false;
    let melee = false;
    if (target && sees) {
      const a = Math.atan2(target.y - p.y, target.x - p.x) + b.aimError;
      aim = { x: Math.cos(a), y: Math.sin(a) };
      const ready = b.seen >= b.reaction && !holdFire;
      const tooClose = (w.kind === 'rocket' || w.kind === 'grenade') && dist < 2.4;
      fire = ready && w.kind !== 'melee' && dist <= w.range * 0.95 && !tooClose;
      melee = ready && dist <= MELEE.range + PLAYER_RADIUS * 0.8;
    } else if (len > 1e-6) {
      aim = move;
    }
    m.setInput(p.id, { move, aim, fire, melee });
  }
}
