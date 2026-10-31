import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  achievementCount,
  achievementIcon,
  boardLabel,
  boardModeLabel,
  formatScore,
  orderBoards,
  parseMyRank,
  parsePublicStats,
  sameUsername,
  splitLeaderboard,
  toAchievementTile,
  toLeaderboardRows,
  type LeaderboardRow,
} from '../src/lib/progress-format';

const row = (rank: number, isMe = false): LeaderboardRow => ({
  rank,
  userId: `u${rank}`,
  username: `p${rank}`,
  avatarUrl: null,
  score: 1000 - rank,
  isMe,
});

test('formatScore groups integers and keeps at most two decimals', () => {
  assert.equal(formatScore(12345, 'en-US'), '12,345');
  assert.equal(formatScore(3.14159, 'en-US'), '3.14');
  assert.equal(formatScore(0, 'en-US'), '0');
  assert.equal(formatScore(-7, 'en-US'), '-7');
  assert.equal(formatScore(Number.NaN, 'en-US'), '—');
});

test('boardModeLabel: Total for total boards, Best run for best boards of multiplayer games, else none', () => {
  assert.equal(boardModeLabel('total', true), 'Total');
  assert.equal(boardModeLabel('total', false), 'Total');
  assert.equal(boardModeLabel('best', true), 'Best run');
  assert.equal(boardModeLabel('best', false), null);
  assert.equal(boardModeLabel(undefined, true), null);
  assert.equal(boardModeLabel(null, true), null);
  assert.equal(boardModeLabel('other', true), null);
});

test('boardLabel humanises board keys', () => {
  assert.equal(boardLabel('high-score'), 'High score');
  assert.equal(boardLabel('best_time'), 'Best time');
  assert.equal(boardLabel('bestTime'), 'Best time');
  assert.equal(boardLabel('score'), 'Score');
  assert.equal(boardLabel('--'), '--');
});

test('orderBoards: manifest order first (primary board), the rest by key', () => {
  const boards = [{ key: 'alpha' }, { key: 'zeta' }, { key: 'height' }, { key: 'beta' }];
  assert.deepEqual(
    orderBoards(boards, ['height', 'zeta']).map((b) => b.key),
    ['height', 'zeta', 'alpha', 'beta'],
  );
  assert.deepEqual(
    orderBoards(boards).map((b) => b.key),
    ['alpha', 'beta', 'height', 'zeta'],
  );
  assert.equal(boards[0]!.key, 'alpha', 'does not mutate the input');
});

test('splitLeaderboard: top 10, "Your rank" only when you are outside them', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
  const outside = splitLeaderboard(rows, { rank: 37, score: 12 });
  assert.equal(outside.top.length, 10);
  assert.deepEqual(outside.yourRank, { rank: 37, score: 12 });

  const inside = splitLeaderboard([row(1), row(2, true), row(3)], { rank: 2, score: 998 });
  assert.equal(inside.yourRank, null);
  assert.equal(inside.top[1]!.isMe, true);

  assert.equal(splitLeaderboard([row(1)], null).yourRank, null);
  assert.deepEqual(splitLeaderboard([], null), { top: [], yourRank: null });
});

test('parseMyRank accepts {score, rank} and rejects null / partial values', () => {
  assert.deepEqual(parseMyRank({ score: 120.5, rank: 4 }), { rank: 4, score: 120.5 });
  assert.deepEqual(parseMyRank({ score: '7', rank: '1' }), { rank: 1, score: 7 });
  assert.equal(parseMyRank(null), null);
  assert.equal(parseMyRank({ score: 3 }), null);
  assert.equal(parseMyRank({ score: null, rank: null }), null);
  assert.equal(parseMyRank('x'), null);
});

test('toLeaderboardRows resolves avatars and flags your row', () => {
  const rows = toLeaderboardRows(
    [
      { rank: 1, user_id: 'a', username: 'ann', avatar_url: 'defaults/avatar-01.webp', score: 300, is_me: false },
      { rank: 2, user_id: 'b', username: 'bob', avatar_url: null, score: 250, is_me: true },
    ],
    (v) => (v ? `https://cdn/${v}` : null),
  );
  assert.deepEqual(rows, [
    {
      rank: 1,
      userId: 'a',
      username: 'ann',
      avatarUrl: 'https://cdn/defaults/avatar-01.webp',
      score: 300,
      isMe: false,
    },
    { rank: 2, userId: 'b', username: 'bob', avatarUrl: null, score: 250, isMe: true },
  ]);
  assert.deepEqual(
    toLeaderboardRows(null, () => null),
    [],
  );
});

test('achievement tiles: hidden ones are "???" until unlocked; icons; count', () => {
  const def = {
    id: '1',
    key: 'secret',
    title: 'Into the void',
    description: 'Fall off the map',
    icon: '🕳️',
    hidden: true,
  };
  const locked = toAchievementTile(def, false);
  assert.equal(locked.title, '???');
  assert.equal(locked.description, null);
  assert.deepEqual(locked.icon, { kind: 'default' });
  assert.equal(locked.secret, true);
  const open = toAchievementTile(def, true);
  assert.equal(open.title, 'Into the void');
  assert.deepEqual(open.icon, { kind: 'glyph', text: '🕳️' });
  assert.equal(open.secret, false);
  const visibleLocked = toAchievementTile({ ...def, hidden: false }, false);
  assert.equal(visibleLocked.title, 'Into the void');
  assert.equal(visibleLocked.unlocked, false);

  assert.deepEqual(achievementIcon('https://cdn.example.com/a.png'), {
    kind: 'image',
    uri: 'https://cdn.example.com/a.png',
  });
  assert.deepEqual(achievementIcon(null), { kind: 'default' });
  assert.deepEqual(achievementIcon('  '), { kind: 'default' });
  assert.deepEqual(achievementIcon('trophy-gold'), { kind: 'default' });

  assert.equal(achievementCount([open, locked, visibleLocked]), '1 / 3');
  assert.equal(achievementCount([]), '0 / 0');
});

test('public profile helpers: stats parsing, case-insensitive username match', () => {
  assert.deepEqual(parsePublicStats({ achievements: 3, games_played: 5, friends: 4 }), { achievements: 3, gamesPlayed: 5, friends: 4 });
  // Hidden by privacy or a block: null (rendered as a dash), never 0.
  assert.deepEqual(parsePublicStats({ achievements: 3, games_played: null, friends: 2 }), { achievements: 3, gamesPlayed: null, friends: 2 });
  assert.deepEqual(parsePublicStats({ achievements: 3, games_played: 0 }), { achievements: 3, gamesPlayed: 0, friends: 0 });
  assert.deepEqual(parsePublicStats(null), { achievements: 0, gamesPlayed: null, friends: 0 });
  assert.deepEqual(parsePublicStats({ achievements: '2', games_played: -1, friends: 'x' }), { achievements: 2, gamesPlayed: 0, friends: 0 });
  assert.equal(sameUsername('Ann', 'ann'), true);
  assert.equal(sameUsername('ann', 'bob'), false);
  assert.equal(sameUsername(undefined, 'ann'), false);
});
