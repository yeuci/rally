import { DAY_LENGTH, LAST_ORDERS, WEEK_DAYS } from './constants.ts';

/**
 * The difficulty of a day, all in one place. Every number the simulation asks "how hard is it right now" comes from
 * `dayTuning()` (per day, per crew size, per upgrade and per reputation) and `arrivalShape()` (within the day). The
 * README prints this table; the tests pin the curves' shapes and the headless simulation (test/sim.test.ts) checks that
 * bots survive them at every crew size.
 *
 * | Curve               | Monday | per day       | Sunday | Overtime (day 8+)              | Why                                          |
 * | ------------------- | ------ | ------------- | ------ | ------------------------------ | -------------------------------------------- |
 * | arrivals / min      | 2.4    | × 1.12        | ≈ 5.4  | × 1.06 / day, cap 3.4 × Monday | busier every day; Sunday's festival × 1.15   |
 * | stool patience (s)  | 62     | × 0.94        | ≈ 43   | × 0.97 / day, floor 26 s       | less slack as the dishes get harder          |
 * | table patience      | × 1.4  | (of stool)    |        |                                | hot dishes are carried across the room       |
 * | stale time (s)      | 64     | × 0.95        | ≈ 47   | floor 30 s (≈ one lap)         | "a couple of laps" early, a lap and a half later |
 * | order complexity    | 0      | + 1/6         | 1      | 1                              | the mix leans toward the effortful recipes   |
 * | table share         | –      | 0.24 Wed → 0.36 Sun |  | 0.38                           | splits the crew into belt cooks and runners  |
 *
 * Crew size `n` (active chefs, bots included): arrivals × (0.55 + 0.45 n) — 1.0, 1.45, 1.9, 2.35 — so every chef has
 * about the same work; patience × 1.15 solo and × 1.05 for two (a lone chef walks every errand); a solo crew gets the
 * auto rice cooker for free (the "prep helper"); and the open stools grow with the crew (6, 8, 10, 11) so four chefs
 * have customers to serve. At one star left, patience gets × 1.15 (the comeback): a bad day ends with tension, not a
 * cascade of angry exits.
 */

export interface DayTuning {
  /** Average arrivals per minute over the open hours (crew size and upgrades included). */
  arrivalsPerMin: number;
  /** Seconds a stool customer waits for their order. */
  patience: number;
  /** Seconds a table customer waits for a hot dish. */
  tablePatience: number;
  /** Seconds a plate rides the belt unclaimed before it goes stale. */
  staleTime: number;
  /** Fraction of arrivals that ask for a table (once the dining room is open). */
  tableShare: number;
  /** 0…1: how much the order mix leans toward effortful recipes. */
  complexity: number;
  /** Stools around the bar that take customers. */
  stools: number;
  /** Multiplier on tips (the food critic, happy hour). */
  tipFactor: number;
  /** VIP omakase customers today. */
  vips: number;
}

/** Upgrades and today's cards that change the curves (see orders.ts `CARDS`). */
export interface TuningMods {
  /** Extra seating cards taken (each +2 stools, × 1.12 arrivals). */
  expand: number;
  /** Free green tea (× 1.12 patience). */
  tea: boolean;
  /** The food critic is in today (× 2 tips, × 0.8 patience). */
  critic: boolean;
  /** Happy hour today (× 1.25 arrivals, × 1.5 tips). */
  rush: boolean;
}

export const NO_MODS: Readonly<TuningMods> = Object.freeze({ expand: 0, tea: false, critic: false, rush: false });

/** Monday's numbers, before the crew and the upgrades. */
export const BASE = {
  arrivalsPerMin: 2.4,
  patience: 62,
  staleTime: 64,
} as const;

/** Per-day growth during the week (days 1–7). */
export const GROWTH = {
  arrivals: 1.12,
  patience: 0.94,
  stale: 0.95,
} as const;

/** Overtime (day 8 on): slower growth from Sunday's numbers, with caps so a run keeps escalating but stays playable. */
export const OVERTIME = {
  arrivals: 1.06,
  arrivalsCap: 3.4,
  patience: 0.97,
  patienceFloor: 26,
  staleFloor: 30,
} as const;

/** Sunday's festival rush. */
export const FESTIVAL_ARRIVALS = 1.15;
/** Table customers wait this much longer than stool customers. */
export const TABLE_PATIENCE = 1.4;
/** Comeback: at this many stars or fewer, patience × COMEBACK. */
export const COMEBACK_STARS = 1;
export const COMEBACK = 1.15;
/** Tips: price × TIP_RATE × the fraction of patience left when served. */
export const TIP_RATE = 0.6;
/** The VIP's tip for the whole omakase: base plus this much per unit of patience left on average. */
export const VIP_TIP = { base: 600, speed: 400 } as const;

/** Crew multiplier on arrivals: 0.55 + 0.45 × chefs. */
export function crewArrivals(crew: number): number {
  return 0.55 + 0.45 * Math.max(1, crew);
}

/** Crew multiplier on patience: solo chefs walk every errand themselves. */
export function crewPatience(crew: number): number {
  return crew <= 1 ? 1.15 : crew === 2 ? 1.05 : 1;
}

/** Stools open around the bar for a crew (before extra-seating cards). */
export function crewStools(crew: number): number {
  return Math.max(6, Math.min(11, 4 + 2 * Math.max(1, crew)));
}

/** Day 8+ counts as Overtime: the days past Sunday. */
export const overtimeDays = (day: number) => Math.max(0, day - WEEK_DAYS);

export function dayTuning(day: number, crew: number, mods: TuningMods = NO_MODS, stars = 5): DayTuning {
  const d = Math.max(1, Math.floor(day));
  const weekDay = Math.min(d, WEEK_DAYS);
  const over = overtimeDays(d);

  let arrivals = BASE.arrivalsPerMin * GROWTH.arrivals ** (weekDay - 1);
  if (d === WEEK_DAYS) arrivals *= FESTIVAL_ARRIVALS;
  if (over > 0) {
    // Overtime grows from a normal Sunday (the festival bonus does not carry over), capped.
    arrivals = Math.min(
      BASE.arrivalsPerMin * OVERTIME.arrivalsCap,
      BASE.arrivalsPerMin * GROWTH.arrivals ** (WEEK_DAYS - 1) * OVERTIME.arrivals ** over,
    );
  }
  arrivals *= crewArrivals(crew) * 1.12 ** mods.expand * (mods.rush ? 1.25 : 1);

  let patience = BASE.patience * GROWTH.patience ** (weekDay - 1);
  if (over > 0) patience = Math.max(OVERTIME.patienceFloor, patience * OVERTIME.patience ** over);
  patience *= crewPatience(crew) * (mods.tea ? 1.12 : 1) * (mods.critic ? 0.8 : 1);
  if (stars <= COMEBACK_STARS) patience *= COMEBACK;

  let staleTime = BASE.staleTime * GROWTH.stale ** (weekDay - 1);
  if (over > 0) staleTime = Math.max(OVERTIME.staleFloor, staleTime * GROWTH.stale ** over);

  return {
    arrivalsPerMin: round2(arrivals),
    patience: round2(patience),
    tablePatience: round2(patience * TABLE_PATIENCE),
    staleTime: round2(staleTime),
    tableShare: d < 3 ? 0 : Math.min(0.38, 0.24 + 0.03 * (d - 3)),
    complexity: Math.min(1, (d - 1) / (WEEK_DAYS - 1)),
    stools: crewStools(crew) + 2 * mods.expand,
    tipFactor: (mods.critic ? 2 : 1) * (mods.rush ? 1.5 : 1),
    vips: d < 5 ? 0 : over >= 3 ? 2 : 1,
  };
}

/**
 * Within a day (u = 0 at opening, 1 at closing): a light morning, the lunch rush, a lull, the dinner rush, and no new
 * customers after last orders. Normalized so its mean over the open hours is 1 (so `arrivalsPerMin` is the day's
 * average). There is no sudden wall: the peaks are smooth.
 */
export function arrivalShape(u: number): number {
  if (u < 0 || u >= LAST_ORDERS) return 0;
  return rawShape(u) / SHAPE_MEAN;
}

function rawShape(u: number): number {
  const lunch = 1.3 * Math.exp(-(((u - 0.28) / 0.09) ** 2));
  const dinner = 1.5 * Math.exp(-(((u - 0.7) / 0.1) ** 2));
  // A slow start: the first minutes of the morning are quieter still.
  const morning = 0.45 * Math.min(1, 0.4 + u * 6);
  return morning + lunch + dinner;
}

const SHAPE_MEAN = (() => {
  let sum = 0;
  const n = 900;
  for (let i = 0; i < n; i++) sum += rawShape(((i + 0.5) / n) * LAST_ORDERS);
  return sum / n;
})();

/** Arrivals per second at day fraction `u` for a day's tuning. */
export function arrivalRate(t: DayTuning, u: number): number {
  return (t.arrivalsPerMin / 60) * arrivalShape(u);
}

/** Expected customers over a whole day (for the tests and the README). */
export function expectedCustomers(t: DayTuning): number {
  return (t.arrivalsPerMin / 60) * DAY_LENGTH * LAST_ORDERS;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
