import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BARRELS,
  BARREL_RESPAWN,
  BotDriver,
  DT,
  FINAL_TIER,
  GunRunMatch,
  KNIFE_SPEED,
  LADDER,
  MEDS,
  MED_HEAL,
  PLAYER_HP,
  WEAPONS,
  sanitizeRules,
  tierWeapon,
  type MatchEvent,
  type MatchRules,
  type MatchSummary,
  type PlayerInput,
} from '../src/index.ts';

/** Fast rules so a match fits in a test. */
const FAST: Partial<MatchRules> = { startingTime: 0.1, overTime: 0.5, respawnTime: 0.5, protectionTime: 0.3 };
const idle: PlayerInput = { move: { x: 0, y: 0 }, aim: null, fire: false, melee: false };

/** A match with `n` players (a, b, c…), stepped into `playing`. */
function playing(n = 2, rules: Partial<MatchRules> = {}, seed = 1) {
  const m = new GunRunMatch({ seed, rules: { ...FAST, ...rules } });
  const ids = 'abcdefgh'.slice(0, n).split('');
  for (const id of ids) m.addPlayer(id, id.toUpperCase());
  const events: MatchEvent[] = [];
  for (let i = 0; i < 60 && m.phase !== 'playing'; i++) events.push(...m.step(DT));
  assert.equal(m.phase, 'playing');
  // Out of their spawn protection.
  for (const p of m.players.values()) p.protectedFor = 0;
  return { m, ids, events };
}

function run(m: GunRunMatch, seconds: number): MatchEvent[] {
  const ev: MatchEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) ev.push(...m.step(DT));
  return ev;
}

/** Face `target` from `shooter` (aim input, held fire or not). */
function aimAt(m: GunRunMatch, shooter: string, target: string, fire = true, melee = false) {
  const s = m.players.get(shooter)!;
  const t = m.players.get(target)!;
  const len = Math.hypot(t.x - s.x, t.y - s.y);
  m.setInput(shooter, { move: { x: 0, y: 0 }, aim: { x: (t.x - s.x) / len, y: (t.y - s.y) / len }, fire, melee });
}

/** Two players in the open, `gap` apart along x (the middle lane south of the containers). */
function faceOff(m: GunRunMatch, gap = 5, a = 'a', b = 'b') {
  m.place(a, -gap / 2, 0.2);
  m.place(b, gap / 2, 0.2);
}

test('rules from a client are clamped; unknown keys are dropped', () => {
  assert.deepEqual(sanitizeRules({ respawnTime: 0, killsPerTier: 99, autoStart: false, nope: 1 }), {
    respawnTime: 0.1,
    killsPerTier: 20,
    autoStart: false,
  });
  assert.deepEqual(sanitizeRules('garbage'), {});
});

test('a quick-play room waits for two players, then "get ready" (no shooting), then the match', () => {
  const m = new GunRunMatch({ rules: { ...FAST, startingTime: 0.5 } });
  m.addPlayer('a', 'A');
  run(m, 0.5);
  assert.equal(m.phase, 'waiting', 'one player warms up');
  assert.equal(m.players.get('a')!.alive, true);
  m.addPlayer('b', 'B');
  m.step(DT);
  assert.equal(m.phase, 'starting');
  assert.equal(m.match, 1);
  const [a, b] = [m.players.get('a')!, m.players.get('b')!];
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 8, 'spread-out spawns');
  // No shots while getting ready.
  aimAt(m, 'a', 'b');
  const ev = run(m, 0.3);
  assert.equal(ev.filter((e) => e.type === 'shot').length, 0);
  run(m, 0.3);
  assert.equal(m.phase, 'playing');
  assert.equal(a.tier, 0);
  assert.equal(tierWeapon(a.tier).id, 'pistol');
});

test('private rooms wait for `start`; after their first match they keep cycling', () => {
  const m = new GunRunMatch({ rules: { ...FAST, autoStart: false } });
  m.addPlayer('a', 'A');
  m.addPlayer('b', 'B');
  run(m, 0.5);
  assert.equal(m.phase, 'waiting');
  m.requestStart();
  run(m, 0.3);
  assert.equal(m.phase, 'playing');
  m.forceEnd([]);
  assert.equal(m.phase, 'over');
  run(m, 0.7);
  assert.equal(m.match, 2, 'the next match started without another `start`');
});

test('the pistol: three hits kill, the kill is credited, the victim respawns protected at a far spawn', () => {
  const { m } = playing();
  faceOff(m);
  aimAt(m, 'a', 'b');
  const ev = run(m, 0.75);
  const b = m.players.get('b')!;
  const hits = ev.filter((e) => e.type === 'hit' && e.id === 'b');
  assert.equal(hits.length, 3, `${hits.length} hits`);
  const kill = ev.find((e) => e.type === 'kill');
  assert.deepEqual(kill && { id: kill.id, by: kill.by, cause: kill.cause }, { id: 'b', by: 'a', cause: 'pistol' });
  assert.equal(m.players.get('a')!.kills, 1);
  assert.equal(m.players.get('a')!.tierKills, 1);
  assert.equal(b.deaths, 1);
  // Dead for respawnTime, then back at full health, protected, far from A.
  m.setInput('a', idle);
  const back = run(m, 0.6);
  assert.ok(back.some((e) => e.type === 'spawn' && e.id === 'b'));
  assert.equal(b.alive, true);
  assert.equal(b.hp, PLAYER_HP);
  assert.ok(b.protectedFor > 0, 'spawn protection');
  const a = m.players.get('a')!;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 10, 'respawned away from the shooter');
  // Protected: shots do nothing.
  aimAt(m, 'a', 'b');
  const during = run(m, 0.2);
  assert.equal(during.filter((e) => e.type === 'hit').length, 0, 'no damage while protected');
});

test('three kills promote to the next gun; the ladder ends on the knife', () => {
  const { m } = playing();
  const a = m.players.get('a')!;
  const tiers: number[] = [];
  for (let k = 0; k < 3; k++) {
    faceOff(m, 3);
    const b = m.players.get('b')!;
    b.protectedFor = 0;
    b.hp = 1;
    aimAt(m, 'a', 'b');
    const ev = run(m, 0.4);
    assert.ok(
      ev.some((e) => e.type === 'kill' && e.id === 'b'),
      `kill ${k + 1}`,
    );
    for (const e of ev) if (e.type === 'tier') tiers.push(e.tier);
    m.setInput('a', idle);
    run(m, 0.6);
  }
  assert.deepEqual(tiers, [1], 'promoted once, after the third kill');
  assert.equal(a.tier, 1);
  assert.equal(a.tierKills, 0);
  assert.equal(m.weaponOf(a).id, LADDER[1]);
  assert.equal(LADDER[FINAL_TIER], 'knife');
  assert.equal(m.speedOf({ tier: FINAL_TIER }), KNIFE_SPEED);
});

test('a knife kill demotes the victim one rung; a knife kill on the last rung wins the match', () => {
  const { m } = playing(3);
  const [a, b] = [m.players.get('a')!, m.players.get('b')!];
  b.tier = 4;
  b.tierKills = 2;
  // Two stabs (55 each) at arm's length.
  m.place('a', 0, 0.2, 0);
  m.place('b', 1.1, 0.2);
  aimAt(m, 'a', 'b', false, true);
  const ev = run(m, 1.0);
  assert.equal(ev.filter((e) => e.type === 'stab' && e.hit).length, 2);
  const kill = ev.find((e) => e.type === 'kill')!;
  assert.ok(kill.type === 'kill' && kill.demote && kill.cause === 'knife');
  assert.equal(b.tier, 3, 'down a rung');
  assert.equal(b.tierKills, 0);
  assert.equal(a.knifeKills, 1);
  assert.equal(a.tierKills, 1, 'and it counts as a kill');
  // A on the knife rung kills C with the trigger: the match is won.
  m.setInput('a', idle);
  run(m, 0.6);
  a.tier = FINAL_TIER;
  assert.equal(m.weaponOf(a).id, 'knife');
  const c = m.players.get('c')!;
  c.protectedFor = 0;
  c.hp = 30;
  m.place('a', 0, 0.2, 0);
  m.place('c', 1.0, 0.2);
  aimAt(m, 'a', 'c', true, false);
  const end = run(m, 0.3);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'a');
  const over = end.find((e) => e.type === 'matchOver') as Extract<MatchEvent, { type: 'matchOver' }>;
  assert.equal(over.summary.winner, 'a');
  assert.equal(over.summary.reason, 'knife');
  assert.equal(over.summary.standings[0]!.id, 'a');
  assert.equal(over.summary.standings[0]!.placement, 1);
  assert.ok(over.summary.standings.slice(1).every((s) => s.placement >= 2));
  // The next match after the banner, everyone back on the first rung.
  run(m, 0.7);
  assert.equal(m.match, 2);
  assert.ok([...m.players.values()].every((p) => p.tier === 0 && p.kills === 0));
});

test('on the last rung only the knife counts: a gun kill (a barrel) does not win', () => {
  const { m } = playing();
  const a = m.players.get('a')!;
  a.tier = FINAL_TIER;
  m.giveKills('a', 3, []);
  assert.equal(a.tier, FINAL_TIER);
  assert.equal(m.winner, null);
});

test('lag compensation: a shot hits the target where the shooter saw it, not where it is now', () => {
  const { m } = playing();
  const [a, b] = [m.players.get('a')!, m.players.get('b')!];
  m.place('a', -6, 0.2, 0);
  m.place('b', 3.2, -1.8);
  // B walks down past A's line of fire; A aims at where B was 6 ticks ago (what A's screen shows).
  const trail: { x: number; y: number }[] = [];
  m.setInput('b', { move: { x: 0, y: 1 }, aim: null, fire: false, melee: false });
  for (let i = 0; i < 20; i++) {
    m.step(DT);
    trail.push({ x: b.x, y: b.y });
  }
  const seen = trail[trail.length - 7]!;
  const aim = { x: seen.x - a.x, y: seen.y - a.y };
  const len = Math.hypot(aim.x, aim.y);
  const shoot = (viewDelay: number) => {
    const copy = { x: b.x, y: b.y };
    m.setViewTick('a', m.tick - viewDelay);
    m.setInput('a', { move: { x: 0, y: 0 }, aim: { x: aim.x / len, y: aim.y / len }, fire: true, melee: false });
    m.setInput('b', { move: { x: 0, y: 1 }, aim: null, fire: false, melee: false });
    const ev = m.step(DT);
    m.setInput('a', idle);
    return { ev, copy };
  };
  assert.ok(Math.abs(b.y - seen.y) > 0.9, 'B has moved on more than a body width');
  const { ev } = shoot(6);
  assert.ok(
    ev.some((e) => e.type === 'hit' && e.id === 'b'),
    'hit where A saw B',
  );
  // Without the rewind the same shot misses.
  const { m: m2 } = playing();
  m2.place('a', -6, 0.2, 0);
  m2.place('b', 3.2, -1.8);
  m2.setInput('b', { move: { x: 0, y: 1 }, aim: null, fire: false, melee: false });
  for (let i = 0; i < 20; i++) m2.step(DT);
  m2.setViewTick('a', m2.tick);
  m2.setInput('a', { move: { x: 0, y: 0 }, aim: { x: aim.x / len, y: aim.y / len }, fire: true, melee: false });
  const miss = m2.step(DT);
  assert.ok(!miss.some((e) => e.type === 'hit'), 'no rewind, no hit');
  // The rewind is capped (350 ms ≈ 10.5 ticks).
  m.setViewTick('a', m.tick - 100);
  assert.ok(a.viewDelay <= 10.5 + 1e-9);
});

test('weapons: the shotgun fans 7 pellets, the sniper kills in one, walls stop bullets', () => {
  const { m } = playing();
  const [a, b] = [m.players.get('a')!, m.players.get('b')!];
  a.tier = LADDER.indexOf('shotgun');
  faceOff(m, 2.5);
  aimAt(m, 'a', 'b');
  const ev = m.step(DT);
  const shot = ev.find((e) => e.type === 'shot') as Extract<MatchEvent, { type: 'shot' }>;
  assert.equal(shot.rays.length / 4, WEAPONS.shotgun.pellets);
  assert.ok(b.hp < PLAYER_HP - 50, `point blank shotgun (${b.hp} HP left)`);
  m.setInput('a', idle);
  run(m, 1);
  b.hp = PLAYER_HP;
  a.tier = LADDER.indexOf('sniper');
  a.fireCd = 0;
  faceOff(m, 14);
  aimAt(m, 'a', 'b');
  const snipe = run(m, 0.1);
  assert.ok(
    snipe.some((e) => e.type === 'kill' && e.cause === 'sniper'),
    'one shot',
  );
  // Behind the red container (x -7.4…-2.2, y -4.85…-2.35): safe from a pistol on the other side.
  m.setInput('a', idle);
  run(m, 0.7);
  a.tier = 0;
  const bb = m.players.get('b')!;
  bb.protectedFor = 0;
  m.place('a', -4.8, -6.2);
  m.place('b', -4.8, -1.2);
  aimAt(m, 'a', 'b');
  const wall = run(m, 1);
  assert.equal(wall.filter((e) => e.type === 'hit').length, 0, 'the container stops every shot');
});

test('rockets burst on contact with splash; your own blast hurts you less; two in one blast counts', () => {
  const { m } = playing(3);
  const [a, b, c] = [m.players.get('a')!, m.players.get('b')!, m.players.get('c')!];
  a.tier = LADDER.indexOf('rocket');
  m.place('a', -6, 0.2, 0);
  m.place('b', 1, 0.2);
  m.place('c', 1.2, 1.3);
  b.hp = 80;
  c.hp = 60;
  aimAt(m, 'a', 'b');
  const ev = run(m, 0.7);
  assert.ok(ev.some((e) => e.type === 'launch'));
  assert.ok(ev.some((e) => e.type === 'boom'));
  assert.equal(b.alive, false);
  assert.equal(c.alive, false, 'splash');
  assert.equal(a.bestBlast, 2);
  // Point blank against a wall: the shooter takes half.
  m.setInput('a', idle);
  run(m, 0.7);
  a.fireCd = 0;
  a.hp = PLAYER_HP;
  m.place('a', -4.8, -1.6, -Math.PI / 2);
  m.setInput('a', { move: { x: 0, y: 0 }, aim: { x: 0, y: -1 }, fire: true, melee: false });
  const self = run(m, 0.2);
  const hurt = self.find((e) => e.type === 'hit' && e.id === 'a') as Extract<MatchEvent, { type: 'hit' }> | undefined;
  assert.ok(hurt && hurt.damage <= WEAPONS.rocket.damage * 0.5 + 1, `self damage ${hurt?.damage}`);
});

test('grenades are lobbed over players and burst where they land', () => {
  const { m } = playing();
  const [a, b] = [m.players.get('a')!, m.players.get('b')!];
  a.tier = LADDER.indexOf('grenade');
  m.place('a', -8, 0.2, 0);
  m.place('b', -8 + WEAPONS.grenade.range, 0.2);
  const landing = b.x;
  aimAt(m, 'a', 'b');
  const ev = run(m, 0.3);
  m.setInput('a', idle);
  const flight = ev.concat(run(m, 1.2));
  const boom = flight.find((e) => e.type === 'boom') as Extract<MatchEvent, { type: 'boom' }>;
  assert.ok(boom, 'it burst');
  assert.ok(Math.abs(boom.x - landing) < 0.8, `at the end of the throw (${boom.x})`);
  assert.ok(flight.some((e) => e.type === 'kill' && e.id === 'b' && e.cause === 'grenade'));
});

test('barrels: a shot sets one off, the blast is credited to the shooter and chains; it stands again later', () => {
  const { m } = playing();
  const [a, b] = [m.players.get('a')!, m.players.get('b')!];
  const barrel = BARRELS[0]!;
  m.place('a', barrel.x + 5, barrel.y, Math.PI);
  m.place('b', barrel.x - 1.2, barrel.y + 0.3);
  b.hp = 50;
  m.setInput('a', { move: { x: 0, y: 0 }, aim: { x: -1, y: 0 }, fire: true, melee: false });
  const ev = run(m, 0.5);
  assert.ok(!(m.barrels & 1), 'the barrel went off');
  assert.ok(ev.some((e) => e.type === 'boom'));
  const kill = ev.find((e) => e.type === 'kill') as Extract<MatchEvent, { type: 'kill' }>;
  assert.deepEqual({ id: kill.id, by: kill.by, cause: kill.cause }, { id: 'b', by: 'a', cause: 'barrel' });
  assert.equal(a.barrelKills, 1);
  assert.ok(Math.abs(m.barrelRespawn(0) - (BARREL_RESPAWN - 0.5)) < 0.5);
  m.setInput('a', idle);
  run(m, BARREL_RESPAWN);
  assert.ok(m.barrels & 1, 'standing again');
});

test('med kits heal the hurt (not the healthy) and come back', () => {
  const { m } = playing();
  const a = m.players.get('a')!;
  const med = MEDS[0]!;
  m.place('a', med.x, med.y);
  a.hp = PLAYER_HP;
  run(m, 0.1);
  assert.ok(m.meds & 1, 'full health: left on the ground');
  a.hp = 30;
  const ev = run(m, 0.1);
  assert.ok(ev.some((e) => e.type === 'heal' && e.id === 'a'));
  assert.equal(a.hp, 30 + MED_HEAL);
  assert.ok(!(m.meds & 1));
  a.hp = PLAYER_HP;
  run(m, 16);
  assert.ok(m.meds & 1, 'back');
});

test('joining a match under way: on the lowest rung anyone is on, spawning a moment later', () => {
  const { m } = playing();
  m.players.get('a')!.tier = 3;
  m.players.get('b')!.tier = 2;
  const c = m.addPlayer('c', 'C');
  assert.equal(c.tier, 2);
  assert.equal(c.alive, false);
  run(m, 1.1);
  assert.equal(c.alive, true);
});

test('the time limit decides by the ladder; too few players go back to waiting', () => {
  const { m } = playing(3, { timeLimit: 5 });
  m.players.get('b')!.tier = 2;
  const ev = run(m, 5.1);
  const over = ev.find((e) => e.type === 'matchOver') as Extract<MatchEvent, { type: 'matchOver' }>;
  assert.equal(over.summary.reason, 'time');
  assert.equal(over.summary.winner, 'b');
  const { m: m2 } = playing(2);
  m2.removePlayer('b');
  m2.step(DT);
  assert.equal(m2.phase, 'waiting');
});

test('a suicide costs the progress on the rung but never a rung', () => {
  const { m } = playing();
  const a = m.players.get('a')!;
  a.tier = LADDER.indexOf('rocket');
  a.tierKills = 2;
  a.hp = 20;
  m.place('a', -4.8, -1.6, -Math.PI / 2);
  m.setInput('a', { move: { x: 0, y: 0 }, aim: { x: 0, y: -1 }, fire: true, melee: false });
  run(m, 0.3);
  assert.equal(a.alive, false);
  assert.equal(a.tierKills, 0);
  assert.equal(a.tier, LADDER.indexOf('rocket'));
});

test('the same seed and inputs replay the same match', () => {
  const play = () => {
    const { m } = playing(4, {}, 99);
    const bots = new BotDriver(m, 5);
    for (const p of m.players.values()) p.bot = true;
    const log: string[] = [];
    for (let i = 0; i < 30 * 20; i++) {
      bots.think(DT);
      for (const e of m.step(DT)) if (e.type === 'kill' || e.type === 'tier') log.push(JSON.stringify(e));
    }
    return { log, at: [...m.players.values()].map((p) => [p.x.toFixed(6), p.y.toFixed(6), p.tier, p.kills]) };
  };
  const a = play();
  const b = play();
  assert.deepEqual(a, b);
  assert.ok(a.log.length > 0, 'the bots fought');
});

test('bots fight: over a couple of minutes of bot-only play there are kills, promotions and no one stuck', () => {
  const { m } = playing(4, {}, 3);
  const bots = new BotDriver(m, 11);
  for (const p of m.players.values()) p.bot = true;
  let kills = 0;
  const start = new Map([...m.players.values()].map((p) => [p.id, { x: p.x, y: p.y }]));
  const moved = new Set<string>();
  let summary: MatchSummary | null = null;
  for (let i = 0; i < 30 * 150 && !summary; i++) {
    bots.think(DT);
    for (const e of m.step(DT)) {
      if (e.type === 'kill') kills++;
      if (e.type === 'matchOver') summary = e.summary;
    }
    for (const p of m.players.values()) {
      const s = start.get(p.id)!;
      if (Math.hypot(p.x - s.x, p.y - s.y) > 4) moved.add(p.id);
    }
  }
  assert.ok(kills >= 8, `${kills} kills`);
  assert.equal(moved.size, 4, 'every bot got around');
  assert.ok(Math.max(...[...m.players.values()].map((p) => p.tier)) >= 2 || summary, 'promotions');
});
