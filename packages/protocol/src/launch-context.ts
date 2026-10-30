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
  }),
});
export type LaunchContext = z.infer<typeof LaunchContextSchema>;
