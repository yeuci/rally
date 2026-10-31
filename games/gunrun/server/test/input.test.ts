import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HISTORY_TICKS, MAX_REWIND_TICKS, PositionHistory, RateWindow, clampStick, parseInput } from '../src/index.ts';

const ok = { mx: 0.5, my: 0, ax: 3, ay: 4, fire: true, melee: false, rt: 120.5, s: 7 };

test('parseInput clamps the stick, normalizes the aim and checks every field', () => {
  assert.deepEqual(parseInput(ok), {
    input: { move: { x: 0.5, y: 0 }, aim: { x: 0.6, y: 0.8 }, fire: true, melee: false },
    seq: 7,
    rt: 120.5,
  });
  assert.deepEqual(parseInput({ ...ok, mx: 3, my: 4 })!.input.move, { x: 0.6, y: 0.8 }, 'clamped to |m| ≤ 1');
  assert.deepEqual(parseInput({ ...ok, mx: 0.01, my: 0.02 })!.input.move, { x: 0, y: 0 }, 'dead zone');
  assert.equal(parseInput({ ...ok, ax: 0, ay: 0 })!.input.aim, null, 'zero aim = keep the last');
  assert.equal(parseInput({ ...ok, melee: 1 })!.input.melee, true);
  assert.equal(parseInput({ ...ok, melee: undefined })!.input.melee, false, 'melee is optional');
  assert.equal(parseInput({ ...ok, rt: -1 })!.rt, null, 'a bad view tick is ignored, not fatal');
  assert.equal(parseInput({ ...ok, rt: 'x' })!.rt, null);
  for (const bad of [
    null,
    'x',
    { ...ok, mx: 'left' },
    { ...ok, ax: NaN },
    { ...ok, fire: 'yes' },
    { ...ok, fire: 2 },
    { ...ok, melee: 'no' },
    { ...ok, s: -1 },
    { ...ok, s: 2 ** 31 },
    { ...ok, s: undefined },
  ]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
  }
  assert.equal(clampStick('a', 0), null);
});

test('RateWindow allows `limit` messages per rolling second', () => {
  const w = new RateWindow(3);
  assert.deepEqual(
    [0, 10, 20, 30].map((t) => w.allow(t)),
    [true, true, true, false],
  );
  assert.equal(w.allow(1000), true);
});

test('position history: interpolated rewinds, now for the present, nothing from an earlier life or while dead', () => {
  const h = new PositionHistory();
  for (let t = 1; t <= 20; t++) h.record(t, t, 0, t !== 12, 1);
  const now = { x: 21, y: 0 };
  assert.deepEqual(h.at(18, 1, now, 21), { x: 18, y: 0 });
  assert.deepEqual(h.at(17.25, 1, now, 21), { x: 17.25, y: 0 }, 'between two ticks');
  assert.deepEqual(h.at(20.5, 1, now, 21), { x: 20.5, y: 0 }, 'between the last record and now');
  assert.deepEqual(h.at(21, 1, now, 21), now);
  assert.equal(h.at(12, 1, now, 21), null, 'dead then');
  assert.equal(h.at(18, 2, now, 21), null, 'another life');
  assert.deepEqual(h.at(21 - HISTORY_TICKS - 2, 1, now, 21), { x: 21 - HISTORY_TICKS, y: 0 }, 'older: the oldest');
  h.clear();
  assert.equal(h.at(18, 1, now, 21), null, 'cleared (a respawn)');
  assert.ok(MAX_REWIND_TICKS < HISTORY_TICKS, 'the history covers the longest rewind');
});
