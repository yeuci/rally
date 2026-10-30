import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_COUNTS_REFRESH_MS, liveCountLabel, toLiveCounts } from '../src/lib/dashboard';
import { joinTargetParams, parseJoinTarget } from '../src/lib/join-target';
import {
  parsePublicPresence,
  presenceLine,
  presenceRow,
  sortByPresence,
  toFriendsPresence,
  type FriendPresence,
} from '../src/lib/social';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

const row = (user_id: string, status: string | null, extra: Partial<{ game_id: string | null; game_title: string | null; room_id: string | null; joinable: boolean | null }> = {}) => ({
  user_id,
  status,
  game_id: null,
  game_title: null,
  room_id: null,
  joinable: false,
  ...extra,
});

test('toFriendsPresence: online and in_game rows by user id; unknown statuses dropped', () => {
  const map = toFriendsPresence([
    row(A, 'online'),
    row(B, 'in_game', { game_id: 'sumo', game_title: 'Sumo', room_id: 'r1', joinable: true }),
    row(C, 'offline'),
    row(D, null),
  ]);
  assert.deepEqual([...map.keys()], [A, B]);
  assert.deepEqual(map.get(A), { userId: A, status: 'online', gameId: null, gameTitle: null, joinable: false });
  assert.deepEqual(map.get(B), { userId: B, status: 'in_game', gameId: 'sumo', gameTitle: 'Sumo', joinable: true });
  assert.equal(toFriendsPresence(null).size, 0);
});

test('toFriendsPresence: in_game without a game reads as online and is never joinable', () => {
  const map = toFriendsPresence([row(A, 'in_game', { game_id: null, joinable: true }), row(B, 'online', { game_id: 'sumo', joinable: true })]);
  assert.deepEqual(map.get(A), { userId: A, status: 'online', gameId: null, gameTitle: null, joinable: false });
  assert.equal(map.get(B)!.joinable, false, 'online friends have nothing to join');
  assert.equal(map.get(B)!.gameId, null);
  assert.equal(toFriendsPresence([row(C, 'in_game', { game_id: 'sumo', joinable: null })]).get(C)!.joinable, false);
});

const p = (userId: string, status: 'online' | 'in_game', joinable = false, gameTitle: string | null = 'Sumo'): FriendPresence => ({
  userId,
  status,
  gameId: status === 'in_game' ? 'sumo' : null,
  gameTitle: status === 'in_game' ? gameTitle : null,
  joinable,
});

test('presenceRow: offline → null, online → "Online", in a game → "In Sumo"', () => {
  assert.equal(presenceRow(undefined), null);
  assert.equal(presenceRow(null), null);
  const online = presenceRow(p(A, 'online'), '@ann')!;
  assert.equal(online.label, 'Online');
  assert.equal(online.tone, 'online');
  assert.equal(online.join, null);
  assert.match(online.accessibilityLabel, /@ann is online/);
  const playing = presenceRow(p(A, 'in_game'), '@ann')!;
  assert.equal(playing.label, 'In Sumo');
  assert.equal(playing.tone, 'in_game');
  assert.equal(playing.join, null, 'not joinable: no Join');
  assert.equal(presenceRow(p(A, 'in_game', false, null))!.label, 'In a game');
});

test('presenceRow: a joinable room gives Join with the launch target for useLaunchGame', () => {
  const r = presenceRow(p(B, 'in_game', true), '@bo')!;
  assert.deepEqual(r.join, { gameId: 'sumo', gameTitle: 'Sumo', friendId: B });
  assert.match(r.accessibilityLabel, /can join/);
  // What the friends screen pushes: /game/sumo/play?join=friend&friend=<uuid>, which the play route parses back.
  const params = joinTargetParams({ join: 'friend', friend: r.join!.friendId });
  assert.deepEqual(params, { join: 'friend', friend: B });
  assert.deepEqual(parseJoinTarget(params), { join: 'friend', friend: B });
  // A joinable row without a title still launches (the consent dialog says "this game").
  assert.equal(presenceRow(p(B, 'in_game', true, null))!.join!.gameTitle, 'this game');
});

test('sortByPresence: joinable games, then games, then online, then offline; list order kept inside a group', () => {
  const friends = [{ userId: 'z-off' }, { userId: A }, { userId: B }, { userId: 'y-off' }, { userId: C }, { userId: D }];
  const presence = new Map([
    [A, p(A, 'online')],
    [B, p(B, 'in_game', false)],
    [C, p(C, 'in_game', true)],
    [D, p(D, 'online')],
  ]);
  assert.deepEqual(
    sortByPresence(friends, presence).map((f) => f.userId),
    [C, B, A, D, 'z-off', 'y-off'],
  );
  assert.deepEqual(sortByPresence(friends, new Map()).map((f) => f.userId), friends.map((f) => f.userId));
});

test('parsePublicPresence / presenceLine: "Online", "Playing Sumo", null when hidden or offline', () => {
  assert.equal(parsePublicPresence(null), null);
  assert.equal(parsePublicPresence('online'), null);
  assert.equal(parsePublicPresence({ status: 'offline' }), null);
  assert.deepEqual(parsePublicPresence({ status: 'online', game_id: null, game_title: null }), { status: 'online', gameId: null, gameTitle: null });
  assert.deepEqual(parsePublicPresence({ status: 'in_game', game_id: 'sumo', game_title: 'Sumo' }), { status: 'in_game', gameId: 'sumo', gameTitle: 'Sumo' });
  assert.deepEqual(parsePublicPresence({ status: 'in_game', game_id: null }), { status: 'online', gameId: null, gameTitle: null });
  assert.equal(presenceLine(null), null);
  assert.equal(presenceLine(parsePublicPresence({ status: 'online' })), 'Online');
  assert.equal(presenceLine(parsePublicPresence({ status: 'in_game', game_id: 'sumo', game_title: 'Sumo' })), 'Playing Sumo');
  assert.equal(presenceLine(parsePublicPresence({ status: 'in_game', game_id: 'sumo', game_title: '' })), 'Playing a game');
});

test('toLiveCounts / liveCountLabel: "12 playing" for multiplayer games with players only', () => {
  assert.equal(LIVE_COUNTS_REFRESH_MS, 30_000);
  const counts = toLiveCounts([
    { game_id: 'sumo', players: 12, rooms: 3 },
    { game_id: 'big', players: '1530', rooms: '40' },
    { game_id: 'empty', players: 0, rooms: 0 },
    { game_id: 'bad', players: 'x', rooms: -2 },
    { game_id: null, players: 5, rooms: 1 },
  ]);
  assert.deepEqual(counts.get('sumo'), { players: 12, rooms: 3 });
  assert.deepEqual(counts.get('bad'), { players: 0, rooms: 0 });
  assert.equal(counts.size, 4);
  const mp = (id: string) => ({ id, max_players: 8 });
  assert.equal(liveCountLabel(mp('sumo'), counts), '12 playing');
  assert.equal(liveCountLabel(mp('big'), counts, 'en-US'), '1.5K playing');
  assert.equal(liveCountLabel(mp('empty'), counts), null, 'nobody playing: the tile keeps its line');
  assert.equal(liveCountLabel(mp('unknown'), counts), null);
  assert.equal(liveCountLabel({ id: 'sumo', max_players: 1 }, counts), null, 'solo games never show a count');
  assert.equal(liveCountLabel(mp('sumo'), undefined), null, 'counts not loaded yet');
  assert.equal(liveCountLabel(mp('one'), toLiveCounts([{ game_id: 'one', players: 1, rooms: 1 }])), '1 playing');
  assert.equal(toLiveCounts(null).size, 0);
});
