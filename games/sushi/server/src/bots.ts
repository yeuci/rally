import { INTERACT_RANGE, PLAYER_RADIUS, SINK_CAPACITY } from './constants.ts';
import type { Chef, Customer, SushiGame } from './game.ts';
import {
  Cook,
  Pan,
  SEAT_TARGET,
  SLOT_TARGET,
  actionFor,
  crateOpen,
  stationType,
  targetPoint,
  workFor,
} from './interact.ts';
import { SEATS, STATIONS, isFree, openBounds, type StationDef } from './map.ts';
import {
  CHOP,
  Kind,
  MAT_INGREDIENTS,
  isBeltDish,
  isChoppable,
  isHotDish,
  item,
  matchRecipe,
  recipeFor,
  type Item,
} from './recipes.ts';
import type { Vec2 } from './vec.ts';

/**
 * Helper bots: chefs the server drives through the same inputs a player sends (a stick, presses, a target), so they
 * obey every rule a human does. The headless simulation (test/sim.test.ts) runs crews of them through whole days to
 * check the tuning is survivable at every crew size; a dev command can add them to a room.
 *
 * Each bot re-plans every few ticks from what it holds and what the restaurant needs (a reactive priority list, no
 * long scripts): carry what is in hand where it belongs; serve table orders; save a gyoza before it burns; pull stale
 * plates; fetch the truck's box; wash and bus when plates run low; otherwise build a belt dish someone ordered on a
 * mat (claiming it, so two bots don't make the same plate), fetching its ingredients, chopping, rolling, plating.
 * Bots with an odd slot prefer the runner's jobs (tables, dishes, deliveries) when there are two or more chefs.
 * Movement follows A* paths on a 0.25-unit grid of the open floor.
 */

const CELL = 0.25;
const REPLAN_TICKS = 4;

interface Grid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  free: Uint8Array;
}

const grids = new Map<number, Grid>();

function gridFor(zones: number): Grid {
  let g = grids.get(zones);
  if (g) return g;
  const b = openBounds(zones);
  const w = Math.ceil((b.x1 - b.x0) / CELL);
  const h = Math.ceil((b.y1 - b.y0) / CELL);
  const free = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = b.x0 + (i + 0.5) * CELL;
      const y = b.y0 + (j + 0.5) * CELL;
      free[j * w + i] = isFree(x, y, zones, PLAYER_RADIUS + 0.04) ? 1 : 0;
    }
  }
  g = { x0: b.x0, y0: b.y0, w, h, free };
  grids.set(zones, g);
  return g;
}

const cellOf = (g: Grid, x: number, y: number) => ({
  i: Math.max(0, Math.min(g.w - 1, Math.floor((x - g.x0) / CELL))),
  j: Math.max(0, Math.min(g.h - 1, Math.floor((y - g.y0) / CELL))),
});
const centre = (g: Grid, i: number, j: number): Vec2 => ({ x: g.x0 + (i + 0.5) * CELL, y: g.y0 + (j + 0.5) * CELL });

/** The free cell nearest (x, y) (a ring search). */
function nearestFree(g: Grid, x: number, y: number): { i: number; j: number } | null {
  const c = cellOf(g, x, y);
  let best: { i: number; j: number } | null = null;
  let bestD = Infinity;
  for (let r = 0; r < 16 && !best; r++) {
    for (let j = c.j - r; j <= c.j + r; j++) {
      for (let i = c.i - r; i <= c.i + r; i++) {
        if (i < 0 || j < 0 || i >= g.w || j >= g.h || !g.free[j * g.w + i]) continue;
        const p = centre(g, i, j);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) [best, bestD] = [{ i, j }, d];
      }
    }
  }
  return best;
}

/** A* over the grid (8-neighbour, no corner cutting); the path as cell centres, smoothed by line of sight. */
export function findPath(zones: number, from: Vec2, to: Vec2): Vec2[] | null {
  const g = gridFor(zones);
  const s = nearestFree(g, from.x, from.y);
  const t = nearestFree(g, to.x, to.y);
  if (!s || !t) return null;
  const n = g.w * g.h;
  const cost = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const open: number[] = [];
  const startI = s.j * g.w + s.i;
  const goalI = t.j * g.w + t.i;
  cost[startI] = 0;
  open.push(startI);
  const hEst = (k: number) => Math.hypot((k % g.w) - t.i, Math.floor(k / g.w) - t.j);
  const fScore = new Float32Array(n).fill(Infinity);
  fScore[startI] = hEst(startI);
  const closed = new Uint8Array(n);
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (fScore[open[k]!]! < fScore[open[bi]!]!) bi = k;
    const cur = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (cur === goalI) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % g.w;
    const cj = Math.floor(cur / g.w);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const k = nj * g.w + ni;
        if (!g.free[k] || closed[k]) continue;
        if (di && dj && (!g.free[cj * g.w + ni] || !g.free[nj * g.w + ci])) continue;
        const c = cost[cur]! + (di && dj ? Math.SQRT2 : 1);
        if (c < cost[k]!) {
          cost[k] = c;
          prev[k] = cur;
          fScore[k] = c + hEst(k);
          open.push(k);
        }
      }
    }
  }
  if (cost[goalI] === Infinity) return null;
  const cells: Vec2[] = [];
  for (let k = goalI; k !== -1 && k !== startI; k = prev[k]!) cells.push(centre(g, k % g.w, Math.floor(k / g.w)));
  cells.reverse();
  // Line-of-sight smoothing on the grid.
  const out: Vec2[] = [];
  let anchor: Vec2 = from;
  for (let k = 0; k < cells.length; k++) {
    const next = cells[k + 1];
    if (next && clear(g, anchor, next)) continue;
    out.push(cells[k]!);
    anchor = cells[k]!;
  }
  return out;
}

function clear(g: Grid, a: Vec2, b: Vec2): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(d / (CELL * 0.5));
  for (let s = 1; s <= steps; s++) {
    const x = a.x + ((b.x - a.x) * s) / steps;
    const y = a.y + ((b.y - a.y) * s) / steps;
    const c = cellOf(g, x, y);
    if (!g.free[c.j * g.w + c.i]) return false;
  }
  return true;
}

/** A belt dish a bot is building, on a mat. */
interface DishJob {
  dish: Kind;
  mat: number;
  owner: string;
}

interface BotMind {
  id: string;
  goal: number;
  /** Hold the button at the goal (work) instead of tapping. */
  hold: boolean;
  path: Vec2[];
  pathFor: string;
  stuck: number;
  lastX: number;
  lastY: number;
  ticks: number;
  presses: number;
  wait: number;
  /** The ingredient it is on its way to get for a dish (so no two bots fetch the same one). */
  fetching: Kind | null;
  /** The runner task it claimed (see `free`). */
  task: string;
}

export class BotCrew {
  private readonly game: SushiGame;
  private readonly minds = new Map<string, BotMind>();
  private readonly jobs = new Map<string, DishJob>();
  /** Bots stand still (tests of other things). */
  frozen = false;

  constructor(game: SushiGame) {
    this.game = game;
  }

  think(dt: number): void {
    const g = this.game;
    for (const id of [...this.minds.keys()]) if (!g.chefs.get(id)?.bot) this.forget(id);
    if (g.phase !== 'morning' && g.phase !== 'open' && g.phase !== 'closing') {
      for (const c of g.chefs.values()) if (c.bot) c.input = { ...c.input, move: { x: 0, y: 0 }, button: false };
      this.jobs.clear();
      return;
    }
    for (const c of g.chefs.values()) {
      if (!c.bot) continue;
      let m = this.minds.get(c.id);
      if (!m) {
        m = {
          id: c.id,
          goal: -1,
          hold: false,
          path: [],
          pathFor: '',
          stuck: 0,
          lastX: c.x,
          lastY: c.y,
          ticks: 0,
          presses: c.input.presses,
          wait: 0,
          fetching: null,
          task: '',
        };
        this.minds.set(c.id, m);
      }
      if (this.frozen) {
        c.input = { ...c.input, move: { x: 0, y: 0 }, button: false };
        continue;
      }
      this.drive(c, m, dt);
    }
  }

  forget(id: string): void {
    this.minds.delete(id);
    this.jobs.delete(id);
  }

  private drive(c: Chef, m: BotMind, dt: number) {
    const g = this.game;
    m.ticks++;
    m.wait = Math.max(0, m.wait - dt);
    // Keep working while there is work at the goal (stirring is only worth it while nothing else needs doing).
    const working = m.hold && c.work >= 0 ? workFor(g, c.held, c.work) : null;
    if (working && working !== 'stir') {
      c.input = { ...c.input, move: { x: 0, y: 0 }, button: true };
      return;
    }
    if (working === 'stir' && m.ticks % 10 !== 0) {
      c.input = { ...c.input, move: { x: 0, y: 0 }, button: true };
      return;
    }
    if (m.ticks % REPLAN_TICKS === 0 || m.goal < 0 || !this.stillUseful(c, m)) this.plan(c, m);
    if (m.goal < 0) {
      c.input = { move: { x: 0, y: 0 }, button: false, presses: m.presses, target: -1 };
      return;
    }
    const p = targetPoint(g, m.goal);
    if (!p) {
      m.goal = -1;
      return;
    }
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d <= INTERACT_RANGE - 0.2) {
      // In reach: press (a tap, or a press held for work), standing still.
      const work = workFor(g, c.held, m.goal);
      const act = actionFor(g, c.held, m.goal);
      if (m.hold && work) {
        if (!c.input.button) m.presses++;
        c.input = { move: { x: 0, y: 0 }, button: true, presses: m.presses, target: m.goal };
      } else if (act && m.wait <= 0) {
        m.presses++;
        c.input = { move: { x: 0, y: 0 }, button: false, presses: m.presses, target: m.goal };
        m.wait = 0.1;
        m.goal = -1;
      } else {
        c.input = { move: { x: 0, y: 0 }, button: false, presses: m.presses, target: m.goal };
      }
      return;
    }
    // Walk there.
    const key = `${m.goal}:${g.zones}`;
    if (m.pathFor !== key || !m.path.length || m.ticks % 20 === 0) {
      m.path = findPath(g.zones, c, p) ?? [];
      m.pathFor = key;
    }
    while (m.path.length && Math.hypot(m.path[0]!.x - c.x, m.path[0]!.y - c.y) < 0.2) m.path.shift();
    const next = m.path[0] ?? p;
    const dx = next.x - c.x;
    const dy = next.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = m.path.length <= 1 ? Math.min(1, Math.max(0.35, d / 1.2)) : 1;
    c.input = { move: { x: (dx / len) * k, y: (dy / len) * k }, button: false, presses: m.presses, target: -1 };
    // Unstick: a bot that has not moved for a while drops its goal.
    if (Math.hypot(c.x - m.lastX, c.y - m.lastY) < 0.02) m.stuck += dt;
    else m.stuck = 0;
    m.lastX = c.x;
    m.lastY = c.y;
    if (m.stuck > 2) {
      m.stuck = 0;
      m.goal = -1;
      m.path = [];
      this.jobs.delete(c.id);
    }
  }

  private stillUseful(c: Chef, m: BotMind): boolean {
    if (m.goal < 0) return false;
    return actionFor(this.game, c.held, m.goal) !== null || (m.hold && workFor(this.game, c.held, m.goal) !== null);
  }

  private setGoal(m: BotMind, target: number, hold = false) {
    if (m.goal !== target) m.path = [];
    m.goal = target;
    m.hold = hold;
  }

  private plan(c: Chef, m: BotMind) {
    const g = this.game;
    m.hold = false;
    m.fetching = null;
    m.task = '';
    // The job is done once its dish is in hand (it is counted as held from now on).
    const job = this.jobs.get(c.id);
    if (job && c.held?.kind === job.dish) this.jobs.delete(c.id);
    if (c.held) {
      const t = this.whereToPut(c, c.held);
      if (t >= 0) this.setGoal(m, t);
      else m.goal = -1;
      return;
    }
    const runner = g.crew >= 2 && c.slot % 2 === 1;
    const t = runner ? (this.runnerJob(c, m) ?? this.cookJob(c, m)) : (this.cookJob(c, m) ?? this.runnerJob(c, m));
    if (t === null) m.goal = -1;
  }

  // --- where things go ------------------------------------------------------------------------------------------------
  private whereToPut(c: Chef, held: Item): number {
    const g = this.game;
    const nearest = (ids: number[]) => this.nearestOf(c, ids);
    switch (held.kind) {
      case Kind.DeliveryBox:
        return nearest(STATIONS.filter((s) => s.type === 'crate').map((s) => s.id));
      case Kind.DirtyPlate: {
        const sink = STATIONS.find((s) => s.type === 'sink')!;
        if (g.station(sink.id).count < SINK_CAPACITY) return sink.id;
        return this.spareCounter(c);
      }
      case Kind.GyozaBurnt:
        return this.bin();
      case Kind.GyozaRaw: {
        const pan = STATIONS.find((s) => s.type === 'pan')!;
        return actionFor(g, held, pan.id) ? pan.id : this.spareCounter(c);
      }
    }
    if (isHotDish(held.kind)) {
      const seats = SEATS.filter((s) => g.seat(s.id).wants === held.kind).map((s) => SEAT_TARGET + s.id);
      return seats.length ? nearest(seats) : this.spareCounter(c);
    }
    if (isBeltDish(held.kind)) {
      if (!held.plated) return STATIONS.find((s) => s.type === 'plates')!.id;
      // Off the belt because it went stale (or nobody wants it any more): the bin.
      if (!this.wanted(held.kind)) return this.bin();
      return this.passSlot(c, held);
    }
    if (isChoppable(held.kind)) {
      const boards = this.usableStations(c, (s, t) => t === 'board' && !g.station(s.id).item);
      return boards.at(0) ?? this.spareCounter(c);
    }
    if (MAT_INGREDIENTS.has(held.kind)) {
      const job = this.jobs.get(c.id) ?? this.jobFor(held.kind);
      if (job && actionFor(g, held, job.mat)) return job.mat;
      const mats = STATIONS.filter((s) => stationType(s, g) === 'mat' && actionFor(g, held, s.id)).map((s) => s.id);
      return mats.length ? nearest(mats) : this.spareCounter(c);
    }
    return this.bin();
  }

  /** The empty belt slot nearest the chef (the kitchen side when it is there). */
  private passSlot(c: Chef, held: Item): number {
    const g = this.game;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < g.slots.length; i++) {
      if (!actionFor(g, held, SLOT_TARGET + i)) continue;
      const p = targetPoint(g, SLOT_TARGET + i)!;
      const d = Math.hypot(p.x - c.x, p.y - c.y) + (p.y > -0.5 ? 3 : 0);
      if (d < bestD) [best, bestD] = [SLOT_TARGET + i, d];
    }
    return best;
  }

  private bin(): number {
    return STATIONS.find((s) => s.type === 'bin')!.id;
  }

  /** The nearest empty counter top, or the bin when the counters are full. */
  private spareCounter(c: Chef): number {
    const g = this.game;
    const t = this.nearestOf(
      c,
      STATIONS.filter((s) => stationType(s, g) === 'counter' && !g.station(s.id).item).map((s) => s.id),
    );
    return t >= 0 ? t : this.bin();
  }

  private nearestOf(c: Chef, targets: number[]): number {
    let best = -1;
    let bestD = Infinity;
    for (const t of targets) {
      const p = targetPoint(this.game, t);
      if (!p) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestD) [best, bestD] = [t, d];
    }
    return best;
  }

  private usableStations(c: Chef, pick: (s: StationDef, type: string) => boolean): number[] {
    const g = this.game;
    return STATIONS.filter((s) => (!s.zone || g.zones & s.zone) && pick(s, stationType(s, g)))
      .map((s) => s.id)
      .sort((a, b) => {
        const pa = targetPoint(g, a)!;
        const pb = targetPoint(g, b)!;
        return Math.hypot(pa.x - c.x, pa.y - c.y) - Math.hypot(pb.x - c.x, pb.y - c.y);
      });
  }

  // --- what is wanted ---------------------------------------------------------------------------------------------
  private waiting(): Customer[] {
    return [...this.game.customers.values()].filter(
      (c) => c.state === 'wait' || c.state === 'sit' || c.state === 'walkIn',
    );
  }

  /** Whether some customer still wants a belt dish of this kind more than the belt already carries. */
  private wanted(kind: Kind): boolean {
    return this.shortfall(kind) > -1;
  }

  /** Orders of `kind` minus fresh plates of it already on the belt or being built. */
  private shortfall(kind: Kind): number {
    const g = this.game;
    let want = 0;
    for (const c of this.waiting()) if (c.orders[c.course] === kind && SEATS[c.seat]!.kind === 'stool') want++;
    let have = 0;
    for (const s of g.slots) if (s.item?.kind === kind && !s.stale) have++;
    for (const j of this.jobs.values()) if (j.dish === kind) have++;
    for (const ch of g.chefs.values()) if (ch.held?.kind === kind) have++;
    for (const s of g.stations) if (s.item?.kind === kind) have++;
    return want - have;
  }

  private jobFor(kind: Kind): DishJob | null {
    for (const j of this.jobs.values()) if (recipeFor(j.dish)?.needs.includes(kind)) return j;
    return null;
  }

  // --- the cook's jobs: belt dishes --------------------------------------------------------------------------------
  private cookJob(c: Chef, m: BotMind): number | null {
    const g = this.game;
    // A finished dish on a mat or board waiting for a plate.
    for (const s of STATIONS) {
      const it = g.station(s.id).item;
      if (it && isBeltDish(it.kind) && this.wanted(it.kind) && stationType(s, g) !== 'counter') {
        this.setGoal(m, s.id);
        return s.id;
      }
    }
    let job = this.jobs.get(c.id);
    if (!job) {
      job = this.newJob(c) ?? undefined;
      if (!job) return this.helpJob(c, m);
    }
    const matView = g.station(job.mat);
    if (matView.item) {
      this.setGoal(m, job.mat);
      if (matView.item.kind === job.dish) this.jobs.delete(c.id);
      return job.mat;
    }
    const recipe = recipeFor(job.dish)!;
    // Something on the mat that doesn't belong: take it off.
    if (matView.mat.some((k) => !recipe.needs.includes(k))) {
      this.setGoal(m, job.mat);
      return job.mat;
    }
    if (matchRecipe(matView.mat, g.day)?.dish === job.dish) {
      this.setGoal(m, job.mat, true);
      return job.mat;
    }
    // Rice last: the pot cooks while the rest is fetched.
    const missing = recipe.needs
      .filter((k) => !matView.mat.includes(k))
      .sort((a, b) => (a === Kind.Rice ? 1 : 0) - (b === Kind.Rice ? 1 : 0));
    for (const k of missing) {
      if (this.claimed(k, c.id)) continue;
      const t = this.fetch(c, k, job.mat);
      if (t !== null) {
        this.setGoal(m, t.target, t.hold);
        m.fetching = k;
        return t.target;
      }
    }
    return null;
  }

  /** Someone else holds `k` (or the raw fish it is cut from) or is on the way to get it. */
  private claimed(k: Kind, self: string): boolean {
    for (const ch of this.game.chefs.values()) {
      if (ch.id === self) continue;
      if (ch.held?.kind === k || (ch.held && CHOP[ch.held.kind] === k)) return true;
      if (this.minds.get(ch.id)?.fetching === k) return true;
    }
    return false;
  }

  private newJob(c: Chef): DishJob | null {
    const g = this.game;
    const busyMats = new Set([...this.jobs.values()].map((j) => j.mat));
    const mats = STATIONS.filter((s) => stationType(s, g) === 'mat' && !busyMats.has(s.id));
    if (!mats.length) return null;
    // The most-wanted dish, most impatient customer first.
    const waiting = this.waiting()
      .filter((w) => SEATS[w.seat]!.kind === 'stool')
      .sort((a, b) => a.patience - b.patience);
    for (const w of waiting) {
      const dish = w.orders[w.course]!;
      if (this.shortfall(dish) <= 0) continue;
      const mat =
        mats.find((s) => {
          const v = g.station(s.id);
          return !v.item && v.mat.every((k) => recipeFor(dish)!.needs.includes(k));
        }) ?? mats[0]!;
      const job = { dish, mat: mat.id, owner: c.id };
      this.jobs.set(c.id, job);
      return job;
    }
    return null;
  }

  /** No job of its own: fetch an ingredient someone else's dish still lacks. */
  private helpJob(c: Chef, m: BotMind): number | null {
    const g = this.game;
    for (const job of this.jobs.values()) {
      const v = g.station(job.mat);
      const missing = recipeFor(job.dish)!.needs.filter((k) => !v.mat.includes(k));
      for (const k of missing) {
        if (this.claimed(k, c.id)) continue;
        const t = this.fetch(c, k, job.mat);
        if (t) {
          this.setGoal(m, t.target, t.hold);
          m.fetching = k;
          return t.target;
        }
      }
    }
    // Keep the rice pot going.
    const rice = STATIONS.find((s) => s.type === 'rice')!;
    if (g.station(rice.id).state === Cook.idle) {
      this.setGoal(m, rice.id);
      return rice.id;
    }
    return null;
  }

  /** The next step toward having ingredient `k` in hand: a target (and whether to hold), or null. */
  private fetch(c: Chef, k: Kind, mat: number): { target: number; hold: boolean } | null {
    const g = this.game;
    // Only fetch what the mat can take right now (else it would end up parked on a counter, and picked up again).
    if (!actionFor(g, item(k), mat)) return null;
    if (k === Kind.Rice) {
      const rice = STATIONS.find((s) => s.type === 'rice')!;
      const v = g.station(rice.id);
      if (v.state === Cook.ready && v.count > 0) return { target: rice.id, hold: false };
      if (v.state === Cook.idle) return { target: rice.id, hold: false };
      return { target: rice.id, hold: true }; // stir while it cooks
    }
    // Leftovers on a counter first.
    for (const s of STATIONS) {
      if (stationType(s, g) === 'counter' && g.station(s.id).item?.kind === k) return { target: s.id, hold: false };
    }
    const raw = (Object.keys(CHOP).map(Number) as Kind[]).find((r) => CHOP[r] === k);
    if (raw !== undefined) {
      // A slice: ready on a board, or a raw one to chop, or fetch the raw fish (a free board must be there for it).
      for (const s of STATIONS) {
        if (stationType(s, g) !== 'board') continue;
        const it = g.station(s.id).item;
        if (it?.kind === k) return { target: s.id, hold: false };
        if (it?.kind === raw) return { target: s.id, hold: true };
      }
      const freeBoard = STATIONS.some((s) => stationType(s, g) === 'board' && !g.station(s.id).item);
      if (!freeBoard) return null;
      return this.crateFor(c, raw);
    }
    return this.crateFor(c, k);
  }

  private crateFor(c: Chef, k: Kind): { target: number; hold: boolean } | null {
    const g = this.game;
    const crate = STATIONS.find((s) => s.crate === k);
    if (!crate || !crateOpen(crate, g, g.station(crate.id))) return null;
    void c;
    return { target: crate.id, hold: false };
  }

  // --- the runner's jobs: tables, the pan, stale plates, dishes, deliveries ---------------------------------------
  /** A task no other bot has claimed (`task` keys in the minds: 'pan', 'slot:3', 'cust:12', 'drop', 'sink', …). */
  private free(task: string, self: string): boolean {
    for (const [id, m] of this.minds) if (id !== self && m.task === task) return false;
    return true;
  }

  private runnerJob(c: Chef, m: BotMind): number | null {
    const g = this.game;
    const go = (t: number, task: string, hold = false) => {
      this.setGoal(m, t, hold);
      m.task = task;
      return t;
    };
    // The pan first: never let gyoza burn; bin a burnt one.
    const pan = STATIONS.find((s) => s.type === 'pan')!;
    const pv = g.station(pan.id);
    if ((pv.state === Pan.done || pv.state === Pan.smoking || pv.state === Pan.burnt) && this.free('pan', c.id)) {
      return go(pan.id, 'pan');
    }
    // Stale plates on the belt.
    for (let i = 0; i < g.slots.length; i++) {
      if (g.slots[i]!.stale && this.free(`slot:${i}`, c.id)) return go(SLOT_TARGET + i, `slot:${i}`);
    }
    // Table orders, most impatient first, one bot per customer.
    const tables = this.waiting()
      .filter((w) => SEATS[w.seat]!.kind === 'table' && w.state === 'wait')
      .sort((a, b) => a.patience - b.patience);
    const covered = new Map<Kind, number>();
    for (const ch of g.chefs.values()) if (ch.held) covered.set(ch.held.kind, (covered.get(ch.held.kind) ?? 0) + 1);
    for (const w of tables) {
      const k = w.orders[w.course]!;
      const have = covered.get(k) ?? 0;
      if (have > 0) {
        covered.set(k, have - 1);
        continue;
      }
      const task = `cust:${w.id}`;
      if (!this.free(task, c.id)) continue;
      // A dish of it waiting on a counter.
      for (const s of STATIONS) {
        if (stationType(s, g) === 'counter' && g.station(s.id).item?.kind === k) return go(s.id, task);
      }
      if (k === Kind.Gyoza) {
        if (pv.state === Pan.cooking && this.free('pan', c.id)) return go(pan.id, 'pan', true);
        if (pv.state === Pan.empty && this.free('gyoza', c.id) && !this.claimed(Kind.GyozaRaw, c.id)) {
          const crate = STATIONS.find((s) => s.crate === Kind.GyozaRaw);
          if (crate && crateOpen(crate, g, g.station(crate.id))) {
            m.fetching = Kind.GyozaRaw;
            return go(crate.id, 'gyoza');
          }
        }
        continue;
      }
      const pot = STATIONS.find((s) => s.dish === k);
      if (!pot) continue;
      const v = g.station(pot.id);
      if (v.state === Cook.ready && v.count > 0) return go(pot.id, task);
      if (!this.free(`pot:${pot.id}`, c.id)) continue;
      if (v.state === Cook.idle) return go(pot.id, `pot:${pot.id}`);
      return go(pot.id, `pot:${pot.id}`, true);
    }
    // The truck's box, when stock runs low.
    const drop = STATIONS.find((s) => s.type === 'drop')!;
    if ((!drop.zone || g.zones & drop.zone) && g.station(drop.id).count > 0 && this.free('drop', c.id)) {
      const low = STATIONS.some((s) => s.type === 'crate' && g.station(s.id).count >= 0 && g.station(s.id).count <= 2);
      if (low) return go(drop.id, 'drop');
    }
    // Dishes: wash when plates run low, bus when seats are dirty.
    if (g.dishes) {
      const plates = g.station(STATIONS.find((s) => s.type === 'plates')!.id).count;
      const sink = STATIONS.find((s) => s.type === 'sink')!;
      if (g.station(sink.id).count > 0 && plates <= 5 && this.free('sink', c.id)) return go(sink.id, 'sink', true);
      // Bus a pile before it blocks the seat, or anything once the plates run low.
      const dirty = SEATS.filter((s) => g.seat(s.id).dirty >= (plates <= 6 ? 1 : 2) && this.free(`bus:${s.id}`, c.id));
      if (dirty.length) {
        const t = this.nearestOf(
          c,
          dirty.map((s) => SEAT_TARGET + s.id),
        );
        return go(t, `bus:${t - SEAT_TARGET}`);
      }
      if (g.station(sink.id).count > 0 && this.free('sink', c.id)) return go(sink.id, 'sink', true);
    }
    // Every counter full of leftovers: clear one (it goes to the bin unless a dish needs it).
    const counters = STATIONS.filter((s) => stationType(s, g) === 'counter');
    if (counters.every((s) => g.station(s.id).item)) {
      const junk = counters.filter((s) => !this.needed(g.station(s.id).item!.kind)).map((s) => s.id);
      if (junk.length) return go(this.nearestOf(c, junk), 'junk');
    }
    return null;
  }

  /** Whether an item could still go into a dish someone is building or waiting for. */
  private needed(k: Kind): boolean {
    if (isBeltDish(k) || isHotDish(k)) return this.wanted(k) || this.waiting().some((w) => w.orders[w.course] === k);
    for (const j of this.jobs.values()) {
      const r = recipeFor(j.dish);
      if (r?.needs.includes(k) || r?.needs.some((n) => CHOP[k] === n)) return true;
    }
    return false;
  }
}
