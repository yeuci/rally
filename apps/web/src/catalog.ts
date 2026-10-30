import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { GameManifestSchema, type GameManifest } from '@rally/protocol';
import { z } from 'zod';
import type { SiteConfig } from './config.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
export const GAMES_DIR = path.join(REPO_ROOT, 'games');

export type CatalogSource = 'local' | 'supabase';

export interface Catalog {
  source: CatalogSource;
  games: GameManifest[];
  warnings: string[];
}

export class CatalogError extends Error {
  override name = 'CatalogError';
}

function describeZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

const byTitle = (a: GameManifest, b: GameManifest) => a.title.localeCompare(b.title, 'en');

/** Every `games/<slug>/game.json` in the monorepo, validated. An invalid manifest fails the build. */
export async function loadLocalCatalog(gamesDir: string = GAMES_DIR): Promise<GameManifest[]> {
  const entries = await readdir(gamesDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const games: GameManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(gamesDir, entry.name, 'game.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new CatalogError(`${file}: invalid JSON (${(err as Error).message})`);
    }
    const parsed = GameManifestSchema.safeParse(json);
    if (!parsed.success) throw new CatalogError(`${file}: ${describeZodError(parsed.error)}`);
    if (parsed.data.id !== entry.name) {
      throw new CatalogError(`${file}: id "${parsed.data.id}" does not match its folder "${entry.name}"`);
    }
    games.push(parsed.data);
  }
  return games.sort(byTitle);
}

/** A `games` row (public read for status = 'published') with its live `game_versions` row embedded. */
export const SupabaseGameRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().default(''),
  genres: z.array(z.string()).nullable().default([]),
  screenshots: z.array(z.string()).nullable().default([]),
  icon_url: z.string().nullable().optional(),
  cover_url: z.string().nullable().optional(),
  engine: z.string(),
  orientation: z.string().nullable().default('any'),
  min_players: z.number(),
  max_players: z.number(),
  modes: z.array(z.string()).nullable().default([]),
  age_rating: z.string(),
  min_app_version: z.string().nullable().default('0.0.0'),
  featured_rank: z.number().nullable().default(null),
  current_version: z.object({ version: z.string(), manifest: z.unknown() }).nullable().optional(),
});
export type SupabaseGameRow = z.infer<typeof SupabaseGameRowSchema>;

export const GAMES_SELECT = [
  'id',
  'title',
  'description',
  'genres',
  'screenshots',
  'icon_url',
  'cover_url',
  'engine',
  'orientation',
  'min_players',
  'max_players',
  'modes',
  'age_rating',
  'min_app_version',
  'featured_rank',
  // games ↔ game_versions has two FKs; name the one behind games.current_version_id.
  'current_version:game_versions!games_current_version_fk(version,manifest)',
].join(',');

/**
 * Catalog columns win over the published manifest (the publish tool keeps them in sync, and an operator
 * may edit the row, e.g. to fix a typo, without re-publishing). The result is validated like a game.json.
 */
export function rowToManifest(row: SupabaseGameRow): GameManifest {
  const manifest = row.current_version?.manifest;
  const base =
    manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? (manifest as Record<string, unknown>) : {};
  return GameManifestSchema.parse({
    ...base,
    id: row.id,
    version: row.current_version?.version ?? base.version ?? '0.0.0',
    title: row.title,
    description: row.description ?? '',
    genres: row.genres ?? [],
    screenshots: row.screenshots ?? [],
    icon: row.icon_url ?? undefined,
    cover: row.cover_url ?? undefined,
    engine: row.engine,
    orientation: row.orientation ?? 'any',
    players: { min: row.min_players, max: row.max_players },
    modes: row.modes?.length ? row.modes : (base.modes ?? ['solo']),
    ageRating: row.age_rating,
    minAppVersion: row.min_app_version ?? '0.0.0',
  });
}

export interface SupabaseCatalogOptions {
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * Published games from Supabase with the anon key (RLS: `status = 'published'`), featured first.
 * A row that does not validate is skipped with a warning; a failed request fails the build.
 */
export async function loadSupabaseCatalog(
  url: string,
  anonKey: string,
  opts: SupabaseCatalogOptions = {},
): Promise<{ games: GameManifest[]; warnings: string[] }> {
  const sb = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
  });
  const { data, error } = await sb
    .from('games')
    .select(GAMES_SELECT)
    .eq('status', 'published')
    .order('featured_rank', { ascending: true, nullsFirst: false })
    .order('title', { ascending: true });
  if (error) throw new CatalogError(`Supabase catalog query failed: ${error.message}`);

  const warnings: string[] = [];
  const games: GameManifest[] = [];
  for (const raw of (data ?? []) as unknown[]) {
    const id = (raw as { id?: unknown } | null)?.id;
    const row = SupabaseGameRowSchema.safeParse(raw);
    if (!row.success) {
      warnings.push(`Supabase game ${String(id)}: unexpected row shape (${describeZodError(row.error)}), skipped`);
      continue;
    }
    try {
      games.push(rowToManifest(row.data));
    } catch (err) {
      const detail = err instanceof z.ZodError ? describeZodError(err) : (err as Error).message;
      warnings.push(`Supabase game ${row.data.id}: does not validate as a GameManifest (${detail}), skipped`);
    }
  }
  return { games, warnings };
}

/** Supabase when SUPABASE_URL + SUPABASE_ANON_KEY are set, else the monorepo's games/*\/game.json. */
export async function loadCatalog(
  config: Pick<SiteConfig, 'supabase'>,
  opts: SupabaseCatalogOptions & { gamesDir?: string } = {},
): Promise<Catalog> {
  if (config.supabase) {
    const { games, warnings } = await loadSupabaseCatalog(config.supabase.url, config.supabase.anonKey, opts);
    return { source: 'supabase', games, warnings };
  }
  return { source: 'local', games: await loadLocalCatalog(opts.gamesDir), warnings: [] };
}
