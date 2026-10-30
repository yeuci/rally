import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerClock } from '@rally/game-kit';
import { DT, PATCH_MS, SUBSTEPS, SumoMatch, integrate, type Body, type Phase } from '@rally/game-sumo-server';
import { Predictor, shouldPredict, type OwnSnapshot } from '../src/predict.ts';

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

test('rebased on tick time (not arrival time), a steady push through 1-or-2-tick patches is drawn at a steady speed', () => {
  // The server: 30 Hz ticks, full stick held, already at terminal speed. Patches every 50 ms carry the newest tick
  // (1 or 2 since the last one) and arrive 20–45 ms later (network + event loop jitter, deterministic).
  const stick = { x: 1, y: 0 };
  const body: Body = { id: 's', x: 0, y: 0, vx: 0, vy: 0, alive: true };
  const states: OwnSnapshot[] = [];
  for (let tick = 0; tick < 600; tick++) {
    for (let i = 0; i < SUBSTEPS; i++) integrate(body, stick, DT / SUBSTEPS);
    states.push({ x: body.x, y: body.y, vx: body.vx, vy: body.vy });
  }
  let seed = 3;
  const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 25;
  const tickMs = DT * 1000;
  const arrivals: { tick: number; at: number }[] = [];
  for (let send = 10_007.3; send < 19_000; send += PATCH_MS) {
    arrivals.push({ tick: Math.floor(send / tickMs), at: send + 20 + jitter() });
  }
  const run = (contentTime: boolean) => {
    const p = new Predictor();
    const clock = new ServerClock();
    p.rttMs = 40;
    p.recordStick(0, stick);
    let k = 0;
    let last: number | null = null;
    const speeds: number[] = [];
    for (let now = 10_000; now < 19_000; now += 1000 / 60) {
      while (k < arrivals.length && arrivals[k]!.at <= now) {
        const { tick, at } = arrivals[k++]!;
        clock.observe(tick * tickMs, at);
        p.rebase(states[tick]!, contentTime ? clock.toLocal(tick * tickMs) : at, at);
      }
      const x = p.sample(now)?.x;
      if (x === undefined) continue;
      if (last !== null && now > 12_000) speeds.push((x - last) * 60);
      last = x;
    }
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length) / mean;
  };
  const byArrival = run(false);
  const byTick = run(true);
  assert.ok(byArrival > 0.03, `arrival times make the drawn speed wobble (${(byArrival * 100).toFixed(1)} %)`);
  assert.ok(byTick < 0.002, `tick times keep it steady (${(byTick * 100).toFixed(2)} %)`);
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
