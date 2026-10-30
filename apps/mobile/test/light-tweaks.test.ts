import assert from 'node:assert/strict';
import { test } from 'node:test';
import { podiumTint } from '../src/lib/progress-format';
import {
  RECENT_SEARCHES_MAX,
  addRecentSearch,
  parseRecentSearches,
  removeRecentSearch,
} from '../src/lib/recent-searches';
import { filterPeople } from '../src/lib/search';
import { gameShareContent, gameWebUrl, normalizeWebOrigin } from '../src/lib/share';

test('recent searches: newest first, trimmed, case-insensitive dedupe, capped at 8', () => {
  assert.equal(RECENT_SEARCHES_MAX, 8);
  let list: string[] = [];
  list = addRecentSearch(list, '  sumo ');
  list = addRecentSearch(list, 'Stack');
  assert.deepEqual(list, ['Stack', 'sumo']);
  // Searching again moves it to the front with the new spelling, once.
  assert.deepEqual(addRecentSearch(list, 'SUMO'), ['SUMO', 'Stack']);
  // Blank, whitespace and the bare people prefix are not searches.
  for (const q of ['', '   ', '@', ' @ ']) assert.deepEqual(addRecentSearch(list, q), list);
  assert.deepEqual(addRecentSearch([], 'puzzle   games'), ['puzzle games']);
  for (let i = 0; i < 12; i++) list = addRecentSearch(list, `q${i}`);
  assert.equal(list.length, 8);
  assert.equal(list[0], 'q11');
  assert.equal(list.at(-1), 'q4');
  assert.deepEqual(addRecentSearch(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
});

test('recent searches: remove one (case-insensitive), the input list is never mutated', () => {
  const list = ['Stack', '@ana', 'sumo'];
  assert.deepEqual(removeRecentSearch(list, 'stack'), ['@ana', 'sumo']);
  assert.deepEqual(removeRecentSearch(list, 'nope'), list);
  addRecentSearch(list, 'new');
  assert.deepEqual(list, ['Stack', '@ana', 'sumo']);
});

test('recent searches: the stored JSON is parsed defensively', () => {
  assert.deepEqual(parseRecentSearches(null), []);
  assert.deepEqual(parseRecentSearches('garbage'), []);
  assert.deepEqual(parseRecentSearches('{"a":1}'), []);
  assert.deepEqual(parseRecentSearches('["sumo", 3, null, " Stack ", "SUMO", "", "@"]'), ['sumo', 'Stack']);
  const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => `q${i}`));
  assert.equal(parseRecentSearches(many).length, 8);
});

test('podium tint: gold, silver, bronze for ranks 1 to 3, none below or for odd input', () => {
  assert.equal(podiumTint(1), 'gold');
  assert.equal(podiumTint(2), 'silver');
  assert.equal(podiumTint(3), 'bronze');
  for (const rank of [0, -1, 4, 10, 1.5, Number.NaN]) assert.equal(podiumTint(rank), null, String(rank));
});

test('friends filter: username or display name, accent- and case-insensitive, "@" ignored', () => {
  const people = [
    { username: 'ana_b', displayName: 'Ana Belén' },
    { username: 'zoe', displayName: null },
    { username: 'BOB', displayName: 'Robert' },
  ];
  assert.deepEqual(
    filterPeople(people, '').map((p) => p.username),
    ['ana_b', 'zoe', 'BOB'],
  );
  assert.deepEqual(filterPeople(people, '  ').length, 3);
  assert.deepEqual(
    filterPeople(people, 'belen').map((p) => p.username),
    ['ana_b'],
  );
  assert.deepEqual(
    filterPeople(people, '@zo').map((p) => p.username),
    ['zoe'],
  );
  assert.deepEqual(
    filterPeople(people, 'bob').map((p) => p.username),
    ['BOB'],
  );
  assert.deepEqual(
    filterPeople(people, 'rob').map((p) => p.username),
    ['BOB'],
  );
  assert.deepEqual(filterPeople(people, 'xyz'), []);
});

test('share: the web origin is a bare http(s) origin or nothing', () => {
  assert.equal(normalizeWebOrigin('https://rally.app/'), 'https://rally.app');
  assert.equal(normalizeWebOrigin(' http://localhost:5190 '), 'http://localhost:5190');
  for (const bad of [undefined, null, '', 'rally.app', 'https://rally.app/games', 'ftp://rally.app', 'https://']) {
    assert.equal(normalizeWebOrigin(bad), null, String(bad));
  }
  assert.equal(gameWebUrl('https://rally.app', 'stack'), 'https://rally.app/game/stack');
  assert.equal(gameWebUrl('https://rally.app', 'a b'), 'https://rally.app/game/a%20b');
  assert.equal(gameWebUrl(null, 'stack'), null);
});

test('share: the title, plus the link (iOS: as url; Android: in the message) when the origin is known', () => {
  const game = { id: 'stack', title: 'Stack' };
  assert.deepEqual(gameShareContent(game, null, 'ios'), { title: 'Stack', message: 'Stack' });
  assert.deepEqual(gameShareContent(game, null, 'android'), { title: 'Stack', message: 'Stack' });
  assert.deepEqual(gameShareContent(game, 'https://rally.app', 'ios'), {
    title: 'Stack',
    message: 'Stack',
    url: 'https://rally.app/game/stack',
  });
  assert.deepEqual(gameShareContent(game, 'https://rally.app', 'android'), {
    title: 'Stack',
    message: 'Stack https://rally.app/game/stack',
  });
});
