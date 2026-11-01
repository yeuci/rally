import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHAKE, createShakeDetector, shakeForce, type AccelSample } from '../src/lib/shake';

const REST: AccelSample = { x: 0, y: 0, z: -1 }; // flat on a table: 1 g down
const flick = (g: number): AccelSample => ({ x: g, y: 0, z: -1 });

/** Feeds `samples` at the accelerometer's interval from `start`; returns the times a shake was detected. */
function run(samples: AccelSample[], start = 0, interval = SHAKE.intervalMs) {
  const d = createShakeDetector();
  const hits: number[] = [];
  samples.forEach((s, i) => {
    const t = start + i * interval;
    if (d.push(s, t)) hits.push(t);
  });
  return hits;
}

/** A burst: `jolts` hard samples every `gapMs`, resting samples in between. */
function burst(jolts: number, gapMs: number, g = 2.4, tail = 10): AccelSample[] {
  const per = Math.max(1, Math.round(gapMs / SHAKE.intervalMs));
  const out: AccelSample[] = [];
  for (let j = 0; j < jolts; j++) {
    out.push(flick(j % 2 ? -g : g));
    for (let k = 1; k < per; k++) out.push(REST);
  }
  for (let k = 0; k < tail; k++) out.push(REST);
  return out;
}

test('thresholds: a shake is three ≥ 1 g jolts within a second, then three seconds of quiet', () => {
  assert.deepEqual(
    {
      forceG: SHAKE.forceG,
      jolts: SHAKE.jolts,
      windowMs: SHAKE.windowMs,
      minGapMs: SHAKE.minGapMs,
      cooldownMs: SHAKE.cooldownMs,
    },
    { forceG: 1, jolts: 3, windowMs: 1000, minGapMs: 100, cooldownMs: 3000 },
  );
  assert.ok(SHAKE.intervalMs <= 50, 'samples fast enough to see the peaks');
});

test('shakeForce: distance from resting 1 g, in any orientation', () => {
  assert.equal(shakeForce(REST), 0);
  assert.equal(shakeForce({ x: 0, y: 1, z: 0 }), 0, 'held upright');
  assert.ok(Math.abs(shakeForce({ x: 2, y: 0, z: 0 }) - 1) < 1e-9);
  assert.ok(Math.abs(shakeForce({ x: 0, y: 0, z: 0 }) - 1) < 1e-9, 'free fall is 1 g away from rest too');
  assert.equal(shakeForce({ x: Number.NaN, y: 0, z: 0 }), 0);
});

test('resting, walking and setting the phone down never trigger', () => {
  assert.deepEqual(run(Array.from({ length: 200 }, () => REST)), []);
  // Walking: ≈ 2 steps a second peaking around 1.5 g.
  const walk = Array.from({ length: 300 }, (_, i) => (i % 12 === 0 ? { x: 0.3, y: 0, z: -1.45 } : REST));
  assert.deepEqual(run(walk), []);
  // One hard knock (dropped on a sofa): a single jolt spanning a few samples.
  assert.deepEqual(run([flick(3), flick(2.8), flick(2.5), ...Array.from({ length: 50 }, () => REST)]), []);
});

test('a deliberate shake triggers once, on the third jolt', () => {
  const hits = run(burst(3, 160));
  assert.equal(hits.length, 1);
  assert.equal(hits[0], 2 * 4 * SHAKE.intervalMs, 'the third jolt (160 ms apart = every 4th sample)');
  assert.equal(run(burst(6, 160)).length, 1, 'keeps shaking: still once (cooldown)');
});

test('jolts spread over more than a second are not a shake', () => {
  assert.deepEqual(run(burst(3, 600)), []);
});

test('samples of one long jolt count once (minGapMs)', () => {
  // Three hard samples back to back (40 ms apart) are one jolt, not three.
  assert.deepEqual(run([flick(2.5), flick(2.5), flick(2.5), ...Array.from({ length: 30 }, () => REST)]), []);
});

test('weak shakes stay under the threshold', () => {
  // A sideways 1.2 g on top of gravity: ≈ 1.56 g in all, 0.56 g from rest.
  assert.deepEqual(run(burst(5, 160, 1.2)), []);
});

test('after the cooldown a new shake triggers again; reset() forgets everything', () => {
  const d = createShakeDetector();
  const shakeAt = (t0: number) => [0, 160, 320].map((dt) => d.push(flick(2.5), t0 + dt));
  assert.deepEqual(shakeAt(0), [false, false, true]);
  assert.deepEqual(shakeAt(1000), [false, false, false], 'inside the 3 s cooldown');
  assert.deepEqual(shakeAt(3400), [false, false, true]);
  d.push(flick(2.5), 10_000);
  d.push(flick(2.5), 10_160);
  d.reset();
  assert.equal(d.push(flick(2.5), 10_320), false, 'the earlier jolts were forgotten');
});
