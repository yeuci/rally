import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACHIEVEMENTS,
  LADDER,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PALETTE,
  RESULT_BOARDS,
  WEAPONS,
  matchAchievements,
  matchBoardScores,
  type MatchSummary,
  type Standing,
} from '../src/index.ts';

const st = (over: Partial<Standing>): Standing => ({
  id: 'x',
  name: 'x',
  slot: 0,
  bot: false,
  tier: 0,
  tierKills: 0,
  kills: 0,
  deaths: 0,
  knifeKills: 0,
  barrelKills: 0,
  bestBlast: 0,
  placement: 2,
  ...over,
});

const summary: MatchSummary = {
  match: 1,
  duration: 300,
  winner: 'ann',
  reason: 'knife',
  standings: [
    st({ id: 'ann', tier: 8, kills: 25, deaths: 0, knifeKills: 3, placement: 1 }),
    st({ id: 'ben', tier: 6, kills: 18, deaths: 9, bestBlast: 2, barrelKills: 1 }),
    st({ id: 'cat', kills: 0, deaths: 12, placement: 3 }),
  ],
};

test('achievements: a win, a flawless win, two in one blast, three demotions, a barrel kill', () => {
  assert.deepEqual(matchAchievements(summary, 'ann'), ['first_win', 'flawless', 'humiliation']);
  assert.deepEqual(matchAchievements(summary, 'ben'), ['two_for_one', 'kaboom']);
  assert.deepEqual(matchAchievements(summary, 'cat'), []);
  assert.deepEqual(matchAchievements(summary, 'nobody'), []);
  const died = { ...summary, standings: [st({ id: 'ann', deaths: 1, placement: 1 })] };
  assert.deepEqual(matchAchievements(died, 'ann'), ['first_win']);
});

test('boards: one win for the winner (total board), the match kills (best board), nothing for zero', () => {
  assert.deepEqual(matchBoardScores(summary, 'ann'), { wins: 1, kills: 25 });
  assert.deepEqual(matchBoardScores(summary, 'ben'), { wins: null, kills: 18 });
  assert.deepEqual(matchBoardScores(summary, 'cat'), { wins: null, kills: null });
  assert.deepEqual(matchBoardScores({ ...summary, winner: null }, 'ann'), { wins: null, kills: 25 });
});

test('game.json matches the rules: room, players, boards and their modes, achievements', () => {
  const game = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
    id: string;
    players: { min: number; max: number };
    server: { room: string; minVersion: number };
    leaderboards: { id: string; mode?: string }[];
    achievements: { key: string }[];
  };
  assert.equal(game.id, 'gunrun');
  assert.equal(game.server.room, 'gunrun');
  assert.ok(game.server.minVersion >= 4, 'needs a server with the gunrun room (SERVER_VERSION 4)');
  assert.deepEqual(game.players, { min: MIN_PLAYERS, max: MAX_PLAYERS });
  assert.deepEqual(
    game.leaderboards.map((b) => [b.id, b.mode ?? 'best']),
    [
      ['wins', 'total'],
      ['kills', 'best'],
    ],
  );
  assert.deepEqual(
    game.leaderboards.map((b) => b.id),
    [...RESULT_BOARDS],
  );
  assert.deepEqual(game.achievements.map((a) => a.key).sort(), Object.keys(ACHIEVEMENTS).sort());
  assert.equal(PALETTE.length, MAX_PLAYERS, 'a colour per seat');
  assert.equal(LADDER[LADDER.length - 1], 'knife');
  for (const id of LADDER) assert.ok(WEAPONS[id], id);
});
