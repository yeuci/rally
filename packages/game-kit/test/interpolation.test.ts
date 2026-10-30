import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotBuffer } from '../src/interpolation.ts';
import { stickFromDirections } from '../src/keyboard.ts';

const buf = () => new SnapshotBuffer({ fields: ['x', 'y'] as const, delayMs: 100 });

test('interpolates between the two snapshots around now - delay', () => {
  const b = buf();
  b.push(1000, [['a', { x: 0, y: 0 }]]);
  b.push(1050, [['a', { x: 10, y: -5 }]]);
  b.push(1100, [['a', { x: 20, y: -10 }]]);
  assert.deepEqual(b.sample('a', 1125), { x: 5, y: -2.5 });
  assert.deepEqual(b.sample('a', 1150), { x: 10, y: -5 });
  assert.deepEqual(b.sample('a', 1175), { x: 15, y: -7.5 });
});

test('holds the newest value past the end and the oldest before the start (no extrapolation)', () => {
  const b = buf();
  b.push(1000, [['a', { x: 1, y: 1 }]]);
  b.push(1050, [['a', { x: 2, y: 2 }]]);
  assert.deepEqual(b.sample('a', 5000), { x: 2, y: 2 });
  assert.deepEqual(b.sample('a', 900), { x: 1, y: 1 });
  assert.equal(b.sample('missing', 1100), null);
});

test('entities appearing or disappearing do not interpolate from nowhere', () => {
  const b = buf();
  b.push(1000, [['a', { x: 0, y: 0 }]]);
  b.push(1050, [
    ['a', { x: 1, y: 0 }],
    ['b', { x: 7, y: 7 }],
  ]);
  b.push(1100, [['b', { x: 8, y: 8 }]]);
  assert.deepEqual(b.sample('b', 1110), { x: 7, y: 7 }, 'newcomer shows at its first sample');
  assert.deepEqual(b.sample('a', 1175), { x: 1, y: 0 }, 'leaver holds its last sample');
});

test('stores copies, replaces same-time pushes and caps its size', () => {
  const b = new SnapshotBuffer({ fields: ['x'] as const, delayMs: 0, capacity: 3 });
  const live = { x: 1 };
  b.push(1, [['a', live]]);
  live.x = 99;
  assert.deepEqual(b.sample('a', 1), { x: 1 });
  b.push(1, [['a', { x: 2 }]]);
  assert.deepEqual(b.sample('a', 1), { x: 2 });
  for (let t = 2; t < 10; t++) b.push(t, [['a', { x: t }]]);
  assert.equal(b.size, 3);
  b.clear();
  assert.equal(b.sample('a', 9), null);
});

test('stickFromDirections: unit vectors, normalized diagonals, opposites cancel', () => {
  assert.deepEqual(stickFromDirections(new Set(['up'])), { x: 0, y: -1 });
  const d = stickFromDirections(new Set(['down', 'right']));
  assert.ok(Math.abs(d.x - Math.SQRT1_2) < 1e-12 && Math.abs(d.y - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(stickFromDirections(new Set(['left', 'right'])), { x: 0, y: 0 });
  assert.deepEqual(stickFromDirections(new Set()), { x: 0, y: 0 });
});
