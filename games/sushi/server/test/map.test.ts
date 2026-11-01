import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACHIEVEMENTS,
  BAR,
  BELT,
  BELT_LENGTH,
  INTERACT_RANGE,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  RESULT_BOARDS,
  SEATS,
  SPAWNS,
  STATIONS,
  Zone,
  beltPoint,
  beltProject,
  clampStick,
  dayAchievements,
  dayBoardScores,
  findPath,
  isFree,
  movePlayer,
  parseInput,
  parseVote,
  RateWindow,
  zonesOn,
  type DaySummary,
} from '../src/index.ts';

test('the belt: a closed loop; projecting a point on it gives it back', () => {
  const a = beltPoint(0);
  const b = beltPoint(BELT_LENGTH);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, 'closed');
  for (let s = 0; s < BELT_LENGTH; s += 0.37) {
    const p = beltPoint(s);
    assert.ok(Math.abs(beltProject(p.x, p.y) - s) < 1e-6, `s = ${s}`);
    const q = beltPoint(s + 0.05);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y) < 0.051, 'continuous');
  }
  // The kitchen side runs left to right (the pass), the front right to left past the stools.
  assert.ok(beltPoint(1).x > beltPoint(0).x && beltPoint(1).y < BELT.cy);
  assert.ok(beltPoint(BELT_LENGTH / 2 + 2).x < beltPoint(BELT_LENGTH / 2 + 1).x);
});

test('every station can be reached from every spawn on every day, and stands within reach', () => {
  for (const day of [1, 3, 6, 7]) {
    const zones = zonesOn(day);
    for (const s of STATIONS) {
      if (s.zone && !(zones & s.zone)) continue;
      const path = findPath(zones, SPAWNS[0]!, s);
      assert.ok(path, `day ${day}: a path to station ${s.id} (${s.type})`);
      const end = path.at(-1) ?? SPAWNS[0]!;
      assert.ok(Math.hypot(end.x - s.x, end.y - s.y) <= INTERACT_RANGE - 0.15, `day ${day}: station ${s.id} in reach`);
    }
    for (const seat of SEATS) {
      if (seat.zone && !(zones & seat.zone)) continue;
      const path = findPath(zones, SPAWNS[1]!, seat);
      assert.ok(path, `day ${day}: a path to seat ${seat.id}`);
      const end = path.at(-1) ?? SPAWNS[1]!;
      assert.ok(Math.hypot(end.x - seat.x, end.y - seat.y) <= INTERACT_RANGE, `day ${day}: seat ${seat.id} in reach`);
    }
  }
  for (const sp of SPAWNS) assert.ok(isFree(sp.x, sp.y, 0), 'spawns are clear');
  assert.equal(SPAWNS.length, MAX_PLAYERS);
});

test('chefs slide along the bar and stay inside; the shoji and the back door only open on their days', () => {
  const body = { x: BELT.cx, y: BAR.y - BAR.r - 1, vx: 0, vy: 0 };
  for (let i = 0; i < 60; i++) movePlayer(body, { x: 0, y: 1 }, 1, 0, 1 / 30);
  assert.ok(body.y <= BAR.y - BAR.r - PLAYER_RADIUS + 1e-6, 'stopped by the bar');
  const walk = (zones: number, from: { x: number; y: number }, stick: { x: number; y: number }) => {
    const b = { ...from, vx: 0, vy: 0 };
    for (let i = 0; i < 120; i++) movePlayer(b, stick, 1, zones, 1 / 30);
    return b;
  };
  assert.ok(walk(0, { x: 7, y: -1 }, { x: 1, y: 0 }).x < 8, 'the shoji screens hold on Monday');
  assert.ok(walk(Zone.dining, { x: 7, y: -1 }, { x: 1, y: 0 }).x > 9, 'and slide away on Wednesday');
  assert.ok(walk(0, { x: -7, y: -3 }, { x: -1, y: 0 }).x > -8, 'the back door is shut');
  assert.ok(walk(Zone.alley, { x: -7, y: -3 }, { x: -1, y: 0 }).x < -8.5, 'and open on Saturday');
  assert.ok(walk(Zone.terrace, { x: 0, y: 4 }, { x: 0, y: 1 }).y > 6, 'the terrace on Sunday');
  assert.ok(walk(0, { x: 0, y: 4 }, { x: 0, y: 1 }).y < 5.6, 'no walking out the front before');
});

test('input: sticks clamped, presses and targets validated, garbage dropped; votes 0–2; the rate window', () => {
  assert.deepEqual(clampStick(3, 4), { x: 0.6, y: 0.8 });
  assert.deepEqual(clampStick(0.01, 0), { x: 0, y: 0 });
  assert.equal(clampStick(NaN, 0), null);
  const ok = parseInput({ mx: 0.5, my: 0, b: 1, p: 3, t: 21, s: 9 });
  assert.deepEqual(ok, { input: { move: { x: 0.5, y: 0 }, button: true, presses: 3, target: 21 }, seq: 9 });
  assert.equal(parseInput({ mx: 0, my: 0, b: 1, p: -1, t: 0, s: 1 }), null);
  assert.equal(parseInput({ mx: 0, my: 0, b: 'yes', p: 1, t: 0, s: 1 }), null);
  assert.equal(parseInput({ mx: 0, my: 0, b: 0, p: 1, t: 5000, s: 1 }), null);
  assert.equal(parseInput(null), null);
  assert.equal(parseInput({ mx: 0, my: 0, b: 0, p: 1, s: 1 })!.input.target, -1, 'no target: -1');
  assert.equal(parseVote({ i: 2 }), 2);
  assert.equal(parseVote({ i: 3 }), null);
  const w = new RateWindow(2);
  assert.ok(w.allow(0) && w.allow(10));
  assert.ok(!w.allow(20));
  assert.ok(w.allow(1001));
});

const day = (over: Partial<DaySummary>): DaySummary => ({
  run: 1,
  day: 3,
  duration: 140,
  earned: 2000,
  tips: 600,
  served: 10,
  angry: 0,
  stale: 0,
  gold: 0,
  perfect: true,
  fullHouse: false,
  stars: 5,
  closed: false,
  week: false,
  crew: [],
  ...over,
});

test('results: the boards (day reached, the day’s tips) and the team achievements', () => {
  assert.deepEqual(dayBoardScores(day({})), { days: 3, tips: 600 });
  assert.deepEqual(dayBoardScores(day({ tips: 0 })), { days: 3, tips: null });
  assert.deepEqual(dayAchievements(day({})), ['five_star_day', 'belt_master']);
  assert.deepEqual(dayAchievements(day({ day: 2 })), ['five_star_day'], 'belt master counts from Wednesday');
  assert.deepEqual(dayAchievements(day({ stale: 1, stars: 4, perfect: false })), []);
  assert.deepEqual(dayAchievements(day({ week: true, day: 7, gold: 10, fullHouse: true, stale: 2 })), [
    'survive_week',
    'five_star_day',
    'gold_rush',
    'full_house',
  ]);
  assert.deepEqual(dayAchievements(day({ closed: true, perfect: false, stars: 0 })), []);
});

test('game.json declares the boards, achievements and room the server writes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    manifest.leaderboards.map((b: { id: string }) => b.id),
    [...RESULT_BOARDS],
  );
  assert.deepEqual(manifest.achievements.map((a: { key: string }) => a.key).sort(), Object.keys(ACHIEVEMENTS).sort());
  assert.equal(manifest.players.max, MAX_PLAYERS);
  assert.equal(manifest.server.room, 'sushi');
  assert.equal(manifest.server.minVersion, 5);
});
