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
/** Tiles per genre row; the category sheet lists them all. */
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
