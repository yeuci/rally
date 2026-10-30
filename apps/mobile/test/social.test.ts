import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberSince, monthYear, playsLabel } from '../src/lib/format';
import { avatarRowCapacity, FRIEND_CELL_WIDTH, ROW_GAP, titleBarRange } from '../src/lib/layout';
import {
  blockAction,
  confirmCopy,
  countBadge,
  DEFAULT_PRIVACY,
  describeSocialError,
  friendButtons,
  isPeopleOnlyQuery,
  nextFriendship,
  parseFriendship,
  parsePrivacy,
  peopleQuery,
  personMatchRank,
  privacyPatch,
  rankPeople,
  searchSectionOrder,
  socialErrorKind,
  splitRequests,
  toFriends,
  toPersonResults,
  toPlayedGames,
  visibilityLabel,
  type Friendship,
  type PersonResult,
} from '../src/lib/social';

const labels = (status: Friendship, mode: 'profile' | 'compact') => friendButtons(status, mode, '@ann').map((b) => b.label);
const intents = (status: Friendship, mode: 'profile' | 'compact') => friendButtons(status, mode, '@ann').map((b) => b.intent);

test('parseFriendship accepts the six states and falls back to none', () => {
  for (const s of ['self', 'friends', 'outgoing', 'incoming', 'blocked', 'none'] as const) assert.equal(parseFriendship(s), s);
  assert.equal(parseFriendship('pending'), 'none');
  assert.equal(parseFriendship(null), 'none');
  assert.equal(parseFriendship(42), 'none');
});

test('friendButtons: profile buttons per relationship', () => {
  assert.deepEqual(labels('none', 'profile'), ['Add friend']);
  assert.deepEqual(intents('none', 'profile'), ['send']);
  assert.deepEqual(labels('outgoing', 'profile'), ['Requested']);
  assert.deepEqual(intents('outgoing', 'profile'), ['cancel']);
  assert.deepEqual(labels('incoming', 'profile'), ['Accept', 'Decline']);
  assert.deepEqual(intents('incoming', 'profile'), ['accept', 'decline']);
  assert.deepEqual(labels('friends', 'profile'), ['Friends']);
  assert.deepEqual(intents('friends', 'profile'), ['remove']);
  assert.equal(friendButtons('friends', 'profile')[0]!.confirm, true, 'removing a friend asks first');
  assert.equal(friendButtons('none', 'profile')[0]!.confirm, false);
  assert.deepEqual(labels('self', 'profile'), []);
  assert.deepEqual(labels('blocked', 'profile'), []);
});

test('friendButtons: compact rows show one short button', () => {
  assert.deepEqual(labels('none', 'compact'), ['Add']);
  assert.deepEqual(labels('outgoing', 'compact'), ['Requested']);
  assert.deepEqual(labels('incoming', 'compact'), ['Accept']);
  assert.deepEqual(labels('friends', 'compact'), ['Friends']);
  assert.deepEqual(labels('self', 'compact'), []);
  assert.match(friendButtons('outgoing', 'compact', '@ann')[0]!.accessibilityLabel, /@ann.*cancel/i);
});

test('blockAction: Block, Unblock once blocked, nothing for yourself', () => {
  assert.equal(blockAction('none'), 'block');
  assert.equal(blockAction('friends'), 'block');
  assert.equal(blockAction('blocked'), 'unblock');
  assert.equal(blockAction('self'), null);
});

test('nextFriendship: optimistic transitions', () => {
  assert.equal(nextFriendship('none', 'send'), 'outgoing');
  assert.equal(nextFriendship('incoming', 'send'), 'friends', 'sending to someone who asked you accepts');
  assert.equal(nextFriendship('outgoing', 'cancel'), 'none');
  assert.equal(nextFriendship('incoming', 'accept'), 'friends');
  assert.equal(nextFriendship('incoming', 'decline'), 'none');
  assert.equal(nextFriendship('friends', 'remove'), 'none');
  assert.equal(nextFriendship('friends', 'block'), 'blocked');
  assert.equal(nextFriendship('blocked', 'unblock'), 'none');
});

test('nextFriendship: the server answer wins when there is one', () => {
  assert.equal(nextFriendship('none', 'send', 'friends'), 'friends');
  assert.equal(nextFriendship('none', 'send', 'outgoing'), 'outgoing');
  assert.equal(nextFriendship('incoming', 'accept', 'none'), 'none', 'the request was withdrawn meanwhile');
  assert.equal(nextFriendship('incoming', 'decline', 'none'), 'none');
  assert.equal(nextFriendship('none', 'send', 'garbage'), 'outgoing', 'unknown answers fall back to the optimistic state');
  assert.equal(nextFriendship('none', 'send', null), 'outgoing');
  assert.equal(nextFriendship('none', 'send', 'self'), 'outgoing');
});

test('confirmCopy only for remove / block / unblock', () => {
  assert.match(confirmCopy('remove', '@ann')!.title, /Remove @ann/);
  assert.equal(confirmCopy('block', '@ann')!.action, 'Block');
  assert.equal(confirmCopy('unblock', '@ann')!.action, 'Unblock');
  assert.equal(confirmCopy('send', '@ann'), null);
});

test('social error mapping by message prefix', () => {
  assert.equal(socialErrorKind({ message: 'ANONYMOUS_FORBIDDEN: link an account' }), 'anonymous');
  assert.equal(socialErrorKind({ message: 'UNAUTHENTICATED' }), 'unauthenticated');
  assert.equal(socialErrorKind({ message: 'BLOCKED: cannot interact' }), 'blocked');
  assert.equal(socialErrorKind({ message: 'NOT_FOUND' }), 'not-found');
  assert.equal(socialErrorKind({ message: 'INVALID: query too long' }), 'invalid');
  assert.equal(socialErrorKind({ message: 'RATE_LIMITED: send_friend_request' }), 'rate-limited');
  assert.equal(socialErrorKind(new Error('Network request failed')), 'network');
  assert.equal(socialErrorKind('boom'), 'other');
  assert.equal(socialErrorKind(null), 'other');
  assert.equal(socialErrorKind({ message: 'the user is BLOCKED' }), 'other', 'prefix only');
  assert.match(describeSocialError({ message: 'RATE_LIMITED' }), /try again in a minute/);
  assert.match(describeSocialError({ message: 'ANONYMOUS_FORBIDDEN' }), /link Apple, Google or email/);
});

test('NOT_FOUND from respond_friend_request means the request is gone, not the player', () => {
  const gone = { message: 'NOT_FOUND: friend request' };
  assert.match(describeSocialError(gone, 'accept'), /request is no longer there/);
  assert.match(describeSocialError(gone, 'decline'), /request is no longer there/);
  assert.match(describeSocialError({ message: 'NOT_FOUND: user' }, 'send'), /player no longer exists/);
  assert.match(describeSocialError({ message: 'NOT_FOUND: user' }), /player no longer exists/);
});

test('peopleQuery / isPeopleOnlyQuery', () => {
  assert.equal(peopleQuery('  @Ann '), 'Ann');
  assert.equal(peopleQuery('@@ann'), 'ann');
  assert.equal(peopleQuery('@'), '');
  assert.equal(peopleQuery('  '), '');
  assert.equal(peopleQuery('a'), 'a');
  assert.equal(isPeopleOnlyQuery(' @ann'), true);
  assert.equal(isPeopleOnlyQuery('ann'), false);
});

const person = (username: string, displayName: string | null, friendship: Friendship = 'none'): PersonResult => ({
  userId: `id-${username}`,
  username,
  displayName,
  avatarUrl: null,
  friendship,
});

test('personMatchRank: exact username, prefix, display-name word, other', () => {
  assert.equal(personMatchRank(person('ann', null), 'Ann'), 0);
  assert.equal(personMatchRank(person('annie', null), '@ann'), 1);
  assert.equal(personMatchRank(person('zed', 'Anna Smith'), 'ann'), 2);
  assert.equal(personMatchRank(person('zed', 'Big Ánnie'), 'ann'), 2, 'word prefix, accents folded');
  assert.equal(personMatchRank(person('joanne', null), 'ann'), 3);
  assert.equal(personMatchRank(person('bob', null), 'ann'), 4);
});

test('rankPeople orders by match then username, keeps rows put when friendship changes, drops blocked', () => {
  const rows = [person('joanne', null), person('zed', 'Anna'), person('annie', null, 'friends'), person('ann', null), person('anb', null, 'blocked')];
  assert.deepEqual(
    rankPeople(rows, 'ann').map((p) => p.username),
    ['ann', 'annie', 'zed', 'joanne'],
  );
  const flipped = rows.map((p) => (p.username === 'annie' ? { ...p, friendship: 'outgoing' as const } : p));
  assert.deepEqual(rankPeople(flipped, 'ann').map((p) => p.username), ['ann', 'annie', 'zed', 'joanne']);
});

test('searchSectionOrder: games first, people first for an exact handle, people only for @', () => {
  const games = [{ title: 'Annihilator' }, { title: 'Pong' }];
  assert.deepEqual(searchSectionOrder('pong', games, []), ['games', 'people']);
  assert.deepEqual(searchSectionOrder('ann', games, [person('ann', null)]), ['games', 'people'], 'a game title starts with it');
  assert.deepEqual(searchSectionOrder('ann', [{ title: 'Pong' }], [person('ann', null)]), ['people', 'games']);
  assert.deepEqual(searchSectionOrder('ann', [{ title: 'Pong' }], [person('annie', null)]), ['games', 'people']);
  assert.deepEqual(searchSectionOrder('@ann', games, []), ['people']);
});

test('toPersonResults maps rows and parses friendship', () => {
  assert.deepEqual(
    toPersonResults([{ user_id: 'u1', username: 'ann', display_name: '', avatar_url: null, friendship: 'incoming' }]),
    [{ userId: 'u1', username: 'ann', displayName: null, avatarUrl: null, friendship: 'incoming' }],
  );
  assert.deepEqual(toPersonResults(null), []);
  assert.equal(toPersonResults([{ user_id: 'u', username: 'x', display_name: null, avatar_url: null, friendship: '??' }])[0]!.friendship, 'none');
});

test('privacy: parse with defaults, patch only on change, labels', () => {
  assert.deepEqual(parsePrivacy(null), DEFAULT_PRIVACY);
  assert.deepEqual(parsePrivacy({}), { games: 'public', friends: 'public' });
  assert.deepEqual(parsePrivacy({ games: 'friends', friends: 'private' }), { games: 'friends', friends: 'private' });
  assert.deepEqual(parsePrivacy({ games: 'everyone', friends: 7 }), { games: 'public', friends: 'public' });
  assert.deepEqual(parsePrivacy('{"games":"private"}'), { games: 'private', friends: 'public' });
  assert.deepEqual(parsePrivacy('not json'), DEFAULT_PRIVACY);
  assert.deepEqual(parsePrivacy([1, 2]), DEFAULT_PRIVACY);
  const saved = { games: 'public', friends: 'public' } as const;
  assert.equal(privacyPatch(saved, { ...saved }), null);
  assert.deepEqual(privacyPatch(saved, { games: 'friends', friends: 'public' }), { games: 'friends', friends: 'public' }, 'always the whole object');
  assert.equal(visibilityLabel('public'), 'Everyone');
  assert.equal(visibilityLabel('friends'), 'Friends');
  assert.equal(visibilityLabel('private'), 'Only me');
});

test('splitRequests splits by direction, newest first, drops unknown directions', () => {
  const row = (user_id: string, direction: string, created_at: string) => ({
    user_id,
    username: user_id,
    display_name: null,
    avatar_url: null,
    direction,
    created_at,
  });
  const { incoming, outgoing } = splitRequests([
    row('a', 'incoming', '2026-10-01T00:00:00Z'),
    row('b', 'outgoing', '2026-10-02T00:00:00Z'),
    row('c', 'incoming', '2026-10-03T00:00:00Z'),
    row('d', 'sideways', '2026-10-04T00:00:00Z'),
  ]);
  assert.deepEqual(incoming.map((r) => r.userId), ['c', 'a']);
  assert.deepEqual(outgoing.map((r) => r.userId), ['b']);
  assert.deepEqual(splitRequests(null), { incoming: [], outgoing: [] });
});

test('countBadge', () => {
  assert.equal(countBadge(0), null);
  assert.equal(countBadge(undefined), null);
  assert.equal(countBadge(3), '3');
  assert.equal(countBadge(12), '9+');
});

test('toPlayedGames: numbers, null best, most recent first; toFriends', () => {
  const games = toPlayedGames([
    { game_id: 'a', title: 'A', icon_url: '', cover_url: 'https://x/c.png', plays: '3', best_score: null, last_played_at: '2026-10-01T00:00:00Z' },
    { game_id: 'b', title: 'B', icon_url: 'https://x/i.png', cover_url: null, plays: 1, best_score: '1200', last_played_at: '2026-10-20T00:00:00Z' },
  ]);
  assert.deepEqual(games.map((g) => g.gameId), ['b', 'a']);
  assert.equal(games[0]!.bestScore, 1200);
  assert.equal(games[1]!.bestScore, null);
  assert.equal(games[1]!.plays, 3);
  assert.deepEqual(games[1]!.art, { icon_url: null, cover_url: 'https://x/c.png', screenshots: [] });
  assert.deepEqual(toPlayedGames(null), []);
  assert.deepEqual(toFriends([{ user_id: 'u', username: 'ann', display_name: '', avatar_url: 'a.png', since: '2026-01-01' }]), [
    { userId: 'u', username: 'ann', displayName: null, avatarUrl: 'a.png', since: '2026-01-01' },
  ]);
});

test('memberSince / monthYear / playsLabel', () => {
  assert.equal(monthYear('2026-10-30T12:00:00Z', 'en-US'), 'Oct 2026');
  assert.equal(memberSince('2026-10-01T00:30:00Z', 'en-US'), 'Member since Oct 2026', 'UTC month, whatever the device zone');
  assert.equal(memberSince(null), '');
  assert.equal(memberSince('nope'), '');
  assert.equal(playsLabel(1), '1 play');
  assert.equal(playsLabel(0), '0 plays');
  assert.equal(playsLabel(12.7), '12 plays');
});

test('avatarRowCapacity fits whole cells with gaps; titleBarRange', () => {
  assert.equal(avatarRowCapacity(0), 0);
  assert.equal(avatarRowCapacity(30), 1, 'at least one when there is any width');
  assert.equal(avatarRowCapacity(FRIEND_CELL_WIDTH * 4 + ROW_GAP * 3), 4);
  assert.equal(avatarRowCapacity(FRIEND_CELL_WIDTH * 4 + ROW_GAP * 3 - 1), 3);
  assert.equal(avatarRowCapacity(358), 4, 'iPhone portrait column');
  assert.equal(avatarRowCapacity(800), 10, 'landscape');
  assert.deepEqual(titleBarRange(400, 107), [245, 293]);
  assert.deepEqual(titleBarRange(60, 107), [0, 1], 'never inverted on tiny heroes');
});

test('peopleQuery never exceeds what search_profiles accepts', async () => {
  const { peopleQuery, PEOPLE_QUERY_MAX } = await import('../src/lib/social');
  assert.equal(peopleQuery('@' + 'a'.repeat(50)).length, PEOPLE_QUERY_MAX);
  assert.equal(peopleQuery('  @@sloth  '), 'sloth');
});
