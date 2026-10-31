import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Bot } from '../src/bot.ts';
import {
  DEBARKER_Z,
  LOG_LEN,
  QUEUE_MAX,
  SHIFT_SECONDS,
  SawlineSim,
  TICK,
  UPGRADES,
  judge,
  orderSize,
  rng,
  truckGap,
} from '../src/sim.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string; maxScorePerMinute: number }[];
};

/** Run `seconds` of game time in 60 Hz frames. */
function run(sim: SawlineSim, seconds: number, beforeTick?: (s: SawlineSim) => void) {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) sim.advance(1 / 60, beforeTick);
}

/** Run until `until` holds (or `max` seconds pass). */
function runUntil(sim: SawlineSim, until: (s: SawlineSim) => boolean, max = 60, beforeTick?: (s: SawlineSim) => void) {
  for (let t = 0; t < max && !until(sim); t += 1 / 60) sim.advance(1 / 60, beforeTick);
  assert.ok(until(sim), 'condition reached');
}

function botShift(seed: number, frameDt: number, jitter = 0, skill = 0.12) {
  const sim = new SawlineSim(seed);
  const bot = new Bot(seed * 3, skill);
  const buys: string[] = [];
  sim.start();
  let n = 0;
  while (sim.phase === 'playing') {
    const dt = frameDt * (1 + (jitter ? Math.sin(n++ * 12.9898) * jitter : 0));
    for (const e of sim.advance(dt, bot.drive)) if (e.type === 'buy') buys.push(`${e.id}@${sim.tick}`);
  }
  return { sim, buys };
}

const holdDebark = (s: SawlineSim) => s.setDebark(true);

test('rng is seeded; cuts are judged against the log length', () => {
  const a = rng(9);
  const b = rng(9);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
  assert.equal(judge(LOG_LEN), 'perfect');
  assert.equal(judge(LOG_LEN + 0.09), 'perfect');
  assert.equal(judge(LOG_LEN - 0.2), 'good');
  assert.equal(judge(LOG_LEN + 0.5), 'off');
});

test('the same input per tick gives the same shift at 30, 60 and 120 fps and with jittery frames', () => {
  const ref = botShift(3, 1 / 60);
  for (const [dt, jitter] of [
    [1 / 30, 0],
    [1 / 120, 0],
    [1 / 60, 0.6],
  ] as const) {
    const other = botShift(3, dt, jitter);
    assert.deepEqual(other.buys, ref.buys, `upgrade ticks at dt=${dt} jitter=${jitter}`);
    assert.equal(other.sim.earned, ref.sim.earned);
    assert.deepEqual(other.sim.cuts, ref.sim.cuts);
    assert.equal(other.sim.lost, ref.sim.lost);
  }
  assert.equal(ref.sim.time, SHIFT_SECONDS);
});

test('economy: skill pays, the bot buys most upgrades, and earnings stay under the board rate limit', () => {
  const limit = manifest.leaderboards.find((b) => b.id === 'earnings')!.maxScorePerMinute;
  const sloppy = botShift(5, 1 / 60, 0, 0.3).sim;
  const sharp = botShift(5, 1 / 60, 0, 0.06).sim;
  assert.ok(sharp.earned > sloppy.earned * 1.3, `sharp $${sharp.earned} vs sloppy $${sloppy.earned}`);
  assert.ok(sharp.cuts.perfect > sloppy.cuts.perfect * 2);
  for (const seed of [1, 2]) {
    const { sim, buys } = botShift(seed, 1 / 60);
    assert.ok(sim.earned >= 3000 && sim.earned < 5000, `seed ${seed}: earned ${sim.earned}`);
    assert.ok(buys.length >= 9, `seed ${seed}: ${buys.join(' ')}`);
    assert.ok(sim.earned / (SHIFT_SECONDS / 60) < limit / 2);
  }
});

test('the debarker holds the line until it runs, then strips bark at its own speed', () => {
  const sim = new SawlineSim(1);
  sim.start();
  run(sim, 5);
  const trunk = sim.items[0]!;
  assert.ok(Math.abs(trunk.front - DEBARKER_Z) < 1e-9, `waiting at the ring (front ${trunk.front})`);
  assert.equal(trunk.debarked, 0);
  assert.ok(sim.debarkerBlocked);
  run(sim, 1, holdDebark);
  assert.ok(trunk.front > DEBARKER_Z + 0.7 && trunk.front < DEBARKER_Z + 0.95, `debarked ~0.85 (front ${trunk.front})`);
  assert.ok(Math.abs(trunk.debarked - (trunk.front - DEBARKER_Z)) < 1e-9);
  // Let go: it stops again.
  const at = trunk.front;
  run(sim, 1, (s) => s.setDebark(false));
  assert.equal(trunk.front, at);
});

test('a tap on the mark makes a perfect log; early taps only drop the blade; overrun forces a rough cut', () => {
  const sim = new SawlineSim(2);
  sim.start();
  runUntil(sim, (s) => (s.sawDepth ?? 0) >= 0.2, 60, holdDebark);
  assert.equal(sim.cut(), 'early');
  assert.equal(sim.cut(), 'busy', 'blade still coming back up');
  runUntil(sim, (s) => (s.sawDepth ?? 0) >= LOG_LEN - 0.02, 10, holdDebark);
  assert.equal(sim.cut(), 'perfect');
  assert.equal(sim.cuts.perfect, 1);
  const log = sim.items.find((i) => i.kind === 'log')!;
  assert.ok(Math.abs(log.length - LOG_LEN) <= 0.1);
  // Never tap again: the saw cuts on its own once a piece is far too long.
  runUntil(sim, (s) => s.cuts.off > 0, 10, holdDebark);
  assert.equal(
    sim.events.some((e) => e.type === 'cut' && e.auto),
    true,
  );
});

test('a late-delivered tap is judged where the log was when the finger came down', () => {
  const sim = new SawlineSim(2);
  sim.start();
  runUntil(sim, (s) => (s.sawDepth ?? 0) >= LOG_LEN + 0.04, 60, holdDebark);
  // Two ticks after the right moment at belt speed would be "good"; with lateBy it is judged back on the mark.
  run(sim, TICK * 2, holdDebark);
  // Now past the perfect window (0.04 + two ticks of belt > 0.1).
  assert.equal(judge(sim.sawDepth ?? 0), 'good');
  assert.equal(sim.cut(TICK * 2), 'perfect');
});

test('logs become bundles of planks at the splitter and drop into the pile', () => {
  const sim = new SawlineSim(4);
  const bot = new Bot(1, 0);
  sim.start();
  runUntil(sim, (s) => s.pile > 0, 60, bot.drive);
  // Perfect cuts make 10 planks (+combo bonus); the first log is one perfect cut. A truck already at the bay may
  // have taken one in the same tick.
  const loaded = sim.trucks.reduce((n, t) => n + t.loaded, 0);
  assert.equal(sim.planksMade, 10);
  assert.equal(sim.pile + loaded, 10);
});

test('trucks load from the pile at a bay, pay, and leave; impatient trucks walk off; the queue is capped', () => {
  const sim = new SawlineSim(6);
  sim.start();
  sim.pile = 500;
  runUntil(sim, (s) => s.trucksServed > 0, 40);
  assert.ok(sim.earned > 0 && sim.wallet === sim.earned);
  assert.equal(sim.earned % 2, 0, '$2 per plank');

  const dry = new SawlineSim(6);
  dry.start();
  run(dry, 120);
  assert.ok(dry.lost > 0, 'with nothing to load, trucks give up');
  assert.ok(dry.queue.length <= QUEUE_MAX);
  assert.ok(dry.trucks.filter((t) => t.state === 'bay').length <= 1);
  assert.equal(dry.earned, 0);
});

test('the shop offers each group’s next upgrade; buying spends the wallet and applies it', () => {
  const sim = new SawlineSim();
  sim.start();
  assert.deepEqual(
    sim.shop.map((u) => u.id),
    ['autoDebark', 'belt1', 'forklift', 'bay2', 'laser1', 'autoSaw'],
  );
  assert.equal(sim.buy('autoDebark'), false, 'cannot afford it');
  sim.wallet = 1000;
  assert.equal(sim.buy('belt2'), false, 'not on offer before belt1');
  assert.ok(sim.buy('belt1'));
  assert.equal(sim.beltSpeed, 1.75);
  assert.ok(sim.shop.some((u) => u.id === 'belt2'));
  assert.ok(sim.buy('autoDebark'));
  assert.ok(sim.ringRunning, 'the ring runs on its own');
  assert.equal(sim.wallet, 1000 - 150 - 80);
  assert.equal(UPGRADES.length, 11);
});

test('trucks come more often, with bigger orders, as the shift goes on', () => {
  assert.ok(truckGap(0) > truckGap(SHIFT_SECONDS));
  assert.ok(orderSize(SHIFT_SECONDS, 0.5) > orderSize(0, 0.5) * 2);
});

test('the shift ends at SHIFT_SECONDS with one "over" event', () => {
  const sim = new SawlineSim();
  sim.start();
  let over = 0;
  for (let t = 0; t < SHIFT_SECONDS + 5; t += 0.25) for (const e of sim.advance(0.25)) if (e.type === 'over') over++;
  assert.equal(over, 1);
  assert.equal(sim.phase, 'over');
  assert.equal(sim.cut(), 'busy');
});
