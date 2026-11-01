/**
 * Technical constants of Northdale (the simulation rate, the wire, input limits). Everything a designer tunes (the
 * day/night cycle, the night-strength curve, zombies, weapons, loot, the truck) lives in tuning.ts. Units are world
 * units (a survivor is ≈ 1.6 tall, 0.8 wide); time is in seconds. Simulation axes: x right (east), y down the screen
 * (south, towards the camera).
 */

/** Server simulation rate (fixed timestep). The synced `tick` counts these steps: server time = tick × DT. */
export const TICK_HZ = 30;
/** State patches go out at Colyseus' default 20 Hz on their own timer: a patch carries 1 or 2 ticks. */
export const PATCH_MS = 50;
/** Fixed step in seconds. */
export const DT = 1 / TICK_HZ;

// --- input -------------------------------------------------------------------------------------------------------
/** Clients send at most this many input messages per second (only when something changed). */
export const INPUT_HZ = 20;
/** Server-side ceiling on input messages per second per client; extra messages are dropped. */
export const MAX_INPUTS_PER_SECOND = 30;
/** Move-stick magnitudes below this are treated as zero. */
export const INPUT_DEADZONE = 0.08;

// --- lag compensation --------------------------------------------------------------------------------------------
/** Shots and swings test zombies at most this far back (ms) to where the shooter saw them. */
export const MAX_REWIND_MS = 300;
/** Positions kept per zombie (ticks): more than the rewind limit. */
export const HISTORY_TICKS = 12;

// --- the wire ------------------------------------------------------------------------------------------------------
/** Synced position range (16-bit quantized on the wire: ≈ 0.005 u steps over the whole town and the highway). */
export const POS_LIMIT = 192;
/** Synced velocity range. */
export const VEL_LIMIT = 12;
/** Zombies further than this from every player are not synced (nobody can see them; they still live on the server). */
export const SYNC_RADIUS = 44;
