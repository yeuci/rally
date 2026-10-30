import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCEL,
  DAMPING,
  DT,
  MAX_SPEED,
  PUCK_RADIUS,
  SUBSTEPS,
  collide,
  integrate,
  isOut,
  spawnPoint,
  stepWorld,
  type Body,
  type Vec2,
} from '../src/index.ts';

const body = (id: string, x: number, y: number, vx = 0, vy = 0): Body => ({ id, x, y, vx, vy, alive: true });
const still: Vec2 = { x: 0, y: 0 };

test('integrate: full stick accelerates in the stick direction', () => {
  const b = body('a', 0, 0);
  integrate(b, { x: 1, y: 0 }, 0.1);
  assert.ok(b.vx > 0 && b.x > 0);
  assert.equal(b.vy, 0);
  assert.equal(b.y, 0);
  // v = ACCEL·dt, then damped once.
  assert.ok(Math.abs(b.vx - ACCEL * 0.1 * Math.exp(-DAMPING * 0.1)) < 1e-12);
});

test('friction: a coasting puck slows down exponentially and comes (almost) to rest', () => {
  const b = body('a', 0, 0, 8, 0);
  integrate(b, still, 1);
  assert.ok(Math.abs(b.vx - 8 * Math.exp(-DAMPING)) < 1e-12);
  for (let i = 0; i < 300; i++) integrate(b, still, DT);
  assert.ok(Math.abs(b.vx) < 1e-3, `speed after 10 s: ${b.vx}`);
  const stoppedAt = b.x;
  integrate(b, still, DT);
  assert.ok(b.x - stoppedAt < 1e-4);
});

test('terminal speed under full stick is ACCEL / DAMPING, and speed is capped', () => {
  const b = body('a', 0, 0);
  for (let i = 0; i < 30 * 10; i++) integrate(b, { x: 0, y: 1 }, DT);
  assert.ok(Math.abs(b.vy - ACCEL / DAMPING) < 0.4, `vy ${b.vy}`);
  const fast = body('f', 0, 0, 100, 0);
  integrate(fast, still, DT);
  assert.ok(Math.hypot(fast.vx, fast.vy) <= MAX_SPEED + 1e-9);
});

test('collide: a moving puck hitting a resting one pushes both apart', () => {
  const a = body('a', 0, 0, 6, 0);
  const b = body('b', 1.9, 0);
  const impulse = collide(a, b);
  assert.ok(impulse > 0);
  assert.ok(b.vx > 0, 'the hit puck moves away');
  assert.ok(a.vx < 6, 'the hitter loses speed');
  // Overlap resolved symmetrically.
  assert.ok(Math.abs(b.x - a.x - 2 * PUCK_RADIUS) < 1e-12);
  // Momentum (equal masses) is conserved by the impulse exchange.
  assert.ok(Math.abs(a.vx + b.vx - 6) < 1e-12);
});

test('collide: no contact, or already separating, gives no impulse', () => {
  const a = body('a', 0, 0, 1, 0);
  const far = body('b', 2.5, 0);
  assert.equal(collide(a, far), 0);
  assert.equal(far.vx, 0);
  const sep = body('c', 1.5, 0, 3, 0); // overlapping but moving away faster than a
  assert.equal(collide(a, sep), 0);
  assert.ok(Math.abs(sep.x - a.x - 2) < 1e-12, 'still separated');
});

test('collide: identical positions resolve along +x deterministically', () => {
  const a = body('a', 1, 1);
  const b = body('b', 1, 1);
  collide(a, b);
  assert.equal(a.x, 0);
  assert.equal(b.x, 2);
  assert.equal(a.y, 1);
});

test('isOut: centre past the edge', () => {
  assert.equal(isOut({ x: 0, y: 0 }, 5), false);
  assert.equal(isOut({ x: 4.99, y: 0 }, 5), false);
  assert.equal(isOut({ x: 3.6, y: 3.6 }, 5), true);
});

test('stepWorld: a puck driven over the edge falls and is reported once', () => {
  const a = body('a', 4, 0, 0, 0);
  const b = body('b', -4, 0);
  let fallenAt = -1;
  for (let i = 0; i < 60 && fallenAt < 0; i++) {
    const r = stepWorld([a, b], (id) => (id === 'a' ? { x: 1, y: 0 } : still), 5, DT, SUBSTEPS);
    if (r.fallen.length) {
      assert.deepEqual(r.fallen, ['a']);
      fallenAt = i;
    }
  }
  assert.ok(fallenAt > 0, 'a fell off');
  assert.equal(a.alive, false);
  assert.equal(b.alive, true);
  const x = a.x;
  const r = stepWorld([a, b], () => ({ x: 1, y: 0 }), 5, DT, SUBSTEPS);
  assert.deepEqual(r.fallen, []);
  assert.equal(a.x, x, 'dead pucks are not simulated');
});

test('stepWorld: contacts report the colliding pair', () => {
  const a = body('a', -1.2, 0, 5, 0);
  const b = body('b', 1.2, 0, -5, 0);
  const contacts = [];
  for (let i = 0; i < 10; i++) contacts.push(...stepWorld([a, b], () => still, 9, DT, SUBSTEPS).contacts);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]!.a, 'a');
  assert.equal(contacts[0]!.b, 'b');
  assert.ok(contacts[0]!.impulse > 4);
  assert.ok(a.vx < 0 && b.vx > 0, 'they bounce off each other');
});

/** Scripted inputs: a few players steering around for 20 s. */
function scripted(order: string[]) {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const bodies = order.map((id) => {
    const s = spawnPoint(ids.indexOf(id), ids.length, 9);
    return body(id, s.x, s.y);
  });
  const log: string[] = [];
  for (let t = 0; t < 600; t++) {
    const r = stepWorld(
      bodies,
      (id) => {
        const k = ids.indexOf(id);
        const a = t * 0.05 + k * 1.7;
        return { x: Math.cos(a), y: Math.sin(a * 1.3) * 0.8 };
      },
      9 - t * 0.01,
      DT,
      SUBSTEPS,
    );
    for (const c of r.contacts) log.push(`${t}:${c.a}-${c.b}`);
    for (const f of r.fallen) log.push(`${t}:out:${f}`);
  }
  const final = [...bodies].sort((a, b) => (a.id < b.id ? -1 : 1)).map((b) => [b.id, b.x, b.y, b.vx, b.vy, b.alive]);
  return { final, log };
}

test('deterministic: same inputs give bit-identical results, whatever the body order', () => {
  const one = scripted(['p1', 'p2', 'p3', 'p4']);
  const two = scripted(['p1', 'p2', 'p3', 'p4']);
  const shuffled = scripted(['p3', 'p1', 'p4', 'p2']);
  assert.deepEqual(two, one);
  assert.deepEqual(shuffled, one);
  assert.ok(one.log.length > 0, 'the script produced collisions or falls');
});

test('spawnPoint: evenly spaced inside the platform', () => {
  const pts = [0, 1, 2, 3].map((i) => spawnPoint(i, 4, 9));
  for (const p of pts) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 5.4) < 1e-9);
  for (let i = 0; i < 4; i++) {
    for (let k = i + 1; k < 4; k++) assert.ok(Math.hypot(pts[i]!.x - pts[k]!.x, pts[i]!.y - pts[k]!.y) > 2);
  }
});
