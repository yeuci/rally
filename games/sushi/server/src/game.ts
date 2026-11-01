import {
  BELT_SLOTS,
  BELT_SPEED,
  CARRY_PLATES,
  CHOP_TIME,
  CLOSING_MAX,
  CUSTOMER_SPEED,
  DAY_LENGTH,
  DELIVERY_AMOUNT,
  DELIVERY_EVERY,
  EAT_TIME,
  GRAB_WINDOW,
  GYOZA_BURN_AFTER,
  GYOZA_COOK_TIME,
  GYOZA_SMOKE_AFTER,
  HOLD_DELAY,
  LOBBY_TIME,
  MAX_STARS,
  MORNING_TIME,
  OVER_TIME,
  PLATE_POOL,
  PLATES_UPGRADE,
  POT_COOK_TIME,
  POT_PORTIONS,
  REACT_TIME,
  RICE_COOK_TIME,
  RICE_PORTIONS,
  ROLL_TIME,
  SINK_CAPACITY,
  SIT_TIME,
  STEAM_PORTIONS,
  STEAM_TIME,
  STIR_SPEEDUP,
  STOCK_MAX,
  STOCK_START,
  TARGET_SLACK,
  TICK_HZ,
  VOTE_TIME,
  WASH_TIME,
  SEAT_PILE,
  WAVE_BELOW,
  WEEK_DAYS,
} from './constants.ts';
import {
  Cook,
  Pan,
  SEAT_TARGET,
  SLOT_TARGET,
  actionFor,
  inReach,
  isCookStation,
  pickTarget,
  stationType,
  workFor,
  type Action,
  type SeatView,
  type StationView,
  type Work,
  type WorldView,
} from './interact.ts';
import {
  BELT_LENGTH,
  DOOR,
  FESTIVAL_GATE,
  SEATS,
  SPAWNS,
  STATIONS,
  STREET,
  beltPoint,
  movePlayer,
  zonesOn,
  type SeatDef,
} from './map.ts';
import {
  CREW_STATIONS,
  beltOrder,
  botChoice,
  cardById,
  offerCards,
  omakase,
  tableOrder,
  tally,
  type CardId,
} from './orders.ts';
import {
  CHOP,
  Kind,
  MECHANIC_DAY,
  isBeltDish,
  item,
  matchRecipe,
  priceOf,
  tierOf,
  type Item,
  type Mechanic,
} from './recipes.ts';
import { Rng } from './rng.ts';
import { TIP_RATE, VIP_TIP, arrivalRate, dayTuning, type DayTuning, type TuningMods } from './tuning.ts';
import type { Vec2 } from './vec.ts';

/**
 * `SushiGame`: the whole restaurant, engine- and network-free (apps/game-server's SushiRoom steps it at TICK_HZ and
 * mirrors it into the Colyseus state; the tests and the bots drive it directly). Deterministic for a seed and the
 * inputs: every random choice (arrivals' seats, orders, the night's cards, tie-breaks) comes from one Rng.
 *
 * A run is a week of shifts: lobby → (morning → open → closing → night) × days → over (no stars left). Each morning
 * the kitchen is reset and the day's zones open; the doors open for DAY_LENGTH seconds while customers arrive on the
 * day's curve (tuning.ts); after closing the last customers finish; at night the crew votes on an upgrade.
 */

export type Phase = 'lobby' | 'morning' | 'open' | 'closing' | 'night' | 'over';

/** Rules the tests and the dev commands may change (`sanitizeRules`). */
export interface GameRules {
  /** Public rooms start the run by themselves; private ones wait for `requestStart`. */
  autoStart: boolean;
  dayLength: number;
  morningTime: number;
  voteTime: number;
  overTime: number;
  closingMax: number;
  lobbyTime: number;
  /** Multipliers on the tuning (tests, the e2e). */
  arrivals: number;
  patience: number;
  /** No customers arrive by themselves (only the dev command spawns them). */
  noArrivals: boolean;
}

export const DEFAULT_RULES: Readonly<GameRules> = Object.freeze({
  autoStart: true,
  dayLength: DAY_LENGTH,
  morningTime: MORNING_TIME,
  voteTime: VOTE_TIME,
  overTime: OVER_TIME,
  closingMax: CLOSING_MAX,
  lobbyTime: LOBBY_TIME,
  arrivals: 1,
  patience: 1,
  noArrivals: false,
});

/** Accept only known, sane rule values (tests and dev commands send them). */
export function sanitizeRules(raw: unknown): Partial<GameRules> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<GameRules> = {};
  const num = (k: keyof GameRules, lo: number, hi: number) => {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, number>)[k] = Math.min(hi, Math.max(lo, v));
  };
  num('dayLength', 5, 900);
  num('morningTime', 0.2, 60);
  num('voteTime', 0.5, 120);
  num('overTime', 0.5, 120);
  num('closingMax', 0.5, 300);
  num('lobbyTime', 0.1, 60);
  num('arrivals', 0, 10);
  num('patience', 0.1, 20);
  if (typeof r.autoStart === 'boolean') out.autoStart = r.autoStart;
  if (typeof r.noArrivals === 'boolean') out.noArrivals = r.noArrivals;
  return out;
}

export interface ChefInput {
  /** Move stick, |m| ≤ 1. */
  move: Vec2;
  /** The context button is down. */
  button: boolean;
  /** Presses so far (a press and release between two inputs still counts). */
  presses: number;
  /** The target the client highlighted (-1: none): used when it is within reach and usable. */
  target: number;
}

/** What the chef's body is doing (the client picks the clip and the tool in hand). */
export const ChefAct = { none: 0, chop: 1, roll: 2, stir: 3, wash: 4 } as const;

export interface Chef {
  id: string;
  name: string;
  slot: number;
  bot: boolean;
  connected: boolean;
  /** Join order (bots leave first, the oldest human is the host of nothing in particular). */
  order: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing, radians (the way it last moved, or toward what it works). */
  face: number;
  input: ChefInput;
  held: Item | null;
  /** The press being decided: its target and how long it has been held. */
  press: { target: number; t: number; tap: boolean } | null;
  seenPresses: number;
  /** The station worked while the button is held (-1: none). */
  work: number;
  act: number;
  /** The night's vote (-1: none). */
  vote: number;
}

export type CustomerState = 'walkIn' | 'sit' | 'wait' | 'eat' | 'happy' | 'angry' | 'walkOut';
/** Wire codes of `CustomerState`. */
export const CUSTOMER_STATES: readonly CustomerState[] = ['walkIn', 'sit', 'wait', 'eat', 'happy', 'angry', 'walkOut'];

export interface Customer {
  id: number;
  /** Which of the customer models (0–3). */
  look: number;
  vip: boolean;
  seat: number;
  state: CustomerState;
  x: number;
  y: number;
  path: Vec2[];
  pathAt: number;
  /** Seconds in the current state. */
  t: number;
  /** The orders (one; the VIP's three courses) and the current one. */
  orders: Kind[];
  course: number;
  patience: number;
  patienceMax: number;
  /** Patience fractions left at each serve (the VIP's tip). */
  speeds: number[];
  /** Waving now (the client plays Wave). */
  waving: boolean;
  /** Leaves without a penalty (the restaurant closed on them). */
  neutral: boolean;
}

interface StationRt extends StationView {
  progress: number;
  /** The pan: seconds since the gyoza was done. */
  heat: number;
  /** Stirred this tick (a chef holds the button at it). */
  stirred: boolean;
  mat: Kind[];
}

interface SlotRt {
  item: Item | null;
  /** Seconds on the belt. */
  age: number;
  stale: boolean;
}

interface SeatRt {
  customer: number;
  dirty: number;
  /** The dish on the table / bar in front of the customer while they eat (Kind.None otherwise). */
  eating: Kind;
}

export interface DaySummary {
  run: number;
  day: number;
  /** Seconds the day ran (morning to night). */
  duration: number;
  earned: number;
  tips: number;
  served: number;
  angry: number;
  stale: number;
  gold: number;
  perfect: boolean;
  fullHouse: boolean;
  stars: number;
  /** The restaurant closed today (no stars left). */
  closed: boolean;
  /** Sunday survived. */
  week: boolean;
  crew: { id: string; name: string; bot: boolean }[];
}

export type GameEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'morning'; day: number; teach: Mechanic[] }
  | { type: 'pick'; chef: string; kind: Kind; station: number }
  | { type: 'put'; chef: string; kind: Kind; station: number }
  | { type: 'chopped'; chef: string; station: number; kind: Kind }
  | { type: 'rolled'; chef: string; station: number; kind: Kind }
  | { type: 'plated'; chef: string; kind: Kind }
  | { type: 'belt'; chef: string; slot: number; kind: Kind }
  | { type: 'beltTake'; chef: string; slot: number; kind: Kind; stale: boolean }
  | { type: 'grab'; customer: number; seat: number; kind: Kind; price: number; tip: number }
  | { type: 'serve'; customer: number; seat: number; kind: Kind; price: number; tip: number; chef: string }
  | { type: 'vip'; customer: number; seat: number; tip: number }
  | { type: 'seated'; customer: number; seat: number }
  | { type: 'happy'; customer: number; seat: number }
  | { type: 'angry'; customer: number; seat: number }
  | { type: 'stars'; stars: number; delta: number }
  | { type: 'stale'; slot: number }
  | { type: 'smoke'; station: number }
  | { type: 'burn'; station: number }
  | { type: 'cooked'; station: number; kind: Kind }
  | { type: 'bin'; chef: string; kind: Kind }
  | { type: 'washed'; chef: string; station: number }
  | { type: 'bus'; chef: string; seat: number; n: number }
  | { type: 'delivery' }
  | { type: 'restock'; chef: string }
  | { type: 'fullHouse' }
  | { type: 'refused'; chef: string }
  | { type: 'dayOver'; summary: DaySummary }
  | { type: 'vote'; card: CardId }
  | { type: 'runOver'; summary: DaySummary };

export interface GameOptions {
  seed?: number;
  rules?: Partial<GameRules>;
}

const PLAYER_SPEED_SANDALS = 1.12;

export class SushiGame implements WorldView {
  rules: GameRules;
  readonly rng: Rng;
  phase: Phase = 'lobby';
  /** Seconds in the current phase. */
  phaseTime = 0;
  run = 0;
  day = 1;
  stars = MAX_STARS;
  /** Yen earned this run (sales and tips). */
  money = 0;
  zones = 0;
  tick = 0;
  readonly chefs = new Map<string, Chef>();
  readonly stations: StationRt[] = STATIONS.map(() => emptyStation());
  readonly slots: SlotRt[] = Array.from({ length: BELT_SLOTS }, () => ({ item: null, age: 0, stale: false }));
  beltS = 0;
  readonly seats: SeatRt[] = SEATS.map(() => ({ customer: -1, dirty: 0, eating: Kind.None }));
  readonly customers = new Map<number, Customer>();
  /** Upgrades owned this run (stackable ones count), and today's one-day cards. */
  readonly owned = new Map<CardId, number>();
  readonly todayCards = new Set<CardId>();
  /** The night's cards and the winner once tallied. */
  cards: CardId[] = [];
  chosen = -1;
  /** The solo crew's free rice cooker today (the "prep helper"). */
  helper = false;
  /** Per-day numbers. */
  dayStats = newDayStats();
  /** The last finished day's summary (shown at night and on the closed banner). */
  lastSummary: DaySummary | null = null;
  /** The truck's next box (seconds) and whether one waits at the back door. */
  deliveryIn = DELIVERY_EVERY;
  frozen = false;
  private serial = 0;
  private customerSerial = 0;
  private arrivalDebt = 0;
  private vipTimes: number[] = [];
  private tuning: DayTuning;
  private dayStartedAt = 0;
  private clock = 0;

  constructor(options: GameOptions = {}) {
    this.rng = new Rng(options.seed ?? 1);
    this.rules = { ...DEFAULT_RULES, ...(options.rules ?? {}) };
    this.tuning = dayTuning(1, 1);
    this.resetKitchen();
  }

  // --- the world view (interact.ts) --------------------------------------------------------------------------------
  get board2() {
    return this.owned.has('board2') || this.crew >= CREW_STATIONS;
  }
  get mat2() {
    return this.owned.has('mat2') || this.crew >= CREW_STATIONS;
  }
  get dishes() {
    return this.day >= MECHANIC_DAY.dishes;
  }
  slot(i: number) {
    const s = this.slots[i];
    return { item: s?.item ?? null, stale: s?.stale ?? false };
  }
  station(id: number): StationView {
    return this.stations[id] ?? emptyStation();
  }
  seat(id: number): SeatView {
    const def = SEATS[id];
    const rt = this.seats[id];
    if (!def || !rt) return { open: false, wants: Kind.None, dirty: 0 };
    const c = rt.customer >= 0 ? this.customers.get(rt.customer) : undefined;
    return {
      open: this.seatOpen(def),
      wants: c && c.state === 'wait' ? (c.orders[c.course] ?? Kind.None) : Kind.None,
      dirty: rt.dirty,
    };
  }

  // --- players -----------------------------------------------------------------------------------------------------
  get chefList(): Chef[] {
    return [...this.chefs.values()].sort((a, b) => a.slot - b.slot);
  }

  /** Chefs working today: connected humans and bots (the crew size the tuning scales with). */
  get crew(): number {
    let n = 0;
    for (const c of this.chefs.values()) if (c.connected) n++;
    return Math.max(1, n);
  }

  addPlayer(id: string, name: string, bot = false): Chef {
    const used = new Set([...this.chefs.values()].map((c) => c.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const spawn = SPAWNS[slot % SPAWNS.length]!;
    const chef: Chef = {
      id,
      name,
      slot,
      bot,
      connected: true,
      order: this.serial++,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      face: -Math.PI / 2,
      input: { move: { x: 0, y: 0 }, button: false, presses: 0, target: -1 },
      held: null,
      press: null,
      seenPresses: 0,
      work: -1,
      act: ChefAct.none,
      vote: -1,
    };
    this.chefs.set(id, chef);
    return chef;
  }

  removePlayer(id: string): void {
    this.chefs.delete(id);
  }

  setConnected(id: string, on: boolean): void {
    const c = this.chefs.get(id);
    if (!c) return;
    c.connected = on;
    if (!on) c.input = { ...c.input, move: { x: 0, y: 0 }, button: false };
  }

  setName(id: string, name: string): void {
    const c = this.chefs.get(id);
    if (c) c.name = name;
  }

  setInput(id: string, input: ChefInput): void {
    const c = this.chefs.get(id);
    if (c) c.input = input;
  }

  /** A chef's vote at night (index into `cards`). */
  vote(id: string, index: number): void {
    const c = this.chefs.get(id);
    if (!c || this.phase !== 'night' || this.chosen >= 0) return;
    if (!Number.isInteger(index) || index < 0 || index >= this.cards.length) return;
    c.vote = index;
  }

  requestStart(): void {
    if (this.phase === 'lobby' && this.chefs.size > 0) this.startRun([]);
  }

  setRules(rules: Partial<GameRules>): void {
    this.rules = { ...this.rules, ...rules };
  }

  // --- derived numbers --------------------------------------------------------------------------------------------
  get mods(): TuningMods {
    return {
      expand: this.owned.get('expand') ?? 0,
      tea: this.owned.has('tea'),
      critic: this.todayCards.has('critic'),
      rush: this.todayCards.has('rush'),
    };
  }

  get today(): DayTuning {
    return this.tuning;
  }

  /** Fraction of the open hours gone (0 at opening, 1 at closing). */
  get dayFraction(): number {
    if (this.phase === 'morning' || this.phase === 'lobby') return 0;
    if (this.phase === 'open') return Math.min(1, this.clock / this.rules.dayLength);
    return 1;
  }

  get beltSpeed(): number {
    return BELT_SPEED * (this.owned.has('belt') ? 1.25 : 1);
  }

  get chefSpeed(): number {
    return this.owned.has('sandals') ? PLAYER_SPEED_SANDALS : 1;
  }

  get platePool(): number {
    return PLATE_POOL + (this.owned.has('plates') ? PLATES_UPGRADE : 0);
  }

  get autoCooker(): boolean {
    return this.helper || this.owned.has('cooker');
  }

  /** Seconds left in the phase (the HUD's countdowns). */
  get timer(): number {
    switch (this.phase) {
      case 'lobby':
        return Math.max(0, this.rules.lobbyTime - this.phaseTime);
      case 'morning':
        return Math.max(0, this.rules.morningTime - this.phaseTime);
      case 'open':
        return Math.max(0, this.rules.dayLength - this.clock);
      case 'closing':
        return Math.max(0, this.rules.closingMax - this.phaseTime);
      case 'night':
        return Math.max(0, this.rules.voteTime - this.phaseTime);
      case 'over':
        return Math.max(0, this.rules.overTime - this.phaseTime);
    }
  }

  seatOpen(def: SeatDef): boolean {
    if (def.zone && !(this.zones & def.zone)) return false;
    if (def.kind === 'stool') return def.rank < this.tuning.stools;
    return this.day >= MECHANIC_DAY.tables;
  }

  // --- the step -------------------------------------------------------------------------------------------------------
  step(dt: number): GameEvent[] {
    const ev: GameEvent[] = [];
    this.tick++;
    this.phaseTime += dt;
    if (this.frozen) return ev;
    this.tuning = dayTuning(this.day, this.crew, this.mods, this.stars);
    switch (this.phase) {
      case 'lobby':
        // Chefs can walk round and practise while a private room waits (no customers come).
        this.world(dt, ev);
        if (this.rules.autoStart && this.chefs.size > 0 && this.phaseTime >= this.rules.lobbyTime) this.startRun(ev);
        break;
      case 'morning':
        this.world(dt, ev);
        if (this.phaseTime >= this.rules.morningTime) this.setPhase('open', ev);
        break;
      case 'open':
        this.clock += dt;
        this.arrivals(dt, ev);
        this.world(dt, ev);
        if (this.phase === 'open' && this.clock >= this.rules.dayLength) this.setPhase('closing', ev);
        break;
      case 'closing':
        this.world(dt, ev);
        if (this.phase !== 'closing') break;
        if (this.customers.size === 0) this.endDay(ev);
        else if (this.phaseTime >= this.rules.closingMax) {
          // The last ones leave without a fuss.
          for (const c of this.customers.values()) {
            if (c.state === 'wait' || c.state === 'sit' || c.state === 'walkIn') this.leave(c, 'happy', true, ev);
          }
          if (this.phaseTime >= this.rules.closingMax + 4) {
            this.customers.clear();
            for (const s of this.seats) s.customer = -1;
            this.endDay(ev);
          }
        }
        break;
      case 'night':
        this.night(ev);
        break;
      case 'over':
        if (this.phaseTime >= this.rules.overTime) {
          if (this.rules.autoStart && this.chefs.size > 0) this.startRun(ev);
          else this.setPhase('lobby', ev);
        }
        break;
    }
    return ev;
  }

  private setPhase(p: Phase, ev: GameEvent[]) {
    this.phase = p;
    this.phaseTime = 0;
    ev.push({ type: 'phase', phase: p });
  }

  /** A new run: Monday, five stars, nothing owned. */
  private startRun(ev: GameEvent[]) {
    this.run++;
    this.day = 1;
    this.stars = MAX_STARS;
    this.money = 0;
    this.owned.clear();
    this.todayCards.clear();
    this.lastSummary = null;
    this.startDay(ev);
  }

  /** The morning of `this.day`: reset the kitchen, open the day's zones, teach what is new. */
  private startDay(ev: GameEvent[]) {
    this.zones = zonesOn(this.day);
    this.helper = this.crew <= 1;
    this.tuning = dayTuning(this.day, this.crew, this.mods, this.stars);
    this.resetKitchen();
    this.dayStats = newDayStats();
    this.clock = 0;
    this.arrivalDebt = 0.6;
    this.deliveryIn = 6;
    this.dayStartedAt = this.tick;
    // The VIPs come at random points of the lunch-to-dinner stretch.
    this.vipTimes = Array.from({ length: this.tuning.vips }, () => this.rng.range(0.2, 0.62)).sort((a, b) => a - b);
    for (const c of this.chefs.values()) {
      const spawn = SPAWNS[c.slot % SPAWNS.length]!;
      Object.assign(c, { x: spawn.x, y: spawn.y, vx: 0, vy: 0, held: null, press: null, work: -1, vote: -1 });
      c.seenPresses = c.input.presses;
    }
    this.setPhase('morning', ev);
    const teach = (Object.keys(MECHANIC_DAY) as Mechanic[]).filter((m) => MECHANIC_DAY[m] === this.day);
    ev.push({ type: 'morning', day: this.day, teach });
  }

  private resetKitchen() {
    STATIONS.forEach((def, i) => {
      const s = emptyStation();
      if (def.type === 'plates') s.count = this.dishes ? this.platePool : -1;
      if (def.type === 'crate') s.count = this.day >= MECHANIC_DAY.delivery ? STOCK_START : -1;
      this.stations[i] = s;
    });
    for (const s of this.slots) Object.assign(s, { item: null, age: 0, stale: false });
    for (const s of this.seats) Object.assign(s, { customer: -1, dirty: 0, eating: Kind.None });
    this.customers.clear();
    this.beltS = 0;
  }

  // --- chefs ------------------------------------------------------------------------------------------------------
  private world(dt: number, ev: GameEvent[]) {
    for (const s of this.stations) s.stirred = false;
    for (const c of this.chefs.values()) this.chef(c, dt, ev);
    this.cook(dt, ev);
    this.belt(dt, ev);
    this.customersStep(dt, ev);
    this.delivery(dt, ev);
  }

  private chef(c: Chef, dt: number, ev: GameEvent[]) {
    const stick = c.connected ? c.input.move : { x: 0, y: 0 };
    movePlayer(c, stick, this.chefSpeed, this.zones, dt);
    if (Math.hypot(stick.x, stick.y) > 0.2) c.face = Math.atan2(stick.y, stick.x);

    // A new press: decide now (tap), soon (tap or hold), or start working.
    if (c.input.presses !== c.seenPresses) {
      const tapped = !c.input.button;
      c.seenPresses = c.input.presses;
      c.work = -1;
      const target = this.resolveTarget(c);
      if (target < 0) {
        c.press = null;
        ev.push({ type: 'refused', chef: c.id });
      } else {
        this.faceTarget(c, target);
        const act = actionFor(this, c.held, target);
        const work = workFor(this, c.held, target);
        if (act && work && !tapped) c.press = { target, t: 0, tap: false };
        else if (act) {
          c.press = null;
          this.apply(c, act, target, ev);
        } else if (work && !tapped) {
          c.press = null;
          c.work = target;
        } else c.press = null;
      }
    } else if (c.press) {
      c.press.t += dt;
      if (!c.input.button) {
        const act = actionFor(this, c.held, c.press.target);
        if (act) this.apply(c, act, c.press.target, ev);
        c.press = null;
      } else if (c.press.t >= HOLD_DELAY) {
        c.work = workFor(this, c.held, c.press.target) ? c.press.target : -1;
        c.press = null;
      }
    }

    // Working while the button is held, in reach, and there is still work.
    c.act = ChefAct.none;
    if (c.work >= 0) {
      const w = workFor(this, c.held, c.work);
      if (!c.input.button || !w || !inReach(this, c.x, c.y, c.work, 0.35) || !c.connected) {
        c.work = -1;
      } else {
        this.faceTarget(c, c.work);
        this.doWork(c, w, c.work, dt, ev);
      }
    }
  }

  /** The client's highlighted target when it is in reach and usable, else the server's own pick. */
  private resolveTarget(c: Chef): number {
    const hint = c.input.target;
    if (
      Number.isInteger(hint) &&
      hint >= 0 &&
      inReach(this, c.x, c.y, hint, TARGET_SLACK) &&
      (actionFor(this, c.held, hint) || workFor(this, c.held, hint))
    ) {
      return hint;
    }
    return pickTarget(this, { x: c.x, y: c.y, face: c.face, held: c.held });
  }

  private faceTarget(c: Chef, target: number) {
    const st = target < SEAT_TARGET ? STATIONS[target] : null;
    const p = st ?? (target >= SEAT_TARGET && target < SLOT_TARGET ? SEATS[target - SEAT_TARGET] : null);
    if (p) c.face = Math.atan2(p.y - c.y, p.x - c.x);
    else if (target >= SLOT_TARGET) {
      const q = beltPoint(this.beltS + ((target - SLOT_TARGET) * BELT_LENGTH) / BELT_SLOTS);
      c.face = Math.atan2(q.y - c.y, q.x - c.x);
    }
  }

  private apply(c: Chef, act: Action, target: number, ev: GameEvent[]) {
    const st = target < SEAT_TARGET ? this.stations[target] : undefined;
    const def = target < SEAT_TARGET ? STATIONS[target] : undefined;
    switch (act) {
      case 'crate': {
        if (!st || def?.crate === undefined) return;
        c.held = item(def.crate);
        if (st.count > 0) st.count--;
        ev.push({ type: 'pick', chef: c.id, kind: def.crate, station: target });
        return;
      }
      case 'take': {
        if (!st?.item) return;
        c.held = st.item;
        st.item = null;
        st.progress = 0;
        if (def?.type === 'pan') {
          st.state = Pan.empty;
          st.heat = 0;
        }
        ev.push({ type: 'pick', chef: c.id, kind: c.held.kind, station: target });
        return;
      }
      case 'matTake': {
        if (!st?.mat.length) return;
        const k = st.mat.pop()!;
        st.progress = 0;
        c.held = item(k);
        ev.push({ type: 'pick', chef: c.id, kind: k, station: target });
        return;
      }
      case 'cookStart': {
        if (!st) return;
        st.state = Cook.cooking;
        st.progress = 0;
        ev.push({ type: 'put', chef: c.id, kind: def?.dish ?? Kind.Rice, station: target });
        return;
      }
      case 'cookTake': {
        if (!st || !def?.dish) return;
        c.held = item(def.dish);
        st.count--;
        if (st.count <= 0) {
          st.count = 0;
          st.state = Cook.idle;
          if (def.type === 'rice' && this.autoCooker) st.state = Cook.cooking;
        }
        ev.push({ type: 'pick', chef: c.id, kind: def.dish, station: target });
        return;
      }
      case 'beltTake': {
        const i = target - SLOT_TARGET;
        const slot = this.slots[i];
        if (!slot?.item) return;
        c.held = slot.item;
        ev.push({ type: 'beltTake', chef: c.id, slot: i, kind: slot.item.kind, stale: slot.stale });
        Object.assign(slot, { item: null, age: 0, stale: false });
        return;
      }
      case 'bus': {
        const seat = this.seats[target - SEAT_TARGET];
        if (!seat || seat.dirty <= 0) return;
        const have = c.held?.kind === Kind.DirtyPlate ? c.held.n : 0;
        const take = Math.min(seat.dirty, CARRY_PLATES - have);
        if (take <= 0) return;
        seat.dirty -= take;
        c.held = item(Kind.DirtyPlate, false, have + take);
        ev.push({ type: 'bus', chef: c.id, seat: target - SEAT_TARGET, n: take });
        return;
      }
      case 'dropTake': {
        if (!st || st.count <= 0) return;
        st.count = 0;
        c.held = item(Kind.DeliveryBox);
        ev.push({ type: 'pick', chef: c.id, kind: Kind.DeliveryBox, station: target });
        return;
      }
      case 'put': {
        if (!st || !c.held) return;
        st.item = c.held;
        st.progress = 0;
        if (def?.type === 'pan') {
          st.state = Pan.cooking;
          st.heat = 0;
        }
        ev.push({ type: 'put', chef: c.id, kind: c.held.kind, station: target });
        c.held = null;
        return;
      }
      case 'matAdd': {
        if (!st || !c.held) return;
        st.mat.push(c.held.kind);
        st.progress = 0;
        ev.push({ type: 'put', chef: c.id, kind: c.held.kind, station: target });
        c.held = null;
        return;
      }
      case 'plate': {
        if (!st || !c.held) return;
        if (this.dishes) st.count--;
        c.held = { ...c.held, plated: true };
        ev.push({ type: 'plated', chef: c.id, kind: c.held.kind });
        return;
      }
      case 'beltPut': {
        const i = target - SLOT_TARGET;
        const slot = this.slots[i];
        if (!slot || slot.item || !c.held) return;
        Object.assign(slot, { item: c.held, age: 0, stale: false });
        ev.push({ type: 'belt', chef: c.id, slot: i, kind: c.held.kind });
        c.held = null;
        return;
      }
      case 'bin': {
        if (!c.held) return;
        const k = c.held.kind;
        // A plated dish leaves its plate behind (dirty) once plates are counted.
        c.held = c.held.plated && this.dishes ? item(Kind.DirtyPlate) : null;
        ev.push({ type: 'bin', chef: c.id, kind: k });
        return;
      }
      case 'sinkPut': {
        if (!st || c.held?.kind !== Kind.DirtyPlate) return;
        const n = Math.min(c.held.n, SINK_CAPACITY - st.count);
        st.count += n;
        c.held = c.held.n - n > 0 ? item(Kind.DirtyPlate, false, c.held.n - n) : null;
        ev.push({ type: 'put', chef: c.id, kind: Kind.DirtyPlate, station: target });
        return;
      }
      case 'serve': {
        const seatId = target - SEAT_TARGET;
        const rt = this.seats[seatId];
        const cust = rt && rt.customer >= 0 ? this.customers.get(rt.customer) : undefined;
        if (!cust || !c.held || cust.state !== 'wait' || cust.orders[cust.course] !== c.held.kind) return;
        const kind = c.held.kind;
        c.held = null;
        const { price, tip } = this.pay(cust, kind);
        ev.push({ type: 'serve', customer: cust.id, seat: seatId, kind, price, tip, chef: c.id });
        this.startEating(cust, kind);
        return;
      }
      case 'restock': {
        if (c.held?.kind !== Kind.DeliveryBox) return;
        c.held = null;
        STATIONS.forEach((d, i) => {
          if (d.type === 'crate' && this.stations[i]!.count >= 0) {
            this.stations[i]!.count = Math.min(STOCK_MAX, this.stations[i]!.count + DELIVERY_AMOUNT);
          }
        });
        ev.push({ type: 'restock', chef: c.id });
        return;
      }
    }
  }

  private doWork(c: Chef, w: Work, target: number, dt: number, ev: GameEvent[]) {
    const st = this.stations[target]!;
    switch (w) {
      case 'chop': {
        c.act = ChefAct.chop;
        st.progress += dt / (CHOP_TIME / (this.owned.has('knives') ? 1.5 : 1));
        if (st.progress >= 1 && st.item) {
          const to = CHOP[st.item.kind];
          if (to !== undefined) st.item = item(to);
          st.progress = 0;
          c.work = -1;
          ev.push({ type: 'chopped', chef: c.id, station: target, kind: st.item.kind });
        }
        return;
      }
      case 'roll': {
        c.act = ChefAct.roll;
        st.progress += dt / ROLL_TIME;
        if (st.progress >= 1) {
          const r = matchRecipe(st.mat, this.day);
          st.progress = 0;
          c.work = -1;
          if (r) {
            st.mat = [];
            st.item = item(r.dish);
            ev.push({ type: 'rolled', chef: c.id, station: target, kind: r.dish });
          }
        }
        return;
      }
      case 'wash': {
        c.act = ChefAct.wash;
        st.progress += dt / (WASH_TIME / (this.owned.has('sink') ? 1.6 : 1));
        if (st.progress >= 1 && st.count > 0) {
          st.progress = 0;
          st.count--;
          const plates = STATIONS.find((d) => d.type === 'plates');
          if (plates) {
            const p = this.stations[plates.id]!;
            // Table bowls come back too: the stack never grows past the restaurant's plates.
            if (p.count >= 0) p.count = Math.min(this.platePool, p.count + 1);
          }
          ev.push({ type: 'washed', chef: c.id, station: target });
        }
        return;
      }
      case 'stir':
        c.act = ChefAct.stir;
        st.stirred = true;
        return;
    }
  }

  // --- cooking ------------------------------------------------------------------------------------------------------
  private cook(dt: number, ev: GameEvent[]) {
    const stove = this.owned.has('stove') ? 1.4 : 1;
    STATIONS.forEach((def, i) => {
      const st = this.stations[i]!;
      const type = stationType(def, this);
      const speed = st.stirred ? STIR_SPEEDUP : 1;
      if (isCookStation(type)) {
        if (type === 'rice' && st.state === Cook.idle && this.autoCooker && this.phase !== 'lobby') {
          st.state = Cook.cooking;
          st.progress = 0;
        }
        if (st.state !== Cook.cooking) return;
        const time = type === 'rice' ? RICE_COOK_TIME : type === 'pot' ? POT_COOK_TIME / stove : STEAM_TIME / stove;
        st.progress += (dt * speed) / time;
        if (st.progress >= 1) {
          st.progress = 0;
          st.state = Cook.ready;
          st.count = type === 'rice' ? RICE_PORTIONS : type === 'pot' ? POT_PORTIONS : STEAM_PORTIONS;
          ev.push({ type: 'cooked', station: i, kind: def.dish ?? Kind.Rice });
        }
        return;
      }
      if (type !== 'pan' || !st.item) return;
      if (st.state === Pan.cooking) {
        st.progress += (dt * speed * stove) / GYOZA_COOK_TIME;
        if (st.progress >= 1) {
          st.progress = 1;
          st.state = Pan.done;
          st.heat = 0;
          st.item = item(Kind.Gyoza);
          ev.push({ type: 'cooked', station: i, kind: Kind.Gyoza });
        }
      } else if (st.state === Pan.done || st.state === Pan.smoking) {
        // Tossing a done pan does not save it: it keeps heating.
        st.heat += dt;
        if (st.state === Pan.done && st.heat >= GYOZA_SMOKE_AFTER) {
          st.state = Pan.smoking;
          ev.push({ type: 'smoke', station: i });
        }
        if (st.heat >= GYOZA_BURN_AFTER) {
          st.state = Pan.burnt;
          st.item = item(Kind.GyozaBurnt);
          ev.push({ type: 'burn', station: i });
        }
      }
    });
  }

  // --- the belt ---------------------------------------------------------------------------------------------------
  private belt(dt: number, ev: GameEvent[]) {
    this.beltS = (this.beltS + this.beltSpeed * dt) % BELT_LENGTH;
    const staleTime = this.tuning.staleTime;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (!s.item) continue;
      s.age += dt;
      if (!s.stale && s.age >= staleTime) {
        s.stale = true;
        this.dayStats.stale++;
        ev.push({ type: 'stale', slot: i });
      }
    }
  }

  slotS(i: number): number {
    return (this.beltS + (i * BELT_LENGTH) / BELT_SLOTS) % BELT_LENGTH;
  }

  // --- customers ----------------------------------------------------------------------------------------------------
  private arrivals(dt: number, ev: GameEvent[]) {
    const u = this.clock / this.rules.dayLength;
    if (this.vipTimes.length && u >= this.vipTimes[0]!) {
      if (this.spawnCustomer({ vip: true }, ev)) this.vipTimes.shift();
    }
    if (this.rules.noArrivals) return;
    this.arrivalDebt += arrivalRate(this.tuning, u) * this.rules.arrivals * dt;
    // Customers who find no free seat wait outside a little, then try again (the debt is capped, not lost).
    this.arrivalDebt = Math.min(this.arrivalDebt, 1.6);
    while (this.arrivalDebt >= 1) {
      if (!this.spawnCustomer({}, ev)) break;
      this.arrivalDebt -= 1;
    }
  }

  freeSeats(kind: 'stool' | 'table'): SeatDef[] {
    return SEATS.filter(
      (s) =>
        s.kind === kind && this.seatOpen(s) && this.seats[s.id]!.customer < 0 && this.seats[s.id]!.dirty < SEAT_PILE,
    );
  }

  /**
   * A customer arrives (null when there is no free seat). `seat` / `order` pin them (dev commands, tests); otherwise
   * a table with the day's table share (once the dining room is open), else a stool; a random free seat; an order
   * from the day's mix.
   */
  spawnCustomer(
    opts: { seat?: number; order?: Kind; vip?: boolean; patience?: number },
    ev: GameEvent[],
  ): Customer | null {
    let seat: SeatDef | undefined;
    if (opts.seat !== undefined) {
      seat = SEATS[opts.seat];
      if (!seat || this.seats[seat.id]!.customer >= 0) return null;
    } else {
      const tables = opts.vip ? [] : this.freeSeats('table');
      const stools = this.freeSeats('stool');
      const wantTable = tables.length > 0 && (stools.length === 0 || this.rng.next() < this.tuning.tableShare);
      const pool = wantTable ? tables : stools;
      if (!pool.length) return null;
      seat = pool[this.rng.int(pool.length)]!;
    }
    const day = this.day;
    const cx = this.tuning.complexity;
    const orders = opts.vip
      ? omakase(this.rng, day)
      : [opts.order ?? (seat.kind === 'table' ? tableOrder(this.rng, day, cx) : beltOrder(this.rng, day, cx))];
    const base = seat.kind === 'table' ? this.tuning.tablePatience : this.tuning.patience;
    const patienceMax = (opts.patience ?? base * (opts.vip ? 1.3 : 1)) * this.rules.patience;
    const start = this.day === WEEK_DAYS ? FESTIVAL_GATE : STREET;
    const path = [...(this.day === WEEK_DAYS ? [{ x: 0, y: 8.8 }] : []), DOOR, ...seat.path];
    const c: Customer = {
      id: ++this.customerSerial,
      look: this.rng.int(4),
      vip: !!opts.vip,
      seat: seat.id,
      state: 'walkIn',
      x: start.x,
      y: start.y,
      path,
      pathAt: 0,
      t: 0,
      orders,
      course: 0,
      patience: patienceMax,
      patienceMax,
      speeds: [],
      waving: false,
      neutral: false,
    };
    this.customers.set(c.id, c);
    this.seats[seat.id]!.customer = c.id;
    this.checkFullHouse(ev);
    return c;
  }

  private checkFullHouse(ev: GameEvent[]) {
    if (this.dayStats.fullHouse) return;
    const open = SEATS.filter((s) => this.seatOpen(s));
    if (open.length && open.every((s) => this.seats[s.id]!.customer >= 0)) {
      this.dayStats.fullHouse = true;
      ev.push({ type: 'fullHouse' });
    }
  }

  private customersStep(dt: number, ev: GameEvent[]) {
    for (const c of [...this.customers.values()]) {
      c.t += dt;
      switch (c.state) {
        case 'walkIn':
          if (this.walk(c, dt)) {
            c.state = 'sit';
            c.t = 0;
          }
          break;
        case 'sit':
          if (c.t >= SIT_TIME) {
            c.state = 'wait';
            c.t = 0;
            ev.push({ type: 'seated', customer: c.id, seat: c.seat });
          }
          break;
        case 'wait': {
          c.patience -= dt;
          c.waving = c.patience / c.patienceMax < WAVE_BELOW && Math.floor(c.t / 2.2) % 2 === 0;
          if (SEATS[c.seat]!.kind === 'stool') this.reachForPlate(c, ev);
          if (c.state === 'wait' && c.patience <= 0) this.leave(c, 'angry', false, ev);
          break;
        }
        case 'eat':
          if (c.t >= EAT_TIME) {
            const rt = this.seats[c.seat]!;
            rt.eating = Kind.None;
            if (this.dishes) rt.dirty = Math.min(CARRY_PLATES, rt.dirty + 1);
            c.course++;
            if (c.course < c.orders.length) {
              c.state = 'wait';
              c.t = 0;
              c.patience = c.patienceMax * 0.85;
            } else {
              if (c.vip) {
                const avg = c.speeds.reduce((a, b) => a + b, 0) / Math.max(1, c.speeds.length);
                const tip = Math.round((VIP_TIP.base + VIP_TIP.speed * avg) * this.tuning.tipFactor);
                this.dayStats.tips += tip;
                this.dayStats.earned += tip;
                this.money += tip;
                ev.push({ type: 'vip', customer: c.id, seat: c.seat, tip });
              }
              this.leave(c, 'happy', false, ev);
            }
          }
          break;
        case 'happy':
        case 'angry':
          if (c.t >= REACT_TIME) {
            c.state = 'walkOut';
            c.t = 0;
            // Back the way they came, out to the street.
            const out = this.day === WEEK_DAYS ? FESTIVAL_GATE : STREET;
            c.path = [...SEATS[c.seat]!.path.slice(0, -1).reverse(), DOOR, out];
            c.pathAt = 0;
            const rt = this.seats[c.seat]!;
            if (rt.customer === c.id) rt.customer = -1;
          }
          break;
        case 'walkOut':
          if (this.walk(c, dt)) this.customers.delete(c.id);
          break;
      }
    }
  }

  /** Follow the path; true once at its end. */
  private walk(c: Customer, dt: number): boolean {
    let step = CUSTOMER_SPEED * dt;
    while (step > 0 && c.pathAt < c.path.length) {
      const p = c.path[c.pathAt]!;
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d <= step) {
        c.x = p.x;
        c.y = p.y;
        c.pathAt++;
        step -= d;
      } else {
        c.x += (dx / d) * step;
        c.y += (dy / d) * step;
        step = 0;
      }
    }
    return c.pathAt >= c.path.length;
  }

  /** A waiting stool customer takes the first passing plate of what they want (never a stale one). */
  private reachForPlate(c: Customer, ev: GameEvent[]) {
    const want = c.orders[c.course];
    const seat = SEATS[c.seat]!;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (!s.item || s.stale || s.item.kind !== want) continue;
      const d = Math.abs(this.slotS(i) - seat.grab);
      if (Math.min(d, BELT_LENGTH - d) > GRAB_WINDOW) continue;
      Object.assign(s, { item: null, age: 0, stale: false });
      const { price, tip } = this.pay(c, want);
      ev.push({ type: 'grab', customer: c.id, seat: c.seat, kind: want, price, tip });
      this.startEating(c, want);
      return;
    }
  }

  private pay(c: Customer, kind: Kind): { price: number; tip: number } {
    const frac = Math.max(0, Math.min(1, c.patience / c.patienceMax));
    c.speeds.push(frac);
    const price = priceOf(kind);
    const tip = c.vip ? 0 : Math.round(price * TIP_RATE * frac * this.tuning.tipFactor);
    this.dayStats.earned += price + tip;
    this.dayStats.tips += tip;
    this.dayStats.served++;
    if (tierOf(kind) === 'gold') this.dayStats.gold++;
    this.money += price + tip;
    return { price, tip };
  }

  private startEating(c: Customer, kind: Kind) {
    c.state = 'eat';
    c.t = 0;
    c.waving = false;
    this.seats[c.seat]!.eating = kind;
  }

  private leave(c: Customer, mood: 'happy' | 'angry', neutral: boolean, ev: GameEvent[]) {
    c.state = mood;
    c.t = 0;
    c.waving = false;
    c.neutral = neutral;
    if (mood === 'happy') {
      if (!neutral) ev.push({ type: 'happy', customer: c.id, seat: c.seat });
      return;
    }
    this.dayStats.angry++;
    ev.push({ type: 'angry', customer: c.id, seat: c.seat });
    this.setStars(this.stars - 1, ev);
  }

  setStars(n: number, ev: GameEvent[]) {
    const next = Math.max(0, Math.min(MAX_STARS, Math.round(n)));
    if (next === this.stars) return;
    ev.push({ type: 'stars', stars: next, delta: next - this.stars });
    this.stars = next;
    if (this.stars <= 0 && (this.phase === 'open' || this.phase === 'closing' || this.phase === 'morning')) {
      const summary = this.summary(true);
      this.lastSummary = summary;
      ev.push({ type: 'runOver', summary });
      this.setPhase('over', ev);
    }
  }

  // --- deliveries ---------------------------------------------------------------------------------------------------
  private delivery(dt: number, ev: GameEvent[]) {
    if (this.day < MECHANIC_DAY.delivery || this.phase === 'morning') return;
    const drop = STATIONS.find((d) => d.type === 'drop');
    if (!drop) return;
    const st = this.stations[drop.id]!;
    if (st.count > 0) return;
    this.deliveryIn -= dt;
    if (this.deliveryIn <= 0) {
      st.count = 1;
      this.deliveryIn = DELIVERY_EVERY;
      ev.push({ type: 'delivery' });
    }
  }

  // --- the end of a day, the night, the vote ------------------------------------------------------------------------
  private summary(closed: boolean): DaySummary {
    const s = this.dayStats;
    return {
      run: this.run,
      day: this.day,
      duration: (this.tick - this.dayStartedAt) / TICK_HZ,
      earned: s.earned,
      tips: s.tips,
      served: s.served,
      angry: s.angry,
      stale: s.stale,
      gold: s.gold,
      perfect: !closed && s.angry === 0,
      fullHouse: s.fullHouse,
      stars: this.stars,
      closed,
      week: !closed && this.day === WEEK_DAYS,
      crew: this.chefList.map((c) => ({ id: c.id, name: c.name, bot: c.bot })),
    };
  }

  private endDay(ev: GameEvent[]) {
    // A perfect day (no angry exits) wins a star back.
    if (this.dayStats.angry === 0) this.setStars(this.stars + 1, ev);
    const summary = this.summary(false);
    this.lastSummary = summary;
    ev.push({ type: 'dayOver', summary });
    this.cards = offerCards(this.rng, this.day, this.owned, this.crew);
    this.chosen = -1;
    for (const c of this.chefs.values()) {
      c.vote = -1;
      c.held = null;
      c.work = -1;
    }
    this.setPhase('night', ev);
  }

  private night(ev: GameEvent[]) {
    const voters = [...this.chefs.values()].filter((c) => c.connected && !c.bot);
    const allVoted = voters.length > 0 && voters.every((c) => c.vote >= 0);
    if (this.chosen < 0 && (allVoted || this.phaseTime >= this.rules.voteTime)) {
      // Bots abstain; a kitchen of bots only (the simulation) votes their preference.
      const votes = voters.length
        ? [...this.chefs.values()].filter((c) => !c.bot).map((c) => c.vote)
        : [botChoice(this.cards)];
      this.chosen = tally(this.rng, this.cards, votes);
      const card = this.cards[this.chosen];
      if (card) ev.push({ type: 'vote', card });
      this.phaseTime = Math.max(this.phaseTime, this.rules.voteTime - 1.6);
    }
    if (this.chosen >= 0 && this.phaseTime >= this.rules.voteTime) {
      this.todayCards.clear();
      const card = cardById(this.cards[this.chosen] ?? '');
      if (card) {
        if (card.today) this.todayCards.add(card.id);
        else this.owned.set(card.id, (this.owned.get(card.id) ?? 0) + 1);
      }
      this.cards = [];
      this.chosen = -1;
      this.day++;
      this.startDay(ev);
    }
  }

  // --- dev and test hooks -----------------------------------------------------------------------------------------
  /** Jump to the morning of `day` (the run keeps its stars and money; earlier days' cards are not drawn). */
  skipToDay(day: number, ev: GameEvent[] = []): void {
    if (this.phase === 'lobby' || this.phase === 'over') {
      this.run++;
      this.stars = MAX_STARS;
      this.money = 0;
      this.owned.clear();
    }
    this.todayCards.clear();
    this.cards = [];
    this.chosen = -1;
    this.day = Math.max(1, Math.min(99, Math.floor(day)));
    this.startDay(ev);
  }

  /** Close the doors now (the day's last customers still finish). */
  endOpen(ev: GameEvent[] = []): void {
    if (this.phase === 'morning') this.setPhase('open', ev);
    if (this.phase === 'open') {
      this.clock = this.rules.dayLength;
      this.setPhase('closing', ev);
    }
  }

  give(id: string, kind: Kind, plated = false, n = 1): void {
    const c = this.chefs.get(id);
    if (c) c.held = kind === Kind.None ? null : item(kind, plated && isBeltDish(kind), n);
  }

  place(id: string, x: number, y: number): void {
    const c = this.chefs.get(id);
    if (!c) return;
    c.x = x;
    c.y = y;
    c.vx = 0;
    c.vy = 0;
  }

  /** Put a plate on belt slot `i` (dev): `age` seconds old (past the stale time makes it stale at once). */
  putOnBelt(i: number, kind: Kind, age = 0): void {
    const s = this.slots[i];
    if (!s) return;
    Object.assign(s, { item: item(kind, true), age, stale: false });
  }
}

function emptyStation(): StationRt {
  return { item: null, mat: [], state: 0, count: 0, progress: 0, heat: 0, stirred: false };
}

function newDayStats() {
  return { earned: 0, tips: 0, served: 0, angry: 0, stale: 0, gold: 0, fullHouse: false };
}
