import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateWindow, clampStick, parseInput, stickFromDrag } from '../src/index.ts';

const ok = { mx: 0.5, my: 0, ax: 3, ay: 4, fire: true, melee: 0, act: 1, use: 7, slot: 1, rt: 120.5, s: 9 };

test('parseInput: a valid message, clamped and normalized', () => {
  const p = parseInput(ok)!;
  assert.deepEqual(p.input.move, { x: 0.5, y: 0 });
  assert.deepEqual(p.input.aim, { x: 0.6, y: 0.8 });
  assert.equal(p.input.fire, true);
  assert.equal(p.input.melee, false);
  assert.equal(p.input.act, true);
  assert.equal(p.input.use, 7);
  assert.equal(p.input.slot, 1);
  assert.equal(p.seq, 9);
  assert.equal(p.rt, 120.5);
  // A stick over 1 is cut to 1; a tiny aim keeps the last one; missing use/slot/act default to 0/false.
  const q = parseInput({ mx: 3, my: 4, ax: 0, ay: 0.01, fire: false, melee: false, rt: -1, s: 1 })!;
  assert.deepEqual(q.input.move, { x: 0.6, y: 0.8 });
  assert.equal(q.input.aim, null);
  assert.equal(q.input.act, false);
  assert.equal(q.input.use, 0);
  assert.equal(q.rt, null);
});

test('parseInput: garbage is refused', () => {
  for (const bad of [
    null,
    'x',
    { ...ok, mx: 'a' },
    { ...ok, ax: Infinity },
    { ...ok, fire: 'yes' },
    { ...ok, act: 2 },
    { ...ok, use: 256 },
    { ...ok, use: 1.5 },
    { ...ok, slot: 2 },
    { ...ok, s: -1 },
    { ...ok, s: 1.5 },
  ]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
  }
});

test('sticks and the rate window', () => {
  assert.deepEqual(clampStick(0.01, 0.01), { x: 0, y: 0 });
  assert.equal(clampStick(NaN, 0), null);
  assert.deepEqual(stickFromDrag(112, 0, 56), { x: 1, y: 0 });
  const w = new RateWindow(3);
  assert.deepEqual(
    [0, 10, 20, 30, 1001, 1011].map((t) => w.allow(t)),
    [true, true, true, false, true, true],
  );
});
