import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE_SIZE,
  PERFECT_TOLERANCE,
  RANGE,
  SPAWN_DELAY,
  StackSim,
  sliderOffset,
  speedFor,
  type DropOutcome,
} from '../src/sim.ts';

/** Time (s after the layer spawned) at which the slider reaches `offset` on its first pass. */
const timeAt = (offset: number, speed: number) => SPAWN_DELAY + (offset + RANGE) / speed;

/**
 * Drive a sim the way the game does: frames of `frameDt` (with optional jitter), presses at absolute times
 * (seconds since start) delivered on the next frame with `lateBy = frameTime - pressTime`.
 */
function play(pressTimes: number[], frameDt: number, jitter = 0) {
  const sim = new StackSim();
  sim.start();
  const outcomes: DropOutcome[] = [];
  let now = 0;
  let i = 0;
  let n = 0;
  while (sim.phase === 'playing' && now < 120) {
    const dt = frameDt * (1 + (jitter ? Math.sin(n++ * 12.9898) * jitter : 0));
    now += dt;
    sim.advance(dt);
    while (i < pressTimes.length && pressTimes[i]! <= now) {
      const o = sim.drop(now - pressTimes[i]!);
      if (o.kind !== 'ignored') outcomes.push(o);
      i++;
    }
    if (i >= pressTimes.length) break;
  }
  return { sim, outcomes };
}

test('slider: hovers during the spawn delay, then ping-pongs between -RANGE and +RANGE', () => {
  assert.equal(sliderOffset(0, 3), -RANGE);
  assert.equal(sliderOffset(SPAWN_DELAY, 3), -RANGE);
  assert.ok(Math.abs(sliderOffset(timeAt(0, 3), 3)) < 1e-9);
  assert.ok(Math.abs(sliderOffset(timeAt(RANGE, 3), 3) - RANGE) < 1e-9);
  // Back to the start after a full round trip.
  assert.ok(Math.abs(sliderOffset(SPAWN_DELAY + (4 * RANGE) / 3, 3) + RANGE) < 1e-9);
});

test('perfect keeps the size (grows back, capped); trim cuts the overhang into debris; miss ends the game', () => {
  const sim = new StackSim();
  sim.start();
  sim.advance(timeAt(0.05, sim.speed));
  const p = sim.drop();
  assert.equal(p.kind, 'perfect');
  assert.equal(sim.score, 1);
  assert.equal(sim.streak, 1);
  assert.deepEqual(p.kind === 'perfect' && p.placed, { x: 0, z: 0, w: BASE_SIZE, d: BASE_SIZE, layer: 1 });

  // Layer 2 slides along z. Overshoot by 0.9 → 2.1 kept, 0.9 debris on the far side.
  sim.advance(timeAt(0.9, sim.speed));
  const t = sim.drop();
  assert.equal(t.kind, 'trim');
  if (t.kind !== 'trim') return;
  assert.ok(Math.abs(t.placed.d - 2.1) < 1e-9 && Math.abs(t.placed.z - 0.45) < 1e-9);
  assert.ok(Math.abs(t.debris.d - 0.9) < 1e-9 && Math.abs(t.debris.z - 1.95) < 1e-9);
  assert.equal(t.placed.w, BASE_SIZE);
  assert.equal(sim.streak, 0);

  // Perfect on a trimmed slab grows it back a little along the sliding axis.
  sim.advance(timeAt(0, sim.speed));
  sim.drop();
  sim.advance(timeAt(PERFECT_TOLERANCE / 2, sim.speed));
  const g = sim.drop();
  assert.equal(g.kind, 'perfect');
  if (g.kind === 'perfect') assert.ok(g.placed.d > 2.1 && g.placed.d < 2.3);

  // Press while the next slab still hovers → ignored; far off the tower → miss.
  assert.equal(sim.drop().kind, 'ignored');
  sim.advance(SPAWN_DELAY + 0.01);
  const m = sim.drop();
  assert.equal(m.kind, 'miss');
  assert.equal(sim.phase, 'over');
  assert.equal(sim.drop().kind, 'ignored');
});

test('same presses → same tower at 60 Hz, 30 Hz (Low Power Mode), 120 Hz and jittery frames', () => {
  // A scripted run: aim each layer at a target offset (some on the slider's way back), derive the absolute press
  // times from an exact reference, end with a press far off the tower.
  const targets = [0.05, 0.3, -0.2, 0, 0.25, -0.1, 0.08, 0.4, -0.35, 0.02, 0.01, -0.03, 0.15, -4];
  const presses: number[] = [];
  const ref0 = new StackSim();
  ref0.start();
  let clock = 0;
  targets.forEach((off, k) => {
    const back = k % 3 === 2 && off > -RANGE;
    // First pass: -RANGE → +RANGE. Way back: +RANGE → -RANGE.
    const dist = back ? 2 * RANGE + (RANGE - off) : off + RANGE;
    const dt = SPAWN_DELAY + dist / ref0.speed;
    clock += dt;
    presses.push(clock);
    ref0.advance(dt);
    ref0.drop();
  });
  const runs = [1 / 60, 1 / 30, 1 / 120, 1 / 50].map((dt, i) => play(presses, dt, i === 3 ? 0.4 : 0));
  const [ref, ...others] = runs;
  assert.equal(ref!.sim.phase, 'over');
  assert.equal(ref!.sim.score, ref0.score);
  assert.ok(ref!.outcomes.some((o) => o.kind === 'perfect') && ref!.outcomes.some((o) => o.kind === 'trim'));
  assert.ok(ref!.sim.score >= 10, `scripted run should place a few blocks (score ${ref!.sim.score})`);
  for (const r of others) {
    assert.equal(r.sim.score, ref!.sim.score);
    assert.equal(r.sim.phase, ref!.sim.phase);
    assert.deepEqual(
      r.outcomes.map((o) => o.kind),
      ref!.outcomes.map((o) => o.kind),
    );
    for (let i = 0; i < ref!.sim.tower.length; i++) {
      const a = ref!.sim.tower[i]!;
      const b = r.sim.tower[i]!;
      for (const k of ['x', 'z', 'w', 'd'] as const) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `layer ${i} ${k}`);
    }
  }
});

test('speed rises with height and perfect streaks, and stays bounded (score rate under maxScorePerMinute)', () => {
  assert.ok(speedFor(10, 0) > speedFor(0, 0));
  assert.ok(speedFor(10, 3) > speedFor(10, 0));
  const max = speedFor(1000, 1000);
  assert.ok(max < 6.1);
  // Fastest possible placement: hover, then travel until the slider first overlaps a full-size slab.
  const minSecondsPerBlock = SPAWN_DELAY + (RANGE - BASE_SIZE) / max;
  assert.ok(60 / minSecondsPerBlock <= 120, `${(60 / minSecondsPerBlock).toFixed(1)} blocks/min`);
});
