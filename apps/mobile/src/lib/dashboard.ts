/**
 * Pure parts of the dashboard: hero and category-card geometry, genre rows from the catalog, the hero's auto-advance
 * rules. No React Native imports (test/dashboard.test.ts runs it under plain Node). Like lib/layout.ts, every size is
 * computed from the live window on each render and never cached.
 */
import type { GameCard } from './catalog';
import { coverUriFor } from './game-art';
import { ROW_GAP, type Size } from './layout';

/** Featured hero, full bleed from the top of the window. Narrow: a tall cover (≈ 10:13) capped at 66 % of the
 * window; wide: 16:7, capped at 78 % of the window height so the first row still peeks below it on a phone. */
export function dashboardHeroHeight({ width, height }: Size, wide: boolean): number {
  if (wide) return Math.round(Math.min((width * 7) / 16, height * 0.78));
  return Math.round(Math.min(width * 1.3, height * 0.66));
}

/** Category cards visible across the "Browse by category" row (the last one peeks). */
export const CATEGORY_CARDS_VISIBLE = { narrow: 1.55, wide: 3.3 } as const;
const CATEGORY_CARD_MIN = 168;
const CATEGORY_CARD_MAX = 320;

/** Wide category card width: the row starts at `padLeft` and bleeds off the right edge, like the tile rows. */
export function categoryCardWidth(width: number, padLeft: number, wide: boolean): number {
  const visible = wide ? CATEGORY_CARDS_VISIBLE.wide : CATEGORY_CARDS_VISIBLE.narrow;
  const card = Math.floor((width - padLeft - Math.floor(visible) * ROW_GAP) / visible);
  return Math.max(CATEGORY_CARD_MIN, Math.min(card, CATEGORY_CARD_MAX));
}

/** Category cards are 2:1. */
export function categoryCardHeight(cardWidth: number): number {
  return Math.round(cardWidth / 2);
}

/** Genre rows shown on the dashboard (the most populated first); every genre still has a card in "Browse by category". */
export const GENRE_ROWS_MAX = 10;
/** Tiles per genre row; Browse (`/browse?genre=`) lists them all. */
export const GENRE_ROW_GAMES_MAX = 20;

/** Stable key of a genre as stored in `games.genres` (case and padding ignored). */
export function genreKey(genre: string): string {
  return genre.trim().toLowerCase();
}

/** "puzzle" → "Puzzle", "tower-defense" → "Tower defense". */
export function genreLabel(genre: string): string {
  const words = genre.trim().replace(/[-_\s]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type GenreGroup<T> = { key: string; label: string; games: T[] };

type Sortable = Pick<GameCard, 'id' | 'genres' | 'featured_rank' | 'created_at' | 'title'>;

/**
 * The catalog grouped by genre, one group per genre present: biggest first, then by name. A game sits in every genre
 * it lists (once, whatever the spelling). Inside a group: featured games in rank order, then the newest.
 */
export function groupByGenre<T extends Sortable>(games: readonly T[]): GenreGroup<T>[] {
  const groups = new Map<string, GenreGroup<T>>();
  for (const game of games) {
    const seen = new Set<string>();
    for (const raw of game.genres) {
      const key = genreKey(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let group = groups.get(key);
      if (!group) {
        group = { key, label: genreLabel(raw), games: [] };
        groups.set(key, group);
      }
      group.games.push(game);
    }
  }
  const list = [...groups.values()];
  for (const g of list) g.games.sort(byFeaturedThenNewest);
  return list.sort((a, b) => b.games.length - a.games.length || a.label.localeCompare(b.label));
}

function byFeaturedThenNewest(a: Sortable, b: Sortable): number {
  const ra = a.featured_rank ?? Number.POSITIVE_INFINITY;
  const rb = b.featured_rank ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  const time = Date.parse(b.created_at) - Date.parse(a.created_at);
  return time || a.title.localeCompare(b.title);
}

/**
 * The game whose art stands for each category card: one with uploaded cover art (`coverUriFor(…, 'feature')`) that no
 * earlier card uses, else any game with art, else the first game not used yet, else the first game (generated art).
 * Earlier (bigger) categories pick first, so neighbouring cards rarely repeat a cover.
 */
export function categoryCoverGames<T extends GameCard>(groups: readonly GenreGroup<T>[]): Map<string, T> {
  const used = new Set<string>();
  const out = new Map<string, T>();
  for (const group of groups) {
    const withArt = group.games.filter((g) => coverUriFor(g, 'feature'));
    const pick =
      withArt.find((g) => !used.has(g.id)) ?? withArt[0] ?? group.games.find((g) => !used.has(g.id)) ?? group.games[0];
    if (!pick) continue;
    used.add(pick.id);
    out.set(group.key, pick);
  }
  return out;
}

/** "1 game", "12 games". */
export function gamesCountLabel(n: number): string {
  return n === 1 ? '1 game' : `${n} games`;
}

/** Time a hero page stays before the next one slides in. */
export const HERO_AUTO_ADVANCE_MS = 6000;

/** How long the pager's slide to the next page takes (the native animated scroll), for the silent jump after it. */
export const HERO_SLIDE_MS = 450;

/**
 * The pager's items: with several pages, a copy of the last page before the first and a copy of the first after the
 * last. Advancing past either end slides into the copy, which looks like the real page, and the pager then jumps
 * without animation to the real one (`heroLanding`); so the auto-advance never rewinds across every page to get from
 * the last back to the first, and a swipe past the end carries on round.
 */
export function heroLoop<T>(pages: readonly T[]): T[] {
  return pages.length > 1 ? [pages[pages.length - 1]!, ...pages, pages[0]!] : [...pages];
}

/** The pager index of a real page (the copies shift everything by one when there are several pages). */
export function heroLoopIndex(page: number, count: number): number {
  return count > 1 ? page + 1 : 0;
}

/**
 * Where a scroll landed: the real page it shows and, when it stopped on a copy, the pager index to jump to (the
 * matching real page) without animation.
 */
export function heroLanding(index: number, count: number): { page: number; jumpTo: number | null } {
  if (count <= 1) return { page: 0, jumpTo: null };
  if (index <= 0) return { page: count - 1, jumpTo: count };
  if (index >= count + 1) return { page: 0, jumpTo: 1 };
  return { page: index - 1, jumpTo: null };
}

/** Next hero page, wrapping to the first. */
export function nextHeroPage(page: number, count: number): number {
  if (count <= 1) return 0;
  return (Math.max(0, page) + 1) % count;
}

/**
 * Whether the hero should advance on its own right now: only with several pages, never under reduced motion or a
 * screen reader (content moving under the focus), while a finger is on it, while the dashboard is not the focused
 * screen, or while the drawer is open.
 */
export function heroAutoAdvances(s: {
  count: number;
  reducedMotion: boolean;
  screenReader: boolean;
  touching: boolean;
  focused: boolean;
  drawerOpen: boolean;
}): boolean {
  return s.count > 1 && !s.reducedMotion && !s.screenReader && !s.touching && s.focused && !s.drawerOpen;
}

// --- live counts (m3-phase2 §2 "Catalog") ---------------------------------------------------------------------------

/** How often the dashboard refreshes `game_live_counts` while it is in front. */
export const LIVE_COUNTS_REFRESH_MS = 30_000;

/** Players in live rooms (private ones included) and live public rooms, for one multiplayer game. */
export interface LiveCount {
  players: number;
  rooms: number;
}

/** `game_live_counts` rows → counts by game id (games without a live room are absent; bad numbers read as 0). */
export function toLiveCounts(
  rows: readonly { game_id: string | null; players: number | string | null; rooms: number | string | null }[] | null,
): Map<string, LiveCount> {
  const count = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const out = new Map<string, LiveCount>();
  for (const r of rows ?? []) {
    if (!r.game_id) continue;
    out.set(r.game_id, { players: count(r.players), rooms: count(r.rooms) });
  }
  return out;
}

/**
 * "12 playing" for a multiplayer game with players in live rooms ("1.2k playing" from a thousand); null otherwise
 * (solo games, nobody playing), so the tile keeps its usual line. `locale` is injectable for tests.
 */
export function liveCountLabel(
  game: { id: string; max_players: number },
  counts: ReadonlyMap<string, LiveCount> | undefined,
  locale?: string,
): string | null {
  if (game.max_players <= 1) return null;
  const players = counts?.get(game.id)?.players ?? 0;
  if (players <= 0) return null;
  const n = players < 1000 ? String(players) : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(players);
  return `${n} playing`;
}

// --- visits (`games.visits`, `game_visits_daily`) -------------------------------------------------------------------

/** Days `useVisitsDaily` reads, today (UTC) included. */
export const VISITS_DAILY_DAYS = 7;

/** One UTC day of visits: `day` is `YYYY-MM-DD`. */
export interface VisitsDay {
  day: string;
  visits: number;
}

const DAY_MS = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The `day` bounds (inclusive, `YYYY-MM-DD`, UTC) of the last `days` days ending today. */
export function visitsDailyRange(now: number = Date.now(), days: number = VISITS_DAILY_DAYS): { from: string; to: string } {
  const span = Math.max(1, Math.floor(days));
  return { from: isoDay(now - (span - 1) * DAY_MS), to: isoDay(now) };
}

/**
 * `game_visits_daily` rows → one entry per day of the range, oldest first, 0 for a day without a row (or a bad
 * number). Rows outside the range are dropped.
 */
export function toVisitsDaily(
  rows: readonly { day: string; visits: number | string | null }[] | null,
  now: number = Date.now(),
  days: number = VISITS_DAILY_DAYS,
): VisitsDay[] {
  const byDay = new Map<string, number>();
  for (const r of rows ?? []) {
    const n = Number(r.visits);
    byDay.set(r.day.slice(0, 10), Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }
  const span = Math.max(1, Math.floor(days));
  return Array.from({ length: span }, (_, i) => {
    const day = isoDay(now - (span - 1 - i) * DAY_MS);
    return { day, visits: byDay.get(day) ?? 0 };
  });
}
