import { z } from 'zod';
import { Orientation } from './launch-context.ts';

export const GameEngine = z.enum(['playcanvas', 'phaser', 'custom']);
export type GameEngine = z.infer<typeof GameEngine>;

export const GameMode = z.enum(['solo', 'quick', 'browser', 'private', 'party']);
export type GameMode = z.infer<typeof GameMode>;

export const AgeRating = z.enum(['4+', '9+', '12+', '17+']);
export type AgeRating = z.infer<typeof AgeRating>;

/** Bridge capabilities a game may request; each sits behind a host kill switch (App Store 4.7.2). */
export const GameCapability = z.enum(['haptics', 'orientationLock']);
export type GameCapability = z.infer<typeof GameCapability>;

const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'expected semver');
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'expected a lowercase slug');

export const ManifestFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

/** `games/<slug>/game.json`. The publish step fills `sizeBytes` and `files`. */
export const GameManifestSchema = z.object({
  id: slug,
  version: semver,
  engine: GameEngine,
  entry: z.string().default('index.html'),
  orientation: z.union([Orientation, z.literal('any')]).default('any'),
  players: z
    .object({
      min: z.number().int().min(1),
      max: z.number().int().min(1).max(64),
    })
    .refine((p) => p.max >= p.min, 'players.max must be >= players.min'),
  modes: z.array(GameMode).min(1),
  server: z
    .object({
      room: slug,
      minVersion: z.number().int().nonnegative(),
    })
    .optional(),
  sdk: z.string().default('^1'),
  ageRating: AgeRating,
  leaderboards: z
    .array(
      z.object({
        id: z.string(),
        sort: z.enum(['asc', 'desc']),
        maxScorePerMinute: z.number().positive().optional(),
      }),
    )
    .default([]),
  achievements: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        hidden: z.boolean().default(false),
      }),
    )
    .default([]),
  capabilities: z.array(GameCapability).default([]),
  minAppVersion: semver.default('0.0.0'),
  sizeBytes: z.number().int().nonnegative().optional(),
  files: z.array(ManifestFileSchema).optional(),
});
export type GameManifest = z.infer<typeof GameManifestSchema>;
export type GameManifestInput = z.input<typeof GameManifestSchema>;
