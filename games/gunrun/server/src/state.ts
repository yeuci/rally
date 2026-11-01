import type { Phase } from './match.ts';

/**
 * The room's synchronized state as the client sees it (the server defines it as a Colyseus schema in
 * apps/game-server/src/rooms/schema/GunRunState.ts with exactly these fields; keep the two in sync). Player keys are
 * Colyseus session ids (bots: `bot:<n>`); projectile keys their ids in base 36.
 *
 * Positions and velocities are 16-bit quantized on the wire (`POS_LIMIT`, `VEL_LIMIT`), aim an 8-bit angle.
 */
export interface GunRunPlayerView {
  name: string;
  /** 0…7: colour (`PALETTE`) and character (slot % 3). */
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Aim angle, radians (world axes: 0 = +x, π/2 = +y). */
  aim: number;
  hp: number;
  alive: boolean;
  /** Spawn protection (invulnerable, drawn flickering). */
  prot: boolean;
  /** Tenths of a second until the respawn while dead. */
  respawn: number;
  /** Rung of the ladder (index into `LADDER`). */
  tier: number;
  /** Kills on the current rung (`KILLS_PER_TIER` promote). */
  tk: number;
  kills: number;
  deaths: number;
  connected: boolean;
  guest: boolean;
  /** A server bot (quick play fills rooms with them): never on a board. */
  bot: boolean;
  /** Sequence number of the last input the server applied for this player. */
  ack: number;
}

export interface ProjectileView {
  /** 0 rocket, 1 grenade. */
  kind: number;
  x: number;
  y: number;
  /** Height above the ground. */
  h: number;
}

export interface MapLike<V> {
  get(key: string): V | undefined;
  forEach(fn: (value: V, key: string) => void): void;
  readonly size: number;
}

export interface GunRunStateView {
  phase: Phase;
  /** Seconds left of `starting` / `over`; seconds into the match while `playing`. */
  timer: number;
  /** Increments for every new match (clients reset their timelines on a change). */
  match: number;
  /** Session id of the winner while `over` ('' for none). */
  winner: string;
  /** Standing barrels: a bit per entry of `BARRELS`. */
  barrels: number;
  /** Med kits on the ground: a bit per entry of `MEDS`. */
  meds: number;
  /** Join code of a private room ('' for public rooms). */
  code: string;
  isPrivate: boolean;
  maxPlayers: number;
  tick: number;
  players: MapLike<GunRunPlayerView>;
  projectiles: MapLike<ProjectileView>;
}

/** Client → server message types. */
export const ClientMessage = {
  /** `InputMessage` (see input.ts). At most `INPUT_HZ` per second, only on change. */
  input: 'input',
  /** `{ username }`: display name from the launch context; the server only accepts it for guests. */
  profile: 'profile',
  /** Private rooms: start the match now. */
  start: 'start',
  /** Dev and test builds only (ignored unless the server runs with dev rules): `DevCommand`. */
  dev: 'dev',
} as const;

/** Server → client message types. */
export const ServerMessage = {
  /** `FxBatch` once per tick that had any effects (shots, hits, kills, explosions…). */
  fx: 'fx',
  /** `ResultMessage`, to each human of a finished match, once. */
  result: 'result',
} as const;

/** Effects of one server tick: draw them when the render clock reaches `t × DT`. */
export interface FxBatch {
  t: number;
  e: FxEvent[];
}

/**
 * Effects for sound and visuals. Players are slots (0…7); positions are hundredths of a unit as integers (compact on
 * the wire); weapons are indices into `WEAPON_IDS` (-1: a barrel).
 */
export type FxEvent =
  /** A hitscan shot: shooter, weapon, each ray as [x0, y0, x1, y1] (hundredths). */
  | { k: 'shot'; p: number; w: number; r: number[] }
  /** A rocket or grenade leaves the launcher (x, y: the muzzle, a: aim angle in milliradians). */
  | { k: 'launch'; p: number; w: number; x: number; y: number; a: number }
  /** A stab: who, where, which way (milliradians), and whether it connected. */
  | { k: 'stab'; p: number; x: number; y: number; a: number; hit: boolean }
  /** A player hit (by slot `by`, -1 for the world) for `d` damage at x, y; `hp` left. */
  | { k: 'hit'; p: number; by: number; x: number; y: number; d: number; hp: number }
  /** A kill: victim, killer (-1: nobody / themselves), weapon, where; `demote`: a knife kill sent them down a rung. */
  | { k: 'kill'; p: number; by: number; w: number; x: number; y: number; demote: boolean }
  /** A promotion (or demotion) to `tier`. */
  | { k: 'tier'; p: number; tier: number; up: boolean }
  | { k: 'boom'; x: number; y: number; r: number }
  | { k: 'spawn'; p: number }
  | { k: 'heal'; p: number }
  | { k: 'phase'; phase: Phase }
  /** The match is decided: the winner's slot (-1: nobody). */
  | { k: 'win'; p: number };

/** `ClientMessage.dev` (dev rules only: NODE_ENV=test or RALLY_DEV_RULES=1). Players by display name, or yourself. */
export type DevCommand =
  | { cmd: 'rules'; rules: Record<string, unknown> }
  /** Players take no damage (perf measurements). */
  | { cmd: 'god'; on: boolean }
  /** Bots stand still and hold fire. */
  | { cmd: 'freeze'; on: boolean }
  | { cmd: 'hurt'; name?: string; damage: number }
  | { cmd: 'place'; name?: string; x: number; y: number; aim?: number }
  /** Put a player on rung `tier` with `kills` on it. */
  | { cmd: 'setTier'; name?: string; tier: number; kills?: number }
  /** Credit `n` kills (promotions as earned). */
  | { cmd: 'giveKills'; name?: string; n: number }
  /** Quick-play bots in this room: how many to keep (the room's fill rule otherwise). */
  | { cmd: 'bots'; n: number }
  /** Start the match now (any room). */
  | { cmd: 'start' }
  /** End the match now: the leader by the ladder wins. */
  | { cmd: 'end' };

/** An achievement this match unlocked (from game.json, as stored in Supabase). */
export interface UnlockedAchievement {
  key: string;
  title: string;
  icon: string | null;
}

/**
 * `ServerMessage.result`. `matchId` is `<roomId>:<n>`, unique per match.
 * - `recorded: true`: the match counted. `boards` holds your score and rank on each board of the game (`wins`,
 *   `kills`) after it, as far as it counted there (matches under 20 s and private matches with fewer than 2 signed-in
 *   players skip the boards, so a board can be missing); `unlocked` only what this match unlocked.
 * - `recorded: false`: `guest` (no Rally account: sign in to keep your stats), or `unavailable` (the server could
 *   not save it).
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
export const RESULT_BOARDS = ['wins', 'kills'] as const;

/** Positions in effects: hundredths of a unit, as integers. */
export const fxPos = (v: number) => Math.round(v * 100);
export const fromFx = (v: number) => v / 100;
