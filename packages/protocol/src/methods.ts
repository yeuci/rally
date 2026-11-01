import { z } from './zod.ts';
import { GameSettingValue, LaunchContextSchema, PlayerSettingsSchema } from './launch-context.ts';

const settingKey = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/, 'a camelCase key, up to 32 characters');
const settingLabel = z.string().trim().min(1).max(40);

/** One of the game's own settings, shown in the host's game menu under the platform ones. */
export const GameSettingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('toggle'), key: settingKey, label: settingLabel, default: z.boolean() }),
  z
    .object({
      type: z.literal('slider'),
      key: settingKey,
      label: settingLabel,
      min: z.number(),
      max: z.number(),
      step: z.number().positive(),
      default: z.number(),
    })
    .refine(
      (s) => s.min < s.max && s.default >= s.min && s.default <= s.max,
      'needs min < max and min ≤ default ≤ max',
    ),
  z
    .object({
      type: z.literal('choice'),
      key: settingKey,
      label: settingLabel,
      options: z
        .array(z.object({ value: z.string().min(1).max(32), label: z.string().trim().min(1).max(24) }))
        .min(2)
        .max(6),
      default: z.string(),
    })
    .refine((s) => s.options.some((o) => o.value === s.default), 'default must be one of the options'),
]);
export type GameSetting = z.infer<typeof GameSettingSchema>;

/** A "How to play" entry in the host's game menu. */
export const HelpEntrySchema = z.object({
  title: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(240),
});
export type HelpEntry = z.infer<typeof HelpEntrySchema>;

/** A player in the current match, for the menu's People list. */
export const MenuPlayerSchema = z.object({
  /** Rally user id (from the room), when known: lets the host offer profile / add friend. */
  userId: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(32),
  /** Short stat shown on the row ("12 kills", "Day 4"). */
  detail: z.string().max(24).optional(),
  you: z.boolean().optional(),
});
export type MenuPlayer = z.infer<typeof MenuPlayerSchema>;

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
  /**
   * Declare the game's own settings and "How to play" entries for the host's game menu (call once, after
   * `ready()`; calling again replaces them). Returns the current values: saved ones, else the defaults. Later
   * changes arrive as `settingsChanged`.
   */
  'menu.define': {
    params: z.object({
      settings: z
        .array(GameSettingSchema)
        .max(12)
        .refine((a) => new Set(a.map((s) => s.key)).size === a.length, 'setting keys must be unique')
        .default([]),
      help: z.array(HelpEntrySchema).max(8).default([]),
    }),
    result: z.object({ values: z.record(z.string(), GameSettingValue) }),
  },
  /** Open the host's game menu (the SDK sends it when Escape is pressed on a keyboard). */
  'menu.open': {
    params: z.object({}),
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
  /**
   * The host's game menu opened or closed. While open, release held input (sticks, fire) and ignore new input;
   * a solo game may pause. A multiplayer match keeps running underneath, like any phone notification.
   */
  menu: z.object({ open: z.boolean() }),
  /** The player changed a setting in the game menu: the full, current settings. Apply them live. */
  settingsChanged: PlayerSettingsSchema,
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
  /**
   * The game's connection to its server, for the host's ping bars (game menu) and its standard "Reconnecting…" /
   * "Connection lost" banner over the game. Send on every state change, and about every 2 s with the latest
   * round-trip time while connected.
   */
  'net.status': z.object({
    state: z.enum(['connected', 'reconnecting', 'disconnected']),
    rttMs: z.number().nonnegative().max(60_000).optional(),
  }),
  /** Who is in the match now, for the game menu's People list. Send on join and when it changes. */
  'menu.players': z.object({ players: z.array(MenuPlayerSchema).max(16) }),
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
