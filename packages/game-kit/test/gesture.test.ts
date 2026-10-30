import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GestureTracker } from '../src/gesture.ts';

function track(opts = {}) {
  const log: string[] = [];
  const g = new GestureTracker(
    {
      onPress: (e) => log.push(`press ${e.x},${e.y}@${e.time}`),
      onTap: (e) => log.push(`tap ${e.x},${e.y}`),
      onDragStart: (e) => log.push(`dragstart ${e.startX},${e.startY}`),
      onDrag: (e) => log.push(`drag ${e.x},${e.y} d${e.dx},${e.dy}`),
      onDragEnd: (e) => log.push(`dragend ${e.x},${e.y}`),
    },
    opts,
  );
  return { g, log };
}

test('press fires on down; a short, still release is a tap', () => {
  const { g, log } = track();
  g.down(1, 'touch', { x: 10, y: 10, time: 0 });
  g.move(1, { x: 13, y: 12, time: 20 });
  g.up(1, { x: 13, y: 12, time: 80 });
  assert.deepEqual(log, ['press 10,10@0', 'tap 13,12']);
});

test('moving past the slop turns it into a drag (no tap)', () => {
  const { g, log } = track({ tapSlop: 5 });
  g.down(1, 'mouse', { x: 0, y: 0, time: 0 });
  g.move(1, { x: 10, y: 0, time: 10 });
  g.move(1, { x: 15, y: 4, time: 20 });
  g.up(1, { x: 15, y: 4, time: 30 });
  assert.deepEqual(log, ['press 0,0@0', 'dragstart 0,0', 'drag 10,0 d10,0', 'drag 15,4 d5,4', 'dragend 15,4']);
});

test('long press is not a tap; second pointer and foreign ids are ignored; cancel ends a drag', () => {
  const { g, log } = track({ tapMaxMs: 100 });
  g.down(1, 'touch', { x: 0, y: 0, time: 0 });
  assert.equal(g.down(2, 'touch', { x: 50, y: 50, time: 5 }), false);
  g.up(2, { x: 50, y: 50, time: 10 });
  g.up(1, { x: 0, y: 0, time: 500 });
  assert.deepEqual(log, ['press 0,0@0']);

  log.length = 0;
  g.down(3, 'touch', { x: 0, y: 0, time: 0 });
  g.move(3, { x: 30, y: 0, time: 10 });
  g.cancel(3);
  assert.equal(g.isDown, false);
  assert.deepEqual(log, ['press 0,0@0', 'dragstart 0,0', 'drag 30,0 d30,0', 'dragend 30,0']);
});
