/**
 * Pure parts of the Browse screen (`app/(app)/browse.tsx`): its route params, the genre chips, the sort orders and the
 * grid geometry. No React Native imports; test/browse.test.ts runs it under plain Node. Like lib/layout.ts, every size
 * is computed from the live window on each render and never cached.
 */
import type { GameCard } from './catalog';
import { genreKey, genreLabel, type LiveCount } from './dashboard';
import { ROW_GAP, gridTileWidth, rowTileWidth } from './layout';
import { searchGames } from './search';

// --- params ---------------------------------------------------------------------------------------------------------

export const BROWSE_SORTS = ['popular', 'new', 'az'] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];
export const DEFAULT_BROWSE_SORT: BrowseSort = 'popular';

/** The Segmented control's options, in order. */
export const BROWSE_SORT_OPTIONS: readonly { value: BrowseSort; label: string }[] = [
  { value: 'popular', label: 'Popular' },
  { value: 'new', label: 'New' },
  { value: 'az', label: 'A–Z' },
];

/** Longest `?q=` kept (a pasted paragraph is not a search). */
export const BROWSE_QUERY_MAX = 80;

export type BrowseParams = {
  /** `genreKey` of the selected genre; null = All. */
  genre: string | null;
  sort: BrowseSort;
  /** Text filter carried over from search's "See all" (`searchGames`); null = none. */
  q: string | null;
};

type RawParam = string | string[] | undefined;

function first(value: RawParam): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/**
 * Route params → what the screen shows. Anything missing or unknown falls back to the default (All, Popular, no
 * query) instead of failing: a stale deep link still lands on a working page. The genre is normalised like the
 * catalog's (`genreKey`), so `?genre=Puzzle` and `?genre=puzzle` select the same chip.
 */
export function parseBrowseParams(params: { genre?: RawParam; sort?: RawParam; q?: RawParam }): BrowseParams {
  const genre = genreKey(first(params.genre));
  const sort = first(params.sort).trim().toLowerCase();
  const q = first(params.q).trim().slice(0, BROWSE_QUERY_MAX).trim();
  return {
    genre: genre || null,
    sort: (BROWSE_SORTS as readonly string[]).includes(sort) ? (sort as BrowseSort) : DEFAULT_BROWSE_SORT,
    q: q || null,
  };
}

/**
 * Params for `router.push` / `router.setParams`. Defaults are `undefined`, so `setParams` removes them from the URL
 * and a pushed link stays short (`/browse?genre=puzzle`, not `/browse?genre=puzzle&sort=popular`).
 */
export function browseParams(p: Partial<BrowseParams>): { genre: string | undefined; sort: BrowseSort | undefined; q: string | undefined } {
  const parsed = parseBrowseParams({ genre: p.genre ?? undefined, sort: p.sort, q: p.q ?? undefined });
  return {
    genre: parsed.genre ?? undefined,
    sort: parsed.sort === DEFAULT_BROWSE_SORT ? undefined : parsed.sort,
    q: parsed.q ?? undefined,
  };
}

/** Header title: "Browse", or the selected genre title-cased ("tower-defense" → "Tower Defense"). */
export function browseTitle(genre: string | null): string {
  if (!genre) return 'Browse';
  return genreLabel(genre)
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// --- genre chips ----------------------------------------------------------------------------------------------------

export type GenreChip = { key: string | null; label: string; count: number };

/**
 * The chip row: "All" first, then every genre present in the catalog, the most populated first, then by name (the
 * dashboard's genre-row order). A game counts once per genre whatever the spelling. A selected genre the catalog does
 * not have (a stale deep link) is appended with a count of 0, so the selection is still visible next to its empty
 * state. Labels follow the first spelling seen (`genreLabel`).
 */
export function genreChips(games: readonly Pick<GameCard, 'genres'>[], selected: string | null = null): GenreChip[] {
  const byKey = new Map<string, GenreChip>();
  for (const game of games) {
    const seen = new Set<string>();
    for (const raw of game.genres) {
      const key = genreKey(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const chip = byKey.get(key);
      if (chip) chip.count += 1;
      else byKey.set(key, { key, label: genreLabel(raw), count: 1 });
    }
  }
  const chips = [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const out: GenreChip[] = [{ key: null, label: 'All', count: games.length }, ...chips];
  const sel = selected ? genreKey(selected) : '';
  if (sel && !byKey.has(sel)) out.push({ key: sel, label: genreLabel(sel), count: 0 });
  return out;
}

// --- filtering and sorting ------------------------------------------------------------------------------------------

type Sortable = Pick<GameCard, 'id' | 'title' | 'genres' | 'featured_rank' | 'created_at' | 'max_players'>;

/** Games in `genre` (any spelling); all of them for null. */
export function filterByGenre<T extends Pick<GameCard, 'genres'>>(games: readonly T[], genre: string | null): T[] {
  if (!genre) return [...games];
  const key = genreKey(genre);
  return games.filter((g) => g.genres.some((raw) => genreKey(raw) === key));
}

const byTitle = (a: Sortable, b: Sortable) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

const newestFirst = (a: Sortable, b: Sortable) => {
  const time = (s: string) => {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  };
  return time(b.created_at) - time(a.created_at);
};

/** A–Z: by title, ignoring case and accents; the id breaks ties so the order is stable. */
export function compareAz(a: Sortable, b: Sortable): number {
  return byTitle(a, b);
}

/**
 * New: the most recently published first (the catalog has no separate `published_at`; `created_at` is what
 * "New on Rally" orders by too), then A–Z.
 */
export function compareNew(a: Sortable, b: Sortable): number {
  return newestFirst(a, b) || byTitle(a, b);
}

/**
 * Popular: players in live rooms right now (multiplayer games, `game_live_counts`), then the editors' featured rank
 * (1 first; unranked after every ranked game), then the newest, then A–Z. The catalog exposes no global play
 * counts to the client, so live players are the only usage signal.
 */
export function comparePopular(counts: ReadonlyMap<string, LiveCount> | undefined) {
  const live = (g: Sortable) => (g.max_players > 1 ? (counts?.get(g.id)?.players ?? 0) : 0);
  return (a: Sortable, b: Sortable): number => {
    const players = live(b) - live(a);
    if (players) return players;
    const ra = a.featured_rank ?? Number.POSITIVE_INFINITY;
    const rb = b.featured_rank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return newestFirst(a, b) || byTitle(a, b);
  };
}

/** A sorted copy of `games` (the input is left alone: it is React Query's cached array). */
export function sortGames<T extends Sortable>(
  games: readonly T[],
  sort: BrowseSort,
  counts?: ReadonlyMap<string, LiveCount>,
): T[] {
  const compare = sort === 'az' ? compareAz : sort === 'new' ? compareNew : comparePopular(counts);
  return [...games].sort(compare);
}

/** What the grid shows: the genre, then the carried-over query (`searchGames`), then the sort. */
export function browseGames<T extends Sortable>(
  games: readonly T[],
  params: BrowseParams,
  counts?: ReadonlyMap<string, LiveCount>,
): T[] {
  const inGenre = filterByGenre(games, params.genre);
  const matching = params.q ? searchGames(inGenre, params.q) : inGenre;
  return sortGames(matching, params.sort, counts);
}

// --- grid -----------------------------------------------------------------------------------------------------------

/** Columns in a narrow (portrait phone) window, and the range for wide (landscape / tablet) ones. */
export const BROWSE_COLUMNS = { narrow: 2, wideMin: 3, wideMax: 4 } as const;

/**
 * Grid columns: 2 on a portrait phone; in a wide window as many tiles of the dashboard rows' width (`rowTileWidth`)
 * as fit the content width, kept between 3 and 4, so a grid tile is about the size of a row tile.
 */
export function browseColumns(width: number, pad: { left: number; right: number }, wide: boolean): number {
  if (!wide) return BROWSE_COLUMNS.narrow;
  const contentW = Math.max(0, width - pad.left - pad.right);
  const tile = rowTileWidth(width, pad.left, true);
  const fit = Math.floor((contentW + ROW_GAP) / (tile + ROW_GAP));
  return Math.max(BROWSE_COLUMNS.wideMin, Math.min(BROWSE_COLUMNS.wideMax, fit));
}

/** Grid geometry for the window: columns and the square tile width that fills the content width. */
export function browseGrid(width: number, pad: { left: number; right: number }, wide: boolean): { columns: number; tileWidth: number } {
  const columns = browseColumns(width, pad, wide);
  const contentW = Math.max(0, width - pad.left - pad.right);
  return { columns, tileWidth: gridTileWidth(contentW, columns) };
}
