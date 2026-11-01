import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  AIM_LIMIT,
  CRASH_SECONDS,
  FALL_Y,
  PEDESTAL_HALF,
  PIECES,
  TICK,
  TURN_SECONDS,
  ToppleSim,
  aimRotation,
  initPhysics,
  rng,
  verticalExtent,
  type Seat,
  type SimEvent,
} from '../src/sim.ts';

before(async () => {
  await initPhysics();
});

const humans = (n: number): Seat[] => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, kind: 'human' }));
const bots = (n: number, level: 'easy' | 'normal' | 'hard' = 'normal'): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Bot${i + 1}`, kind: 'bot', level }));

/** Run game time in frames of `dt` until `until` holds (or `max` seconds pass); returns the events seen. */
function runUntil(sim: ToppleSim, until: (s: ToppleSim) => boolean, max = 30, dt = 1 / 60): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let t = 0; t < max && !until(sim); t += dt) seen.push(...sim.advance(dt));
  assert.ok(until(sim), 'condition reached');
  return seen;
}

/** A scripted human game: each turn aims at the next spot in `spots` and drops, on the turn's first tick. */
function scripted(seed: number, frameDt: number, jitter = 0) {
  const spots = [
    { x: 0, z: 0, yaw: 0, flip: false },
    { x: 0.2, z: -0.1, yaw: 2, flip: false },
    { x: -0.15, z: 0.2, yaw: 1, flip: false },
    { x: 0.1, z: 0.1, yaw: 4, flip: true },
    { x: -0.2, z: -0.2, yaw: 3, flip: false },
    { x: 0, z: 0.25, yaw: 6, flip: false },
  ];
  const sim = new ToppleSim(humans(3), seed);
  let turn = 0;
  type Pose = { kind: string; t: object; r: object };
  let poses: Pose[] | null = null;
  let at = -1;
  const input = (s: ToppleSim) => {
    // Snapshot the tower on the first tick of the turn after the last drop: the same tick at any frame rate.
    if (s.humanAiming && turn >= spots.length && !poses) {
      poses = s.pieces.map((p) => ({ kind: p.kind, t: { ...p.body.translation() }, r: { ...p.body.rotation() } }));
      at = s.tick;
    }
    if (!s.humanAiming || turn >= spots.length) return;
    const spot = spots[turn++]!;
    s.setAim(spot.x, spot.z);
    s.turn(spot.yaw);
    if (spot.flip) s.flip();
    s.drop();
  };
  let n = 0;
  while (!poses && sim.tick < 60 * 120 && !sim.finished) {
    sim.advance(frameDt * (1 + (jitter ? Math.sin(n++ * 12.9898) * jitter : 0)), input);
  }
  const result = { poses: poses ?? [], at, round: sim.round };
  sim.dispose();
  return result;
}

test('rng is seeded; piece shapes are sane; rotations and extents', () => {
  const a = rng(5);
  const b = rng(5);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
  for (const [kind, def] of Object.entries(PIECES)) assert.ok(def.parts.length > 0 && def.weight > 0, kind);
  const flat = verticalExtent('plank', aimRotation({ yaw: 0, flip: false }));
  assert.ok(Math.abs(flat.max - 0.11) < 1e-9 && Math.abs(flat.min + 0.11) < 1e-9);
  // Flipped, the plank stands on its long edge: its height is its width (0.26 half).
  const edge = verticalExtent('plank', aimRotation({ yaw: 0, flip: true }));
  assert.ok(Math.abs(edge.max - 0.26) < 1e-6, `flipped half height ${edge.max}`);
  // Yaw does not change a flat piece's height.
  const turned = verticalExtent('plank', aimRotation({ yaw: 3, flip: false }));
  assert.ok(Math.abs(turned.max - 0.11) < 1e-6);
});

test('needs 2–6 seats; the first player is up with a piece and a preview of the next', () => {
  assert.throws(() => new ToppleSim(humans(1)), /2–6 seats/);
  assert.throws(() => new ToppleSim(humans(7)), /2–6 seats/);
  const sim = new ToppleSim(humans(2), 3);
  assert.equal(sim.phase, 'aim');
  assert.equal(sim.current, 0);
  assert.ok(PIECES[sim.piece] && PIECES[sim.next]);
  assert.equal(sim.turnLeft, TURN_SECONDS);
  sim.dispose();
});

test('a human aims (clamped), turns and flips, drops; the piece lands on the pedestal and the next player is up', () => {
  const sim = new ToppleSim(humans(2), 4);
  sim.setAim(99, -99);
  assert.deepEqual([sim.aim.x, sim.aim.z], [AIM_LIMIT, -AIM_LIMIT]);
  sim.setAim(0.1, 0);
  sim.turn(-1);
  assert.equal(sim.aim.yaw, 7);
  sim.flip();
  sim.flip();
  assert.equal(sim.aim.flip, false);
  const dropped = sim.piece;
  sim.drop();
  const events = runUntil(sim, (s) => s.current === 1 && s.phase === 'aim');
  assert.ok(events.some((e) => e.type === 'drop' && e.player === 0 && !e.auto));
  const settled = events.find((e) => e.type === 'settled');
  assert.ok(settled && settled.type === 'settled' && settled.standing === 1);
  assert.equal(sim.pieces.length, 1);
  assert.equal(sim.pieces[0]!.kind, dropped);
  assert.equal(sim.pieces[0]!.owner, 0);
  const y = sim.pieces[0]!.body.translation().y;
  assert.ok(y > 0 && y < 1, `resting on the pedestal (y ${y})`);
  assert.ok(sim.towerTop > 0);
  sim.dispose();
});

test('the same drops give the same tower, at 30, 60 or 120 fps and with jittery frames', () => {
  const ref = scripted(11, 1 / 60);
  assert.ok(ref.poses.length >= 4, `pieces placed: ${ref.poses.length}`);
  for (const [dt, jitter] of [
    [1 / 30, 0],
    [1 / 120, 0],
    [1 / 60, 0.6],
  ] as const) {
    const other = scripted(11, dt, jitter);
    assert.equal(other.at, ref.at, 'snapshot tick');
    assert.deepEqual(other.poses, ref.poses, `bit-identical poses at dt=${dt} jitter=${jitter}`);
  }
});

test('dropping off the pedestal topples: the crash plays, the dropper is out, a fresh round starts with the next player', () => {
  const sim = new ToppleSim(humans(3), 5);
  sim.setAim(AIM_LIMIT, AIM_LIMIT);
  sim.drop();
  const events = runUntil(sim, (s) => s.round === 2, 20);
  const topple = events.find((e) => e.type === 'topple');
  assert.ok(topple && topple.type === 'topple' && topple.player === 0);
  const out = events.find((e) => e.type === 'out');
  assert.ok(out && out.type === 'out' && out.player === 0 && out.place === 3);
  assert.equal(sim.players[0]!.alive, false);
  assert.equal(sim.pieces.length, 0, 'tower cleared');
  assert.equal(sim.current, 1);
  assert.equal(sim.phase, 'aim');
  // The crash lasted CRASH_SECONDS of game time.
  assert.ok(sim.tick * TICK >= CRASH_SECONDS);
  sim.dispose();
});

test('the turn timer drops the piece where it is', () => {
  const sim = new ToppleSim(humans(2), 6);
  sim.setAim(0.3, -0.2);
  const events = runUntil(sim, (s) => s.phase !== 'aim', TURN_SECONDS + 1);
  const drop = events.find((e) => e.type === 'drop');
  assert.ok(drop && drop.type === 'drop' && drop.auto);
  const t = sim.pieces[0]!.body.translation();
  assert.ok(Math.abs(t.x - 0.3) < 1e-6 && Math.abs(t.z + 0.2) < 1e-6);
  sim.dispose();
});

test('input is ignored on a bot’s turn; bots plan, place and pass the turn on', () => {
  const sim = new ToppleSim([{ name: 'Bot', kind: 'bot', level: 'hard' }, ...humans(1)], 7);
  sim.setAim(2, 2);
  sim.drop();
  assert.deepEqual([sim.aim.x, sim.aim.z], [0, 0]);
  const events = runUntil(sim, (s) => s.current === 1 && s.phase === 'aim', 20);
  assert.ok(events.some((e) => e.type === 'drop' && e.player === 0));
  const t = sim.pieces[0]!.body.translation();
  assert.ok(Math.abs(t.x) < PEDESTAL_HALF && Math.abs(t.z) < PEDESTAL_HALF && t.y > 0, 'landed on the pedestal');
  sim.dispose();
});

test('hard bots build safely on a young tower', () => {
  for (const seed of [1, 2, 3]) {
    const sim = new ToppleSim(bots(2, 'hard'), seed);
    runUntil(sim, (s) => s.pieces.length >= 6 || s.phase === 'crash', 120);
    assert.notEqual(sim.phase, 'crash', `seed ${seed}: toppled at ${sim.pieces.length} pieces`);
    assert.ok(sim.pieces.every((p) => p.body.translation().y > FALL_Y));
    sim.dispose();
  }
});

test('an all-bot match ends with one winner and every place handed out', () => {
  const sim = new ToppleSim(bots(4), 2);
  const events = runUntil(sim, (s) => s.finished, 600);
  assert.ok(sim.winner !== null);
  assert.deepEqual(sim.players.map((p) => p.place).sort(), [1, 2, 3, 4]);
  assert.equal(sim.players.filter((p) => p.alive).length, 1);
  assert.equal(events.filter((e) => e.type === 'out').length, 3);
  assert.equal(events.filter((e) => e.type === 'win').length, 1);
  assert.ok(sim.maxStanding >= 2);
  assert.deepEqual(sim.advance(1), [], 'nothing happens after the match');
  sim.dispose();
});
