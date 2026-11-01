import { FACING_BIAS, INTERACT_RANGE, MAT_CAPACITY, SINK_CAPACITY, CARRY_PLATES } from './constants.ts';
import { BELT_LENGTH, SEATS, STATIONS, beltPoint, type StationDef, type StationType } from './map.ts';
import {
  CRATE_DAY,
  Kind,
  MAT_INGREDIENTS,
  couldBecome,
  isBeltDish,
  isChoppable,
  isHotDish,
  matchRecipe,
  type Item,
} from './recipes.ts';
import { BELT_SLOTS } from './constants.ts';

/**
 * What one press of the context button does, decided the same way on the server (which then does it) and on the
 * client (which highlights the target it will act on): pure functions over a read-only view of the world.
 *
 * A target is one number: a station id (0–99), 100 + a seat id, or 200 + a belt slot.
 */
export const SEAT_TARGET = 100;
export const SLOT_TARGET = 200;

export type Action =
  | 'crate'
  | 'take'
  | 'matTake'
  | 'cookStart'
  | 'cookTake'
  | 'beltTake'
  | 'bus'
  | 'dropTake'
  | 'put'
  | 'matAdd'
  | 'plate'
  | 'beltPut'
  | 'bin'
  | 'sinkPut'
  | 'serve'
  | 'restock';

export type Work = 'chop' | 'roll' | 'wash' | 'stir';

/** Cook stations' states (rice, pots, steamer). */
export const Cook = { idle: 0, cooking: 1, ready: 2 } as const;
/** The gyoza pan's states. */
export const Pan = { empty: 0, cooking: 1, done: 2, smoking: 3, burnt: 4 } as const;

export interface StationView {
  item: Item | null;
  /** The mat's ingredients (empty elsewhere). */
  mat: readonly Kind[];
  /** Cook stations: `Cook`; the pan: `Pan`. */
  state: number;
  /** Portions ready, clean plates, dirty plates in the sink, a crate's stock (-1: unlimited). */
  count: number;
}

export interface SeatView {
  /** Open for customers (its zone is open, a stool the crew size opens). */
  open: boolean;
  /** The customer's current order while they wait for it (Kind.None otherwise). */
  wants: Kind;
  dirty: number;
}

/** The read-only world `actionFor` and `pickTarget` need (the server's game or the client's synced state). */
export interface WorldView {
  day: number;
  zones: number;
  /** Upgrades that change stations (`stationType`). */
  board2: boolean;
  mat2: boolean;
  /** Dirty dishes are on (Thursday on): plates are counted and come back dirty. */
  dishes: boolean;
  /** Belt offset (units) and its slots' items and staleness. */
  beltS: number;
  slot(i: number): { item: Item | null; stale: boolean };
  station(id: number): StationView;
  seat(id: number): SeatView;
}

/** What a station is today (a spare counter becomes a second board or mat with its upgrade). */
export function stationType(def: StationDef, w: Pick<WorldView, 'board2' | 'mat2'>): StationType {
  if (def.upgrade === 'board2' && w.board2) return 'board';
  if (def.upgrade === 'mat2' && w.mat2) return 'mat';
  return def.type;
}

const cookTypes: ReadonlySet<StationType> = new Set(['rice', 'pot', 'steamer']);
export const isCookStation = (t: StationType) => cookTypes.has(t);

/** Whether a crate gives today (open, and stocked on delivery days). */
export function crateOpen(def: StationDef, w: Pick<WorldView, 'day'>, view: StationView): boolean {
  return def.crate !== undefined && (CRATE_DAY[def.crate] ?? 99) <= w.day && view.count !== 0;
}

/** The tap action on `target` holding `held` (null: nothing to do). */
export function actionFor(w: WorldView, held: Item | null, target: number): Action | null {
  if (target >= SLOT_TARGET) {
    const slot = w.slot(target - SLOT_TARGET);
    if (!held) return slot.item ? 'beltTake' : null;
    return !slot.item && held.plated && isBeltDish(held.kind) ? 'beltPut' : null;
  }
  if (target >= SEAT_TARGET) {
    const seat = w.seat(target - SEAT_TARGET);
    if (!held) return seat.dirty > 0 ? 'bus' : null;
    if (held.kind === Kind.DirtyPlate) return seat.dirty > 0 && held.n < CARRY_PLATES ? 'bus' : null;
    if (isHotDish(held.kind) && seat.wants === held.kind) return 'serve';
    return null;
  }
  const def = STATIONS[target];
  if (!def || (def.zone && !(w.zones & def.zone))) return null;
  const v = w.station(target);
  const type = stationType(def, w);
  if (!held) {
    switch (type) {
      case 'crate':
        return crateOpen(def, w, v) ? 'crate' : null;
      case 'mat':
        return v.item ? 'take' : v.mat.length ? 'matTake' : null;
      case 'rice':
      case 'pot':
      case 'steamer':
        return v.state === Cook.ready && v.count > 0 ? 'cookTake' : v.state === Cook.idle ? 'cookStart' : null;
      case 'drop':
        return v.count > 0 ? 'dropTake' : null;
      case 'counter':
      case 'board':
      case 'pan':
        return v.item ? 'take' : null;
      default:
        return null;
    }
  }
  switch (type) {
    case 'counter':
      return v.item ? null : 'put';
    case 'board':
      return !v.item && isChoppable(held.kind) && !held.plated ? 'put' : null;
    case 'pan':
      return !v.item && held.kind === Kind.GyozaRaw ? 'put' : null;
    case 'mat': {
      if (v.item || !MAT_INGREDIENTS.has(held.kind) || v.mat.length >= MAT_CAPACITY) return null;
      return couldBecome([...v.mat, held.kind], w.day) ? 'matAdd' : null;
    }
    case 'plates':
      return isBeltDish(held.kind) && !held.plated && (!w.dishes || v.count > 0) ? 'plate' : null;
    case 'bin':
      return held.kind === Kind.DeliveryBox ? null : 'bin';
    case 'sink':
      return held.kind === Kind.DirtyPlate && v.count < SINK_CAPACITY ? 'sinkPut' : null;
    case 'crate':
      return held.kind === Kind.DeliveryBox && def.crate !== undefined ? 'restock' : null;
    default:
      return null;
  }
}

/** The hold (work) on `target` with empty hands (null: nothing to work). */
export function workFor(w: WorldView, held: Item | null, target: number): Work | null {
  if (held || target >= SEAT_TARGET) return null;
  const def = STATIONS[target];
  if (!def || (def.zone && !(w.zones & def.zone))) return null;
  const v = w.station(target);
  switch (stationType(def, w)) {
    case 'board':
      return v.item && isChoppable(v.item.kind) ? 'chop' : null;
    case 'mat':
      return !v.item && matchRecipe(v.mat, w.day) ? 'roll' : null;
    case 'sink':
      return v.count > 0 ? 'wash' : null;
    case 'rice':
    case 'pot':
    case 'steamer':
      return v.state === Cook.cooking ? 'stir' : null;
    case 'pan':
      return v.state === Pan.cooking ? 'stir' : null;
    default:
      return null;
  }
}

const tmp = { x: 0, y: 0, a: 0 };

/** Where a target is (a slot moves with the belt). */
export function targetPoint(w: Pick<WorldView, 'beltS'>, target: number): { x: number; y: number } | null {
  if (target >= SLOT_TARGET) {
    const i = target - SLOT_TARGET;
    if (i >= BELT_SLOTS) return null;
    beltPoint(w.beltS + (i * BELT_LENGTH) / BELT_SLOTS, tmp);
    return { x: tmp.x, y: tmp.y };
  }
  if (target >= SEAT_TARGET) {
    const s = SEATS[target - SEAT_TARGET];
    return s ? { x: s.x, y: s.y } : null;
  }
  const d = STATIONS[target];
  return d ? { x: d.x, y: d.y } : null;
}

export interface Chooser {
  x: number;
  y: number;
  /** Facing (radians, sim axes). */
  face: number;
  held: Item | null;
}

/** Whether a target can be acted on or worked right now by this chef. */
export function usable(w: WorldView, held: Item | null, target: number): boolean {
  return actionFor(w, held, target) !== null || workFor(w, held, target) !== null;
}

/**
 * The target a press would use: the usable one within reach that is nearest, counting a station in front of the chef
 * as up to FACING_BIAS closer (so a chef standing between two crates uses the one they face). -1: none.
 */
export function pickTarget(w: WorldView, c: Chooser, range = INTERACT_RANGE): number {
  let best = -1;
  let bestScore = Infinity;
  const fx = Math.cos(c.face);
  const fy = Math.sin(c.face);
  const consider = (target: number, x: number, y: number) => {
    const dx = x - c.x;
    const dy = y - c.y;
    const d = Math.hypot(dx, dy);
    if (d > range) return;
    const dot = d > 1e-6 ? (dx * fx + dy * fy) / d : 1;
    const score = d - FACING_BIAS * dot;
    if (score >= bestScore || !usable(w, c.held, target)) return;
    best = target;
    bestScore = score;
  };
  for (const s of STATIONS) consider(s.id, s.x, s.y);
  for (const s of SEATS) {
    if (Math.abs(s.x - c.x) > range + 0.5 || Math.abs(s.y - c.y) > range + 0.5) continue;
    consider(SEAT_TARGET + s.id, s.x, s.y);
  }
  for (let i = 0; i < BELT_SLOTS; i++) {
    beltPoint(w.beltS + (i * BELT_LENGTH) / BELT_SLOTS, tmp);
    consider(SLOT_TARGET + i, tmp.x, tmp.y);
  }
  return best;
}

/** Whether `target` is within reach of (x, y) (with `slack` for the client's hint). */
export function inReach(w: Pick<WorldView, 'beltS'>, x: number, y: number, target: number, slack = 0): boolean {
  const p = targetPoint(w, target);
  return !!p && Math.hypot(p.x - x, p.y - y) <= INTERACT_RANGE + slack;
}
