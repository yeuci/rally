import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CARRY_SPEED,
  DT,
  FISTS,
  GUNS,
  Item,
  MELEE,
  NorthdaleMatch,
  PLAYER_RADIUS,
  SAFE_CENTER,
  SAFE_WALLS,
  movePlayer,
  parseInput,
} from '@rally/game-northdale-server';
import { LocalGun, gunOf, meleeOf, shotAngles, tracerLength } from '../src/localgun.ts';
import { Predictor, shouldPredict } from '../src/predict.ts';
import { InputSender, type Command, type SentInput } from '../src/sender.ts';

const cmd = (over: Partial<Command> = {}): Command => ({
  move: { x: 0, y: 0 },
  aim: null,
  fire: false,
  melee: false,
  act: false,
  use: 0,
  slot: 0,
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

test('buttons and item taps go out at once; a held trigger refreshes the view tick every 250 ms', () => {
  const { s } = sender();
  s.offer(cmd({ aim: { x: 1, y: 0 } }), 0);
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true }), 5)?.fire, true, 'trigger: no wait');
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true }), 8)?.melee, true, 'melee: no wait');
  assert.equal(
    s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true, act: true }), 9)?.act,
    true,
    'hold: no wait',
  );
  const tap = s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true, act: true, use: 1, slot: 1 }), 10);
  assert.deepEqual([tap?.use, tap?.slot], [1, 1], 'an item tap: no wait');
  const held = cmd({ aim: { x: 1, y: 0 }, fire: true, melee: true, act: true, use: 1, slot: 1 });
  assert.equal(s.offer({ ...held, rt: 110 }, 100), null);
  assert.equal(s.offer({ ...held, rt: 115 }, 260)?.rt, 115, 'the view tick follows while firing');
  const kept = s.offer({ ...held, move: { x: 0, y: 1 }, aim: null }, 400);
  assert.deepEqual([kept?.ax, kept?.ay], [1, 0], 'no aim this frame keeps the last one on the wire');
  assert.equal(parseInput(kept)?.input.use, 1);
});

test('release stops moving, firing, swinging and holding at once, only when needed', () => {
  const { s } = sender();
  assert.equal(s.release(0), null, 'nothing sent yet');
  s.offer(cmd({ move: { x: 1, y: 0 }, fire: true, melee: true, act: true, use: 3 }), 0);
  const r = s.release(10);
  assert.deepEqual([r?.mx, r?.my, r?.fire, r?.melee, r?.act, r?.use], [0, 0, false, false, false, 3]);
  assert.equal(s.release(20), null, 'already still');
});

test('prediction replays the sent sticks with the server’s own movement (walls included)', () => {
  // The server: a survivor runs out of the safehouse, then shoulders into a safehouse wall. At every "snapshot" (each
  // 10 ticks) the prediction rebased on it lands exactly where the server is 10 ticks later.
  const m = new NorthdaleMatch({ seed: 3, rules: { spawnScale: 0 } });
  m.addPlayer('a', 'A');
  const a = m.players.get('a')!;
  const p = new Predictor();
  const follow = (stick: { x: number; y: number }, snaps: number) => {
    m.setInput('a', { move: stick, aim: null, fire: false, melee: false, act: false, use: 0, slot: 0 });
    p.recordStick(0, stick);
    for (let snap = 0; snap < snaps; snap++) {
      const t = snap * 10 * DT * 1000;
      p.rebase({ x: a.x, y: a.y, vx: a.vx, vy: a.vy, speed: 1, goo: [] }, t);
      for (let i = 0; i < 10; i++) m.step(DT);
      const got = p.predict(t + 10 * DT * 1000);
      assert.ok(Math.hypot(got.x - a.x, got.y - a.y) < 1e-6, `snapshot ${snap}: ${got.x}, ${got.y} vs ${a.x}, ${a.y}`);
    }
  };
  m.place('a', SAFE_CENTER.x, SAFE_CENTER.y);
  m.step(DT);
  const from = { x: a.x, y: a.y };
  follow({ x: -0.6, y: -0.8 }, 9);
  assert.ok(Math.hypot(a.x - from.x, a.y - from.y) > 3, 'it did move');
  // Into a wall (from its outer side, slightly slanted): the survivor slides along it, never through.
  const w = SAFE_WALLS.find((b) => b.x1 - b.x0 > 3)!;
  m.place('a', (w.x0 + w.x1) / 2, w.y1 + 0.6);
  m.step(DT);
  follow({ x: 0.3, y: -0.95 }, 4);
  assert.ok(a.y >= w.y1 + PLAYER_RADIUS - 1e-3, `held at the wall: ${a.y} vs ${w.y1}`);

  // Carrying a part is slower, a goo pool slower still: the same factors as the server.
  const run = (speed: number, goo: { x: number; y: number }[]) => {
    const q = new Predictor();
    q.recordStick(0, { x: 1, y: 0 });
    q.rebase({ x: 0, y: -20, vx: 0, vy: 0, speed, goo }, 0);
    return q.sample(400)!.x;
  };
  assert.ok(run(CARRY_SPEED, []) < run(1, []) * 0.8, 'carrying');
  assert.ok(run(1, [{ x: 0.5, y: -20 }]) < run(1, []) * 0.8, 'goo');
  const ref = { x: 0, y: -20, vx: 0, vy: 0 };
  for (let i = 0; i < 12; i++) movePlayer(ref, { x: 1, y: 0 }, 1, [], DT);
  assert.ok(Math.abs(run(1, []) - ref.x) < 1e-9);
});

test('prediction: the round trip is replayed; corrections blend out; teleports (respawns) snap', () => {
  const still = { x: 0, y: -20, vx: 0, vy: 0, speed: 1, goo: [] };
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

test('prediction runs where the server moves survivors: never for the dead, the escape drive or the result', () => {
  for (const phase of ['waiting', 'day', 'dusk', 'night', 'holdout']) {
    assert.equal(shouldPredict(phase, 0), true, phase);
    assert.equal(shouldPredict(phase, 1), true, `${phase}: crawling while down`);
    assert.equal(shouldPredict(phase, 2), false, `${phase}: dead`);
  }
  assert.equal(shouldPredict('escape', 0), false);
  assert.equal(shouldPredict('over', 0), false);
});

function shotsPerSecond(code: number, fps: number, seconds = 3) {
  const g = new LocalGun();
  let n = 0;
  for (let i = 0; i <= fps * seconds; i++) n += g.update((i * 1000) / fps, gunOf(code), FISTS, true, false).shots;
  return n / seconds;
}

test('your own shots follow the server cadence at any frame rate; a swing interrupts, carrying holds fire', () => {
  for (const fps of [30, 60, 120]) {
    for (const code of [Item.pistol, Item.smg, Item.rifle]) {
      const gun = GUNS[code]!;
      assert.ok(Math.abs(shotsPerSecond(code, fps) - 1 / gun.cooldown) < 0.6, `${code} at ${fps} fps`);
    }
  }
  const g = new LocalGun();
  const pistol = gunOf(Item.pistol);
  const knife = meleeOf(Item.knife);
  assert.deepEqual(g.update(0, pistol, knife, false, false), { shots: 0, swings: 0 });
  assert.deepEqual(g.update(16, pistol, knife, true, false), { shots: 1, swings: 0 }, 'first shot on the press');
  assert.deepEqual(g.update(32, pistol, knife, false, true), { shots: 0, swings: 1 }, 'the melee button');
  let swings = 0;
  for (let t = 48; t <= 32 + MELEE[Item.knife]!.cooldown * 1000 + 20; t += 16)
    swings += g.update(t, pistol, knife, false, true).swings;
  assert.equal(swings, 1, 'the next swing after the weapon’s cooldown');
  assert.equal(new LocalGun().update(0, null, knife, true, false).shots, 0, 'no gun in hand (carrying, empty)');
  assert.equal(meleeOf(Item.none), FISTS);
  assert.equal(gunOf(Item.knife), null);
});

test('the shotgun fans its pellets; tracers stop at walls and drawn zombies', () => {
  const shotgun = GUNS[Item.shotgun]!;
  const fan = shotAngles(shotgun, 0, 0);
  assert.equal(fan.length, shotgun.pellets);
  assert.ok(Math.abs(fan[fan.length - 1]! - fan[0]! - shotgun.spread) < 1e-12);
  assert.deepEqual(shotAngles(GUNS[Item.pistol]!, 1, 0), [1]);
  assert.ok(Math.abs(tracerLength(0, -20, 1, 0, 15, [{ x: 3, y: -20, r: 0.5 }]) - 2.5) < 1e-9);
  assert.ok(
    Math.abs(
      tracerLength(
        0,
        -20,
        1,
        0,
        15,
        [
          { x: 3, y: -20, r: 0.5 },
          { x: 5, y: -20, r: 0.5 },
        ],
        2,
      ) - 4.5,
    ) < 1e-9,
    'a piercing rifle round stops at the second',
  );
  assert.equal(tracerLength(0, -20, 1, 0, 0.5, []), 0.5, 'range');
  // At a safehouse wall from 2 units away: the tracer stops at its face.
  const w = SAFE_WALLS.find((b) => b.x1 - b.x0 > 3)!;
  assert.ok(Math.abs(tracerLength((w.x0 + w.x1) / 2, w.y1 + 2, 0, -1, 15, []) - 2) < 0.05, 'the safehouse wall');
});
