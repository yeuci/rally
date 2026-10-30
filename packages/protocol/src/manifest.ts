import { z } from './zod.ts';
import { Orientation } from './launch-context.ts';

export const GameEngine = z.enum(['playcanvas', 'phaser', 'custom']);
export type GameEngine = z.infer<typeof GameEngine>;

export const GameMode = z.enum(['solo', 'quick', 'browser', 'private', 'party']);
export type GameMode = z.infer<typeof GameMode>;

export const AgeRating = z.enum(['4+', '9+', '12+', '17+']);
export type AgeRating = z.infer<typeof AgeRating>;

/** How often a leaderboard resets (`public.leaderboards.period`). */
export const LeaderboardPeriod = z.enum(['alltime', 'weekly', 'daily']);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriod>;

/** Bridge capabilities a game may request; each sits behind a host kill switch (App Store 4.7.2). */
export const GameCapability = z.enum(['haptics', 'orientationLock']);
export type GameCapability = z.infer<typeof GameCapability>;

const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'expected semver');
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'expected a lowercase slug');

/** File extensions accepted for game artwork (icon, cover, screenshots). */
export const ART_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;

/** Anything that starts with a URL scheme (`https:`, `javascript:`, `data:` …) is treated as a URL, not a path. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/**
 * A bundle-relative art path: `art/icon.png`, `./art/shot-1.webp`. Segments start with a letter, digit, `_` or `-`
 * (so no `..`, no hidden files, no absolute paths, no backslashes) and the file has an image extension.
 */
const LOCAL_ART_PATH =
  /^(?:\.\/)?(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i;
const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * True when an art value from game.json is a local file (relative to `games/<slug>/`) rather than an absolute URL.
 * `tooling/publish-game` uploads local files to the CDN and rewrites them to URLs, so a published manifest
 * (`game_versions.manifest`) and the `games` row only ever carry URLs.
 */
export function isLocalArtPath(value: string): boolean {
  return !URL_SCHEME.test(value);
}

/** `./art/icon.png` → `art/icon.png`. */
export function normalizeLocalArtPath(value: string): string {
  return value.replace(/^\.\//, '');
}

/**
 * One piece of game artwork: an absolute http(s) URL (https in production), or a local path inside the game folder
 * such as `art/cover.jpg` (png, jpg, jpeg or webp; no `..`).
 */
export const GameArtRef = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => (isLocalArtPath(v) ? LOCAL_ART_PATH.test(v) : httpUrl.safeParse(v).success), {
    message: `expected an absolute http(s) URL or a relative path inside the game folder ending in .${ART_EXTENSIONS.join(', .')} (e.g. "art/cover.jpg")`,
  });

export const ManifestFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

/**
 * `games/<slug>/game.json`. The publish step fills `sizeBytes` and `files`.
 *
 * `title`, `description`, `genres` and `screenshots` are catalog fields: `tooling/publish-game`
 * upserts them into the `games` table (same column names) on every publish; `icon` and `cover` go to
 * `games.icon_url` / `games.cover_url`.
 *
 * Artwork (`icon`, `cover`, `screenshots`) is either an absolute URL or a local file in the game folder
 * (`art/icon.png`); see {@link GameArtRef}. The publish step uploads local files and stores URLs.
 */
export const GameManifestSchema = z.object({
  id: slug,
  version: semver,
  /** Display name in the catalog (`games.title`). */
  title: z.string().trim().min(1).max(80),
  /** One or two sentences for the game page (`games.description`). */
  description: z.string().max(2000).default(''),
  /** Free-form lowercase tags for catalog filtering (`games.genres`), e.g. `["arcade"]`. */
  genres: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'expected a lowercase genre tag'))
    .max(8)
    .default([]),
  /** Square thumbnail for dashboard tiles (`games.icon_url`). Recommended 1024×1024. */
  icon: GameArtRef.optional(),
  /** Wide key art for the featured card and the game page hero (`games.cover_url`). Recommended 1920×1080. */
  cover: GameArtRef.optional(),
  /** Screenshots for the game page gallery (`games.screenshots`), in order. At device resolution; 3–5 is plenty. */
  screenshots: z.array(GameArtRef).max(16).default([]),
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
  /**
   * Solo leaderboards (`public.leaderboards`, synced by `tooling/publish-game` on (game, id)). `id` is the board
   * key games pass to `rally.leaderboard.submit/top`; the database requires `^[a-z][a-z0-9_-]{0,31}$`.
   */
  leaderboards: z
    .array(
      z.object({
        id: z.string(),
        /** `desc`: higher is better (points, height); `asc`: lower is better (times). */
        sort: z.enum(['asc', 'desc']),
        /** Server-side bound for `submit_solo_score`: score <= this × minutes since the play session started. */
        maxScorePerMinute: z.number().positive().optional(),
        /** How often the board resets (00:00 UTC; weekly = ISO week, Monday). Omitted = `alltime`. */
        period: LeaderboardPeriod.optional(),
      }),
    )
    .default([]),
  /** Achievements (`public.achievements`, synced by `tooling/publish-game` on (game, key)). */
  achievements: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        hidden: z.boolean().default(false),
        /** One sentence shown under the title. Omitted = empty. */
        description: z.string().max(280).optional(),
        /** An absolute http(s) image URL or a short string such as an emoji. Omitted = the default trophy. */
        icon: z.string().min(1).max(512).optional(),
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
