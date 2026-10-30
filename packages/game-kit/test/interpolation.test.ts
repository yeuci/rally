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

test('an older push starts a new timeline', () => {
  const b = buf();
  b.push(5000, [['a', { x: 9, y: 9 }]]);
  b.push(1000, [['a', { x: 1, y: 1 }]]);
  assert.equal(b.size, 1);
  assert.equal(b.newest, 1000);
  assert.deepEqual(b.sampleAt('a', 1000), { x: 1, y: 1 });
});

test('sampleAt takes the render time directly (server timeline)', () => {
  const b = buf();
  const tick = 1000 / 30;
  b.push(0, [['a', { x: 0, y: 0 }]]);
  b.push(tick, [['a', { x: 1, y: 0 }]]); // 1 tick
  b.push(3 * tick, [['a', { x: 3, y: 0 }]]); // 2 ticks: the same speed on the server timeline
  for (const t of [10, tick, 50, 80]) assert.ok(Math.abs(b.sampleAt('a', t)!.x - t / tick) < 1e-9, `t=${t}`);
});

test('Hermite: positions match at the snapshots, speed is continuous across them', () => {
  const b = new SnapshotBuffer({ fields: ['x', 'v'] as const, rates: { x: 'v' }, delayMs: 0 });
  // x = t² (per second): v = 2t.
  for (const t of [0, 0.05, 0.1, 0.15]) b.push(t * 1000, [['a', { x: t * t, v: 2 * t }]]);
  for (const t of [0.05, 0.1]) assert.ok(Math.abs(b.sampleAt('a', t * 1000)!.x - t * t) < 1e-12);
  // A cubic through a quadratic with exact slopes reproduces it in between.
  for (const t of [0.02, 0.07, 0.125]) assert.ok(Math.abs(b.sampleAt('a', t * 1000)!.x - t * t) < 1e-12, `t=${t}`);
  const speed = (t: number) => (b.sampleAt('a', t + 0.01)!.x - b.sampleAt('a', t - 0.01)!.x) / 0.02;
  assert.ok(Math.abs(speed(50) - speed(50.02)) < 1e-6, 'no kink at a snapshot');
  // Rate fields themselves are interpolated linearly.
  assert.ok(Math.abs(b.sampleAt('a', 75)!.v - 0.15) < 1e-12);
});

test('extrapolates at most extrapolateMs past the newest snapshot, then holds', () => {
  const withRates = new SnapshotBuffer({ fields: ['x', 'vx'] as const, rates: { x: 'vx' }, extrapolateMs: 50 });
  withRates.push(0, [['a', { x: 0, vx: 10 }]]);
  withRates.push(50, [['a', { x: 0.5, vx: 10 }]]);
  assert.ok(Math.abs(withRates.sampleAt('a', 75)!.x - 0.75) < 1e-12, 'from the rates');
  assert.ok(Math.abs(withRates.sampleAt('a', 100)!.x - 1) < 1e-12);
  assert.ok(Math.abs(withRates.sampleAt('a', 400)!.x - 1) < 1e-12, 'held after one interval');
  const linear = new SnapshotBuffer({ fields: ['x'] as const, extrapolateMs: 20 });
  linear.push(0, [['a', { x: 0 }]]);
  linear.push(50, [['a', { x: 5 }]]);
  assert.ok(Math.abs(linear.sampleAt('a', 60)!.x - 6) < 1e-12, 'from the last two snapshots');
  assert.ok(Math.abs(linear.sampleAt('a', 90)!.x - 7) < 1e-12);
  const single = new SnapshotBuffer({ fields: ['x'] as const, extrapolateMs: 20 });
  single.push(0, [['a', { x: 3 }]]);
  assert.deepEqual(single.sampleAt('a', 10), { x: 3 }, 'nothing to extrapolate from');
});

test('stickFromDirections: unit vectors, normalized diagonals, opposites cancel', () => {
  assert.deepEqual(stickFromDirections(new Set(['up'])), { x: 0, y: -1 });
  const d = stickFromDirections(new Set(['down', 'right']));
  assert.ok(Math.abs(d.x - Math.SQRT1_2) < 1e-12 && Math.abs(d.y - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(stickFromDirections(new Set(['left', 'right'])), { x: 0, y: 0 });
  assert.deepEqual(stickFromDirections(new Set()), { x: 0, y: 0 });
});
