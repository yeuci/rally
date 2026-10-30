import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameCard } from '../src/lib/catalog';
import {
  CATEGORY_CARDS_VISIBLE,
  categoryCardHeight,
  categoryCardWidth,
  categoryCoverGames,
  dashboardHeroHeight,
  gamesCountLabel,
  genreKey,
  genreLabel,
  groupByGenre,
  heroAutoAdvances,
  nextHeroPage,
  toVisitsDaily,
  VISITS_DAILY_DAYS,
  visitsDailyRange,
} from '../src/lib/dashboard';
import { ROW_GAP, isWideLayout, pagePadding } from '../src/lib/layout';

const PORTRAIT = { width: 393, height: 852 };
const LANDSCAPE = { width: 852, height: 393 };
const TABLET_LANDSCAPE = { width: 1194, height: 834 };

const COVER = 'https://cdn.example.com/games/x/art/cover.jpg';

function game(id: string, genres: string[], extra: Partial<GameCard> = {}): GameCard {
  return {
    id,
    title: id,
    description: '',
    genres,
    icon_url: null,
    cover_url: null,
    screenshots: [],
    min_players: 1,
    max_players: 1,
    age_rating: '4+',
    featured_rank: null,
    created_at: '2026-10-01T00:00:00Z',
    visits: 0,
    ...extra,
  };
}

test('hero: tall in portrait, 16:7 in landscape but never more than 78 % of the window height', () => {
  const portrait = dashboardHeroHeight(PORTRAIT, isWideLayout(PORTRAIT));
  assert.equal(portrait, Math.round(393 * 1.3));
  assert.ok(portrait <= PORTRAIT.height * 0.66);

  // Phone landscape: 16:7 of 852 (373) would fill the window; the cap leaves the first row peeking.
  const phone = dashboardHeroHeight(LANDSCAPE, isWideLayout(LANDSCAPE));
  assert.equal(phone, Math.round(393 * 0.78));
  assert.ok(phone < (LANDSCAPE.width * 7) / 16);

  // Tablet landscape: plain 16:7.
  assert.equal(dashboardHeroHeight(TABLET_LANDSCAPE, true), Math.round((1194 * 7) / 16));
  // Landscape is always shorter than portrait on the same phone.
  assert.ok(phone < portrait);
  // Short portrait windows (split screen): capped by the height.
  assert.equal(dashboardHeroHeight({ width: 393, height: 500 }, false), 330);
});

test('category cards: ≈1.55 across a phone, ≈3.3 in landscape, 2:1, re-derived from the window after rotation', () => {
  const visible = (w: number, padLeft: number, card: number) => (w - padLeft) / (card + ROW_GAP);
  const p = pagePadding({ left: 0, right: 0 });
  const portrait = categoryCardWidth(PORTRAIT.width, p.left, false);
  assert.ok(Math.abs(visible(PORTRAIT.width, p.left, portrait) - CATEGORY_CARDS_VISIBLE.narrow) < 0.15);

  const l = pagePadding({ left: 59, right: 59 });
  const landscape = categoryCardWidth(LANDSCAPE.width, l.left, true);
  assert.ok(Math.abs(visible(LANDSCAPE.width, l.left, landscape) - CATEGORY_CARDS_VISIBLE.wide) < 0.3);

  assert.equal(categoryCardHeight(240), 120);
  // Clamped on very small and very large windows.
  assert.equal(categoryCardWidth(200, 16, false), 168);
  assert.equal(categoryCardWidth(3000, 16, true), 320);
});

test('genre labels and keys', () => {
  assert.equal(genreLabel('puzzle'), 'Puzzle');
  assert.equal(genreLabel(' tower-defense '), 'Tower defense');
  assert.equal(genreLabel('party_game'), 'Party game');
  assert.equal(genreKey(' Puzzle '), 'puzzle');
  assert.equal(gamesCountLabel(1), '1 game');
  assert.equal(gamesCountLabel(0), '0 games');
  assert.equal(gamesCountLabel(12), '12 games');
});

test('groupByGenre: one group per genre present, biggest first, a game in each of its genres once', () => {
  const games = [
    game('a', ['puzzle', 'Arcade']),
    game('b', ['arcade']),
    game('c', ['Arcade', 'arcade ', 'party']),
    game('d', []),
    game('e', ['  ']),
  ];
  const groups = groupByGenre(games);
  assert.deepEqual(
    groups.map((g) => [g.key, g.label, g.games.map((x) => x.id)]),
    [
      ['arcade', 'Arcade', ['a', 'b', 'c'].sort()],
      ['party', 'Party', ['c']],
      ['puzzle', 'Puzzle', ['a']],
    ],
  );
  // Ties on size: alphabetical by label.
  assert.deepEqual(
    groupByGenre([game('x', ['zeta']), game('y', ['alpha'])]).map((g) => g.key),
    ['alpha', 'zeta'],
  );
  assert.deepEqual(groupByGenre([]), []);
});

test('groupByGenre orders each genre: featured by rank, then newest, then title', () => {
  const games = [
    game('old', ['arcade'], { created_at: '2026-01-01T00:00:00Z' }),
    game('new', ['arcade'], { created_at: '2026-09-01T00:00:00Z' }),
    game('star-2', ['arcade'], { featured_rank: 2, created_at: '2025-01-01T00:00:00Z' }),
    game('star-1', ['arcade'], { featured_rank: 1, created_at: '2025-01-01T00:00:00Z' }),
    game('b-same', ['arcade'], { created_at: '2026-05-01T00:00:00Z' }),
    game('a-same', ['arcade'], { created_at: '2026-05-01T00:00:00Z' }),
  ];
  assert.deepEqual(
    groupByGenre(games)[0]!.games.map((g) => g.id),
    ['star-1', 'star-2', 'new', 'a-same', 'b-same', 'old'],
  );
});

test('category covers prefer uploaded art and avoid repeating a game across cards', () => {
  // Both genres have two games; arcade sorts first and takes "a", so party uses its other game with art.
  const a = game('a', ['arcade', 'party'], { cover_url: COVER });
  const b = game('b', ['arcade'], { screenshots: [COVER] });
  const c = game('c', ['party'], { cover_url: COVER });
  const covers = categoryCoverGames(groupByGenre([a, b, c]));
  assert.equal(covers.get('arcade')!.id, 'a');
  assert.equal(covers.get('party')!.id, 'c');

  // When the only game with art is taken, it is reused: uploaded art beats a unique generated cover.
  const shared = game('shared', ['arcade', 'party'], { cover_url: COVER });
  const plain = game('plain', ['party']);
  const reused = categoryCoverGames(groupByGenre([shared, plain]));
  assert.equal(reused.get('party')!.id, 'shared'); // party (2 games) picks first
  assert.equal(reused.get('arcade')!.id, 'shared');
  // No art anywhere: an unused game, else the first.
  const none = categoryCoverGames(groupByGenre([game('p', ['x', 'y']), game('q', ['y'])]));
  assert.equal(none.get('y')!.id, 'p'); // y is bigger, picks first
  assert.equal(none.get('x')!.id, 'p');
});

test('hero pages wrap, and auto-advance stops whenever it should', () => {
  assert.equal(nextHeroPage(0, 3), 1);
  assert.equal(nextHeroPage(2, 3), 0);
  assert.equal(nextHeroPage(0, 1), 0);
  assert.equal(nextHeroPage(5, 0), 0);

  const on = { count: 3, reducedMotion: false, screenReader: false, touching: false, focused: true, drawerOpen: false };
  assert.equal(heroAutoAdvances(on), true);
  assert.equal(heroAutoAdvances({ ...on, count: 1 }), false);
  assert.equal(heroAutoAdvances({ ...on, reducedMotion: true }), false);
  assert.equal(heroAutoAdvances({ ...on, screenReader: true }), false);
  assert.equal(heroAutoAdvances({ ...on, touching: true }), false);
  assert.equal(heroAutoAdvances({ ...on, focused: false }), false);
  assert.equal(heroAutoAdvances({ ...on, drawerOpen: true }), false);
});

test('visits daily: the last 7 UTC days, today included, oldest first, missing days as 0', () => {
  const now = Date.parse('2026-10-30T01:30:00Z');
  assert.equal(VISITS_DAILY_DAYS, 7);
  assert.deepEqual(visitsDailyRange(now), { from: '2026-10-24', to: '2026-10-30' });
  // Across a month boundary.
  assert.deepEqual(visitsDailyRange(Date.parse('2026-11-03T23:59:00Z')), { from: '2026-10-28', to: '2026-11-03' });
  const days = toVisitsDaily(
    [
      { day: '2026-10-24', visits: 10 },
      { day: '2026-10-28', visits: '1200' },
      { day: '2026-10-30', visits: null },
      // Outside the range: dropped.
      { day: '2026-10-20', visits: 99 },
    ],
    now,
  );
  assert.deepEqual(days, [
    { day: '2026-10-24', visits: 10 },
    { day: '2026-10-25', visits: 0 },
    { day: '2026-10-26', visits: 0 },
    { day: '2026-10-27', visits: 0 },
    { day: '2026-10-28', visits: 1200 },
    { day: '2026-10-29', visits: 0 },
    { day: '2026-10-30', visits: 0 },
  ]);
  assert.equal(toVisitsDaily(null, now).length, 7);
});
