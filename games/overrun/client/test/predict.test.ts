import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, OverrunMatch, movePlayer, type Phase } from '@rally/game-overrun-server';
import { Predictor, shouldPredict } from '../src/predict.ts';

const still = { x: 0, y: 0, vx: 0, vy: 0, down: false };

test('replays the sticks sent since the snapshot with the server’s own movement (walls included)', () => {
  const p = new Predictor();
  p.recordStick(1000, { x: 0, y: -1 });
  p.rebase({ ...still, x: -4, y: -6.5 }, 1000);
  const got = p.sample(1000 + 30 * DT * 1000)!;
  const ref = { x: -4, y: -6.5, vx: 0, vy: 0 };
  for (let i = 0; i < 30; i++) movePlayer(ref, { x: 0, y: -1 }, false, DT);
  assert.ok(Math.abs(got.x - ref.x) < 1e-9 && Math.abs(got.y - ref.y) < 1e-9, `${got.y} vs ${ref.y}`);
  assert.ok(Math.abs(got.y - -7.25) < 1e-6, 'stopped by the north wall like on the server');
});

test('the round trip is replayed: inputs not in the snapshot yet still move us now; down = crawl', () => {
  const p = new Predictor();
  p.rttMs = 100;
  p.recordStick(950, { x: 1, y: 0 });
  p.rebase(still, 1000);
  assert.ok(p.sample(1000)!.x > 0.05, 'already moving');
  const down = new Predictor();
  down.recordStick(0, { x: 1, y: 0 });
  down.rebase({ ...still, down: true }, 0);
  assert.ok(down.sample(1000)!.x < 1, 'crawling');
});

test('corrections blend out; teleports snap', () => {
  const p = new Predictor();
  p.rebase(still, 1000);
  p.rebase({ ...still, x: 0.5 }, 1050, 1050);
  const right = p.sample(1050)!;
  assert.ok(Math.abs(right.x) < 1e-9, 'drawn where it was');
  assert.ok(Math.abs(p.sample(1600)!.x - 0.5) < 0.01, 'converged');
  p.rebase({ ...still, x: 10 }, 1700, 1700);
  assert.equal(p.sample(1700)!.x, 10, 'snapped');
});

test('predicts in the phases where the server moves players, for active players only', () => {
  const phases = ['waiting', 'breather', 'wave', 'over'] as const;
  assert.deepEqual(
    phases.filter((ph) => shouldPredict(ph, true)),
    ['waiting', 'breather', 'wave'],
  );
  assert.equal(shouldPredict('wave', false), false, 'waiting to spawn');
  // The rule matches the match: a held stick moves the player exactly there.
  const m = new OverrunMatch({ rules: { firstBreatherTime: 0.3, breatherTime: 0.3, overTime: 0.3, waveSize: 1 } });
  m.addPlayer('a', 'A');
  const moved = new Map<Phase, boolean>();
  for (let i = 0; i < 300 && moved.size < 4; i++) {
    m.setInput('a', { move: { x: i % 40 < 20 ? 1 : -1, y: 0 }, aim: null, fire: false, weapon: 0 });
    if (m.phase === 'wave' && i > 30) m.hurt(m.players.get('a')!, 999, []);
    const phase = m.phase;
    const x = m.players.get('a')!.x;
    m.step(DT);
    if (m.phase !== phase) continue;
    if (!moved.has(phase)) moved.set(phase, m.players.get('a')!.x !== x);
  }
  for (const [phase, didMove] of moved) assert.equal(shouldPredict(phase, true), didMove, phase);
});

test('stickAt follows the recorded history', () => {
  const p = new Predictor();
  p.recordStick(100, { x: 1, y: 0 });
  p.recordStick(200, { x: 0, y: 1 });
  p.recordStick(250, { x: 0, y: 1 });
  assert.deepEqual(p.stickAt(50), { x: 0, y: 0 });
  assert.deepEqual(p.stickAt(150), { x: 1, y: 0 });
  assert.deepEqual(p.stickAt(260), { x: 0, y: 1 });
});
