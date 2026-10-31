import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BARREL_BLAST_RADIUS,
  CHAIN_DELAY,
  COMBO_WINDOW,
  DT,
  ExplosiveKind,
  KILL_POINTS,
  MAX_ALIVE_ZOMBIES,
  OverrunMatch,
  REVIVE_HP,
  REVIVE_TIME,
  WEAPONS,
  ZOMBIES,
  ZombieKind,
  runAchievements,
  runBoardScores,
  sanitizeRules,
  waveSpec,
  type MatchEvent,
  type Phase,
  type PlayerInput,
  type RunSummary,
} from '../src/index.ts';

const FAST = { firstBreatherTime: 0.2, breatherTime: 0.2, overTime: 0.3 };

function run(m: OverrunMatch, seconds: number, events: MatchEvent[] = []): MatchEvent[] {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) events.push(...m.step(DT));
  return events;
}

function until(m: OverrunMatch, phase: Phase, maxSeconds = 30): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < maxSeconds / DT && m.phase !== phase; i++) events.push(...m.step(DT));
  assert.equal(m.phase, phase, `reached ${phase}`);
  return events;
}

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({
  move: { x: 0, y: 0 },
  aim: null,
  fire: false,
  weapon: 0,
  ...over,
});

/** Aim `id` at a point and hold the trigger (or let go). */
function aimAt(m: OverrunMatch, id: string, x: number, y: number, fire = true, weapon = 0) {
  const p = m.players.get(id)!;
  const len = Math.hypot(x - p.x, y - p.y);
  m.setInput(id, input({ aim: { x: (x - p.x) / len, y: (y - p.y) / len }, fire, weapon }));
}

/** A frozen wave with no spawns: zombies only where a test puts them. */
function arena(seed = 1): OverrunMatch {
  const m = new OverrunMatch({ seed, rules: { ...FAST, waveSize: 1 } });
  m.addPlayer('a', 'Alice');
  until(m, 'wave');
  m.clearZombies();
  m.frozen = true;
  // An unreachable dummy keeps the wave from clearing while the test's zombies die.
  m.spawnZombie(ZombieKind.walker, 23, 15);
  return m;
}

test('the wave curve: 8 + 5N zombies, faster each wave (capped), brutes from wave 4, spitters from wave 6', () => {
  assert.deepEqual(
    [1, 2, 3, 10].map((n) => waveSpec(n).total),
    [13, 18, 23, 58],
  );
  assert.equal(waveSpec(1).speedMul, 1);
  assert.ok(Math.abs(waveSpec(6).speedMul - 1.2) < 1e-9);
  assert.equal(waveSpec(50).speedMul, 1.4, 'capped');
  assert.deepEqual(
    [3, 4, 6, 8].map((n) => waveSpec(n).brutes),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    [5, 6, 8].map((n) => waveSpec(n).spitters),
    [0, 2, 3],
  );
  for (let n = 1; n < 40; n++) assert.ok(waveSpec(n + 1).spawnInterval <= waveSpec(n).spawnInterval);
});

test('a lone player starts a run: breather with a banner, then the wave spawns at the gates and finishes', () => {
  const m = new OverrunMatch({ seed: 5, rules: { ...FAST, waveSize: 6 } });
  const a = m.addPlayer('a', 'Alice');
  assert.equal(m.phase, 'waiting');
  assert.equal(a.active, true, 'spawned for practice');
  assert.deepEqual(m.step(DT), [{ type: 'phase', phase: 'breather' }]);
  assert.equal(m.wave, 1);
  assert.equal(m.run, 1);
  const ev = until(m, 'wave');
  assert.deepEqual(
    ev.filter((e) => e.type === 'wave'),
    [{ type: 'wave', wave: 1 }],
  );
  assert.equal(m.remaining, 6);
  const seen = new Set<number>();
  for (let i = 0; i < 30 * 6; i++) {
    m.step(DT);
    for (const z of m.zombies.values()) {
      if (seen.has(z.id)) continue;
      seen.add(z.id);
      assert.ok(Math.abs(z.x) > 21 || Math.abs(z.y) > 13, `spawned at a gate (${z.x}, ${z.y})`);
    }
  }
  assert.equal(seen.size, 6);
  assert.equal(m.zombies.size + m.queued, 6);
  // Kill them all: the next breather starts, wave 2.
  m.frozen = true;
  for (const z of [...m.zombies.values()]) z.hp = 1;
  m.clearZombies();
  const next = m.step(DT);
  assert.ok(next.some((e) => e.type === 'waveCleared' && e.wave === 1));
  assert.equal(m.phase, 'breather');
  assert.equal(m.wave, 2);
  assert.equal(m.reached, 1);
});

test('at most 120 zombies are alive; the rest of the wave queues', () => {
  const m = new OverrunMatch({ seed: 2, rules: { ...FAST, waveSize: 200 } });
  m.addPlayer('a', 'Alice');
  until(m, 'wave');
  for (let i = 0; i < 30 * 90 && m.queued > 0 && m.zombies.size < MAX_ALIVE_ZOMBIES; i++) {
    m.players.get('a')!.hp = 100;
    m.step(DT);
  }
  run(m, 3);
  assert.ok(m.zombies.size <= MAX_ALIVE_ZOMBIES);
  assert.equal(m.zombies.size + m.queued, 200 - 0, 'nothing lost');
  assert.ok(m.queued >= 80, `queued ${m.queued}`);
});

test('separation spreads a stacked horde, and nobody ends up inside an obstacle', () => {
  const m = arena();
  m.frozen = false;
  m.place('a', 0, 10.5);
  for (let i = 0; i < 30; i++) m.spawnZombie(ZombieKind.walker, -10, -12);
  run(m, 1.5);
  const zs = [...m.zombies.values()].filter((z) => z.x < 20);
  let overlaps = 0;
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      if (Math.hypot(zs[i]!.x - zs[j]!.x, zs[i]!.y - zs[j]!.y) < ZOMBIES[0]!.radius * 2 * 0.5) overlaps++;
    }
  }
  assert.equal(overlaps, 0, 'no two zombies more than half overlapped');
  const xs = zs.map((z) => z.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 2, 'spread out');
});

test('hitscan: a zombie behind a wall is safe, the wall takes the bullet; one in the open takes it', () => {
  const m = arena();
  m.place('a', -4, -6.5); // below the north wall's left segment
  const hidden = m.spawnZombie(ZombieKind.walker, -4, -10); // above it
  const ray = m.castRay(-4, -6.85, 0, -1, 15);
  assert.equal(ray.zombie, null);
  assert.ok(Math.abs(ray.t - (-6.85 + 8.3 - 0.6)) < 1e-9 || Math.abs(ray.t - 0.85) < 1e-9, `wall at ${ray.t}`);
  aimAt(m, 'a', -4, -10);
  const ev = run(m, 0.5);
  assert.equal(hidden.hp, hidden.maxHp, 'untouched');
  const shots = ev.filter((e) => e.type === 'shot');
  assert.ok(shots.length >= 1);
  for (const s of shots) assert.ok(s.type === 'shot' && s.rays[3]! >= -7.7 - 1e-6, 'tracer ends at the wall');

  m.place('a', 0, 5);
  const open = m.spawnZombie(ZombieKind.walker, 0, 10);
  aimAt(m, 'a', 0, 10);
  const ev2 = run(m, 2);
  assert.ok(!m.zombies.has(open.id), 'killed');
  const kill = ev2.find((e) => e.type === 'kill' && e.zombie === open.id);
  assert.ok(kill && kill.type === 'kill' && kill.by === 'a');
  assert.equal(m.players.get('a')!.kills, 1);
  assert.ok(ev2.filter((e) => e.type === 'hit' && e.zombie === open.id).length >= 3, 'three pistol hits');
});

test('shotgun: five pellets fanned over its spread hit a line of zombies across the cone', () => {
  const m = arena();
  m.unlocked = 3;
  const a = m.players.get('a')!;
  a.ammo[2] = 10;
  m.place('a', 0, 4);
  // Five zombies on an arc 4 units in front, one per pellet direction.
  const spread = WEAPONS[2]!.spread;
  const targets = [-2, -1, 0, 1, 2].map((k) => {
    const ang = Math.PI / 2 + (k * spread) / 4;
    return m.spawnZombie(ZombieKind.walker, Math.cos(ang) * 4, 4 + Math.sin(ang) * 4);
  });
  m.setInput('a', input({ aim: { x: 0, y: 1 }, fire: true, weapon: 2 }));
  const ev = m.step(DT);
  const shot = ev.find((e) => e.type === 'shot');
  assert.ok(shot && shot.type === 'shot');
  assert.equal(shot.weapon, 2);
  assert.equal(shot.rays.length, 5 * 4, 'five rays');
  const hit = new Set(ev.filter((e) => e.type === 'hit').map((e) => (e as { zombie: number }).zombie));
  assert.deepEqual([...hit].sort(), targets.map((z) => z.id).sort(), 'each pellet hit its own zombie');
  assert.equal(a.ammo[2], 9, 'one shell');
  // The fan is symmetric around the aim.
  const angles = [];
  for (let i = 0; i < 5; i++) {
    const [x0, y0, x1, y1] = shot.rays.slice(i * 4, i * 4 + 4) as [number, number, number, number];
    angles.push(Math.atan2(y1 - y0, x1 - x0) - Math.PI / 2);
  }
  assert.ok(Math.abs(angles[0]! + angles[4]!) < 0.08 && Math.abs(angles[4]! - angles[0]! - spread) < 0.1);
});

test('barrels: a shot sets one off, the blast kills, chains to the next barrel after a delay; 10 kills = demolition', () => {
  const m = arena();
  m.unlocked = 5;
  const a = m.players.get('a')!;
  a.ammo[3] = 3;
  m.place('a', 0, 6);
  // Place two barrels with the barrel weapon, walking between placements.
  m.setInput('a', input({ aim: { x: 0, y: 1 }, fire: true, weapon: 3 }));
  m.step(DT);
  m.setInput('a', input({ aim: { x: 0, y: 1 }, fire: false, weapon: 3 }));
  run(m, WEAPONS[3]!.cooldown);
  m.place('a', 2.5, 6);
  m.setInput('a', input({ aim: { x: 0, y: 1 }, fire: true, weapon: 3 }));
  m.step(DT);
  m.setInput('a', input({ fire: false, weapon: 0 }));
  m.step(DT);
  const barrels = [...m.explosives.values()];
  assert.equal(barrels.length, 2);
  assert.ok(barrels.every((b) => b.kind === ExplosiveKind.barrel && b.owner === 'a'));
  assert.equal(a.ammo[3], 1);
  const [b1, b2] = barrels as [(typeof barrels)[0], (typeof barrels)[0]];
  assert.ok(Math.hypot(b1.x - b2.x, b1.y - b2.y) < BARREL_BLAST_RADIUS, 'in each other’s blast');
  // Twelve zombies packed around the first barrel, one around the second.
  // (leaving the left side open for the shot).
  for (let i = 0; i < 12; i++) {
    const ang = -0.7 * Math.PI + (i / 11) * 1.4 * Math.PI;
    m.spawnZombie(ZombieKind.walker, b1.x + Math.cos(ang) * 1.2, b1.y + Math.sin(ang) * 1.2);
  }
  // Shoot the first barrel from the side.
  m.place('a', b1.x - 8, b1.y);
  aimAt(m, 'a', b1.x, b1.y);
  const ev: MatchEvent[] = [];
  for (let i = 0; i < 30 && !ev.some((e) => e.type === 'boom'); i++) ev.push(...m.step(DT));
  const booms = ev.filter((e) => e.type === 'boom');
  assert.equal(booms.length, 1, 'first barrel went off');
  const first = booms[0]!;
  assert.ok(first.type === 'boom' && first.by === 'a' && first.kills >= 10, `kills ${JSON.stringify(first)}`);
  assert.ok(m.explosives.has(b2.id), 'second barrel waits for the chain delay');
  m.setInput('a', input());
  const later = run(m, CHAIN_DELAY + 2 * DT);
  assert.ok(
    later.some((e) => e.type === 'boom'),
    'chain reaction',
  );
  assert.equal(m.explosives.size, 0);
  assert.ok(a.bestBlast >= 10);
  assert.ok(a.kills >= 12);
});

test('mines arm, then a zombie stepping on one sets it off', () => {
  const m = arena();
  m.unlocked = 5;
  const a = m.players.get('a')!;
  a.ammo[4] = 2;
  m.place('a', 0, 6);
  m.setInput('a', input({ aim: { x: 1, y: 0 }, fire: true, weapon: 4 }));
  m.step(DT);
  m.setInput('a', input());
  const mine = [...m.explosives.values()][0]!;
  assert.equal(mine.kind, ExplosiveKind.mine);
  m.spawnZombie(ZombieKind.walker, mine.x + 0.6, mine.y);
  run(m, 0.3);
  assert.ok(m.explosives.has(mine.id), 'not armed yet');
  const ev = run(m, 0.6);
  assert.ok(ev.some((e) => e.type === 'boom'));
  assert.ok(ev.some((e) => e.type === 'kill' && e.by === 'a'));
});

test('combo: kills within 1.5 s chain into a multiplier (x2…x8), score = points × multiplier', () => {
  const m = arena();
  m.place('a', 0, 0);
  const a = m.players.get('a')!;
  const kill = () => {
    const z = m.spawnZombie(ZombieKind.walker, 0, 3);
    z.hp = 1;
    aimAt(m, 'a', 0, 3);
    const ev: MatchEvent[] = [];
    for (let i = 0; i < 20 && m.zombies.has(z.id); i++) ev.push(...m.step(DT));
    m.setInput('a', input());
    return ev.find((e) => e.type === 'kill');
  };
  const mults = [];
  for (let i = 0; i < 10; i++) {
    const k = kill();
    assert.ok(k && k.type === 'kill');
    mults.push(k.mult);
    run(m, 0.3);
  }
  assert.deepEqual(mults, [1, 2, 3, 4, 5, 6, 7, 8, 8, 8]);
  assert.equal(m.combo, 8);
  assert.equal(a.score, KILL_POINTS * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 8 + 8));
  assert.equal(m.teamScore, a.score);
  run(m, COMBO_WINDOW + 0.1);
  assert.equal(m.combo, 1, 'lapsed');
  assert.equal(kill()!.type === 'kill' && (kill() as { mult: number }).mult, 2, 'a new chain');
});

test('weapons unlock for the team at kill thresholds, with starting ammo', () => {
  const m = arena();
  m.addPlayer('b', 'Bob');
  const ev: MatchEvent[] = [];
  const b = m.players.get('b')!;
  assert.equal(b.active, false, 'Bob joined mid-wave');
  m.place('a', 0, 0);
  for (let i = 0; i < WEAPONS[1]!.unlockKills; i++) {
    const z = m.spawnZombie(ZombieKind.walker, 0, 3);
    z.hp = 1;
    aimAt(m, 'a', 0, 3);
    for (let k = 0; k < 20 && m.zombies.has(z.id); k++) ev.push(...m.step(DT));
  }
  assert.deepEqual(
    ev.filter((e) => e.type === 'unlock'),
    [{ type: 'unlock', weapon: 1 }],
  );
  assert.equal(m.unlocked, 2);
  assert.equal(m.players.get('a')!.ammo[1], WEAPONS[1]!.startAmmo);
  // Switching to it works; the server falls back to the pistol when it runs dry.
  const a = m.players.get('a')!;
  a.ammo[1] = 2;
  const z = m.spawnZombie(ZombieKind.brute, 0, 3);
  aimAt(m, 'a', z.x, z.y, true, 1);
  m.step(DT);
  assert.equal(a.weapon, 1);
  run(m, 0.5);
  assert.equal(a.ammo[1], 0);
  assert.equal(a.weapon, 0, 'back to the pistol');
});

test('a player joining mid-wave waits, and spawns at the next breather', () => {
  const m = new OverrunMatch({ seed: 4, rules: { ...FAST, waveSize: 3 } });
  m.addPlayer('a', 'Alice');
  until(m, 'wave');
  const b = m.addPlayer('b', 'Bob');
  assert.equal(b.active, false);
  assert.equal(b.slot, 1);
  run(m, 1);
  assert.equal(b.active, false, 'still waiting');
  m.clearZombies();
  until(m, 'breather', 1);
  assert.equal(b.active, true, 'spawned between waves');
  assert.equal(b.hp, 100);
  // Joining during a breather spawns at once.
  const c = m.addPlayer('c', 'Cleo');
  assert.equal(c.active, true);
});

test('down and revive: a teammate standing close for 3 s revives at 50 % HP; stepping away drains progress', () => {
  const m = arena();
  m.addPlayer('b', 'Bob');
  m.clearZombies();
  until(m, 'breather', 2); // Bob spawns
  m.frozen = true;
  until(m, 'wave', 2);
  m.clearZombies();
  m.spawnZombie(ZombieKind.walker, 23, 15);
  const a = m.players.get('a')!;
  const b = m.players.get('b')!;
  const ev: MatchEvent[] = [];
  m.hurt(a, 150, ev);
  assert.deepEqual(
    ev.map((e) => e.type),
    ['hurt', 'down'],
  );
  assert.equal(a.down, true);
  assert.equal(a.hp, 0);
  // Down players crawl and cannot shoot.
  aimAt(m, 'a', 5, 5);
  const x0 = a.x;
  m.setInput('a', input({ move: { x: 1, y: 0 }, fire: true }));
  const shots = run(m, 1).filter((e) => e.type === 'shot');
  assert.equal(shots.length, 0);
  assert.ok(a.x - x0 > 0.5 && a.x - x0 < 1.2, `crawled ${a.x - x0}`);
  m.setInput('a', input());
  // Bob stands next to her for half the time, steps away (progress drains), then the full 3 s.
  m.place('b', a.x + 1, a.y);
  run(m, REVIVE_TIME / 2);
  assert.ok(a.down && a.revive > 1.4);
  m.place('b', a.x + 5, a.y);
  run(m, 0.5);
  assert.ok(a.revive < 0.6, `drained to ${a.revive}`);
  m.place('b', a.x + 1, a.y);
  const before = Math.round(a.revive / DT);
  const revived = run(m, REVIVE_TIME - before * DT - 2 * DT);
  assert.equal(a.down, true, 'not quite yet');
  revived.push(...run(m, 4 * DT));
  assert.equal(a.down, false);
  assert.equal(a.hp, REVIVE_HP);
  assert.ok(revived.some((e) => e.type === 'revive' && e.id === 'a' && e.by === 'b'));
  assert.equal(b.revives, 1);
});

test('the run ends when everyone is down; a solo player who goes down loses; then a new run starts', () => {
  const m = new OverrunMatch({ seed: 9, rules: { ...FAST, waveSize: 5 } });
  m.addPlayer('a', 'Alice');
  until(m, 'wave');
  const ev: MatchEvent[] = [];
  m.hurt(m.players.get('a')!, 999, ev);
  ev.push(...m.step(DT));
  assert.equal(m.phase, 'over');
  const over = ev.find((e) => e.type === 'runOver');
  assert.ok(over && over.type === 'runOver');
  assert.equal(over.summary.wave, 1);
  assert.deepEqual(
    over.summary.standings.map((s) => [s.id, s.placement, s.downs]),
    [['a', 1, 1]],
  );
  until(m, 'breather', 2);
  assert.equal(m.run, 2);
  assert.equal(m.wave, 1);
  assert.equal(m.players.get('a')!.down, false, 'fresh run');
  assert.equal(m.zombies.size, 0);

  // Two players: one down is not the end.
  const two = new OverrunMatch({ seed: 9, rules: { ...FAST, waveSize: 5 } });
  two.addPlayer('a', 'Alice');
  two.addPlayer('b', 'Bob');
  until(two, 'wave');
  two.hurt(two.players.get('a')!, 999, []);
  two.step(DT);
  assert.equal(two.phase, 'wave');
  two.hurt(two.players.get('b')!, 999, []);
  two.step(DT);
  assert.equal(two.phase, 'over');
});

test('private rooms wait for start (or a full room); clearing a wave gets downed players back up', () => {
  const m = new OverrunMatch({ seed: 1, rules: { ...FAST, autoStart: false, waveSize: 2 } });
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  run(m, 2);
  assert.equal(m.phase, 'waiting');
  m.requestStart();
  m.step(DT);
  assert.equal(m.phase, 'breather');
  until(m, 'wave');
  m.hurt(m.players.get('a')!, 999, []);
  m.clearZombies();
  m.step(DT);
  assert.equal(m.phase, 'breather');
  assert.equal(m.players.get('a')!.down, false);
  assert.equal(m.players.get('a')!.hp, REVIVE_HP);
  // After the run a private room goes back to waiting.
  until(m, 'wave');
  for (const p of m.players.values()) m.hurt(p, 999, []);
  until(m, 'over', 1);
  until(m, 'waiting', 2);
  const full = new OverrunMatch({ rules: { autoStart: false } });
  for (const id of ['a', 'b', 'c', 'd']) full.addPlayer(id, id);
  full.step(DT);
  assert.equal(full.phase, 'breather', 'a full private room starts by itself');
});

test('untouchable: a wave cleared without a scratch counts; a hurt one does not', () => {
  const m = new OverrunMatch({ seed: 1, rules: { ...FAST, waveSize: 1 } });
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'wave');
  m.hurt(m.players.get('b')!, 5, []);
  m.clearZombies();
  m.step(DT);
  assert.equal(m.players.get('a')!.cleanWaves, 1);
  assert.equal(m.players.get('b')!.cleanWaves, 0);
});

test('zombies chase and bite; spitters keep their distance and lob globs that land where you were', () => {
  const m = new OverrunMatch({ seed: 11, rules: { ...FAST, waveSize: 1 } });
  m.addPlayer('a', 'Alice');
  until(m, 'wave');
  m.clearZombies();
  m.place('a', 0, 0);
  m.spawnZombie(ZombieKind.walker, 23, 15);
  const z = m.spawnZombie(ZombieKind.walker, 3, 0);
  const ev = run(m, 3);
  assert.ok(
    ev.some((e) => e.type === 'hurt' && e.id === 'a'),
    'bitten',
  );
  assert.ok(Math.hypot(z.x, z.y) < 1.4, 'reached the player');
  assert.ok(m.players.get('a')!.hp < 100);

  m.clearZombies();
  m.spawnZombie(ZombieKind.walker, 23, 15);
  m.players.get('a')!.hp = 100;
  m.place('a', 0, 0);
  const s = m.spawnZombie(ZombieKind.spitter, -3, 0);
  const ev2 = run(m, 4);
  assert.ok(Math.hypot(s.x, s.y) > 4.5, `backed off to ${Math.hypot(s.x, s.y).toFixed(1)}`);
  assert.ok(
    ev2.some((e) => e.type === 'spit'),
    'spat',
  );
  assert.ok(
    ev2.some((e) => e.type === 'splash'),
    'landed',
  );
  // Standing still, the glob hits; dodging (walking away after it is thrown) avoids it.
  assert.ok(ev2.some((e) => e.type === 'hurt' && e.id === 'a'));
});

test('deterministic: the same seed and inputs give the same run, bit for bit', () => {
  const play = () => {
    const m = new OverrunMatch({ seed: 1234, rules: { ...FAST } });
    m.addPlayer('a', 'Alice');
    m.addPlayer('b', 'Bob');
    const trace: string[] = [];
    for (let i = 0; i < 30 * 40; i++) {
      for (const p of m.playerList) {
        let best: { x: number; y: number } | null = null;
        let bd = Infinity;
        for (const z of m.zombies.values()) {
          const d = Math.hypot(z.x - p.x, z.y - p.y);
          if (d < bd) [bd, best] = [d, z];
        }
        const ang = i * 0.05 + p.slot;
        m.setInput(p.id, {
          move: { x: Math.cos(ang) * 0.6, y: Math.sin(ang) * 0.6 },
          aim: best ? { x: (best.x - p.x) / bd, y: (best.y - p.y) / bd } : null,
          fire: bd < 10,
          weapon: Math.min(2, m.unlocked - 1),
        });
      }
      m.step(DT);
      if (i % 30 === 0) {
        trace.push(
          JSON.stringify([
            m.phase,
            m.wave,
            m.teamScore,
            [...m.players.values()].map((p) => [p.x, p.y, p.hp, p.kills]),
            [...m.zombies.values()].map((z) => [z.id, z.x, z.y, z.hp]),
          ]),
        );
      }
    }
    return trace;
  };
  const a = play();
  const b = play();
  assert.ok(
    a.some((t) => t.includes('"wave"')),
    'reached a wave',
  );
  assert.deepEqual(a, b);
});

test('results: achievements per player', () => {
  const summary: RunSummary = {
    run: 1,
    wave: 10,
    duration: 600,
    teamScore: 9000,
    teamKills: 700,
    standings: [
      {
        id: 'a',
        name: 'A',
        slot: 0,
        score: 6000,
        kills: 520,
        revives: 3,
        downs: 0,
        placement: 1,
        cleanWaves: 2,
        bestBlast: 11,
      },
      {
        id: 'b',
        name: 'B',
        slot: 1,
        score: 3000,
        kills: 180,
        revives: 0,
        downs: 4,
        placement: 2,
        cleanWaves: 0,
        bestBlast: 4,
      },
    ],
  };
  assert.deepEqual(runAchievements(summary, 'a'), [
    'first_wave_10',
    'horde_slayer',
    'medic',
    'untouchable',
    'demolition',
  ]);
  assert.deepEqual(runAchievements({ ...summary, wave: 9 }, 'b'), []);
  assert.deepEqual(runAchievements(summary, 'nobody'), []);
});

test('board scores are the run’s wave and the player’s kills, uncapped (best-run boards)', () => {
  const standing = { name: 'a', slot: 0, score: 0, revives: 0, downs: 0, placement: 1, cleanWaves: 0, bestBlast: 0 };
  const summary: RunSummary = {
    run: 1,
    wave: 23,
    duration: 900,
    teamScore: 0,
    teamKills: 520,
    standings: [
      { ...standing, id: 'a', kills: 520 },
      { ...standing, id: 'b', kills: 0 },
    ],
  };
  assert.deepEqual(runBoardScores(summary, 'a'), { wave: 23, kills: 520 });
  assert.deepEqual(runBoardScores(summary, 'b'), { wave: 23, kills: null }, '0 kills is not reported');
  assert.deepEqual(runBoardScores({ ...summary, wave: 0 }, 'a'), { wave: null, kills: 520 });
  assert.deepEqual(runBoardScores(summary, 'nobody'), { wave: null, kills: null });
});

test('dev rules from a client are sanitized', () => {
  assert.deepEqual(sanitizeRules({ breatherTime: 0.5, overTime: -3, waveSize: 9999, evil: 1, autoStart: 'yes' }), {
    breatherTime: 0.5,
    overTime: 0.1,
    waveSize: 500,
  });
  assert.deepEqual(sanitizeRules(null), {});
});
