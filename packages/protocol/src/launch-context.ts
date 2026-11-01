import { z } from './zod.ts';

export const LaunchIntent = z.enum(['solo', 'quick', 'joinById', 'private', 'party']);
export type LaunchIntent = z.infer<typeof LaunchIntent>;

export const Orientation = z.enum(['portrait', 'landscape']);
export type Orientation = z.infer<typeof Orientation>;

export const SafeAreaSchema = z.object({
  top: z.number().nonnegative(),
  right: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
  left: z.number().nonnegative(),
});
export type SafeArea = z.infer<typeof SafeAreaSchema>;

/** A rectangle in CSS pixels of the game's page (origin top-left). */
export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type Rect = z.infer<typeof RectSchema>;

/** How much the game should draw: the host resolves the player's "Auto" from the device. */
export const GraphicsQuality = z.enum(['low', 'medium', 'high']);
export type GraphicsQuality = z.infer<typeof GraphicsQuality>;

/** A value of one of the game's own settings (see `menu.define`). */
export const GameSettingValue = z.union([z.boolean(), z.number(), z.string()]);
export type GameSettingValue = z.infer<typeof GameSettingValue>;

/**
 * The player's settings from the host's game menu, in the launch context and in every `settingsChanged` event.
 * Volumes are 0..1 each; a sound plays at master × music (or master × effects). Apply them live.
 */
export const PlayerSettingsSchema = z.object({
  volume: z.object({
    master: z.number().min(0).max(1),
    music: z.number().min(0).max(1),
    effects: z.number().min(0).max(1),
  }),
  graphics: GraphicsQuality,
  /** Off: the game should not call `haptics()` (the host also drops them). */
  haptics: z.boolean(),
  /**
   * Touch controls, honoured by every game with on-screen sticks: swap the sides (left-handed), scale and opacity of
   * the sticks, and aim assist for games that aim.
   */
  controls: z.object({
    swapSticks: z.boolean(),
    stickSize: z.number().min(0.75).max(1.5),
    stickOpacity: z.number().min(0.2).max(1),
    aimAssist: z.boolean(),
  }),
  /** The game's own settings (declared with `menu.define`), by key: saved values, else the declared defaults. */
  game: z.record(z.string(), GameSettingValue),
});
export type PlayerSettings = z.infer<typeof PlayerSettingsSchema>;

/** What the host hands the game in reply to `ready()`. */
export const LaunchContextSchema = z.object({
  game: z.object({
    id: z.string(),
    version: z.string(),
  }),
  user: z.object({
    id: z.string(),
    username: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  intent: LaunchIntent,
  party: z
    .object({
      id: z.string(),
      leaderId: z.string(),
      memberIds: z.array(z.string()),
    })
    .optional(),
  resume: z
    .object({
      reconnectionToken: z.string(),
    })
    .optional(),
  device: z.object({
    safeArea: SafeAreaSchema,
    orientation: Orientation,
    pixelRatio: z.number().positive(),
    locale: z.string(),
    /**
     * Where the host draws its game-menu button over the page (top-left, inside the safe area). Keep HUD out of
     * it. Absent on hosts without the menu.
     */
    menuButton: RectSchema.optional(),
  }),
  /** The player's settings (absent on hosts without the game menu: use your defaults). */
  settings: PlayerSettingsSchema.optional(),
});
export type LaunchContext = z.infer<typeof LaunchContextSchema>;
