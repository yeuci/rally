import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendsPlayingNow, recentPlayerDetail, toFriendsPresence, toRecentPlayers } from '../src/lib/social';

type RecentRow = NonNullable<Parameters<typeof toRecentPlayers>[0]>[number];
const row = (over: Partial<RecentRow> = {}): RecentRow => ({
  user_id: 'u1',
  username: 'sloth',
  display_name: 'Sloth',
  avatar_url: null,
  game_id: 'sumo',
  game_title: 'Sumo',
  played_at: '2026-11-01T10:00:00Z',
  matches: 2,
  friendship: 'none',
  ...over,
});

test('toRecentPlayers: rows → people, most recent first, unknown friendship as none, blocked/self dropped', () => {
  const people = toRecentPlayers([
    row({ user_id: 'u1', username: 'old', played_at: '2026-10-25T10:00:00Z', matches: '3' as unknown as number }),
    row({ user_id: 'u2', username: 'new', played_at: '2026-11-01T09:00:00Z', friendship: 'weird', display_name: '' }),
    row({ user_id: 'u3', username: 'blocked', friendship: 'blocked' }),
    row({ user_id: 'u4', username: 'me', friendship: 'self' }),
    row({ user_id: '', username: 'broken' }),
  ]);
  assert.deepEqual(
    people.map((p) => [p.username, p.friendship, p.matches, p.displayName]),
    [
      ['new', 'none', 2, null],
      ['old', 'none', 3, 'Sloth'],
    ],
  );
  assert.deepEqual(toRecentPlayers(null), []);
});

test('recentPlayerDetail: game, shared matches when more than one, when', () => {
  const ago = () => '2 h ago';
  assert.equal(recentPlayerDetail({ gameTitle: 'Sumo', matches: 1, playedAt: 'x' }, ago), 'Sumo · 2 h ago');
  assert.equal(recentPlayerDetail({ gameTitle: 'Sumo', matches: 3, playedAt: 'x' }, ago), 'Sumo · 3 matches · 2 h ago');
  assert.equal(
    recentPlayerDetail({ gameTitle: null, matches: 1, playedAt: 'x' }, () => ''),
    'A match',
  );
});

const friends = [
  { userId: 'a', username: 'ann', displayName: 'Ann' },
  { userId: 'b', username: 'bob', displayName: null },
  { userId: 'c', username: 'cat', displayName: 'Cat' },
  { userId: 'd', username: 'dan', displayName: 'Dan' },
  { userId: 'e', username: 'eve', displayName: 'Eve' },
];
const presence = toFriendsPresence([
  { user_id: 'a', status: 'in_game', game_id: 'sumo', game_title: 'Sumo', joinable: false },
  { user_id: 'b', status: 'in_game', game_id: 'stack', game_title: 'Stack', joinable: true },
  { user_id: 'c', status: 'online', game_id: null, game_title: null, joinable: false },
  { user_id: 'd', status: 'in_game', game_id: 'sumo', game_title: 'Sumo', joinable: true },
  { user_id: 'zz', status: 'in_game', game_id: 'sumo', game_title: 'Sumo', joinable: true },
]);
const games = [
  { id: 'sumo', title: 'Sumo' },
  { id: 'overrun', title: 'Overrun' },
];

test('friendsPlayingNow: in-game friends only, joinable first, then by name; with the catalog card when known', () => {
  const rows = friendsPlayingNow(friends, presence, games);
  assert.deepEqual(
    rows.map((r) => [r.friend.username, r.presence.gameId, r.presence.joinable, r.game?.title ?? null]),
    [
      ['bob', 'stack', true, null],
      ['dan', 'sumo', true, 'Sumo'],
      ['ann', 'sumo', false, 'Sumo'],
    ],
  );
  assert.ok(!rows.some((r) => r.friend.userId === 'zz'), 'not in the friends list: left out');
  assert.deepEqual(friendsPlayingNow(undefined, presence), []);
  assert.deepEqual(friendsPlayingNow(friends, undefined), []);
  assert.deepEqual(friendsPlayingNow(friends, new Map()), [], 'nobody playing: the row hides');
});

test('friendsPlayingNow for one game (the game page)', () => {
  assert.deepEqual(
    friendsPlayingNow(friends, presence, games, 'sumo').map((r) => r.friend.username),
    ['dan', 'ann'],
  );
  assert.deepEqual(friendsPlayingNow(friends, presence, games, 'overrun'), []);
});
