import type { Phase } from './match.ts';

/**
 * The room's synchronized state as the client sees it (the server defines it as a Colyseus schema in
 * apps/game-server/src/rooms/schema/SumoState.ts with exactly these fields; keep the two in sync).
 * Player keys are Colyseus session ids.
 */
export interface SumoPlayerView {
  name: string;
  /** Index into `PALETTE`. */
  color: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  score: number;
  connected: boolean;
  guest: boolean;
  inRound: boolean;
  /** Sequence number of the last input the server applied for this player. */
  ack: number;
}

export interface MapLike<V> {
  get(key: string): V | undefined;
  forEach(fn: (value: V, key: string) => void): void;
  readonly size: number;
}

export interface SumoStateView {
  phase: Phase;
  timer: number;
  round: number;
  matchTime: number;
  radius: number;
  /** Session id of the last round's winner; '' = draw / none. */
  roundWinner: string;
  /** Session id of the match winner while `phase` is roundOver/matchOver after the deciding round; '' otherwise. */
  matchWinner: string;
  /** Join code of a private room ('' for public rooms). */
  code: string;
  isPrivate: boolean;
  maxPlayers: number;
  tick: number;
  players: MapLike<SumoPlayerView>;
}

/** Client → server message types. */
export const ClientMessage = {
  /** `{ x, y, s }` stick + sequence (see `InputMessage`). At most `INPUT_HZ` per second, only on change. */
  input: 'input',
  /** `{ username }`: display name from the launch context; the server only accepts it for guests. */
  profile: 'profile',
} as const;

/** Server → client message types. */
export const ServerMessage = {
  /** Effects batch for sound and screen shake: `FxEvent[]` once per tick that had any. */
  fx: 'fx',
  /**
   * `ResultMessage`, to each player of a finished match, once (server v2+): what the match did to *your* Rally
   * stats. Guests get theirs at once; signed-in players when the write to Supabase answered (usually well inside the
   * `matchOver` screen, but it can come after the room reset if the write had to be retried).
   */
  result: 'result',
} as const;

/** An achievement this match unlocked (from game.json, as stored in Supabase). */
export interface UnlockedAchievement {
  key: string;
  title: string;
  icon: string | null;
}

/**
 * `ServerMessage.result`. `matchId` is `<roomId>:<n>`, unique per match.
 * - `recorded: true`: the match counted. `wins` / `losses` are your Sumo totals after it; `rank` is your place on the
 *   `wins` board for the board's current period, or null when the match did not count there (under 20 s, a private
 *   room with fewer than 2 signed-in players, the hourly cap). `boards` has every board of the game you are on;
 *   `unlocked` only what this match unlocked.
 * - `recorded: false`: `guest` (no Rally account, or an anonymous one: sign in to keep your wins), or `unavailable`
 *   (the server could not save it: no database, an outage that outlasted the retries, or an account that cannot
 *   record results).
 */
export type ResultMessage =
  | {
      matchId: string;
      recorded: true;
      wins: number;
      losses: number;
      rank: number | null;
      boards: Record<string, { score: number; rank: number }>;
      unlocked: UnlockedAchievement[];
    }
  | { matchId: string; recorded: false; reason: 'guest' | 'unavailable' };

/** The board whose rank `ResultMessage.rank` reports (game.json `leaderboards[0].id`). */
export const RESULT_BOARD = 'wins';

export type FxEvent =
  | { k: 'hit'; a: string; b: string; i: number; x: number; y: number }
  | { k: 'out'; id: string; by: string }
  | { k: 'round'; winner: string }
  | { k: 'match'; winner: string };
