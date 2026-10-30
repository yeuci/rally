import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RenderClock, ServerClock, interpolationDelay } from '../src/netclock.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICK = 1000 / 30;
const PATCH = 50;

/**
 * A 30 Hz server patched at 20 Hz: each patch carries the newest tick (1 or 2 ticks since the last one), sent
 * 0–33 ms after that tick was simulated, plus `latency` and a random `jitter` on the way. Local = server + 5000.
 */
function* patches(opts: { seconds: number; latency: number; jitter: number; seed?: number; from?: number }) {
  const r = rng(opts.seed ?? 1);
  const from = opts.from ?? 0;
  for (let send = from + PATCH; send <= from + opts.seconds * 1000; send += PATCH) {
    const tick = Math.floor(send / TICK);
    yield { serverMs: tick * TICK, localMs: 5000 + send + opts.latency + r() * opts.jitter };
  }
}

test('ServerClock: the offset is the lower envelope of the arrivals; late bursts do not move it', () => {
  const c = new ServerClock();
  for (const p of patches({ seconds: 5, latency: 20, jitter: 30 })) c.observe(p.serverMs, p.localMs);
  // Earliest possible arrival = 5000 + latency (a patch sent right at a tick, no jitter): the estimate sits within a
  // few ms above it, never below.
  assert.ok(c.offsetMs! >= 5020 && c.offsetMs! < 5026, `offset ${c.offsetMs}`);
  // Jitter covers the tick-to-patch wait (≤ 33 ms) plus the network spread (≤ 30 ms).
  assert.ok(c.jitterMs > 40 && c.jitterMs < 64, `jitter ${c.jitterMs}`);
  const floor = c.floorMs!;
  const before = c.offsetMs!;
  c.observe(5000, 5000 + 5000 + 400); // one very late packet, right after the others
  assert.equal(c.floorMs, floor);
  assert.ok(Math.abs(c.offsetMs! - before) < 0.01, 'the estimate does not follow it');
  assert.equal(c.toLocal(10_000), 10_000 + c.offsetMs!);
  assert.ok(Math.abs(c.toServer(c.toLocal(1234)) - 1234) < 1e-9);
});

test('ServerClock: eases to an earlier floor at once, to a later one once the window has passed; re-seeds on a jump', () => {
  const c = new ServerClock({ windowMs: 1000 });
  for (let s = 0; s < 2000; s += 50) c.observe(s, s + 100);
  assert.equal(c.offsetMs, 100);
  c.observe(2000, 2090);
  assert.equal(c.floorMs, 90, 'earlier: the floor moves at once');
  assert.ok(Math.abs(c.offsetMs! - 99) < 1e-9, 'the estimate eases toward it (10 % per observation)');
  for (let s = 2050; s < 2500; s += 50) c.observe(s, s + 130);
  assert.ok(c.offsetMs! < 95, `still easing to 90 (${c.offsetMs})`);
  for (let s = 2500; s < 5000; s += 50) c.observe(s, s + 130);
  assert.equal(c.floorMs, 130, 'later: once the earlier arrival left the window');
  assert.ok(Math.abs(c.offsetMs! - 130) < 1, `${c.offsetMs}`);
  assert.equal(c.jitterMs, 0);
  c.observe(0, 50_000); // new room / server restart: the tick went back
  assert.equal(c.offsetMs, 50_000);
  c.reset();
  assert.equal(c.offsetMs, null);
});

test('interpolationDelay: one interval plus the jitter, clamped to 2–3 intervals', () => {
  assert.equal(interpolationDelay(0, { intervalMs: 50 }), 100);
  assert.equal(interpolationDelay(33, { intervalMs: 50 }), 100);
  assert.equal(interpolationDelay(70, { intervalMs: 50 }), 120);
  assert.equal(interpolationDelay(500, { intervalMs: 50 }), 150);
  assert.equal(interpolationDelay(10, { intervalMs: 20, minIntervals: 1, maxIntervals: 4 }), 30);
});

test('RenderClock: delay adapts to jitter (2 intervals on a quiet link, 3 on a bad one)', () => {
  const quiet = new RenderClock({ intervalMs: PATCH });
  for (const p of patches({ seconds: 4, latency: 5, jitter: 3 })) quiet.observe(p.serverMs, p.localMs);
  assert.equal(quiet.delayMs, 100);
  const bad = new RenderClock({ intervalMs: PATCH });
  for (const p of patches({ seconds: 4, latency: 5, jitter: 120 })) bad.observe(p.serverMs, p.localMs);
  assert.equal(bad.delayMs, 150);
});

test('RenderClock: render time runs smoothly at ~1× through bursty 1-or-2-tick patches and never past the data', () => {
  const clock = new RenderClock({ intervalMs: PATCH });
  const all = [...patches({ seconds: 10, latency: 10, jitter: 25, seed: 7 })];
  let k = 0;
  let newest = -Infinity;
  let last: number | null = null;
  const rates: number[] = [];
  for (let now = 5100; now < 15_000; now += 1000 / 60) {
    while (k < all.length && all[k]!.localMs <= now) {
      clock.observe(all[k]!.serverMs, all[k]!.localMs);
      newest = Math.max(newest, all[k]!.serverMs);
      k++;
    }
    const rt = clock.renderTime(now);
    if (rt === null) continue;
    if (now > 6000) {
      assert.ok(rt <= newest + PATCH, `at most one interval past the newest snapshot (${rt - newest})`);
      if (last !== null) rates.push((rt - last) / (1000 / 60));
    }
    last = rt;
  }
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  assert.ok(min >= 0.95 - 1e-9 && max <= 1.05 + 1e-9, `render time rate ${min}…${max}`);
  const mean = rates.reduce((s, v) => s + v, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((s, v) => s + (v - mean) ** 2, 0) / rates.length);
  assert.ok(sd < 0.01, `render time rate std ${sd}`);
});

test('RenderClock: null before data; snaps on the first frame and after a long gap', () => {
  const clock = new RenderClock({ intervalMs: PATCH });
  assert.equal(clock.renderTime(0), null);
  clock.observe(1000, 1100);
  assert.equal(clock.renderTime(1100), 1100 - 100 - 100);
  clock.observe(1000, 1500); // a repeat of the same tick is ignored
  assert.equal(clock.server.offsetMs, 100);
  clock.observe(60_000, 60_100);
  assert.equal(clock.renderTime(60_100), 60_100 - 100 - 100);
  clock.reset();
  assert.equal(clock.renderTime(70_000), null);
});
