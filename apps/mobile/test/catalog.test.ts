import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAvatarPath } from '../src/lib/avatar';
import { formatCount, timeAgo, visitsLabel } from '../src/lib/format';
import { searchGames } from '../src/lib/search';
import { compareSemver, satisfiesMinVersion } from '../src/lib/semver';

test('compareSemver / satisfiesMinVersion', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1);
  assert.equal(compareSemver('0.1.0', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(satisfiesMinVersion('0.1.0', '0.0.0', '0.1.0'), true);
  assert.equal(satisfiesMinVersion('0.1.0', '0.0.0', '1.0.0'), false);
  assert.equal(satisfiesMinVersion('0.1.0', null, undefined), true);
});

test('searchGames matches title and genre, ignoring case and accents', () => {
  const games = [
    { id: 'a', title: 'Rally Spike', genres: ['arcade'] },
    { id: 'b', title: 'Pokémon-ish Party', genres: ['party'] },
    { id: 'c', title: 'Kart Chaos', genres: ['racing'] },
  ];
  assert.deepEqual(searchGames(games, 'spike').map((g) => g.id), ['a']);
  assert.deepEqual(searchGames(games, 'POKEMON').map((g) => g.id), ['b']);
  assert.deepEqual(searchGames(games, 'rac').map((g) => g.id), ['c']);
  assert.deepEqual(searchGames(games, 'ar').map((g) => g.id), ['a', 'b', 'c']);
  assert.deepEqual(searchGames(games, '   '), []);
});

test('timeAgo', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  assert.equal(timeAgo('2026-10-29T11:59:30Z', now), 'just now');
  assert.equal(timeAgo('2026-10-29T11:55:00Z', now), '5 min ago');
  assert.equal(timeAgo('2026-10-29T09:00:00Z', now), '3 h ago');
  assert.equal(timeAgo('2026-10-27T12:00:00Z', now), '2 d ago');
  assert.equal(timeAgo(null, now), '');
});

test('resolveAvatarPath keeps absolute URLs and resolves bucket paths', () => {
  const base = 'https://x.supabase.co/storage/v1/object/public/avatars/';
  assert.equal(resolveAvatarPath(null, base), null);
  assert.equal(resolveAvatarPath('https://cdn.example.com/a.png', base), 'https://cdn.example.com/a.png');
  assert.equal(resolveAvatarPath('defaults/avatar-03.webp', base), 'https://x.supabase.co/storage/v1/object/public/avatars/defaults/avatar-03.webp');
  assert.equal(resolveAvatarPath('/defaults/avatar-10.webp', base), 'https://x.supabase.co/storage/v1/object/public/avatars/defaults/avatar-10.webp');
});

test('formatCount: compact counts, one decimal at most, rounded down', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(950), '950');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1_000), '1K');
  assert.equal(formatCount(1_049), '1K');
  assert.equal(formatCount(1_050), '1K');
  assert.equal(formatCount(1_100), '1.1K');
  assert.equal(formatCount(12_400), '12.4K');
  assert.equal(formatCount(12_499), '12.4K');
  assert.equal(formatCount(100_000), '100K');
  // Never rounds up into the next unit.
  assert.equal(formatCount(999_999), '999.9K');
  assert.equal(formatCount(1_000_000), '1M');
  assert.equal(formatCount(3_100_000), '3.1M');
  assert.equal(formatCount(3_199_999), '3.1M');
  assert.equal(formatCount(2_500_000_000), '2.5B');
  // Bad input reads as a whole count >= 0.
  assert.equal(formatCount(12.9), '12');
  assert.equal(formatCount(-5), '0');
  assert.equal(formatCount(Number.NaN), '0');
  assert.equal(formatCount(Number.POSITIVE_INFINITY), '0');
});

test('visitsLabel: "12.4K visits", singular for one', () => {
  assert.equal(visitsLabel(12_400), '12.4K visits');
  assert.equal(visitsLabel(3_100_000), '3.1M visits');
  assert.equal(visitsLabel(950), '950 visits');
  assert.equal(visitsLabel(1), '1 visit');
  assert.equal(visitsLabel(0), '0 visits');
});
