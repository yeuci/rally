import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FlowField,
  OBSTACLES,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  circleIsFree,
  lineOfSight,
  movePlayer,
  pushCircleOutOfAabb,
  rayAabb,
  rayCircle,
  type Aabb,
} from '../src/index.ts';

const box: Aabb = { x0: 2, y0: -1, x1: 3, y1: 1 };

test('rays against boxes and circles: distance to the first surface, null on a miss or past the range', () => {
  assert.equal(rayAabb(0, 0, 1, 0, box, 10), 2);
  assert.equal(rayAabb(0, 0, -1, 0, box, 10), null, 'behind');
  assert.equal(rayAabb(0, 0, 1, 0, box, 1.5), null, 'out of range');
  assert.equal(rayAabb(0, 2, 1, 0, box, 10), null, 'passes above');
  assert.equal(rayAabb(2.5, 0, 1, 0, box, 10), 0, 'origin inside');
  assert.ok(Math.abs(rayCircle(0, 0, 1, 0, 5, 0, 1, 10)! - 4) < 1e-12);
  assert.equal(rayCircle(0, 0, 1, 0, 5, 1.5, 1, 10), null, 'misses');
  assert.equal(rayCircle(0, 0, -1, 0, 5, 0, 1, 10), null, 'behind');
  assert.equal(rayCircle(5, 0, 1, 0, 5, 0, 1, 10), 0, 'inside');
});

test('circles are pushed out of boxes along the shortest way', () => {
  const p = { x: 1.8, y: 0 };
  assert.equal(pushCircleOutOfAabb(p, 0.5, box), true);
  assert.ok(Math.abs(p.x - 1.5) < 1e-12 && p.y === 0);
  const inside = { x: 2.9, y: 0.2 };
  pushCircleOutOfAabb(inside, 0.5, box);
  assert.ok(Math.abs(inside.x - 3.5) < 1e-12, 'leaves through the nearest side');
  assert.equal(pushCircleOutOfAabb({ x: 0, y: 0 }, 0.5, box), false);
});

test('players slide along walls and never end up inside an obstacle', () => {
  // Up into the north wall's left segment (x -7…-1, y -8.3…-7.7) from below: it stops there...
  const body = { x: -4, y: -6.5, vx: 0, vy: 0 };
  for (let i = 0; i < 20; i++) movePlayer(body, { x: 0, y: -1 }, false, 1 / 30);
  assert.ok(Math.abs(body.y - (-7.7 + PLAYER_RADIUS)) < 1e-9, `stopped at the wall (y ${body.y})`);
  assert.ok(Math.abs(body.vy) < 1e-9, 'no speed into the wall');
  // ...and pushing diagonally slides along it at the sideways part of the speed.
  for (let i = 0; i < 10; i++) movePlayer(body, { x: 0.6, y: -0.8 }, false, 1 / 30);
  assert.ok(Math.abs(body.y - (-7.7 + PLAYER_RADIUS)) < 1e-9, 'still against the wall');
  assert.ok(body.x > -4 + 0.6 * PLAYER_SPEED * 0.25, `slid right along it (x ${body.x})`);
  // Random walks stay out of every obstacle and inside the fence.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const p = { x: 0, y: 0, vx: 0, vy: 0 };
  for (let i = 0; i < 3000; i++) {
    movePlayer(p, { x: rnd(), y: rnd() }, false, 1 / 30);
    assert.ok(circleIsFree(p.x, p.y, PLAYER_RADIUS - 1e-6), `free at step ${i}: ${p.x}, ${p.y}`);
  }
  // Top speed, and any dt gives the same answer as 1/30 steps.
  const a = { x: 0, y: 0, vx: 0, vy: 0 };
  const b = { x: 0, y: 0, vx: 0, vy: 0 };
  for (let i = 0; i < 30; i++) movePlayer(a, { x: 1, y: 0 }, false, 1 / 30);
  movePlayer(b, { x: 1, y: 0 }, false, 1);
  assert.ok(Math.abs(a.vx - PLAYER_SPEED) < 0.01);
  assert.ok(Math.abs(a.x - b.x) < 1e-9, 'split into ticks');
  const down = { x: 0, y: 0, vx: 0, vy: 0 };
  for (let i = 0; i < 30; i++) movePlayer(down, { x: 1, y: 0 }, true, 1 / 30);
  assert.ok(down.x < 1, 'crawling while down');
});

test('the flow field leads around walls to the nearest target, and every free cell can reach the plaza', () => {
  const f = new FlowField(OBSTACLES);
  f.compute([{ x: 0, y: 0 }]);
  let free = 0;
  for (let c = 0; c < f.cols * f.rows; c++) {
    if (f.blocked[c]) continue;
    free++;
    assert.notEqual(f.dist[c], 0x7fffffff, `cell ${c} reachable`);
  }
  assert.ok(free > f.cols * f.rows * 0.75, `${free} free cells`);

  // Behind the north wall (no line of sight to the plaza): following the field gets there without crossing it.
  const start = { x: -4, y: -10 };
  assert.equal(lineOfSight(start.x, start.y, 0, 0, OBSTACLES), false, 'the wall is in the way');
  const pos = { ...start };
  let steps = 0;
  for (; steps < 400 && Math.hypot(pos.x, pos.y) > 1; steps++) {
    const d = f.direction(pos.x, pos.y);
    assert.ok(d, `a direction at ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}`);
    pos.x += d.x * 0.1;
    pos.y += d.y * 0.1;
    assert.ok(circleIsFree(pos.x, pos.y, 0.2), `never inside an obstacle (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`);
  }
  assert.ok(Math.hypot(pos.x, pos.y) <= 1, 'arrived');
  // It went through the gap in the wall (x within ±1 at y = -8), a longer way than the straight line.
  assert.ok(steps * 0.1 > Math.hypot(start.x, start.y) + 0.5, `path ${(steps * 0.1).toFixed(1)} u`);

  // Two targets: each side of the arena heads for its own.
  f.compute([
    { x: -20, y: 0 },
    { x: 20, y: 0 },
  ]);
  assert.ok(f.direction(-15, 10)!.x < 0);
  assert.ok(f.direction(16, -10)!.x > 0);
  assert.ok(f.distanceAt(-20, 0) === 0 && f.distanceAt(20, 0) === 0);
  f.compute([]);
  assert.equal(f.direction(0, 0), null, 'no targets: no direction');
});
