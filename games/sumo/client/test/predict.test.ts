import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, SUBSTEPS, SumoMatch, integrate, type Body, type Phase } from '@rally/game-sumo-server';
import { Predictor, shouldPredict } from '../src/predict.ts';

test('with no new input the prediction is the server state coasting under friction', () => {
  const p = new Predictor();
  p.rebase({ x: 1, y: 2, vx: 3, vy: 0 }, 1000);
  const at = p.sample(1000)!;
  assert.deepEqual(at, { x: 1, y: 2 });
  const later = p.sample(1100)!;
  assert.ok(later.x > 1.2 && later.x < 1.3, `coasts ~0.28 units in 100 ms (${later.x})`);
  assert.equal(later.y, 2);
});

test('replays the sticks sent since the snapshot with the server integrator', () => {
  const p = new Predictor();
  p.rttMs = 0;
  p.recordStick(1000, { x: 1, y: 0 });
  p.rebase({ x: 0, y: 0, vx: 0, vy: 0 }, 1000);
  const got = p.sample(1000 + 10 * ((DT * 1000) / SUBSTEPS))!;
  const ref: Body = { id: 'r', x: 0, y: 0, vx: 0, vy: 0, alive: true };
  for (let i = 0; i < 10; i++) integrate(ref, { x: 1, y: 0 }, DT / SUBSTEPS);
  assert.ok(Math.abs(got.x - ref.x) < 1e-9, `${got.x} vs ${ref.x}`);
});

test('the round trip is replayed too: inputs the server has not applied yet still move the puck now', () => {
  const p = new Predictor();
  p.rttMs = 100;
  p.recordStick(950, { x: 0, y: 1 }); // sent 50 ms before the snapshot arrived: not in it yet
  p.rebase({ x: 0, y: 0, vx: 0, vy: 0 }, 1000);
  const now = p.sample(1000)!;
  assert.ok(now.y > 0.01, `already moving (${now.y})`);
});

test('corrections blend out instead of jumping; big ones snap', () => {
  const p = new Predictor();
  p.rebase({ x: 0, y: 0, vx: 0, vy: 0 }, 1000);
  assert.deepEqual(p.sample(1000), { x: 0, y: 0 });
  // Server says we were shoved 1 unit right: the drawn position starts where it was and converges.
  p.rebase({ x: 1, y: 0, vx: 0, vy: 0 }, 1050);
  const right = p.sample(1050)!;
  assert.ok(Math.abs(right.x) < 1e-9, 'no jump at the moment of the correction');
  const mid = p.sample(1170)!.x;
  assert.ok(mid > 0.5 && mid < 0.8, `half-way after one time constant (${mid})`);
  assert.ok(p.sample(1800)!.x > 0.99);
  // A respawn across the platform snaps.
  p.rebase({ x: -6, y: 0, vx: 0, vy: 0 }, 1900);
  assert.equal(p.sample(1900)!.x, -6);
});

test('stickAt follows the recorded history', () => {
  const p = new Predictor();
  p.recordStick(100, { x: 1, y: 0 });
  p.recordStick(200, { x: 0, y: 1 });
  p.recordStick(250, { x: 0, y: 1 }); // duplicate ignored
  assert.deepEqual(p.stickAt(50), { x: 0, y: 0 });
  assert.deepEqual(p.stickAt(150), { x: 1, y: 0 });
  assert.deepEqual(p.stickAt(260), { x: 0, y: 1 });
});

test('predicts only in phases where the server moves pucks (not countdown or matchOver)', () => {
  assert.deepEqual((['waiting', 'countdown', 'playing', 'roundOver', 'matchOver'] as const).filter(shouldPredict), [
    'waiting',
    'playing',
    'roundOver',
  ]);
});

test('the phase rule matches SumoMatch: pucks move under a held stick exactly in the predicted phases', () => {
  const m = new SumoMatch({ countdownTime: 0.2, roundOverTime: 0.2, matchOverTime: 0.5, winsToMatch: 1 });
  m.addPlayer('a', 'A');
  const moved = new Map<Phase, boolean>();
  for (let i = 0; i < 400 && moved.size < 5; i++) {
    if (i === 3) m.addPlayer('b', 'B'); // alone first: waiting (practice)
    // A pushes hard (falls off first), B drifts gently (survives into roundOver).
    m.setInput('a', { x: 0, y: 1 });
    if (m.players.has('b')) m.setInput('b', { x: 0.3, y: 0 });
    const phase = m.phase;
    const before = new Map([...m.players].map(([id, p]) => [id, { x: p.x, y: p.y, alive: p.alive }]));
    m.step(DT);
    if (m.phase !== phase) continue; // transition steps lay pucks out
    const anyMoved = [...m.players].some(([id, p]) => {
      const b = before.get(id)!;
      return b.alive && p.alive && (p.x !== b.x || p.y !== b.y);
    });
    if (!moved.has(phase)) moved.set(phase, anyMoved);
  }
  for (const [phase, didMove] of moved) assert.equal(shouldPredict(phase), didMove, phase);
  assert.equal(moved.size, 5, `saw every phase (${[...moved.keys()]})`);
});
