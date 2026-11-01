import type { Phase } from './match.ts';

/**
 * The room's synchronized state as the client sees it (the server defines it as a Colyseus schema in
 * apps/game-server/src/rooms/schema/NorthdaleState.ts with exactly these fields; keep the two in sync). Player keys are
 * Colyseus session ids; zombie, pickup, rock and goo keys their ids in base 36.
 *
 * Positions and velocities are 16-bit quantized on the wire (`POS_LIMIT`, `VEL_LIMIT`), angles 8-bit. Zombies further
 * than `SYNC_RADIUS` from every survivor are left out (they live on, coarsely, on the server).
 */
export interface NorthdalePlayerView {
  name: string;
  /** 0…3: survivor (Lis, Matt, Sam, Shaun) and colour. */
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  hp: number;
  armor: number;
  /** 0 alive, 1 down, 2 dead (back at dawn). */
  life: number;
  /** Revive progress on this survivor, percent. */
  revive: number;
  /** The context action in progress (`Action`) and its progress, percent. */
  actKind: number;
  act: number;
  /** Item codes: the gun, the melee weapon (0 fists), the two item slots, the part carried. */
  gun: number;
  melee: number;
  /** Swings left of the melee weapon. */
  dur: number;
  a0: number;
  a1: number;
  a2: number;
  a3: number;
  i0: number;
  i1: number;
  carry: number;
  kills: number;
  /** A solo survivor's second wind is still there. */
  wind: boolean;
  /** Seconds down (bleeding out). */
  downFor: number;
  inRun: boolean;
  connected: boolean;
  guest: boolean;
  /** Sequence number of the last input the server applied. */
  ack: number;
}

export interface ZombieView {
  kind: number;
  x: number;
  y: number;
  /** Percent of its HP. */
  hp: number;
}

export interface PickupView {
  kind: number;
  x: number;
  y: number;
}

export interface RockView {
  x: number;
  y: number;
  h: number;
  tx: number;
  ty: number;
}

export interface GooView {
  x: number;
  y: number;
}

export interface BarricadeView {
  tier: number;
  /** Percent of its HP. */
  hp: number;
}

export interface MapLike<V> {
  get(key: string): V | undefined;
  forEach(fn: (value: V, key: string) => void): void;
  readonly size: number;
}

export interface NorthdaleStateView {
  phase: Phase;
  /** Seconds left in the phase (counting up while `waiting`), in tenths. */
  timer: number;
  /** Length of the phase (the clock). */
  length: number;
  /** The night in progress or the last one (0 before night 1); the day number; nights survived so far. */
  night: number;
  day: number;
  nights: number;
  blood: boolean;
  run: number;
  tick: number;
  kills: number;
  /** Team scrap. */
  scrap: number;
  wheels: number;
  fuel: number;
  truckScrap: number;
  /** Where the truck is drawn (it moves during the escape). */
  truckX: number;
  truckY: number;
  truckYaw: number;
  /** One character per loot spot (`LOOT_SPOTS`): '1' opened or searched, '0' not. */
  opened: string;
  dogX: number;
  dogY: number;
  /** 0 stray, 1 following, 2 down. */
  dogState: number;
  dogHp: number;
  dogFacing: number;
  dogBite: boolean;
  code: string;
  isPrivate: boolean;
  maxPlayers: number;
  players: MapLike<NorthdalePlayerView>;
  zombies: MapLike<ZombieView>;
  pickups: MapLike<PickupView>;
  rocks: MapLike<RockView>;
  goo: MapLike<GooView>;
  /** Keyed by socket index. */
  barricades: MapLike<BarricadeView>;
}

/** Client → server message types. */
export const ClientMessage = {
  /** `InputMessage` (see input.ts). At most `INPUT_HZ` per second, only on change. */
  input: 'input',
  /** `{ username }`: display name from the launch context; the server only accepts it for guests. */
  profile: 'profile',
  /** Private rooms: start the run now. */
  start: 'start',
  /** Dev and test builds only (ignored unless the server runs with dev rules): `DevCommand`. */
  dev: 'dev',
} as const;

/** Server → client message types. */
export const ServerMessage = {
  /** `FxBatch` once per tick that had any effects. */
  fx: 'fx',
  /** `ResultMessage`, to each survivor of a finished run, once. */
  result: 'result',
} as const;

/** Effects of one server tick: draw them when the render clock reaches `t × DT`. */
export interface FxBatch {
  t: number;
  e: FxEvent[];
}

/**
 * Effects for sound and visuals. Survivors are slots (0…3), -1 for nobody; positions are hundredths of a unit as
 * integers; items are item codes (kill causes: -2 the dog, -3 the truck).
 */
export type FxEvent =
  | { k: 'phase'; phase: Phase }
  | { k: 'night'; n: number; blood: boolean }
  | { k: 'dawn'; n: number }
  /** Shots: shooter, gun, each pellet's ray as [x0, y0, x1, y1]. */
  | { k: 'shot'; p: number; w: number; r: number[] }
  | { k: 'empty'; p: number }
  /** A melee swing: who, the weapon (0 fists), where, which way (milliradians), how many it hit. */
  | { k: 'swing'; p: number; w: number; x: number; y: number; a: number; n: number }
  | { k: 'hit'; z: number; x: number; y: number }
  | { k: 'kill'; z: number; kind: number; x: number; y: number; p: number; w: number }
  | { k: 'hurt'; p: number; hp: number; d: number }
  | { k: 'down'; p: number }
  | { k: 'revive'; p: number; by: number }
  | { k: 'dead'; p: number }
  | { k: 'respawn'; p: number }
  | { k: 'open'; s: number; p: number; n: number }
  | { k: 'loot'; p: number; i: number }
  | { k: 'use'; p: number; i: number }
  | { k: 'broke'; p: number; i: number }
  /** The brute winds up a throw at (x, y). */
  | { k: 'windup'; z: number; x: number; y: number }
  | { k: 'rock'; x: number; y: number }
  | { k: 'goo'; x: number; y: number }
  /** The dog barks at a zombie at (x, y) (the minimap pings there). */
  | { k: 'bark'; x: number; y: number }
  | { k: 'dog'; s: number; p: number }
  | { k: 'build'; s: number; t: number; p: number }
  | { k: 'smash'; s: number }
  | { k: 'breach'; s: number }
  | { k: 'part'; i: number; p: number }
  | { k: 'scrap'; n: number; p: number }
  | { k: 'holdout' }
  | { k: 'escape' }
  | { k: 'over'; n: number; e: boolean };

/** `ClientMessage.dev` (dev rules only: NODE_ENV=test or RALLY_DEV_RULES=1). Survivors by display name, or yourself. */
export type DevCommand =
  | { cmd: 'rules'; rules: Record<string, unknown> }
  /** Survivors take no damage. */
  | { cmd: 'god'; on: boolean }
  /** Zombies stand still, hold their attacks and stop spawning. */
  | { cmd: 'freeze'; on: boolean }
  /** Remove every zombie. */
  | { cmd: 'clear' }
  /** Set the time of day: to `phase`, with `left` seconds of it. */
  | { cmd: 'time'; phase: 'day' | 'dusk' | 'night'; left?: number }
  /** Night `n` falls now. */
  | { cmd: 'night'; n: number }
  /** `n` zombies of `kind` (0 basic, 1 crawler, 2 chubby, 3 brute) at (x, y). */
  | { cmd: 'spawn'; kind: number; x: number; y: number; n?: number }
  /** An item (code) for a survivor, `n` times. */
  | { cmd: 'give'; item: number; n?: number; name?: string }
  | { cmd: 'hurt'; damage: number; name?: string }
  /** Knock a survivor down. */
  | { cmd: 'down'; name?: string }
  | { cmd: 'place'; x: number; y: number; name?: string }
  /** The truck's repair. */
  | { cmd: 'truck'; wheels: number; fuel: number; scrap: number }
  /** Team scrap. */
  | { cmd: 'scrap'; n: number }
  | { cmd: 'start' }
  | { cmd: 'end' };

/** An achievement this run unlocked (from game.json, as stored in Supabase). */
export interface UnlockedAchievement {
  key: string;
  title: string;
  icon: string | null;
}

/**
 * `ServerMessage.result`. `matchId` is `<roomId>:<run>`, unique per run.
 * - `recorded: true`: the run counted. `boards` holds your score and rank on each board after it (`nights`, `kills`,
 *   `escapes`), as far as it counted there; `unlocked` only what this run unlocked.
 * - `recorded: false`: `guest` (no Rally account), or `unavailable` (the server could not save it).
 */
export type ResultMessage =
  | {
      matchId: string;
      recorded: true;
      boards: Record<string, { score: number; rank: number }>;
      unlocked: UnlockedAchievement[];
    }
  | { matchId: string; recorded: false; reason: 'guest' | 'unavailable' };

/** The boards game.json declares, in order (the first is the game's primary board). */
export const RESULT_BOARDS = ['nights', 'kills', 'escapes'] as const;

/** Positions in effects: hundredths of a unit, as integers. */
export const fxPos = (v: number) => Math.round(v * 100);
export const fromFx = (v: number) => v / 100;

/** Life states on the wire. */
export const LIFE = { alive: 0, down: 1, dead: 2 } as const;
