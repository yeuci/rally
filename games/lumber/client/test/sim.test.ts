import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Bot } from '../src/bot.ts';
import {
  BOUNDS,
  CASH_ZONE,
  COUNTER,
  DROP_ZONE,
  LumberSim,
  MILL_CAP,
  MILL_TRAYS,
  QUEUE_MAX,
  REGISTER_ZONE,
  SHIFT_SECONDS,
  TICK,
  UNLOCKS,
  VISIBLE_PADS,
  arrivalGap,
  clampStick,
  queueSlot,
  rng,
  type Vec2,
} from '../src/sim.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string; maxScorePerMinute: number }[];
};

/** Put the player somewhere (and stop them). */
function place(sim: LumberSim, at: Vec2) {
  sim.player.x = sim.player.px = at.x;
  sim.player.z = sim.player.pz = at.z;
  sim.setStick(0, 0);
}

/** Run `seconds` of game time in 60 Hz frames. */
function run(sim: LumberSim, seconds: number, beforeTick?: (s: LumberSim) => void) {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) sim.advance(1 / 60, beforeTick);
}

/** A whole bot-played shift at a given frame rate (optionally with jittery frames). */
function botShift(seed: number, frameDt: number, jitter = 0) {
  const sim = new LumberSim(seed);
  const bot = new Bot();
  const unlocks: string[] = [];
  sim.start();
  let n = 0;
  while (sim.phase === 'playing') {
    const dt = frameDt * (1 + (jitter ? Math.sin(n++ * 12.9898) * jitter : 0));
    for (const e of sim.advance(dt, bot.drive)) if (e.type === 'unlock') unlocks.push(`${e.id}@${sim.tick}`);
  }
  return { sim, unlocks };
}

test('rng is seeded and in [0, 1); clampStick limits to the unit circle', () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.deepEqual(clampStick(3, 4), { x: 0.6, z: 0.8 });
  assert.deepEqual(clampStick(0.3, -0.4), { x: 0.3, z: -0.4 });
  assert.equal(clampStick(NaN, 0), null);
});

test('nothing runs before start(), while paused (dt 0) or after the shift', () => {
  const sim = new LumberSim();
  sim.advance(1);
  assert.equal(sim.tick, 0);
  sim.start();
  sim.advance(0);
  assert.equal(sim.tick, 0);
  sim.advance(TICK * 3 + 1e-9);
  assert.equal(sim.tick, 3);
});

test('the same input per tick gives the same shift at 30, 60 and 120 fps and with jittery frames', () => {
  const ref = botShift(7, 1 / 60);
  for (const [dt, jitter] of [
    [1 / 30, 0],
    [1 / 120, 0],
    [1 / 60, 0.6],
  ] as const) {
    const other = botShift(7, dt, jitter);
    assert.deepEqual(other.unlocks, ref.unlocks, `unlock ticks at dt=${dt} jitter=${jitter}`);
    assert.equal(other.sim.earned, ref.sim.earned);
    assert.equal(other.sim.served, ref.sim.served);
    assert.equal(other.sim.lost, ref.sim.lost);
    assert.equal(other.sim.player.x, ref.sim.player.x);
    assert.equal(other.sim.player.z, ref.sim.player.z);
  }
  assert.equal(ref.sim.time, SHIFT_SECONDS);
});

test('a stall is clamped: one huge frame runs at most 0.5 s of game time', () => {
  const sim = new LumberSim();
  sim.start();
  sim.advance(10);
  assert.equal(sim.tick, 15);
});

test('economy: the greedy bot earns well, buys most upgrades, and stays under the board rate limit', () => {
  const limit = manifest.leaderboards.find((b) => b.id === 'earnings')!.maxScorePerMinute;
  for (const seed of [1, 2, 3]) {
    const { sim, unlocks } = botShift(seed, 1 / 60);
    assert.ok(sim.earned >= 1000, `seed ${seed}: earned ${sim.earned}`);
    assert.ok(sim.earned < 2500, `seed ${seed}: the bot should not reach the top achievement (${sim.earned})`);
    assert.ok(unlocks.length >= 6, `seed ${seed}: unlocks ${unlocks.join(' ')}`);
    assert.ok(sim.earned / (SHIFT_SECONDS / 60) < limit / 2, `seed ${seed}: ${sim.earned} $/shift vs ${limit} $/min`);
  }
});

test('the sawmill fills its tray at its period and stalls when full', () => {
  const sim = new LumberSim();
  place(sim, { x: 5, z: 6 });
  sim.start();
  run(sim, 1.25 * 4 + 0.01);
  assert.equal(sim.mills[0]!.stock, 4);
  run(sim, 60);
  assert.equal(sim.mills[0]!.stock, MILL_CAP);
  assert.equal(sim.mills[1]!.stock, 0, 'the second mill is not built yet');
});

test('pick up at the tray (up to capacity), drop on the counter', () => {
  const sim = new LumberSim();
  sim.start();
  sim.mills[0]!.stock = MILL_CAP;
  place(sim, MILL_TRAYS[0]!);
  run(sim, 2);
  assert.equal(sim.player.carry, sim.player.cap);
  assert.equal(sim.player.cap, 8);
  place(sim, DROP_ZONE);
  run(sim, 2);
  assert.equal(sim.player.carry, 0);
  assert.equal(sim.counter, 8);
});

test('sales need someone at the register; the cash lands on the floor and is collected into the wallet', () => {
  const sim = new LumberSim(3);
  sim.start();
  sim.counter = 20;
  place(sim, { x: 5, z: -4 });
  // Wait for the first builder to reach the register: nobody is at the till, so nothing is sold.
  run(sim, 6);
  const front = sim.queue[0]!;
  assert.deepEqual({ x: front.x, z: front.z }, queueSlot(0));
  assert.equal(front.got, 0);
  assert.equal(sim.earned, 0);

  place(sim, REGISTER_ZONE);
  run(sim, 1);
  assert.equal(front.state, 'happy');
  assert.equal(sim.earned, front.wants * 5);
  assert.equal(sim.cash, sim.earned);
  assert.equal(sim.counter, 20 - front.wants);

  const cash = sim.cash;
  place(sim, CASH_ZONE);
  run(sim, 1);
  assert.equal(sim.cash, 0);
  assert.equal(sim.wallet, cash);
});

test('pads: only the next two show; standing on one spends the wallet and applies the upgrade', () => {
  const sim = new LumberSim();
  sim.start();
  assert.deepEqual(
    sim.visiblePads.map((p) => p.def.id),
    UNLOCKS.slice(0, VISIBLE_PADS).map((u) => u.id),
  );
  sim.wallet = 75;
  const arms = UNLOCKS.find((u) => u.id === 'arms')!;
  place(sim, arms);
  run(sim, 3);
  assert.ok(sim.unlocked.has('arms'));
  assert.equal(sim.player.cap, 16);
  assert.equal(sim.wallet, 75 - arms.cost);
  assert.deepEqual(
    sim.visiblePads.map((p) => p.def.id),
    ['cashier', 'blade'],
  );

  // A partial payment stays on the pad.
  const cashier = UNLOCKS.find((u) => u.id === 'cashier')!;
  place(sim, cashier);
  run(sim, 1);
  assert.equal(sim.wallet, 0);
  assert.equal(sim.pads.find((p) => p.def.id === 'cashier')!.paid, 15);
  assert.ok(!sim.cashierHired);
});

test('a hired hauler moves planks from the tray to the counter on its own', () => {
  const sim = new LumberSim();
  sim.start();
  sim.wallet = 1000;
  for (const id of ['cashier', 'arms', 'blade', 'hauler'] as const) {
    place(
      sim,
      UNLOCKS.find((u) => u.id === id)!,
    );
    run(sim, 4);
  }
  assert.equal(sim.haulers.length, 1);
  place(sim, { x: -5, z: 6 });
  const before = sim.counter;
  run(sim, 20);
  assert.ok(sim.counter + sim.planksSold > before + 10, `counter ${sim.counter}, sold ${sim.planksSold}`);
});

test('customers walk out when nobody serves them; a full queue turns arrivals away', () => {
  const sim = new LumberSim(5);
  sim.start();
  place(sim, { x: -5, z: -4 });
  run(sim, 30);
  assert.ok(sim.lost > 0, 'someone gave up');
  assert.ok(sim.customers.some((c) => c.state === 'angry') || sim.lost > 0);
  assert.ok(sim.queue.length <= QUEUE_MAX);
  run(sim, 60);
  assert.ok(sim.queue.length <= QUEUE_MAX);
  assert.equal(sim.earned, 0);
});

test('customers arrive more often as the shift goes on', () => {
  assert.ok(arrivalGap(0) > arrivalGap(SHIFT_SECONDS / 2));
  assert.ok(arrivalGap(SHIFT_SECONDS / 2) > arrivalGap(SHIFT_SECONDS));
});

test('the player cannot walk through the counter or leave the camp', () => {
  const sim = new LumberSim();
  sim.start();
  place(sim, { x: COUNTER.x, z: COUNTER.z - 1.5 });
  sim.setStick(0, 1);
  run(sim, 2);
  assert.ok(sim.player.z < COUNTER.z - COUNTER.d / 2, `stopped at the counter (z ${sim.player.z})`);
  sim.setStick(-1, 0);
  run(sim, 5);
  assert.equal(sim.player.x, BOUNDS.minX);
});

test('the shift ends at SHIFT_SECONDS with an "over" event', () => {
  const sim = new LumberSim();
  sim.start();
  let over = 0;
  for (let t = 0; t < SHIFT_SECONDS + 5; t += 0.25) for (const e of sim.advance(0.25)) if (e.type === 'over') over++;
  assert.equal(over, 1);
  assert.equal(sim.phase, 'over');
  assert.equal(sim.timeLeft, 0);
  assert.equal(sim.time, SHIFT_SECONDS);
});
