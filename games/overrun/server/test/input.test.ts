import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateWindow, clampStick, parseInput, stickFromDrag } from '../src/index.ts';

const ok = { mx: 0.5, my: 0, ax: 3, ay: 4, fire: true, weapon: 2, s: 7 };

test('parseInput clamps the stick, normalizes the aim and checks every field', () => {
  assert.deepEqual(parseInput(ok), {
    input: { move: { x: 0.5, y: 0 }, aim: { x: 0.6, y: 0.8 }, fire: true, weapon: 2 },
    seq: 7,
  });
  assert.deepEqual(parseInput({ ...ok, mx: 3, my: 4 })!.input.move, { x: 0.6, y: 0.8 }, 'clamped to |m| ≤ 1');
  assert.deepEqual(parseInput({ ...ok, mx: 0.01, my: 0.02 })!.input.move, { x: 0, y: 0 }, 'dead zone');
  assert.equal(parseInput({ ...ok, ax: 0, ay: 0 })!.input.aim, null, 'zero aim = keep the last');
  assert.equal(parseInput({ ...ok, fire: 1 })!.input.fire, true);
  assert.equal(parseInput({ ...ok, fire: 0 })!.input.fire, false);
  for (const bad of [
    null,
    'x',
    { ...ok, mx: 'left' },
    { ...ok, ax: NaN },
    { ...ok, ay: Infinity },
    { ...ok, fire: 'yes' },
    { ...ok, fire: 2 },
    { ...ok, weapon: 5 },
    { ...ok, weapon: -1 },
    { ...ok, weapon: 1.5 },
    { ...ok, s: -1 },
    { ...ok, s: 2 ** 31 },
    { ...ok, s: undefined },
  ]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
  }
});

test('sticks: clamping and drags', () => {
  assert.equal(clampStick('a', 0), null);
  assert.deepEqual(clampStick(10, 0), { x: 1, y: 0 });
  assert.deepEqual(stickFromDrag(28, 0, 56), { x: 0.5, y: 0 });
  assert.deepEqual(stickFromDrag(0, 200, 56), { x: 0, y: 1 });
});

test('RateWindow allows `limit` messages per rolling second', () => {
  const w = new RateWindow(3);
  assert.deepEqual(
    [0, 10, 20, 30].map((t) => w.allow(t)),
    [true, true, true, false],
  );
  assert.equal(w.allow(1000), true, 'the first one left the window');
  assert.equal(w.allow(1001), false);
});
