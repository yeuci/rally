import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Bot, Pilot } from '../src/bot.ts';
import {
  DOOR_H,
  FLAP_SPEED,
  FORM_RULES,
  FoldSim,
  PLANE_HH,
  ROOM_H,
  ROOM_THEMES,
  START_X,
  TICK,
  WALL_T,
  difficulty,
  generateRoom,
  overlaps,
  rng,
  speedScale,
  type Input,
  type SimEvent,
} from '../src/sim.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string; maxScorePerMinute: number }[];
  achievements: { key: string; title: string }[];
};

/** Run `seconds` of game time in frames of `frameDt`, collecting events. */
function run(sim: FoldSim, seconds: number, beforeTick?: (s: FoldSim) => void, frameDt = 1 / 60): SimEvent[] {
  const events: SimEvent[] = [];
  for (let t = 0; t < seconds - 1e-9 && sim.phase === 'playing'; t += frameDt)
    events.push(...sim.advance(frameDt, beforeTick));
  return events;
}

/** A sim already flying, with the house cleared out (tests that only want the plane's physics). */
function emptySky(y = 3): FoldSim {
  const sim = new FoldSim(1);
  for (const room of sim.rooms) {
    room.obstacles.length = 0;
    room.zones.length = 0;
    room.pits.length = 0;
  }
  sim.plane.y = sim.plane.py = y;
  sim.start();
  return sim;
}

/** Inputs at fixed ticks: the same "player" whatever the frame rate. */
function scripted(script: Record<number, Input>) {
  return (s: FoldSim) => {
    const cmd = script[s.tick];
    if (cmd) s.input(cmd);
  };
}

test('rng is seeded and in [0, 1)', () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  assert.notEqual(rng(1)(), rng(2)());
});

test('the run ramps difficulty and speed up to 1500 m, then holds', () => {
  assert.equal(difficulty(0), 0);
  assert.equal(difficulty(750), 0.5);
  assert.equal(difficulty(1500), 1);
  assert.equal(difficulty(5000), 1);
  assert.equal(speedScale(0), 1);
  assert.ok(Math.abs(speedScale(1500) - 1.3) < 1e-9);
  assert.equal(speedScale(9000), speedScale(1500));
});

test('a sim starts on the first input and only plays while playing', () => {
  const sim = new FoldSim(3);
  assert.equal(sim.phase, 'ready');
  assert.deepEqual(sim.advance(1), []);
  assert.equal(sim.tick, 0);
  sim.input('glider');
  assert.equal(sim.phase, 'playing');
  sim.advance(TICK);
  assert.equal(sim.tick, 1);
  // A stalled frame is capped (12 ticks) rather than jumping the plane.
  sim.advance(5);
  assert.equal(sim.tick, 13);
});

test('the same seed and inputs fly the same at 30, 60 and 144 fps', () => {
  // The bot decides from the sim alone, tick by tick: the same "player" whatever the frame rate.
  const ticks = 30 * 60;
  const fly = (dt: number) => {
    const sim = new FoldSim(7);
    const bot = new Bot();
    sim.start();
    while (sim.tick < ticks && sim.phase === 'playing') sim.advance(dt, bot.drive);
    return { sim, bot };
  };
  const ref = fly(1 / 60);
  assert.equal(ref.sim.phase, 'playing');
  for (const dt of [1 / 30, 1 / 144]) {
    const { sim } = fly(dt);
    // Ticks run whole: a coarse frame can step past `ticks`; bring the reference to the same tick.
    while (ref.sim.tick < sim.tick) ref.sim.advance(TICK, ref.bot.drive);
    assert.equal(sim.tick, ref.sim.tick);
    assert.equal(sim.plane.x, ref.sim.plane.x);
    assert.equal(sim.plane.y, ref.sim.plane.y);
    assert.equal(sim.stamps, ref.sim.stamps);
  }
});

test('every room is built from the seed and its index alone', () => {
  for (const seed of [1, 99, 123456]) {
    for (const index of [0, 1, 5, 40]) {
      assert.deepEqual(generateRoom(seed, index, 100), generateRoom(seed, index, 100));
    }
  }
  assert.notDeepEqual(generateRoom(1, 3, 100).obstacles, generateRoom(2, 3, 100).obstacles);
  // Two sims of one seed build the same house, however they are flown.
  const a = new FoldSim(5);
  const b = new FoldSim(5);
  a.start();
  b.start();
  run(a, 20, new Bot().drive);
  run(b, 3);
  const shared = b.rooms.filter((r) => a.rooms.some((q) => q.index === r.index));
  for (const r of shared) {
    const q = a.rooms.find((x) => x.index === r.index)!;
    assert.deepEqual(
      q.obstacles.map((o) => [o.kind, o.x0, o.y0]),
      r.obstacles.map((o) => [o.kind, o.x0, o.y0]),
    );
  }
});

test('rooms join up, keep their furniture inside, and leave the lane passable', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const sim = new FoldSim(seed);
    let x = 0;
    for (let index = 0; index < 60; index++) {
      const room = generateRoom(seed, index, x);
      assert.equal(room.x0, x);
      assert.ok(room.x1 - room.x0 >= 26, `room ${seed}/${index} is long enough`);
      assert.ok(room.theme >= 0 && room.theme < ROOM_THEMES);
      const doors = room.obstacles.filter((o) => o.kind === 'doorway');
      if (index === 0) assert.equal(doors.length, 0);
      else {
        assert.equal(doors.length, 1);
        assert.deepEqual([doors[0]!.x0, doors[0]!.x1, doors[0]!.y0], [x, x + WALL_T, DOOR_H]);
      }
      const furniture = room.obstacles.filter((o) => o.kind !== 'doorway');
      for (const o of furniture) {
        assert.ok(o.x0 > room.x0 + WALL_T && o.x1 < room.x1 - 3, `${o.kind} sits inside room ${seed}/${index}`);
        assert.ok(o.y0 >= 0 && o.y1 <= ROOM_H && o.y1 > o.y0);
        // Something always leaves a way past: over a shelf, under a lamp, round a table.
        if (o.kind === 'shelf') assert.ok(o.y1 <= 4.5 + 1e-9);
        if (o.kind === 'lamp') assert.ok(o.y0 >= 1.6 - 1e-9);
      }
      // Furniture never crowds together (a kettle stands on its table).
      const sorted = furniture.filter((o) => o.kind !== 'kettle').sort((a, b) => a.x0 - b.x0);
      for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i]!.x0 - sorted[i - 1]!.x1 >= 3, 'features keep apart');
      for (const k of furniture.filter((o) => o.kind === 'kettle')) {
        const table = furniture.find((o) => o.kind === 'table' && k.x0 >= o.x0 && k.x1 <= o.x1 && k.y0 === o.y1);
        assert.ok(table, 'a kettle stands on a table');
      }
      for (const pit of room.pits) {
        assert.ok(pit.x1 - pit.x0 >= 3 && pit.x1 - pit.x0 <= 8);
        for (const o of furniture) assert.ok(o.x1 <= pit.x0 || o.x0 >= pit.x1, 'nothing stands over a stairwell');
      }
      for (const s of room.stamps) {
        const box = { x0: s.x - 0.2, x1: s.x + 0.2, y0: s.y - 0.2, y1: s.y + 0.2 };
        assert.ok(!room.obstacles.some((o) => overlaps(o, box)), 'stamps float in the open');
        assert.ok(s.y > PLANE_HH && s.y < ROOM_H - PLANE_HH);
      }
      x = room.x1;
    }
    // The sim's own rooms agree with generateRoom and join without gaps.
    for (let i = 1; i < sim.rooms.length; i++) assert.equal(sim.rooms[i]!.x0, sim.rooms[i - 1]!.x1);
  }
});

test('the first room teaches the shapes: a shelf, a lamp, then a stairwell', () => {
  const room = generateRoom(77, 0, 0);
  assert.deepEqual(
    room.obstacles.map((o) => o.kind),
    ['shelf', 'lamp'],
  );
  assert.equal(room.pits.length, 1);
  assert.ok(room.pits[0]!.x0 > room.obstacles[1]!.x1);
});

test('shapes: the dart drops fast, the glider floats, the crane climbs a flap at a time', () => {
  const fall = (form: Input) => {
    const sim = emptySky(5);
    sim.input(form);
    run(sim, 0.6);
    return { dy: 5 - sim.plane.y, vx: sim.plane.vx, vy: sim.plane.vy };
  };
  const dart = fall('dart');
  const glider = fall('glider');
  assert.ok(dart.dy > glider.dy * 2, `dart drops ${dart.dy.toFixed(2)} vs glider ${glider.dy.toFixed(2)}`);
  assert.ok(dart.vx > glider.vx);
  assert.ok(glider.vy >= -FORM_RULES.glider.maxFall - 1e-9, 'a glider never sinks faster than its limit');

  const sim = emptySky(2);
  const flaps: number[] = [];
  sim.input('flap');
  sim.advance(TICK);
  flaps.push(sim.plane.vy);
  assert.equal(sim.plane.form, 'crane');
  assert.ok(Math.abs(sim.plane.vy - (FLAP_SPEED - FORM_RULES.crane.gravity * TICK)) < 1e-9);
  // A second flap inside the cooldown does nothing.
  sim.input('flap');
  const events = sim.advance(TICK);
  assert.ok(!events.some((e) => e.type === 'flap'));
  assert.ok(sim.plane.vy < flaps[0]!);
  // Flapping steadily climbs.
  const climb = scripted(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [sim.tick + 1 + i * 12, 'flap'])));
  run(sim, 2, climb);
  assert.ok(sim.plane.y > 4, `crane climbed to ${sim.plane.y.toFixed(2)}`);
});

test('refolding a fast dive into the glider pulls it up', () => {
  const sim = emptySky(5.5);
  sim.input('dart');
  run(sim, 0.7);
  const before = sim.plane.vy;
  assert.ok(sim.plane.vx > FORM_RULES.glider.speed + 0.5);
  sim.input('glider');
  const events = sim.advance(TICK);
  assert.deepEqual(events[0], { type: 'form', form: 'glider', from: 'dart' });
  assert.ok(sim.plane.vy > before + 1, `pull-up: ${before.toFixed(2)} → ${sim.plane.vy.toFixed(2)}`);
  assert.deepEqual([...sim.formsUsed].sort(), ['dart', 'glider']);
});

test('the ceiling bonks, the floor skids and a long skid stalls the run', () => {
  const sim = emptySky(ROOM_H - 0.5);
  const up = scripted(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [1 + i * 12, 'flap'])));
  const events = run(sim, 0.8, up);
  assert.ok(events.some((e) => e.type === 'bonk'));
  assert.ok(sim.plane.y <= ROOM_H - PLANE_HH + 1e-9);

  const low = emptySky(0.5);
  low.input('dart');
  const ground = run(low, 6);
  assert.ok(ground.some((e) => e.type === 'skid'));
  assert.equal(low.phase, 'over');
  assert.equal(low.crash?.cause, 'stall');
  assert.deepEqual(
    ground.slice(-2).map((e) => e.type),
    ['crash', 'over'],
  );
});

test('furniture ends the run; a stairwell swallows a plane that drops into it', () => {
  // Gliding level from the start runs into the tutorial shelf (3.4 m tall, at x 12).
  const sim = new FoldSim(1);
  sim.start();
  run(sim, 10);
  assert.equal(sim.crash?.cause, 'shelf');
  assert.ok(sim.crash!.x > 11 && sim.crash!.x < 13.5);

  // Over the shelf and under the lamp by hand, then a dive into the stairwell.
  const pit = new FoldSim(1);
  const room = pit.rooms[0]!;
  room.obstacles.length = 0;
  pit.plane.x = pit.plane.px = room.pits[0]!.x0 + 1;
  pit.plane.y = pit.plane.py = 1;
  pit.input('dart');
  run(pit, 3);
  assert.equal(pit.crash?.cause, 'stairwell');
});

test('stamps are taken once and counted; crossing a stairwell is counted', () => {
  const sim = new FoldSim(1);
  const room = sim.rooms[0]!;
  room.obstacles.length = 0;
  const s = room.stamps[0]!;
  sim.plane.x = sim.plane.px = s.x - 1.5;
  sim.plane.y = sim.plane.py = s.y;
  sim.plane.vy = 0;
  sim.start();
  // Hold the height for a moment: the glider sinks slowly enough to pass through the stamp.
  const events = run(sim, 0.5);
  const taken = events.filter((e) => e.type === 'stamp');
  assert.equal(taken.length, 1);
  assert.ok(s.taken);
  assert.equal(sim.stamps, 1);
  run(sim, 0.5);
  assert.equal(sim.stamps, 1);

  const pit = new FoldSim(1);
  pit.rooms[0]!.obstacles.length = 0;
  const p = pit.rooms[0]!.pits[0]!;
  pit.plane.x = pit.plane.px = p.x0 - 1;
  pit.plane.y = pit.plane.py = 4;
  pit.start();
  const crossed = run(pit, 2);
  assert.ok(crossed.some((e) => e.type === 'stairwell' && e.total === 1));
  assert.equal(pit.stairwells, 1);
});

test('steam soaks the paper, fans push down, radiators lift', () => {
  const zone = (kind: 'steam' | 'fan' | 'heat') => {
    const sim = emptySky(3);
    sim.rooms[0]!.zones.push({ kind, x0: 0, x1: 1000, y0: 0, y1: ROOM_H });
    const events = run(sim, 0.5);
    return { sim, events };
  };
  const plain = emptySky(3);
  run(plain, 0.5);
  const steam = zone('steam');
  assert.ok(steam.sim.plane.soggy > 0);
  assert.equal(steam.events.filter((e) => e.type === 'soggy').length, 1);
  assert.ok(zone('fan').sim.plane.y < plain.plane.y - 0.5);
  assert.ok(zone('heat').sim.plane.y > plain.plane.y + 0.5);
});

test('rooms are generated ahead and dropped behind; entering one is an event', () => {
  const sim = new FoldSim(4);
  sim.start();
  const events = run(sim, 40, new Bot().drive);
  assert.ok(events.some((e) => e.type === 'room' && e.index === 1));
  const last = sim.rooms[sim.rooms.length - 1]!;
  assert.ok(last.x1 >= sim.plane.x + 48);
  assert.ok(sim.rooms[0]!.x1 >= sim.plane.x - 24 - 40);
  assert.ok(sim.rooms.length <= 5);
});

test('a fork flies on by itself without touching the real run', () => {
  const sim = new FoldSim(9);
  sim.start();
  run(sim, 2, new Bot().drive);
  const before = { x: sim.plane.x, y: sim.plane.y, tick: sim.tick, rooms: sim.rooms.length, stamps: sim.stamps };
  const taken = sim.rooms.flatMap((r) => r.stamps.map((s) => s.taken));
  const f = sim.fork();
  run(f, 20, new Bot().drive);
  assert.ok(f.plane.x > before.x + 20);
  assert.deepEqual(
    { x: sim.plane.x, y: sim.plane.y, tick: sim.tick, rooms: sim.rooms.length, stamps: sim.stamps },
    before,
  );
  assert.deepEqual(
    sim.rooms.flatMap((r) => r.stamps.map((s) => s.taken)),
    taken,
  );
  // The same inputs from the same point fly the same in a fork as in the real sim.
  const g = sim.fork();
  run(g, 3, scripted({ [sim.tick + 5]: 'flap', [sim.tick + 40]: 'glider' }));
  run(sim, 3, scripted({ [sim.tick + 5]: 'flap', [sim.tick + 40]: 'glider' }));
  assert.equal(g.plane.x, sim.plane.x);
  assert.equal(g.plane.y, sim.plane.y);
});

test('the house is passable: the bot flies past full difficulty on every seed', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const sim = new FoldSim(seed);
    const bot = new Bot();
    sim.start();
    while (sim.phase === 'playing' && sim.distance < 1600) sim.advance(1 / 30, bot.drive);
    assert.equal(
      sim.phase,
      'playing',
      `seed ${seed}: crashed into ${sim.crash?.cause} at ${sim.distance.toFixed(0)} m`,
    );
    assert.ok(sim.stamps > 40, `seed ${seed}: ${sim.stamps} stamps`);
    assert.ok(sim.stairwells > 5);
    assert.deepEqual([...sim.formsUsed].sort(), ['crane', 'dart', 'glider']);
    // Scores stay under the leaderboard's per-minute cap.
    const cap = manifest.leaderboards.find((b) => b.id === 'distance')!.maxScorePerMinute;
    assert.ok(sim.distance / (sim.time / 60) < cap);
  }
});

test('the rules of thumb alone get through the first room', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const sim = new FoldSim(seed);
    const pilot = new Pilot();
    sim.start();
    run(sim, 12, (s) => {
      const c = pilot.decide(s);
      if (c) s.input(c);
    });
    assert.ok(sim.distance > 40 - START_X || sim.phase === 'playing', `seed ${seed}: ${sim.crash?.cause}`);
  }
});

test('no speed is ever faster than the dart at full speed (the leaderboard cap holds)', () => {
  const cap = manifest.leaderboards.find((b) => b.id === 'distance')!.maxScorePerMinute;
  assert.ok(FORM_RULES.dart.speed * speedScale(1e9) * 60 < cap);
});

test('game.json declares every achievement main.ts unlocks, with the same titles', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const unlocked = [...main.matchAll(/\{ key: '(\w+)', title: '([^']+)'/g)].map((m) => ({ key: m[1], title: m[2] }));
  assert.equal(unlocked.length, 5);
  assert.deepEqual(
    manifest.achievements.map((a) => ({ key: a.key, title: a.title })),
    unlocked,
  );
});
