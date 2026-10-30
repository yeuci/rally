import mime from 'mime';
import {
  GameManifestSchema,
  isLocalArtPath,
  normalizeLocalArtPath,
  type GameManifest,
  type LeaderboardPeriod,
  type ManifestFile,
} from '@rally/protocol';
import type { PlannedArtUpload } from './art.ts';
import { cacheControlFor } from './cache.ts';

/** Supabase Storage bucket holding every game bundle (packages/db migration `20261029000000_m1_init.sql`). */
export const BUCKET = 'games';

/** `public.games` columns the publish step owns. `status`, `featured_rank` and `current_version_id` are never upserted. */
export interface GamesRow {
  id: string;
  title: string;
  description: string;
  genres: string[];
  /** CDN URLs (local game.json paths are uploaded and rewritten first). */
  screenshots: string[];
  /** null clears an icon / cover that was removed from game.json. */
  icon_url: string | null;
  cover_url: string | null;
  engine: GameManifest['engine'];
  orientation: GameManifest['orientation'];
  min_players: number;
  max_players: number;
  modes: GameManifest['modes'];
  age_rating: GameManifest['ageRating'];
  min_app_version: string;
}

/** `public.game_versions` insert. */
export interface GameVersionRow {
  game_id: string;
  version: string;
  entry_url: string;
  manifest: GameManifest;
  sha256: string;
  size_bytes: number;
}

/**
 * `public.leaderboards` upsert on `(game_id, key)` (packages/db `20261030000100_m2_leaderboards.sql`). `id` and
 * `created_at` are never sent, so an existing board keeps both (the oldest board is the game's primary board).
 */
export interface LeaderboardRow {
  game_id: string;
  key: string;
  sort: 'asc' | 'desc';
  period: LeaderboardPeriod;
  /** null clears a bound that was removed from game.json. */
  max_score_per_minute: number | null;
}

/** `public.achievements` upsert on `(game_id, key)`. */
export interface AchievementRow {
  game_id: string;
  key: string;
  title: string;
  description: string;
  icon: string | null;
  hidden: boolean;
}

export interface PlannedUpload {
  /** Path inside the bundle (and inside `dist/`). */
  path: string;
  /** Object key inside the bucket: `<slug>/<version>/<path>`. */
  objectKey: string;
  size: number;
  sha256: string;
  headers: { 'content-type': string; 'cache-control': string };
}

export interface PublishPlan {
  slug: string;
  version: string;
  bucket: string;
  prefix: string;
  supabaseUrl: string;
  entryUrl: string;
  csp: string;
  sizeBytes: number;
  entrySha256: string;
  /** Overwrite an existing `<slug>/<version>/` (normally refused: a published version is immutable). */
  force: boolean;
  uploads: PlannedUpload[];
  /**
   * Local art files from game.json (read from the game folder, not dist/), uploaded content-addressed under
   * `<slug>/art/` with upsert (skipped when the object already exists). Their URLs replace the paths in `db`.
   */
  art: PlannedArtUpload[];
  db: {
    /** Upserted on `id`; a new row gets the column default `status = 'draft'`. */
    games: GamesRow;
    /** Inserted (`--force`: upserted on `(game_id, version)`). */
    gameVersion: GameVersionRow;
    /**
     * Upserted on `(game_id, key)` one at a time in manifest order, so on a first publish the first board is the
     * oldest (primary) one. Never deleted: boards missing from game.json only produce a warning.
     */
    leaderboards: LeaderboardRow[];
    /** Upserted on `(game_id, key)`. Never deleted: achievements missing from game.json only produce a warning. */
    achievements: AchievementRow[];
    /** Flip `games.current_version_id` to the new version. */
    activate: boolean;
    /** Also set `games.status = 'published'`. */
    publish: boolean;
  };
}

/** Public CDN URL of an object in a public bucket; same shape as supabase-js `getPublicUrl`. */
export function publicObjectUrl(supabaseUrl: string, bucket: string, objectKey: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

/** Content-Type for a bundle path; text types carry a charset so WebViews never sniff. */
export function contentTypeFor(relPath: string): string {
  const type = mime.getType(relPath) ?? 'application/octet-stream';
  return /^text\/|^application\/(javascript|json|manifest\+json|xml)$|\+xml$/.test(type)
    ? `${type}; charset=utf-8`
    : type;
}

export function gamesRowFromManifest(m: GameManifest): GamesRow {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    genres: m.genres,
    screenshots: m.screenshots,
    icon_url: m.icon ?? null,
    cover_url: m.cover ?? null,
    engine: m.engine,
    orientation: m.orientation,
    min_players: m.players.min,
    max_players: m.players.max,
    modes: m.modes,
    age_rating: m.ageRating,
    min_app_version: m.minAppVersion,
  };
}

/**
 * The manifest with every local art path replaced by the URL of its planned upload. Throws if a local path has no
 * upload (call {@link planArt} first), so a published manifest never carries a path the app cannot load.
 */
export function applyArtUrls(m: GameManifest, uploads: readonly PlannedArtUpload[]): GameManifest {
  const urls = new Map(uploads.map((u) => [u.source, u.url]));
  const resolve = (field: string, value: string): string => {
    if (!isLocalArtPath(value)) return value;
    const url = urls.get(normalizeLocalArtPath(value));
    if (!url) throw new Error(`${field}: local art path "${value}" has no planned upload (run planArt first)`);
    return url;
  };
  return {
    ...m,
    ...(m.icon !== undefined && { icon: resolve('icon', m.icon) }),
    ...(m.cover !== undefined && { cover: resolve('cover', m.cover) }),
    screenshots: m.screenshots.map((s, i) => resolve(`screenshots[${i}]`, s)),
  };
}

export function leaderboardRowsFromManifest(m: GameManifest): LeaderboardRow[] {
  return m.leaderboards.map((b) => ({
    game_id: m.id,
    key: b.id,
    sort: b.sort,
    period: b.period ?? 'alltime',
    max_score_per_minute: b.maxScorePerMinute ?? null,
  }));
}

export function achievementRowsFromManifest(m: GameManifest): AchievementRow[] {
  return m.achievements.map((a) => ({
    game_id: m.id,
    key: a.key,
    title: a.title,
    description: a.description ?? '',
    icon: a.icon ?? null,
    hidden: a.hidden,
  }));
}

export function buildPlan(input: {
  manifest: GameManifest;
  files: ManifestFile[];
  supabaseUrl: string;
  csp: string;
  /** From `planArt`; required when game.json has local art paths. */
  art?: PlannedArtUpload[];
  force?: boolean;
  activate?: boolean;
  publish?: boolean;
}): PublishPlan {
  const { files } = input;
  const art = input.art ?? [];
  // Local art paths → CDN URLs, so the games row and the stored manifest only ever carry URLs.
  const manifest = applyArtUrls(input.manifest, art);
  const entry = files.find((f) => f.path === manifest.entry);
  if (!entry) throw new Error(`entry document ${manifest.entry} is not in the build output`);
  const prefix = `${manifest.id}/${manifest.version}/`;
  const sizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  // Re-validate so the jsonb stored in game_versions always matches GameManifestSchema.
  const published = GameManifestSchema.parse({ ...manifest, sizeBytes, files });

  return {
    slug: manifest.id,
    version: manifest.version,
    bucket: BUCKET,
    prefix,
    supabaseUrl: input.supabaseUrl,
    entryUrl: publicObjectUrl(input.supabaseUrl, BUCKET, prefix + manifest.entry),
    csp: input.csp,
    sizeBytes,
    entrySha256: entry.sha256,
    force: input.force ?? false,
    uploads: files.map((f) => ({
      path: f.path,
      objectKey: prefix + f.path,
      size: f.size,
      sha256: f.sha256,
      headers: { 'content-type': contentTypeFor(f.path), 'cache-control': cacheControlFor(f.path, manifest.entry) },
    })),
    art,
    db: {
      games: gamesRowFromManifest(published),
      gameVersion: {
        game_id: manifest.id,
        version: manifest.version,
        entry_url: publicObjectUrl(input.supabaseUrl, BUCKET, prefix + manifest.entry),
        manifest: published,
        sha256: entry.sha256,
        size_bytes: sizeBytes,
      },
      leaderboards: leaderboardRowsFromManifest(manifest),
      achievements: achievementRowsFromManifest(manifest),
      activate: input.activate ?? true,
      publish: input.publish ?? false,
    },
  };
}
