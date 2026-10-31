import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARENA_HALF_H,
  ARENA_HALF_W,
  BARRELS,
  MEDS,
  OBSTACLES,
  PLACEMENTS,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSTS,
  PROP_BOUNDS,
  SPAWNS,
  circleIsFree,
  lineOfSight,
  movePlayer,
  pushCircleOutOfAabb,
  pushCircleOutOfCircle,
  rayAabb,
  rayCircle,
  rayCircles,
  rotateQuarter,
  type Aabb,
} from '../src/index.ts';

const box: Aabb = { x0: 2, y0: -1, x1: 3, y1: 1 };

test('rays against boxes and circles: distance to the first surface, null on a miss or past the range', () => {
  assert.equal(rayAabb(0, 0, 1, 0, box, 10), 2);
  assert.equal(rayAabb(0, 0, -1, 0, box, 10), null, 'behind');
  assert.equal(rayAabb(0, 0, 1, 0, box, 1.5), null, 'out of range');
  assert.equal(rayAabb(2.5, 0, 1, 0, box, 10), 0, 'origin inside');
  assert.ok(Math.abs(rayCircle(0, 0, 1, 0, 5, 0, 1, 10)! - 4) < 1e-12);
  assert.equal(rayCircle(0, 0, 1, 0, 5, 1.5, 1, 10), null, 'misses');
  assert.equal(
    rayCircles(
      0,
      0,
      1,
      0,
      [
        { x: 5, y: 0, r: 1 },
        { x: 3, y: 0, r: 0.5 },
      ],
      10,
    ),
    2.5,
    'the nearest circle',
  );
  assert.equal(rayCircles(0, 0, 1, 0, [], 7), 7, 'nothing in the way');
  assert.equal(lineOfSight(0, 0, 10, 0, [box]), false);
  assert.equal(lineOfSight(0, 0, 10, 0, [], [{ x: 5, y: 0.2, r: 0.5 }]), false, 'a post in the way');
  assert.equal(lineOfSight(0, 3, 10, 3, [box], [{ x: 5, y: 0, r: 1 }]), true);
});

test('circles are pushed out of boxes and circles along the shortest way', () => {
  const p = { x: 1.8, y: 0 };
  assert.equal(pushCircleOutOfAabb(p, 0.5, box), true);
  assert.ok(Math.abs(p.x - 1.5) < 1e-12 && p.y === 0);
  const q = { x: 0.5, y: 0 };
  assert.equal(pushCircleOutOfCircle(q, 0.5, { x: 0, y: 0, r: 1 }), true);
  assert.ok(Math.abs(q.x - 1.5) < 1e-12 && q.y === 0);
  const centred = { x: 0, y: 0 };
  pushCircleOutOfCircle(centred, 0.5, { x: 0, y: 0, r: 1 });
  assert.deepEqual(centred, { x: 1.5, y: 0 }, 'exactly on the centre: a fixed axis');
  assert.equal(pushCircleOutOfCircle({ x: 3, y: 0 }, 0.5, { x: 0, y: 0, r: 1 }), false);
});

test('quarter turns follow PlayCanvas (yaw about +y): +x turns to -z, then -x, then +z', () => {
  assert.deepEqual(rotateQuarter(1, 0, 0), [1, 0]);
  assert.deepEqual(rotateQuarter(1, 0, 1), [0, -1]);
  assert.deepEqual(rotateQuarter(1, 0, 2), [-1, -0]);
  assert.deepEqual(rotateQuarter(1, 0, 3), [-0, 1]);
  assert.deepEqual(rotateQuarter(0, 1, 1), [1, -0]);
});

test('the yard: colliders from the placements, everything inside the fence, spawns / barrels / med kits clear', () => {
  assert.ok(OBSTACLES.length >= 20 && POSTS.length >= 3, `${OBSTACLES.length} boxes, ${POSTS.length} posts`);
  for (const o of OBSTACLES) {
    assert.ok(o.x0 < o.x1 && o.y0 < o.y1, `${o.prop} is a box`);
    assert.ok(o.x0 >= -ARENA_HALF_W - 1 && o.x1 <= ARENA_HALF_W + 1, `${o.prop} inside the fence (x)`);
    assert.ok(o.y0 >= -ARENA_HALF_H - 1 && o.y1 <= ARENA_HALF_H + 1, `${o.prop} inside the fence (y)`);
  }
  // A rotated container's collider is its footprint turned a quarter.
  const green = PLACEMENTS.find((p) => p.prop === 'Container_Long' && p.rot === 1)!;
  const c = OBSTACLES.find(
    (o) => Math.abs((o.x0 + o.x1) / 2 - green.x) < 0.2 && Math.abs((o.y0 + o.y1) / 2 - green.y) < 0.2,
  )!;
  const [x0, z0, x1, z1] = PROP_BOUNDS.Container_Long;
  assert.ok(Math.abs(c.x1 - c.x0 - (z1 - z0)) < 1e-9 && Math.abs(c.y1 - c.y0 - (x1 - x0)) < 1e-9, 'turned');
  for (const s of SPAWNS) assert.ok(circleIsFree(s.x, s.y, PLAYER_RADIUS), `spawn ${s.x}, ${s.y} is free`);
  for (const b of [...BARRELS, ...MEDS]) assert.ok(circleIsFree(b.x, b.y, 0.5), `${b.x}, ${b.y} is free`);
  assert.ok(SPAWNS.length >= 16, 'room for eight players to spread out');
});

test('every spawn reaches every other on foot (no walled-in pocket)', () => {
  // Flood fill over a 0.5-unit grid of player-sized free points from the first spawn.
  const step = 0.5;
  const cols = Math.round((ARENA_HALF_W * 2) / step);
  const rows = Math.round((ARENA_HALF_H * 2) / step);
  const free = (c: number, r: number) =>
    circleIsFree(-ARENA_HALF_W + (c + 0.5) * step, -ARENA_HALF_H + (r + 0.5) * step, PLAYER_RADIUS);
  const cell = (x: number, y: number) => [Math.floor((x + ARENA_HALF_W) / step), Math.floor((y + ARENA_HALF_H) / step)];
  const seen = new Uint8Array(cols * rows);
  const [c0, r0] = cell(SPAWNS[0]!.x, SPAWNS[0]!.y);
  const queue = [[c0!, r0!]];
  seen[r0! * cols + c0!] = 1;
  while (queue.length) {
    const [c, r] = queue.pop()!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nc = c! + dc!;
      const nr = r! + dr!;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen[nr * cols + nc] || !free(nc, nr)) continue;
      seen[nr * cols + nc] = 1;
      queue.push([nc, nr]);
    }
  }
  for (const s of SPAWNS) {
    const [c, r] = cell(s.x, s.y);
    assert.equal(seen[r! * cols + c!], 1, `spawn ${s.x}, ${s.y} is reachable`);
  }
});

test('players slide along walls, never end up inside anything, and bump into standing barrels', () => {
  // Random walks stay out of every obstacle and post and inside the fence.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const p = { x: 0, y: -1, vx: 0, vy: 0 };
  for (let i = 0; i < 4000; i++) {
    movePlayer(p, { x: rnd(), y: rnd() }, 1, 0, 1 / 30);
    assert.ok(circleIsFree(p.x, p.y, PLAYER_RADIUS - 1e-6), `free at step ${i}: ${p.x}, ${p.y}`);
  }
  // Top speed, the knife rung's bonus, and any dt gives the same answer as 1/30 steps.
  const a = { x: 0, y: -1, vx: 0, vy: 0 };
  for (let i = 0; i < 30; i++) movePlayer(a, { x: 1, y: 0 }, 1, 0, 1 / 30);
  assert.ok(Math.abs(a.vx - PLAYER_SPEED) < 0.01, `top speed ${a.vx}`);
  const fast = { x: 0, y: -1, vx: 0, vy: 0 };
  for (let i = 0; i < 30; i++) movePlayer(fast, { x: 1, y: 0 }, 1.15, 0, 1 / 30);
  assert.ok(Math.abs(fast.vx - PLAYER_SPEED * 1.15) < 0.01);
  const b = { x: 0, y: -1, vx: 0, vy: 0 };
  movePlayer(b, { x: 1, y: 0 }, 1, 0, 1);
  assert.ok(Math.abs(b.x - a.x) < 1e-9, 'one long step = thirty short ones');
  // A standing barrel stops you; with it down you walk through its spot.
  const barrel = BARRELS[0]!;
  const into = (bits: number) => {
    const body = { x: barrel.x - 2, y: barrel.y, vx: 0, vy: 0 };
    for (let i = 0; i < 30; i++) movePlayer(body, { x: 1, y: 0 }, 1, bits, 1 / 30);
    return body.x;
  };
  assert.ok(into(1) <= barrel.x - 0.5 - PLAYER_RADIUS + 1e-6, 'blocked by the barrel');
  assert.ok(into(0) > barrel.x, 'no barrel, no block');
});
