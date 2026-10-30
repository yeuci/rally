/**
 * Tuning for Sumo. Units are arbitrary "world units" (a puck has radius 1); time is in seconds.
 * Shared by the server (authoritative simulation) and the client (rendering, prediction of the local puck).
 */

/** Server simulation rate (fixed timestep). The synced `tick` counts these steps: server time = tick × DT. */
export const TICK_HZ = 30;
/**
 * State patches go out at Colyseus' default 20 Hz (`Room.patchRate` 50 ms), on their own timer: a patch carries 1
 * or 2 ticks. Clients size their interpolation delay from this interval.
 */
export const PATCH_MS = 50;
/** Fixed step in seconds. */
export const DT = 1 / TICK_HZ;
/** Physics sub-steps per tick (60 Hz integration keeps fast collisions from tunnelling). */
export const SUBSTEPS = 2;

/** Platform radius at the start of every round. */
export const ARENA_RADIUS = 9;
/** The platform stops shrinking here. Two pucks (radius 1) barely fit, so a round cannot stall. */
export const ARENA_MIN_RADIUS = 3.2;
/** Seconds into a round before the platform starts shrinking. */
export const SHRINK_DELAY = 20;
/** Shrink speed in units per second (9 → 3.2 in ~23 s). */
export const SHRINK_RATE = 0.25;
/** A round that is still undecided after this many seconds is a draw. */
export const ROUND_TIME_LIMIT = 75;

export const PUCK_RADIUS = 1;
/** Acceleration at full stick, units/s². */
export const ACCEL = 20;
/** Linear damping ("friction"), 1/s: v *= exp(-DAMPING * dt). Terminal speed = ACCEL / DAMPING = 10 u/s. */
export const DAMPING = 2;
/** Hard cap on speed after collisions. */
export const MAX_SPEED = 16;
/** Coefficient of restitution between pucks. Slightly above 1 so hits feel punchy; damping eats the extra. */
export const RESTITUTION = 1.15;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
/** Seconds of 3-2-1 before a round. */
export const COUNTDOWN_TIME = 3;
/** Seconds the round result stays on screen. */
export const ROUND_OVER_TIME = 2.5;
/** Seconds the match result stays on screen before the next match. */
export const MATCH_OVER_TIME = 5;
/** Round wins needed to win a match. */
export const WINS_TO_MATCH = 3;
/** After this much playing time the match ends at the next round end with the leader as winner (ties play on). */
export const MATCH_TIME_LIMIT = 90;

/** Clients send at most this many input messages per second (only when the direction changes). */
export const INPUT_HZ = 20;
/** Server-side ceiling on input messages per second per client; extra messages are dropped. */
export const MAX_INPUTS_PER_SECOND = 30;
/** Stick magnitudes below this are treated as zero. */
export const INPUT_DEADZONE = 0.05;

/** Puck colors, by palette index (the server assigns the lowest free index). */
export const PALETTE = [
  '#ff5a5f', // red
  '#3fa7ff', // blue
  '#ffc23f', // yellow
  '#46d37a', // green
  '#b46bff', // purple
  '#ff8a3d', // orange
  '#2fd6d0', // teal
  '#ff6fb5', // pink
] as const;
