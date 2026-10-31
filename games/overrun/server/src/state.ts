import type { Phase } from './match.ts';

/**
 * The room's synchronized state as the client sees it (the server defines it as a Colyseus schema in
 * apps/game-server/src/rooms/schema/OverrunState.ts with exactly these fields; keep the two in sync). Player keys
 * are Colyseus session ids; zombie, projectile, explosive and pickup keys are their ids in base 36.
 *
 * Positions and velocities are 16-bit quantized on the wire (`POS_LIMIT`, `VEL_LIMIT`), aim is an 8-bit angle,
 * zombie HP a percentage.
 */
export interface OverrunPlayerView {
  name: string;
  /** 0…3: colour (`PALETTE`) and spawn point. */
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Aim angle, radians (world axes: 0 = +x, π/2 = +y). */
  aim: number;
  hp: number;
  down: boolean;
  /** Revive progress while down, 0…100. */
  revive: number;
  /** Current weapon (index into `WEAPONS`). */
  weapon: number;
  /** Ammo of weapons 1…4 (the pistol has infinite ammo). */
  a1: number;
  a2: number;
  a3: number;
  a4: number;
  score: number;
  kills: number;
  revives: number;
  connected: boolean;
  guest: boolean;
  /** In the current run (false: joined mid-wave, spawns at the next breather; or waiting for the next run). */
  active: boolean;
  /** Sequence number of the last input the server applied for this player. */
  ack: number;
}

export interface ZombieView {
  kind: number;
  x: number;
  y: number;
  /** HP left, percent of its maximum. */
  hp: number;
}

export interface ProjectileView {
  x: number;
  y: number;
  /** Height above the ground. */
  h: number;
  /** Where it will land (drawn as a warning ring). */
  tx: number;
  ty: number;
}

export interface ExplosiveView {
  /** `ExplosiveKind`: 0 barrel, 1 mine. */
  kind: number;
  x: number;
  y: number;
  armed: boolean;
}

export interface PickupView {
  /** 0 = health, 1…4 = ammo for that weapon. */
  kind: number;
  x: number;
  y: number;
}

export interface MapLike<V> {
  get(key: string): V | undefined;
  forEach(fn: (value: V, key: string) => void): void;
  readonly size: number;
}

export interface OverrunStateView {
  phase: Phase;
  /** Seconds left of the breather / run-over screen; seconds into the wave while it runs. */
  timer: number;
  /** The wave being fought, or the next one during a breather (0 before the first). */
  wave: number;
  /** Highest wave this run has started (what the run-over screen and the boards report). */
  reached: number;
  /** Zombies of this wave not yet killed (alive + still to spawn). */
  remaining: number;
  teamScore: number;
  teamKills: number;
  /** Current combo multiplier (1 = none) and how much of its window is left, 0…100. */
  combo: number;
  comboLeft: number;
  /** Weapons unlocked for the team (1 = pistol only … 5 = everything). */
  unlocked: number;
  /** Increments for every new run (clients clear interpolation and decals on a change). */
  run: number;
  /** Join code of a private room ('' for public rooms). */
  code: string;
  isPrivate: boolean;
  maxPlayers: number;
  tick: number;
  players: MapLike<OverrunPlayerView>;
  zombies: MapLike<ZombieView>;
  projectiles: MapLike<ProjectileView>;
  explosives: MapLike<ExplosiveView>;
  pickups: MapLike<PickupView>;
}

/** Client → server message types. */
export const ClientMessage = {
  /** `InputMessage` (see input.ts). At most `INPUT_HZ` per second, only on change. */
  input: 'input',
  /** `{ username }`: display name from the launch context; the server only accepts it for guests. */
  profile: 'profile',
  /** Private rooms: start the run now instead of waiting for more players. */
  start: 'start',
  /** Dev and test builds only (ignored unless the server runs with dev rules): `DevCommand`. */
  dev: 'dev',
} as const;

/** Server → client message types. */
export const ServerMessage = {
  /** `FxBatch` once per tick that had any effects (shots, hits, kills, explosions…). */
  fx: 'fx',
  /** `ResultMessage`, to each player of a finished run, once. */
  result: 'result',
} as const;

/** Effects of one server tick: draw them when the render clock reaches `t × DT`. */
export interface FxBatch {
  t: number;
  e: FxEvent[];
}

/**
 * Effects for sound and visuals (numbers rounded to 0.01). Player references are slots (0…3), zombies their
 * numeric id.
 */
export type FxEvent =
  /** A shot: shooter slot, weapon, and each ray as [x0, y0, x1, y1]. */
  | { k: 'shot'; p: number; w: number; r: number[] }
  /** A zombie hit (flash + a little blood) at x, y. */
  | { k: 'hit'; z: number; x: number; y: number }
  /** A kill: zombie id and kind, where, by which slot (-1 = nobody), the multiplier it scored at. */
  | { k: 'kill'; z: number; kind: number; x: number; y: number; p: number; m: number }
  | { k: 'boom'; x: number; y: number; r: number }
  | { k: 'hurt'; p: number; hp: number }
  | { k: 'down'; p: number }
  | { k: 'revive'; p: number; by: number }
  | { k: 'spit'; x: number; y: number }
  | { k: 'splash'; x: number; y: number }
  | { k: 'place'; p: number; kind: number }
  | { k: 'pickup'; p: number; kind: number }
  | { k: 'unlock'; w: number }
  | { k: 'wave'; n: number }
  | { k: 'clear'; n: number }
  | { k: 'over'; n: number };

/** `ClientMessage.dev` (dev rules only: NODE_ENV=test or RALLY_DEV_RULES=1). */
export type DevCommand =
  | { cmd: 'rules'; rules: Record<string, unknown> }
  /** Zombies stop moving, attacking and spawning (and spitters stop spitting). */
  | { cmd: 'freeze'; on: boolean }
  /** Players take no damage (perf measurements). */
  | { cmd: 'god'; on: boolean }
  | { cmd: 'spawn'; kind?: number; x: number; y: number; n?: number }
  /** Remove every zombie and empty the spawn queue. */
  | { cmd: 'clear' }
  /** Damage a player (by display name, or yourself). */
  | { cmd: 'hurt'; name?: string; damage: number }
  /** Teleport a player (by display name, or yourself). */
  | { cmd: 'place'; name?: string; x: number; y: number }
  /** End the current wave now (the queue is dropped, alive zombies removed). */
  | { cmd: 'endWave' };

/** An achievement this run unlocked (from game.json, as stored in Supabase). */
export interface UnlockedAchievement {
  key: string;
  title: string;
  icon: string | null;
}

/**
 * `ServerMessage.result`. `matchId` is `<roomId>:<n>`, unique per run.
 * - `recorded: true`: the run counted. `boards` holds your score and rank on each board of the game (`wave`,
 *   `kills`) after it, as far as it counted there (runs under 20 s and private runs with fewer than 2 signed-in
 *   players skip the boards, so a board can be missing); `unlocked` only what this run unlocked.
 * - `recorded: false`: `guest` (no Rally account: sign in to keep your stats), or `unavailable` (the server could not
 *   save it).
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
export const RESULT_BOARDS = ['wave', 'kills'] as const;
