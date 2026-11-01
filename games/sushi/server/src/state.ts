import type { Phase } from './game.ts';

/**
 * The room's synchronized state as the client sees it (the server defines it as a Colyseus schema in
 * apps/game-server/src/rooms/schema/SushiState.ts with exactly these fields; keep the two in sync). Chef keys are
 * Colyseus session ids (bots: `bot:<n>`); customer keys their ids in base 36; stations, belt slots and seats are
 * arrays indexed like `STATIONS`, the belt's slots and `SEATS`.
 *
 * Items are uint16 codes (`itemCode` / `decodeItem`), the mat's contents a bitmask (`matMask` / `matItems`).
 */
export interface ChefView {
  name: string;
  /** 0…3: which chef model (panda, cyan, pink, purple) and colour. */
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing, radians. */
  face: number;
  /** What it carries (item code, 0 = nothing). */
  held: number;
  /** What its body does (`ChefAct`): chopping, rolling, stirring, washing. */
  act: number;
  connected: boolean;
  guest: boolean;
  bot: boolean;
  /** The night's vote (-1: none yet). */
  vote: number;
  /** Sequence number of the last input the server applied. */
  ack: number;
}

export interface StationStateView {
  item: number;
  mat: number;
  state: number;
  /** Portions, plates, dirty plates in the sink, a crate's stock (-1: unlimited). */
  count: number;
  /** 0…100: chopping, rolling, washing, cooking. */
  progress: number;
}

export interface SlotView {
  item: number;
  stale: boolean;
  /** 0…100 of the way to stale (the plate wilts as it nears 100). */
  age: number;
}

export interface SeatStateView {
  dirty: number;
  /** The dish being eaten there (a Kind, 0 = none). */
  eating: number;
}

export interface CustomerView {
  look: number;
  vip: boolean;
  seat: number;
  /** Index into `CUSTOMER_STATES`. */
  state: number;
  x: number;
  y: number;
  /** Up to three orders (the VIP's courses; Kind.None when absent) and the one being waited for. */
  o0: number;
  o1: number;
  o2: number;
  course: number;
  /** 0…100 patience left. */
  patience: number;
  waving: boolean;
}

export interface MapLike<V> {
  get(key: string): V | undefined;
  forEach(fn: (value: V, key: string) => void): void;
  readonly size: number;
}

export interface ListLike<V> {
  readonly length: number;
  [index: number]: V;
}

export interface SushiStateView {
  phase: Phase;
  /** Seconds left of the phase (tenths). */
  timer: number;
  run: number;
  day: number;
  /** Fraction of the open hours gone (the clock). */
  clock: number;
  stars: number;
  money: number;
  /** Today's numbers. */
  earned: number;
  tips: number;
  served: number;
  angry: number;
  /** Open zones (`Zone` bits). */
  zones: number;
  /** Owned upgrades ("knives,expand:2") and today's one-day cards ("critic"). */
  owned: string;
  today: string;
  /** The night's three cards ("knives,mat2,critic") and the chosen one (-1 while voting). */
  cards: string;
  chosen: number;
  /** Dirty dishes are on (Thursday on). */
  dishes: boolean;
  /** The solo crew's free rice cooker is on today. */
  helper: boolean;
  /** Chefs working (the tuning scales with it). */
  crew: number;
  beltS: number;
  beltSpeed: number;
  /** The last finished day, as JSON (`DaySummary`), '' before the first. */
  summary: string;
  code: string;
  isPrivate: boolean;
  maxPlayers: number;
  tick: number;
  players: MapLike<ChefView>;
  customers: MapLike<CustomerView>;
  stations: ListLike<StationStateView>;
  slots: ListLike<SlotView>;
  seats: ListLike<SeatStateView>;
}

/** Client → server message types. */
export const ClientMessage = {
  /** `InputMessage` (see input.ts), on change, at most INPUT_HZ per second. */
  input: 'input',
  /** `{ username }`: display name from the launch context; the server only accepts it for guests. */
  profile: 'profile',
  /** `{ i }`: the night's vote (index into `cards`). */
  vote: 'vote',
  /** Private rooms: start the run. */
  start: 'start',
  /** Dev and test builds only (ignored unless the server runs with dev rules): `DevCommand`. */
  dev: 'dev',
} as const;

/** Server → client message types. */
export const ServerMessage = {
  /** `FxBatch` once per tick that had any effects. */
  fx: 'fx',
  /** `ResultMessage`, to each human at the end of every day, once. */
  result: 'result',
} as const;

export interface FxBatch {
  t: number;
  e: FxEvent[];
}

/**
 * Effects for sound and visuals. Chefs are slots (0–3), customers ids, kinds `Kind` numbers, positions hundredths of a
 * unit as integers.
 */
export type FxEvent =
  | { k: 'phase'; phase: Phase }
  /** A new morning: the day and the mechanics it teaches (one banner each). */
  | { k: 'morning'; d: number; teach: string[] }
  | { k: 'pick'; p: number; i: number; s: number }
  | { k: 'put'; p: number; i: number; s: number }
  | { k: 'chop'; p: number; s: number; i: number }
  | { k: 'roll'; p: number; s: number; i: number }
  | { k: 'plate'; p: number; i: number }
  | { k: 'belt'; p: number; n: number; i: number }
  | { k: 'take'; p: number; n: number; i: number; stale: boolean }
  /** Money from a customer: a plate taken off the belt, a table served, the VIP's omakase tip. */
  | { k: 'coin'; c: number; seat: number; how: 'grab' | 'serve' | 'vip'; i: number; v: number; tip: number }
  | { k: 'seated'; c: number }
  | { k: 'happy'; c: number }
  | { k: 'angry'; c: number; seat: number }
  | { k: 'stars'; v: number; d: number }
  | { k: 'stale'; n: number }
  | { k: 'smoke'; s: number }
  | { k: 'burn'; s: number }
  | { k: 'cooked'; s: number; i: number }
  | { k: 'bin'; p: number; i: number }
  | { k: 'wash'; p: number }
  | { k: 'bus'; p: number; seat: number; n: number }
  | { k: 'delivery' }
  | { k: 'restock'; p: number }
  | { k: 'full' }
  /** A press with nothing to do. */
  | { k: 'bonk'; p: number }
  | { k: 'vote'; card: string }
  /** The day is over (night) or the restaurant closed (over). */
  | { k: 'day'; closed: boolean };

/** `ClientMessage.dev` (dev rules only: NODE_ENV=test or RALLY_DEV_RULES=1). Chefs by display name, or yourself. */
export type DevCommand =
  | { cmd: 'rules'; rules: Record<string, unknown> }
  /** Skip to the morning of `day` (3 opens the dining room). */
  | { cmd: 'day'; day: number }
  /** A customer now: at a seat, with an order (a Kind), as the VIP, with this much patience (seconds). */
  | { cmd: 'customer'; seat?: number; order?: number; vip?: boolean; patience?: number }
  /** Put an item in a chef's hands (Kind 0 empties them). */
  | { cmd: 'give'; name?: string; kind: number; plated?: boolean; n?: number }
  | { cmd: 'stars'; n: number }
  | { cmd: 'place'; name?: string; x: number; y: number }
  /** A plate on belt slot `slot`, `age` seconds old (past the stale time: stale at once). */
  | { cmd: 'belt'; slot: number; kind: number; age?: number }
  /** Close the doors now (the last customers still finish). */
  | { cmd: 'close' }
  /** Start the run now (any room). */
  | { cmd: 'start' }
  /** Helper bots in the room (0–3). */
  | { cmd: 'bots'; n: number }
  /** Stop the simulation (art, perf). */
  | { cmd: 'freeze'; on: boolean };

export interface UnlockedAchievement {
  key: string;
  title: string;
  icon: string | null;
}

/**
 * `ServerMessage.result`, at the end of every day (each day is one record: a shift). `matchId` is
 * `<roomId>:<run>:<day>`.
 * - `recorded: true`: the day counted; `boards` holds your score and rank on each board after it (`days`, `tips`),
 *   as far as it counted there; `unlocked` only what this day unlocked.
 * - `recorded: false`: `guest` (sign in to keep your stats) or `unavailable` (the server could not save it).
 */
export type ResultMessage =
  | {
      matchId: string;
      recorded: true;
      boards: Record<string, { score: number; rank: number }>;
      unlocked: UnlockedAchievement[];
    }
  | { matchId: string; recorded: false; reason: 'guest' | 'unavailable' };

/** The boards game.json declares, in order. */
export const RESULT_BOARDS = ['days', 'tips'] as const;

export const fxPos = (v: number) => Math.round(v * 100);
export const fromFx = (v: number) => v / 100;
