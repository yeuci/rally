import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_DEADZONE, RateWindow, clampStick, parseInput, stickFromDrag, stickFromKeys } from '../src/index.ts';

test('clampStick: passes valid sticks, normalizes long ones, zeroes the dead zone', () => {
  assert.deepEqual(clampStick(0.5, -0.25), { x: 0.5, y: -0.25 });
  const long = clampStick(3, 4)!;
  assert.ok(Math.abs(long.x - 0.6) < 1e-12 && Math.abs(long.y - 0.8) < 1e-12);
  assert.deepEqual(clampStick(INPUT_DEADZONE / 2, 0), { x: 0, y: 0 });
  const huge = clampStick(1e300, 1e300)!;
  assert.ok(Math.abs(Math.hypot(huge.x, huge.y) - 1) < 1e-12);
});

test('clampStick: rejects non-numbers and non-finite values', () => {
  for (const [x, y] of [
    [NaN, 0],
    [0, Infinity],
    ['1', 0],
    [null, 0],
    [undefined, undefined],
    [{}, 1],
  ] as [unknown, unknown][]) {
    assert.equal(clampStick(x, y), null, `${String(x)}, ${String(y)}`);
  }
});

test('parseInput: requires an object with a stick and an integer sequence', () => {
  assert.deepEqual(parseInput({ x: 1, y: 0, s: 7 }), { stick: { x: 1, y: 0 }, seq: 7 });
  assert.deepEqual(parseInput({ x: 2, y: 0, s: 0 }), { stick: { x: 1, y: 0 }, seq: 0 });
  assert.equal(parseInput(null), null);
  assert.equal(parseInput('x'), null);
  assert.equal(parseInput({ x: 1, y: 0 }), null);
  assert.equal(parseInput({ x: 1, y: 0, s: 1.5 }), null);
  assert.equal(parseInput({ x: 1, y: 0, s: -1 }), null);
  assert.equal(parseInput({ x: 1, y: 0, s: 2 ** 31 }), null);
  assert.equal(parseInput({ x: 'a', y: 0, s: 1 }), null);
});

test('RateWindow: at most `limit` per rolling second', () => {
  const w = new RateWindow(3);
  assert.equal(w.allow(0), true);
  assert.equal(w.allow(100), true);
  assert.equal(w.allow(200), true);
  assert.equal(w.allow(300), false);
  assert.equal(w.allow(999), false);
  assert.equal(w.allow(1000), true, 'the first one expired');
  assert.equal(w.allow(1050), false);
  assert.equal(w.allow(1100), true);
});

test('stickFromKeys: unit vectors, diagonals normalized, opposites cancel', () => {
  assert.deepEqual(stickFromKeys(false, true, false, false), { x: 1, y: 0 });
  assert.deepEqual(stickFromKeys(false, false, true, false), { x: 0, y: -1 });
  const diag = stickFromKeys(true, false, false, true);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - 1) < 1e-12 && diag.x < 0 && diag.y > 0);
  assert.deepEqual(stickFromKeys(true, true, false, false), { x: 0, y: 0 });
});

test('stickFromDrag: radius = full deflection, clamped beyond', () => {
  assert.deepEqual(stickFromDrag(30, 0, 60), { x: 0.5, y: 0 });
  const far = stickFromDrag(0, 600, 60);
  assert.ok(Math.abs(far.y - 1) < 1e-12);
  assert.deepEqual(stickFromDrag(1, 1, 60), { x: 0, y: 0 });
});
