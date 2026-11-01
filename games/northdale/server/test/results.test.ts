import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACHIEVEMENTS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PALETTE,
  RESULT_BOARDS,
  runAchievements,
  runBoardScores,
  type RunSummary,
  type Standing,
} from '../src/index.ts';

const st = (over: Partial<Standing>): Standing => ({
  id: 'x',
  name: 'x',
  slot: 0,
  kills: 0,
  guitarKills: 0,
  revives: 0,
  downs: 0,
  foundDog: false,
  placement: 2,
  ...over,
});

const summary: RunSummary = {
  run: 1,
  nights: 5,
  duration: 1500,
  escaped: true,
  bloodMoons: 1,
  teamKills: 210,
  standings: [
    st({ id: 'ann', kills: 120, guitarKills: 31, foundDog: true, placement: 1 }),
    st({ id: 'ben', kills: 90 }),
    st({ id: 'cat', kills: 0, placement: 3 }),
  ],
};

test('achievements: first light, blood moon, getaway, good boy, unplugged', () => {
  assert.deepEqual(runAchievements(summary, 'ann'), ['first_light', 'blood_moon', 'getaway', 'good_boy', 'unplugged']);
  assert.deepEqual(runAchievements(summary, 'ben'), ['first_light', 'blood_moon', 'getaway']);
  assert.deepEqual(runAchievements(summary, 'nobody'), []);
  const night0: RunSummary = { ...summary, nights: 0, bloodMoons: 0, escaped: false };
  assert.deepEqual(runAchievements(night0, 'ben'), []);
  const almost: RunSummary = { ...night0, standings: [st({ id: 'ann', guitarKills: 24 })] };
  assert.deepEqual(runAchievements(almost, 'ann'), []);
});

test('boards: nights and kills are best-run scores, escapes a +1 on the total board, nothing for zero', () => {
  assert.deepEqual(runBoardScores(summary, 'ann'), { nights: 5, kills: 120, escapes: 1 });
  assert.deepEqual(runBoardScores(summary, 'cat'), { nights: 5, kills: null, escapes: 1 });
  assert.deepEqual(runBoardScores({ ...summary, escaped: false, nights: 0 }, 'ben'), {
    nights: null,
    kills: 90,
    escapes: null,
  });
  assert.deepEqual(runBoardScores(summary, 'nobody'), { nights: null, kills: null, escapes: null });
});

test('game.json matches the rules: players, room, server v5, boards and achievements', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
    id: string;
    version: string;
    players: { min: number; max: number };
    server: { room: string; minVersion: number };
    leaderboards: { id: string; sort: string; mode?: string }[];
    achievements: { key: string }[];
    screenshots: string[];
  };
  assert.equal(manifest.id, 'northdale');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.players, { min: MIN_PLAYERS, max: MAX_PLAYERS });
  assert.deepEqual(manifest.server, { room: 'northdale', minVersion: 5 });
  assert.deepEqual(
    manifest.leaderboards.map((b) => b.id),
    [...RESULT_BOARDS],
  );
  assert.equal(manifest.leaderboards.find((b) => b.id === 'escapes')?.mode, 'total');
  assert.ok(manifest.leaderboards.filter((b) => b.id !== 'escapes').every((b) => b.mode === undefined));
  assert.deepEqual(manifest.achievements.map((a) => a.key).sort(), Object.keys(ACHIEVEMENTS).sort());
  assert.equal(manifest.screenshots.length, 3);
  assert.equal(PALETTE.length, MAX_PLAYERS);
});
