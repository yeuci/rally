import { z } from './zod.ts';
import { LaunchContextSchema } from './launch-context.ts';

/**
 * Game → host requests. Each entry declares its params and result schema.
 * The host validates params before dispatch; the SDK validates results.
 */
export const RequestSchemas = {
  /** Handshake. Host replies with the launch context and hides its loading overlay. */
  ready: {
    params: z.object({ sdkVersion: z.string() }),
    result: LaunchContextSchema,
  },
  /** Bridge round-trip probe; `t` is echoed back with the host's clock. */
  ping: {
    params: z.object({ t: z.number() }),
    result: z.object({ t: z.number(), hostTime: z.number() }),
  },
  /**
   * Ask the host to matchmake and hand back the seat reservation. The reservation is
   * opaque: pass it straight to `client.consumeSeatReservation()`.
   */
  'session.join': {
    params: z.object({}).optional(),
    result: z.object({
      endpoint: z.string().url(),
      seatReservation: z.record(z.string(), z.unknown()),
    }),
  },
  /** Game reports its reconnection token so the host can offer "Rejoin match?" after a cold start. */
  'session.reportReconnection': {
    params: z.object({
      roomId: z.string(),
      token: z.string(),
      ttlSec: z.number().int().positive(),
    }),
    result: z.null(),
  },
  'save.get': {
    params: z.object({ slot: z.string().min(1).max(32) }),
    result: z.object({
      data: z.unknown().nullable(),
      version: z.number().int().nonnegative(),
    }),
  },
  'save.put': {
    params: z.object({
      slot: z.string().min(1).max(32),
      data: z.unknown(),
      ifVersion: z.number().int().nonnegative().optional(),
    }),
    result: z.object({ version: z.number().int().nonnegative() }),
  },
  'leaderboard.top': {
    params: z.object({
      boardId: z.string(),
      scope: z.enum(['global', 'friends']).default('global'),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    result: z.object({
      entries: z.array(
        z.object({
          rank: z.number().int().positive(),
          userId: z.string(),
          username: z.string(),
          score: z.number(),
        }),
      ),
    }),
  },
  'leaderboard.submit': {
    params: z.object({ boardId: z.string(), score: z.number().finite() }),
    result: z.object({ accepted: z.boolean(), best: z.number().nullable() }),
  },
  'achievement.unlock': {
    params: z.object({ key: z.string() }),
    result: z.object({ unlocked: z.boolean(), alreadyHad: z.boolean() }),
  },
  'invite.open': {
    params: z.object({}).optional(),
    result: z.null(),
  },
  'party.get': {
    params: z.object({}).optional(),
    result: z
      .object({
        id: z.string(),
        leaderId: z.string(),
        memberIds: z.array(z.string()),
      })
      .nullable(),
  },
  exit: {
    params: z.object({ reason: z.string().max(64).optional() }).optional(),
    result: z.null(),
  },
  'ui.loading': {
    /**
     * Boot progress for the host's loading screen. `label` says, in a few plain words, what is loading right now
     * ("Downloading characters", "Building the kitchen", "Connecting to the server"); the host shows it under the bar.
     * A game that sends labels keeps the host's loading screen up after `ready()` until it sends `progress: 1`
     * (playable: models loaded AND the match joined), so the whole boot is one screen; one that never does is
     * revealed at `ready()` as before.
     */
    params: z.object({ progress: z.number().min(0).max(1), label: z.string().trim().min(1).max(60).optional() }),
    result: z.null(),
  },
  haptics: {
    params: z.object({ kind: z.enum(['light', 'medium', 'heavy', 'success', 'warning', 'error']) }),
    result: z.null(),
  },
  'orientation.lock': {
    params: z.object({ mode: z.enum(['portrait', 'landscape', 'any']) }),
    result: z.null(),
  },
} as const;

export type RequestMethod = keyof typeof RequestSchemas;
export type RequestParams<M extends RequestMethod> = z.input<(typeof RequestSchemas)[M]['params']>;
export type RequestResult<M extends RequestMethod> = z.output<(typeof RequestSchemas)[M]['result']>;

export const requestMethods = Object.keys(RequestSchemas) as RequestMethod[];
export function isRequestMethod(method: string): method is RequestMethod {
  return Object.prototype.hasOwnProperty.call(RequestSchemas, method);
}

/** Host → game events. */
export const HostEventSchemas = {
  pause: z.object({}),
  resume: z.object({}),
  /** Back button / close tapped. The game should leave its room, then call `exit()`. */
  exitRequested: z.object({}),
  partyUpdated: z.object({
    id: z.string(),
    leaderId: z.string(),
    memberIds: z.array(z.string()),
  }),
  lowMemory: z.object({}),
} as const;
export type HostEvent = keyof typeof HostEventSchemas;
export type HostEventPayload<E extends HostEvent> = z.output<(typeof HostEventSchemas)[E]>;
export function isHostEvent(method: string): method is HostEvent {
  return Object.prototype.hasOwnProperty.call(HostEventSchemas, method);
}

/** Game → host events (fire-and-forget). */
export const GameEventSchemas = {
  /** Free-form numeric metrics; the host logs/forwards them (spike measurements, fps reports). */
  'telemetry.report': z.object({
    name: z.string().max(64),
    values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  }),
  /** Non-fatal error inside the game bundle. */
  'game.error': z.object({
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
  }),
} as const;
export type GameEvent = keyof typeof GameEventSchemas;
export type GameEventPayload<E extends GameEvent> = z.input<(typeof GameEventSchemas)[E]>;
export function isGameEvent(method: string): method is GameEvent {
  return Object.prototype.hasOwnProperty.call(GameEventSchemas, method);
}
