import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOT_COMMIT,
  BOT_TURN_RATE,
  BotDriver,
  CAMERA_PITCH_DEG,
  DT,
  GunRunMatch,
  PHONE_ASPECTS,
  VIEW_HALF_H,
  VIEW_HALF_W,
  cameraDistance,
  cameraFocus,
  onScreen,
  onTheirScreen,
  type PlayerInput,
} from '../src/index.ts';

const idle: PlayerInput = { move: { x: 0, y: 0 }, aim: null, fire: false, melee: false };

/** A match under way with one bot and humans `a`, `b` (no damage: nobody dies unless a test says so). */
function arena(humans = ['a', 'b']) {
  const m = new GunRunMatch({ seed: 2, rules: { startingTime: 0.1, protectionTime: 0 } });
  m.addPlayer('bot', 'Ace', true);
  for (const h of humans) m.addPlayer(h, h.toUpperCase());
  for (let i = 0; i < 10 && m.phase !== 'playing'; i++) m.step(DT);
  assert.equal(m.phase, 'playing');
  m.invulnerable = true;
  return { m, bots: new BotDriver(m, 3) };
}

const step = (m: GunRunMatch, bots: BotDriver) => {
  bots.think(DT);
  m.step(DT);
};

test('the camera framing: at least VIEW_HALF_W across and VIEW_HALF_H down; the near side shows less ground', () => {
  for (const aspect of PHONE_ASPECTS) {
    assert.ok(onScreen(0, 0, aspect), 'the focus');
    assert.ok(onScreen(VIEW_HALF_W - 0.1, 0, aspect) && !onScreen(VIEW_HALF_W + 1.5, 0, aspect), `across at ${aspect}`);
    assert.ok(cameraDistance(aspect) > 15);
  }
  // 19.5:9 is framed by its height: VIEW_HALF_H on average, less toward the camera (south, +y) than away from it.
  const wide = PHONE_ASPECTS[1];
  assert.ok(onScreen(0, 4.5, wide) && !onScreen(0, VIEW_HALF_H - 0.5, wide), 'south edge ≈ 5 units');
  assert.ok(onScreen(0, -(VIEW_HALF_H + 0.8), wide) && !onScreen(0, -7.5, wide), 'north edge ≈ 6.9 units');
  assert.equal(CAMERA_PITCH_DEG, 60);
  // The focus leads toward the aim and stays inside the yard.
  assert.deepEqual(cameraFocus(0, 0, { x: 2, y: 0 }, wide), { x: 2, y: 0 });
  assert.ok(cameraFocus(19, 0, { x: 2, y: 0 }, wide).x < 19, 'clamped at the fence');
});

test('bots commit to a target: two people trading "nearest" every 0.3 s does not flick the bot between them', () => {
  const { m, bots } = arena();
  m.place('bot', 0, 0.2, 0);
  for (const h of ['a', 'b']) m.setInput(h, idle);
  let switches = 0;
  let last: string | null = null;
  for (let i = 0; i < 30 * 4; i++) {
    // A and B take turns being a little closer (4.7 vs 5.3 units, both in sight).
    const near = Math.floor(i / 9) % 2 === 0;
    m.place('a', near ? -4.7 : -5.3, 0.2);
    m.place('b', near ? 5.3 : 4.7, 0.2);
    m.place('bot', 0, 0.2);
    step(m, bots);
    const t = bots.targetOf('bot');
    if (last !== null && t !== last) switches++;
    last = t;
  }
  assert.ok(last === 'a' || last === 'b');
  assert.ok(switches <= 1, `${switches} switches in 4 s (one is allowed after the ${BOT_COMMIT} s commitment)`);
});

test('bots let go of a target for a clearly closer threat, or when it dies', () => {
  const { m, bots } = arena();
  m.place('bot', 0, 0.2, 0);
  m.place('a', -5, 0.2);
  m.place('b', 6, 0.2);
  for (let i = 0; i < 10; i++) step(m, bots);
  assert.equal(bots.targetOf('bot'), 'a');
  // B steps up next to the bot: much closer, switched at once (inside the commitment).
  m.place('b', 1.6, 0.2);
  step(m, bots);
  assert.equal(bots.targetOf('bot'), 'b');
  // B dies: back to A.
  m.invulnerable = false;
  const b = m.players.get('b')!;
  m.damage(b, 999, null, 'pistol', b.x, b.y, []);
  m.invulnerable = true;
  step(m, bots);
  assert.equal(bots.targetOf('bot'), 'a');
});

test('bots turn their aim at a capped rate (a sweep, not a snap)', () => {
  const { m, bots } = arena(['a']);
  m.place('bot', 0, 0.2, 0);
  m.place('a', 4, 0.2);
  const off = () => {
    const bot = m.players.get('bot')!;
    const a = m.players.get('a')!;
    const d = bots.aimOf('bot')! - Math.atan2(a.y - bot.y, a.x - bot.x);
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  };
  for (let i = 0; i < 30; i++) step(m, bots);
  const before = bots.aimOf('bot')!;
  assert.ok(off() < 0.3, `aiming at A (${off()} off)`);
  // A jumps behind the bot: half a turn away.
  m.place('a', -4, 0.2);
  let prev = before;
  let turns = 0;
  for (let i = 0; i < 30; i++) {
    step(m, bots);
    const now = bots.aimOf('bot')!;
    const d = Math.abs(Math.atan2(Math.sin(now - prev), Math.cos(now - prev)));
    assert.ok(d <= BOT_TURN_RATE * DT + 1e-9, `turned ${d} rad in one tick`);
    if (d > 1e-6) turns++;
    prev = now;
  }
  assert.ok(turns >= 10, 'the half turn took many ticks');
  assert.ok(off() < 0.3, `now aiming at A behind (${off()} off)`);
});

test('bots never fire from off their target’s screen; they close in and fire once it shows them', () => {
  const { m, bots } = arena(['a']);
  // 13 units apart in the open middle lane, a clear line between them: in sight, but off A's screen.
  m.place('bot', -6.5, 0.2, 0);
  m.place('a', 6.5, 0.2, Math.PI);
  m.setInput('a', { ...idle, aim: { x: -1, y: 0 } });
  let firedOnScreen = false;
  for (let i = 0; i < 30 * 4; i++) {
    const bot = m.players.get('bot')!;
    const a = m.players.get('a')!;
    m.place('a', 6.5, 0.2);
    bots.think(DT);
    const shown = onTheirScreen(a, bot);
    if (bot.input.fire) {
      assert.ok(shown, `fired from off screen at ${bot.x.toFixed(2)}, ${bot.y.toFixed(2)}`);
      firedOnScreen = true;
    }
    m.step(DT);
  }
  assert.ok(firedOnScreen, 'it closed in and fired once on screen');
  const bot = m.players.get('bot')!;
  assert.ok(bot.x > -6.5 + 2, `it moved toward A (x ${bot.x})`);
});

test('bot steps are smooth: the stick never jumps from one tick to the next', () => {
  const m = new GunRunMatch({ seed: 9, rules: { startingTime: 0.1, protectionTime: 0 } });
  for (let i = 0; i < 4; i++) m.addPlayer(`b${i}`, `B${i}`, true);
  const bots = new BotDriver(m, 4);
  const prev = new Map<string, { x: number; y: number; alive: boolean }>();
  let worst = 0;
  for (let i = 0; i < 30 * 30; i++) {
    bots.think(DT);
    for (const p of m.playerList) {
      const q = prev.get(p.id);
      if (q?.alive && p.alive) worst = Math.max(worst, Math.hypot(p.input.move.x - q.x, p.input.move.y - q.y));
      prev.set(p.id, { x: p.input.move.x, y: p.input.move.y, alive: p.alive });
    }
    m.step(DT);
  }
  assert.ok(worst < 0.35, `largest stick change in one tick: ${worst.toFixed(3)}`);
});
