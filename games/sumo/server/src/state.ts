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
} as const;

export type FxEvent =
  | { k: 'hit'; a: string; b: string; i: number; x: number; y: number }
  | { k: 'out'; id: string; by: string }
  | { k: 'round'; winner: string }
  | { k: 'match'; winner: string };
