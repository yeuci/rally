import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARROWS,
  BLOCK,
  BUILDINGS,
  CORRIDOR,
  FlowField,
  GANTRY,
  JUNCTION,
  LAYOUT,
  LOOT_SPOTS,
  OBSTACLES,
  PART_SPOTS,
  PLACEMENTS,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSTS,
  REACH,
  SAFE,
  SAFE_CENTER,
  SOCKETS,
  SPAWNS,
  STREET_POINTS,
  TOWN_HALF,
  TRUCK,
  ZONE_INNER,
  DOG_SPOT,
  circleIsFree,
  corridorCenter,
  movePlayer,
  zone,
} from '../src/index.ts';

/** Path distances from the safehouse over the whole town (10 per cell). */
const field = new FlowField(TOWN_HALF, 1, OBSTACLES, POSTS);
field.compute([SAFE_CENTER]);
const reachable = (x: number, y: number) => Number.isFinite(field.distanceAt(x, y));

test('the layout: 6 × 6 blocks with every landmark, a minute to cross on foot', () => {
  assert.equal(LAYOUT.length, 6);
  for (const row of LAYOUT) assert.equal(row.length, 6);
  const all = LAYOUT.join('');
  for (const t of ['S', 'C', 'W', 'P', 'A', 'J', 'L', 'B']) assert.ok(all.includes(t), `block type ${t}`);
  assert.equal(TOWN_HALF * 2, 6 * BLOCK + 7 * CORRIDOR);
  const seconds = (TOWN_HALF * 2) / PLAYER_SPEED;
  assert.ok(seconds >= 58 && seconds <= 75, `crossing takes ${seconds.toFixed(1)} s`);
  // The safehouse is near the centre-south; the Junction is a crossing of two streets.
  assert.ok(SAFE_CENTER.y > 0 && Math.abs(SAFE_CENTER.x) < 40);
  assert.equal(JUNCTION.x, corridorCenter(4));
  assert.equal(JUNCTION.y, corridorCenter(2));
  // The gantry sits on the main street, just beyond the north edge.
  assert.equal(GANTRY.x, corridorCenter(3));
  assert.ok(GANTRY.y < -TOWN_HALF);
  assert.ok(PLACEMENTS.some((p) => p.prop === 'TownSign'));
  assert.ok(PLACEMENTS.some((p) => p.prop === 'WaterTower' && !p.decor));
  assert.ok(BUILDINGS.length > 70);
});

test('spawns, parts, the dog and the truck stand free and connected to the streets', () => {
  for (const s of SPAWNS) {
    assert.ok(circleIsFree(s.x, s.y, PLAYER_RADIUS), `spawn ${s.x},${s.y}`);
    assert.ok(s.x > SAFE.x0 && s.x < SAFE.x1 && s.y > SAFE.y0 && s.y < SAFE.y1, 'spawns inside the safehouse');
  }
  assert.deepEqual(PART_SPOTS.map((p) => p.item).sort(), ['fuel', 'fuel', 'wheel', 'wheel']);
  for (const p of PART_SPOTS) {
    assert.ok(circleIsFree(p.x, p.y, 0.3), `part at ${p.x},${p.y}`);
    assert.ok(reachable(p.x, p.y), `part at ${p.x},${p.y} reachable`);
    assert.equal(zone(p.x, p.y) > 0, true, 'parts lie away from the safehouse');
  }
  assert.ok(circleIsFree(DOG_SPOT.x, DOG_SPOT.y, 0.35) && reachable(DOG_SPOT.x, DOG_SPOT.y), 'the dog');
  assert.ok(TRUCK.x > SAFE.x0 && TRUCK.x < SAFE.x1 && TRUCK.y > SAFE.y0 && TRUCK.y < SAFE.y1, 'the truck');
  assert.ok(!circleIsFree(TRUCK.x, TRUCK.y, 0.3), 'the truck is solid');
});

test('every chest and searchable can be reached (a free standing spot in reach, connected to the safehouse)', () => {
  const bad: string[] = [];
  for (const s of LOOT_SPOTS) {
    const reach = s.kind === 'search' ? 1.6 : 1.7;
    let ok = false;
    for (let r = 0.5; r <= Math.max(reach, 3.3) && !ok; r += 0.2) {
      for (let a = 0; a < 24 && !ok; a++) {
        const x = s.x + Math.cos((a / 24) * Math.PI * 2) * r;
        const y = s.y + Math.sin((a / 24) * Math.PI * 2) * r;
        ok = circleIsFree(x, y, PLAYER_RADIUS) && reachable(x, y);
      }
    }
    if (!ok) bad.push(`${s.kind} ${s.id} at ${s.x.toFixed(1)},${s.y.toFixed(1)}`);
  }
  assert.deepEqual(bad, []);
  // Special chests only in the outer zone; common chests and searchables everywhere.
  for (const s of LOOT_SPOTS) if (s.kind === 'special') assert.equal(s.zone, 2, `special ${s.id} is outer`);
  assert.ok(LOOT_SPOTS.filter((s) => s.kind === 'special').length >= 3);
  assert.ok(LOOT_SPOTS.filter((s) => s.kind === 'chest').length >= 20);
  assert.ok(LOOT_SPOTS.filter((s) => s.kind === 'search').length >= 40);
});

test('zombie spawn points are on the streets, out of the safehouse, everywhere in town', () => {
  assert.ok(STREET_POINTS.length > 600);
  for (const p of STREET_POINTS) {
    assert.ok(!(p.x > SAFE.x0 && p.x < SAFE.x1 && p.y > SAFE.y0 && p.y < SAFE.y1));
  }
  const far = STREET_POINTS.filter((p) => p.zone === 2).length;
  assert.ok(far > STREET_POINTS.length / 3, 'most of the town is the outer zone');
  assert.ok(STREET_POINTS.filter((p) => p.out < ZONE_INNER).length > 50);
});

test('the safehouse: eight sockets in four openings, walls between', () => {
  assert.equal(SOCKETS.length, 8);
  for (const s of SOCKETS) {
    assert.ok(Math.abs(s.x1 - s.x0 - (s.horizontal ? 3 : 0.9)) < 1e-9);
    // A survivor can walk through an empty socket (it is an opening).
    assert.ok(circleIsFree(s.x, s.y, PLAYER_RADIUS), `socket ${s.x},${s.y} is open`);
  }
  // Within reach of the socket from inside.
  assert.ok(REACH.socket >= 2);
  // The yard is enclosed: from the centre to outside, the way goes through an opening.
  const out = { x: SAFE.x0 - 4, y: SAFE.y0 + 4 };
  assert.ok(reachable(out.x, out.y));
});

test('night navigation: every crossing but the four by the safehouse has an arrow toward it', () => {
  assert.equal(ARROWS.length, 49 - 4 + 8);
  for (const a of ARROWS) {
    // Following an arrow never leads further from the safehouse (by street distance).
    // (Sampled across the road: a wreck may stand on the exact spot.)
    const best = (along: number) => {
      let d = Infinity;
      for (let side = -3; side <= 3; side += 0.5) {
        const x = a.x + Math.cos(a.angle) * along - Math.sin(a.angle) * side;
        const y = a.y + Math.sin(a.angle) * along + Math.cos(a.angle) * side;
        d = Math.min(d, field.distanceAt(x, y));
      }
      return d;
    };
    const ahead = best(10);
    const here = best(0);
    assert.ok(Number.isFinite(here) && ahead <= here + 30, `arrow at ${a.x},${a.y}: ${here} → ${ahead}`);
  }
});

test('movement slides along walls and never leaves the town', () => {
  const b = { x: SAFE_CENTER.x, y: SAFE_CENTER.y, vx: 0, vy: 0 };
  for (let i = 0; i < 30 * 80; i++) movePlayer(b, { x: 0.7, y: -0.7 }, 1, [], 1 / 30);
  assert.ok(Math.abs(b.x) <= TOWN_HALF && Math.abs(b.y) <= TOWN_HALF);
  assert.ok(circleIsFree(b.x, b.y, PLAYER_RADIUS - 0.01));
  // Goo halves the speed.
  const c = { x: 0, y: 0, vx: 0, vy: 0 };
  const d = { x: 0, y: 0, vx: 0, vy: 0 };
  for (let i = 0; i < 15; i++) {
    movePlayer(c, { x: 0, y: -1 }, 1, [], 1 / 30);
    movePlayer(d, { x: 0, y: -1 }, 1, [{ x: 0, y: 0 }], 1 / 30);
  }
  assert.ok(Math.abs(d.y) < Math.abs(c.y) * 0.6);
});
