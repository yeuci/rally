import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSE_COLUMNS,
  BROWSE_QUERY_MAX,
  BROWSE_SORT_OPTIONS,
  browseColumns,
  browseGames,
  browseGrid,
  browseParams,
  browseTitle,
  compareAz,
  compareNew,
  comparePopular,
  filterByGenre,
  genreChips,
  parseBrowseParams,
  sortGames,
} from '../src/lib/browse';
import type { GameCard } from '../src/lib/catalog';
import { toLiveCounts } from '../src/lib/dashboard';
import { ROW_GAP, isWideLayout, pagePadding, rowTileWidth } from '../src/lib/layout';

function game(id: string, extra: Partial<GameCard> = {}): GameCard {
  return {
    id,
    title: id,
    description: '',
    genres: [],
    icon_url: null,
    cover_url: null,
    screenshots: [],
    min_players: 1,
    max_players: 1,
    age_rating: '4+',
    featured_rank: null,
    created_at: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

const ids = (games: readonly { id: string }[]) => games.map((g) => g.id);

// --- params ---------------------------------------------------------------------------------------------------------

test('params: defaults for missing or unknown values, genre normalised like the catalog, arrays take the first', () => {
  assert.deepEqual(parseBrowseParams({}), { genre: null, sort: 'popular', q: null });
  assert.deepEqual(parseBrowseParams({ genre: '  Puzzle ', sort: 'NEW' }), { genre: 'puzzle', sort: 'new', q: null });
  assert.deepEqual(parseBrowseParams({ genre: '', sort: 'trending' }), { genre: null, sort: 'popular', q: null });
  assert.deepEqual(parseBrowseParams({ genre: ['arcade', 'party'], sort: ['az', 'new'] }), {
    genre: 'arcade',
    sort: 'az',
    q: null,
  });
  assert.equal(parseBrowseParams({ q: '  sumo ' }).q, 'sumo');
  assert.equal(parseBrowseParams({ q: '   ' }).q, null);
  assert.equal(parseBrowseParams({ q: 'x'.repeat(500) }).q!.length, BROWSE_QUERY_MAX);
});

test('params for the URL: defaults dropped (undefined), so setParams removes them and links stay short', () => {
  assert.deepEqual(browseParams({}), { genre: undefined, sort: undefined, q: undefined });
  assert.deepEqual(browseParams({ genre: 'Arcade', sort: 'popular' }), { genre: 'arcade', sort: undefined, q: undefined });
  assert.deepEqual(browseParams({ genre: null, sort: 'az', q: ' stack ' }), { genre: undefined, sort: 'az', q: 'stack' });
  // Round trip.
  const p = { genre: 'party', sort: 'new' as const, q: 'sumo' };
  assert.deepEqual(parseBrowseParams(browseParams(p)), p);
});

test('title: "Browse", or the genre title-cased', () => {
  assert.equal(browseTitle(null), 'Browse');
  assert.equal(browseTitle('arcade'), 'Arcade');
  assert.equal(browseTitle('tower-defense'), 'Tower Defense');
  assert.equal(browseTitle('Tower defense'), 'Tower Defense');
});

test('sort options: Popular, New, A–Z', () => {
  assert.deepEqual(
    BROWSE_SORT_OPTIONS.map((o) => o.label),
    ['Popular', 'New', 'A–Z'],
  );
});

// --- chips ----------------------------------------------------------------------------------------------------------

test('genre chips: All first (whole catalog), then biggest genre first, then by name; spellings merged', () => {
  const games = [
    game('a', { genres: ['Arcade', 'party'] }),
    game('b', { genres: ['arcade'] }),
    game('c', { genres: ['puzzle', 'Puzzle'] }),
    game('d', { genres: ['Party'] }),
    game('e', { genres: ['arcade'] }),
  ];
  const chips = genreChips(games);
  assert.deepEqual(
    chips.map((c) => [c.key, c.label, c.count]),
    [
      [null, 'All', 5],
      ['arcade', 'Arcade', 3],
      ['party', 'Party', 2],
      ['puzzle', 'Puzzle', 1],
    ],
  );
});

test('genre chips: a selected genre the catalog lacks is appended with 0 so the selection stays visible', () => {
  const games = [game('a', { genres: ['arcade'] })];
  assert.deepEqual(genreChips(games, 'arcade').length, 2);
  const chips = genreChips(games, 'Tower-Defense');
  assert.deepEqual(chips.at(-1), { key: 'tower-defense', label: 'Tower defense', count: 0 });
  assert.deepEqual(
    genreChips([], null).map((c) => c.key),
    [null],
  );
});

// --- filter and sort ------------------------------------------------------------------------------------------------

test('filterByGenre: any spelling; null keeps everything (as a copy)', () => {
  const games = [game('a', { genres: ['Arcade'] }), game('b', { genres: ['party'] }), game('c', { genres: [] })];
  assert.deepEqual(ids(filterByGenre(games, 'arcade')), ['a']);
  assert.deepEqual(ids(filterByGenre(games, ' ARCADE ')), ['a']);
  const all = filterByGenre(games, null);
  assert.deepEqual(ids(all), ['a', 'b', 'c']);
  assert.notEqual(all, games);
});

test('A–Z ignores case and accents; the id breaks ties', () => {
  const games = [game('3', { title: 'stack' }), game('1', { title: 'Échecs' }), game('2', { title: 'Arcade' }), game('0', { title: 'Stack' })];
  assert.deepEqual(ids([...games].sort(compareAz)), ['2', '1', '0', '3']);
});

test('New: newest first, then A–Z; an unparseable date sorts last', () => {
  const games = [
    game('old', { created_at: '2026-01-01T00:00:00Z' }),
    game('b', { title: 'B', created_at: '2026-10-01T00:00:00Z' }),
    game('a', { title: 'A', created_at: '2026-10-01T00:00:00Z' }),
    game('bad', { created_at: 'nope' }),
    game('new', { created_at: '2026-10-20T00:00:00Z' }),
  ];
  assert.deepEqual(ids([...games].sort(compareNew)), ['new', 'a', 'b', 'old', 'bad']);
});

test('Popular: live players (multiplayer only), then featured rank, then newest, then A–Z', () => {
  const counts = toLiveCounts([
    { game_id: 'sumo', players: 12, rooms: 3 },
    { game_id: 'brawl', players: 40, rooms: 5 },
    // A solo game never has live players; a stray row must not lift it.
    { game_id: 'solo', players: 99, rooms: 1 },
  ]);
  const games = [
    game('plain-old', { created_at: '2026-01-01T00:00:00Z' }),
    game('plain-new', { created_at: '2026-10-20T00:00:00Z' }),
    game('solo', { featured_rank: 3 }),
    game('featured-1', { featured_rank: 1 }),
    game('sumo', { max_players: 8 }),
    game('brawl', { max_players: 4 }),
  ];
  assert.deepEqual(ids([...games].sort(comparePopular(counts))), [
    'brawl',
    'sumo',
    'featured-1',
    'solo',
    'plain-new',
    'plain-old',
  ]);
  // Without live counts it falls back to featured rank / recent.
  assert.deepEqual(ids([...games].sort(comparePopular(undefined))).slice(0, 2), ['featured-1', 'solo']);
});

test('sortGames returns a sorted copy and leaves the cached array alone', () => {
  const games = [game('b', { title: 'B' }), game('a', { title: 'A' })];
  const sorted = sortGames(games, 'az');
  assert.deepEqual(ids(sorted), ['a', 'b']);
  assert.deepEqual(ids(games), ['b', 'a']);
});

test('browseGames: genre, then the carried-over query, then the sort', () => {
  const games = [
    game('stack', { title: 'Stack', genres: ['arcade'], created_at: '2026-10-02T00:00:00Z' }),
    game('spike', { title: 'Rally Spike', genres: ['arcade'], created_at: '2026-10-03T00:00:00Z' }),
    game('sumo', { title: 'Sumo', genres: ['party'], created_at: '2026-10-04T00:00:00Z' }),
  ];
  assert.deepEqual(ids(browseGames(games, { genre: 'arcade', sort: 'az', q: null })), ['spike', 'stack']);
  assert.deepEqual(ids(browseGames(games, { genre: null, sort: 'new', q: null })), ['sumo', 'spike', 'stack']);
  assert.deepEqual(ids(browseGames(games, { genre: null, sort: 'az', q: 's' })), ['spike', 'stack', 'sumo']);
  assert.deepEqual(ids(browseGames(games, { genre: 'party', sort: 'az', q: 'stack' })), []);
  assert.deepEqual(ids(browseGames(games, { genre: 'puzzle', sort: 'az', q: null })), []);
});

// --- grid -----------------------------------------------------------------------------------------------------------

const PHONES = [
  { width: 320, height: 568, insets: { left: 0, right: 0 } },
  { width: 393, height: 852, insets: { left: 0, right: 0 } },
  { width: 440, height: 956, insets: { left: 0, right: 0 } },
];
const WIDE = [
  { width: 667, height: 375, insets: { left: 0, right: 0 } }, // small phone, landscape
  { width: 852, height: 393, insets: { left: 59, right: 59 } }, // notched phone, landscape
  { width: 956, height: 440, insets: { left: 62, right: 62 } },
  { width: 834, height: 1194, insets: { left: 0, right: 0 } }, // tablet portrait (≥ 700 pt wide)
  { width: 1194, height: 834, insets: { left: 0, right: 0 } }, // tablet landscape
  { width: 1366, height: 1024, insets: { left: 0, right: 0 } },
];

test('grid columns: 2 on portrait phones, 3–4 when wide', () => {
  for (const w of PHONES) {
    assert.equal(isWideLayout(w), false);
    assert.equal(browseColumns(w.width, pagePadding(w.insets), false), BROWSE_COLUMNS.narrow, `${w.width}`);
  }
  for (const w of WIDE) {
    assert.equal(isWideLayout(w), true);
    const cols = browseColumns(w.width, pagePadding(w.insets), true);
    assert.ok(cols >= 3 && cols <= 4, `${w.width}x${w.height}: ${cols}`);
  }
  assert.equal(browseColumns(852, pagePadding({ left: 59, right: 59 }), true), 4);
});

test('grid tiles fill the content width and stay near the dashboard row tile size when wide', () => {
  for (const w of [...PHONES, ...WIDE]) {
    const wide = isWideLayout(w);
    const pad = pagePadding(w.insets);
    const contentW = w.width - pad.left - pad.right;
    const { columns, tileWidth } = browseGrid(w.width, pad, wide);
    const used = tileWidth * columns + ROW_GAP * (columns - 1);
    assert.ok(used <= contentW && contentW - used < columns, `${w.width}: ${used} / ${contentW}`);
    if (wide && columns === 4) {
      // Not far below the row tile (the grid never squeezes more columns than row-sized tiles allow).
      assert.ok(tileWidth >= rowTileWidth(w.width, pad.left, true) - ROW_GAP, `${w.width}: ${tileWidth}`);
    }
  }
});

test('grid geometry is recomputed from the window each time (rotation round-trip)', () => {
  const portrait = browseGrid(393, pagePadding({ left: 0, right: 0 }), false);
  browseGrid(852, pagePadding({ left: 59, right: 59 }), true);
  assert.deepEqual(browseGrid(393, pagePadding({ left: 0, right: 0 }), false), portrait);
  assert.deepEqual(portrait, { columns: 2, tileWidth: Math.floor((361 - ROW_GAP) / 2) });
});
