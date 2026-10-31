import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotBuffer } from '../src/interpolation.ts';
import { TwinStickTracker } from '../src/twinstick.ts';

const W = 800;

test('twin stick: the left half moves, the right half aims, each with its own finger', () => {
  const t = new TwinStickTracker({ radius: 50 });
  assert.equal(t.down(1, 100, 300, W), 'move');
  assert.equal(t.down(2, 600, 300, W), 'aim');
  t.drag(1, 125, 300);
  assert.deepEqual(t.move, { x: 0.5, y: 0 });
  assert.equal(t.aim, null, 'no aim before a drag');
  assert.equal(t.aiming, true);
  t.drag(2, 600, 280);
  assert.deepEqual(t.aim, { x: 0, y: -1 });
  t.drag(1, 100, 500);
  assert.deepEqual(t.move, { x: 0, y: 1 }, 'clamped to 1');
  t.drag(1, 102, 301);
  assert.deepEqual(t.move, { x: 0, y: 0 }, 'dead zone');
});

test('twin stick: a second finger on a side is ignored, and only a stick’s own finger releases it', () => {
  const t = new TwinStickTracker({ radius: 50 });
  t.down(1, 100, 300, W);
  t.drag(1, 150, 300);
  assert.equal(t.down(3, 200, 200, W), null, 'second finger on the move side');
  t.drag(3, 0, 0);
  assert.deepEqual(t.move, { x: 1, y: 0 }, 'not moved by the other finger');
  assert.equal(t.up(3), null, 'lifting the ignored finger releases nothing');
  assert.deepEqual(t.move, { x: 1, y: 0 }, 'still dragging');
  assert.equal(t.up(1), 'move');
  assert.deepEqual(t.move, { x: 0, y: 0 });
  // A finger cannot drive both sticks.
  t.down(5, 700, 100, W);
  assert.equal(t.down(5, 100, 100, W), null);
});

test('twin stick: the aim direction survives a short tap and a release; releaseAll drops both fingers', () => {
  const t = new TwinStickTracker({ aimDeadzonePx: 10 });
  t.down(2, 600, 300, W);
  t.drag(2, 630, 300);
  assert.deepEqual(t.aim, { x: 1, y: 0 });
  t.up(2);
  assert.equal(t.aiming, false);
  t.down(4, 500, 100, W);
  t.drag(4, 503, 101);
  assert.deepEqual(t.aim, { x: 1, y: 0 }, 'a jiggle inside the dead zone keeps the last aim');
  t.down(1, 50, 50, W);
  t.releaseAll();
  assert.equal(t.aiming, false);
  assert.equal(t.moveFinger, null);
  assert.deepEqual(t.aim, { x: 1, y: 0 });
  assert.equal(new TwinStickTracker({ split: 0.3 }).down(1, 300, 0, 800), 'aim', 'custom split');
});

test('SnapshotBuffer.idsAt: the entities of the snapshot shown at a time', () => {
  const b = new SnapshotBuffer({ fields: ['x'] as const });
  assert.deepEqual([...b.idsAt(0)], []);
  b.push(100, [
    ['a', { x: 0 }],
    ['b', { x: 0 }],
  ]);
  b.push(150, [['a', { x: 1 }]]);
  assert.deepEqual([...b.idsAt(120)], ['a', 'b'], 'b is still there at 120');
  assert.deepEqual([...b.idsAt(150)], ['a']);
  assert.deepEqual([...b.idsAt(50)], ['a', 'b'], 'before every snapshot: the oldest');
});
