import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  GunRunMatch,
  KNIFE_SPEED,
  MELEE,
  WEAPONS,
  movePlayer,
  parseInput,
  type Phase,
} from '@rally/game-gunrun-server';
import { LocalGun, shotAngles, tracerLength } from '../src/localgun.ts';
import { Predictor, shouldPredict } from '../src/predict.ts';
import { InputSender, type Command, type SentInput } from '../src/sender.ts';

const cmd = (over: Partial<Command> = {}): Command => ({
  move: { x: 0, y: 0 },
  aim: null,
  fire: false,
  melee: false,
  rt: 100,
  ...over,
});

function sender() {
  const sent: SentInput[] = [];
  return { s: new InputSender((m) => sent.push(m)), sent };
}

test('the sender: on change only, at most 20 per second, with the view tick; every message parses on the server', () => {
  const { s, sent } = sender();
  assert.ok(s.offer(cmd(), 0), 'the first one always goes');
  assert.equal(s.offer(cmd(), 16), null, 'nothing changed');
  assert.equal(s.offer(cmd({ move: { x: 1, y: 0 } }), 20), null, 'inside the 50 ms window');
  const m = s.offer(cmd({ move: { x: 1, y: 0 }, rt: 123.456 }), 50);
  assert.deepEqual([m?.mx, m?.my, m?.rt, m?.s], [1, 0, 123.5, 2]);
  assert.equal(s.offer(cmd({ move: { x: 0.99, y: 0.01 } }), 200), null, 'tiny stick changes are not news');
  for (const msg of sent) {
    const parsed = parseInput(msg);
    assert.ok(parsed, JSON.stringify(msg));
    assert.equal(parsed.rt, msg.rt);
  }
});

test('the trigger and the knife go out at once; a held trigger refreshes the view tick every 250 ms', () => {
  const { s } = sender();
  s.offer(cmd({ aim: { x: 1, y: 0 } }), 0);
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true }), 5)?.fire, true, 'trigger: no wait');
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true }), 8)?.melee, true, 'knife: no wait');
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true, rt: 110 }), 100), null);
  const refresh = s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true, rt: 115 }), 260);
  assert.equal(refresh?.rt, 115, 'the view tick follows while firing');
  const kept = s.offer(cmd({ move: { x: 0, y: 1 }, fire: true, melee: true }), 400);
  assert.deepEqual([kept?.ax, kept?.ay], [1, 0], 'no aim this frame keeps the last one on the wire');
});

test('release stops moving, firing and stabbing at once, only when needed', () => {
  const { s } = sender();
  assert.equal(s.release(0), null, 'nothing sent yet');
  s.offer(cmd({ move: { x: 1, y: 0 }, fire: true, melee: true }), 0);
  const r = s.release(10);
  assert.deepEqual([r?.mx, r?.my, r?.fire, r?.melee], [0, 0, false, false]);
  assert.equal(s.release(20), null, 'already still');
});

const still = { x: 0, y: 0.4, vx: 0, vy: 0, speed: 1, barrels: 0 };

test('prediction replays the sent sticks with the server’s own movement (walls, barrels and the knife speed)', () => {
  const p = new Predictor();
  p.recordStick(1000, { x: 0, y: -1 });
  p.rebase({ ...still, x: -4.8, y: -1.4 }, 1000);
  const got = p.sample(1000 + 30 * DT * 1000)!;
  const ref = { x: -4.8, y: -1.4, vx: 0, vy: 0 };
  for (let i = 0; i < 30; i++) movePlayer(ref, { x: 0, y: -1 }, 1, 0, DT);
  assert.ok(Math.abs(got.x - ref.x) < 1e-9 && Math.abs(got.y - ref.y) < 1e-9, `${got.y} vs ${ref.y}`);
  assert.ok(got.y > -2.36 + 0.44, 'stopped by the red container like on the server');
  const fast = new Predictor();
  fast.recordStick(0, { x: 1, y: 0 });
  fast.rebase({ ...still, speed: KNIFE_SPEED }, 0);
  const slow = new Predictor();
  slow.recordStick(0, { x: 1, y: 0 });
  slow.rebase(still, 0);
  assert.ok(fast.sample(500)!.x > slow.sample(500)!.x * 1.1, 'the knife rung runs faster');
});

test('prediction: the round trip is replayed; corrections blend out; teleports (respawns) snap', () => {
  const p = new Predictor();
  p.rttMs = 100;
  p.recordStick(950, { x: 1, y: 0 });
  p.rebase(still, 1000);
  assert.ok(p.sample(1000)!.x > 0.05, 'already moving');
  const q = new Predictor();
  q.rebase(still, 1000);
  q.rebase({ ...still, x: 0.5 }, 1050, 1050);
  assert.ok(Math.abs(q.sample(1050)!.x) < 1e-9, 'drawn where it was');
  assert.ok(Math.abs(q.sample(1600)!.x - 0.5) < 0.01, 'converged');
  q.rebase({ ...still, x: 10 }, 1700, 1700);
  assert.equal(q.sample(1700)!.x, 10, 'snapped');
});

test('prediction runs in the phases where the server moves players, for the living only', () => {
  const phases = ['waiting', 'starting', 'playing', 'over'] as const;
  assert.deepEqual(
    phases.filter((ph) => shouldPredict(ph, true)),
    ['waiting', 'starting', 'playing'],
  );
  assert.equal(shouldPredict('playing', false), false, 'dead');
  // The rule matches the match: a held stick moves a living player in exactly those phases.
  const m = new GunRunMatch({ rules: { startingTime: 0.3, overTime: 0.3, protectionTime: 0 } });
  m.addPlayer('a', 'A');
  m.addPlayer('b', 'B');
  const moved = new Map<Phase, boolean>();
  for (let i = 0; i < 400 && moved.size < 4; i++) {
    m.setInput('a', { move: { x: i % 40 < 20 ? 1 : -1, y: 0 }, aim: null, fire: false, melee: false });
    if (m.phase === 'playing' && i > 40) m.forceEnd([]);
    const phase = m.phase;
    const x = m.players.get('a')!.x;
    m.step(DT);
    if (m.phase !== phase) continue;
    if (!moved.has(phase)) moved.set(phase, m.players.get('a')!.x !== x);
  }
  for (const [phase, didMove] of moved) assert.equal(shouldPredict(phase, true), didMove, phase);
});

function shotsPerSecond(weapon: (typeof WEAPONS)[keyof typeof WEAPONS], fps: number, seconds = 3) {
  const g = new LocalGun();
  let n = 0;
  for (let i = 0; i <= fps * seconds; i++) n += g.update((i * 1000) / fps, weapon, true, false).shots;
  return n / seconds;
}

test('your own shots follow the server cadence at any frame rate; the knife has its own', () => {
  for (const fps of [30, 60, 120]) {
    assert.ok(Math.abs(shotsPerSecond(WEAPONS.smg, fps) - 1 / WEAPONS.smg.cooldown) < 0.6, `smg at ${fps} fps`);
    assert.ok(Math.abs(shotsPerSecond(WEAPONS.pistol, fps) - 1 / WEAPONS.pistol.cooldown) < 0.5, `pistol at ${fps}`);
  }
  const g = new LocalGun();
  assert.deepEqual(g.update(0, WEAPONS.pistol, false, false), { shots: 0, stabs: 0 });
  assert.deepEqual(g.update(16, WEAPONS.pistol, true, false), { shots: 1, stabs: 0 }, 'first shot on the press');
  assert.deepEqual(g.update(32, WEAPONS.pistol, true, false), { shots: 0, stabs: 0 });
  assert.deepEqual(g.update(48, WEAPONS.pistol, false, true), { shots: 0, stabs: 1 }, 'the knife button');
  assert.deepEqual(g.update(64, WEAPONS.pistol, false, true), { shots: 0, stabs: 0 });
  let stabs = 0;
  for (let t = 80; t <= 48 + MELEE.cooldown * 1000 + 20; t += 16)
    stabs += g.update(t, WEAPONS.pistol, false, true).stabs;
  assert.equal(stabs, 1, 'the next stab after the knife cooldown');
  assert.deepEqual(new LocalGun().update(0, WEAPONS.knife, true, false), { shots: 0, stabs: 1 }, 'the trigger stabs');
  assert.equal(new LocalGun().update(0, WEAPONS.rocket, true, false).shots, 1, 'a launch (no tracer: kind rocket)');
});

test('the shotgun fans its pellets; tracers stop at walls and drawn players', () => {
  const fan = shotAngles(WEAPONS.shotgun, 0);
  assert.equal(fan.length, WEAPONS.shotgun.pellets);
  assert.ok(Math.abs(fan[fan.length - 1]! - fan[0]! - WEAPONS.shotgun.spread) < 1e-12);
  assert.deepEqual(shotAngles(WEAPONS.pistol, 1), [1]);
  assert.deepEqual(shotAngles(WEAPONS.rocket, 1), [], 'no rays');
  // From under the red container (y -4.85…-2.35, at x -7.4…-2.2) straight up: stops at its face.
  assert.ok(Math.abs(tracerLength(-4.8, -1.4, 0, -1, 15, []) - (2.35 - 1.4 + 0.0)) < 0.02);
  assert.ok(Math.abs(tracerLength(0, 0.4, 1, 0, 15, [{ x: 3, y: 0.4, r: 0.5 }]) - 2.5) < 1e-9);
  assert.equal(tracerLength(0, 0.4, 1, 0, 2, []), 2, 'range');
});
