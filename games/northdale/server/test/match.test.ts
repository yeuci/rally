import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AMMO,
  Action,
  BARRICADES,
  BLEED_OUT,
  CARRY_SPEED,
  DOG_HP,
  DOG_SPOT,
  DT,
  ESCAPE_FROM_NIGHT,
  GOO_RADIUS,
  Item,
  LOOT_SPOTS,
  NorthdaleMatch,
  PART_SPOTS,
  PLAYER_HP,
  PLAYER_RADIUS,
  REVIVE_HP,
  REVIVE_TIME,
  ROCK_WINDUP,
  SAFE,
  SAFE_CENTER,
  SOCKETS,
  TRUCK,
  TRUCK_SCRAP,
  ZOMBIES,
  ZombieKind,
  STREET_POINTS,
  circleIsFree,
  hordeSize,
  runAchievements,
  runBoardScores,
  sanitizeRules,
  type MatchEvent,
  type Phase,
  type PlayerInput,
  type RunSummary,
} from '../src/index.ts';

/** Short phases and no spawns: zombies only where a test puts them. */
const FAST = {
  dayTime: 3,
  firstDayTime: 3,
  duskTime: 1,
  nightTime: 3,
  overTime: 0.5,
  holdoutTime: 2,
  escapeTime: 1,
  spawnScale: 0,
};

function run(m: NorthdaleMatch, seconds: number, events: MatchEvent[] = []): MatchEvent[] {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) events.push(...m.step(DT));
  return events;
}

function until(m: NorthdaleMatch, phase: Phase, maxSeconds = 60): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < maxSeconds / DT && m.phase !== phase; i++) events.push(...m.step(DT));
  assert.equal(m.phase, phase, `reached ${phase}`);
  return events;
}

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({
  move: { x: 0, y: 0 },
  aim: null,
  fire: false,
  melee: false,
  act: false,
  use: 0,
  slot: 0,
  ...over,
});

function aimAt(m: NorthdaleMatch, id: string, x: number, y: number, over: Partial<PlayerInput> = {}) {
  const p = m.players.get(id)!;
  const len = Math.hypot(x - p.x, y - p.y) || 1;
  m.setInput(id, input({ aim: { x: (x - p.x) / len, y: (y - p.y) / len }, ...over }));
}

/** A free spot `r` from (x, y) (the first of 32 directions), where `id` is put. */
function standNear(m: NorthdaleMatch, id: string, x: number, y: number, r: number): { x: number; y: number } {
  for (let a = 0; a < 32; a++) {
    const px = x + Math.cos((a / 32) * Math.PI * 2) * r;
    const py = y + Math.sin((a / 32) * Math.PI * 2) * r;
    if (circleIsFree(px, py, PLAYER_RADIUS + 0.05)) {
      m.place(id, px, py);
      return { x: px, y: py };
    }
  }
  throw new Error(`no free spot ${r} from ${x},${y}`);
}

function match(seed = 1, rules: Partial<typeof FAST> = {}): NorthdaleMatch {
  const m = new NorthdaleMatch({ seed, rules: { ...FAST, ...rules } });
  m.addPlayer('a', 'Alice');
  m.step(DT);
  return m;
}

/** The centre of the first clear 16 × 16 patch of road (no wreck, pole or wall in it), scanning the streets. */
function openSpot(): { x: number; y: number } {
  for (const p of STREET_POINTS) {
    let free = true;
    for (let dy = -8; dy <= 8 && free; dy += 1) {
      for (let dx = -8; dx <= 8 && free; dx += 1) free = circleIsFree(p.x + dx, p.y + dy, 0.45);
    }
    if (free) return { x: p.x, y: p.y };
  }
  throw new Error('no open patch of road');
}
const STREET = openSpot();

test('a run: day → dusk → night 1 → dawn → day 2, nights counted', () => {
  const m = match();
  assert.equal(m.phase, 'day');
  assert.equal(m.night, 0);
  assert.equal(m.day, 1);
  const ev = until(m, 'dusk');
  assert.ok(ev.some((e) => e.type === 'phase' && e.phase === 'dusk'));
  const night = until(m, 'night');
  assert.ok(night.some((e) => e.type === 'night' && e.night === 1 && !e.blood));
  assert.equal(m.night, 1);
  const dawn = until(m, 'day');
  assert.ok(dawn.some((e) => e.type === 'dawn' && e.nights === 1));
  assert.equal(m.nightsSurvived, 1);
  assert.equal(m.day, 2);
});

test('night strength: night 3 zombies have 1.44× HP and hit harder; chubbies join night 3, not night 1', () => {
  const m = match(2, { spawnScale: 1, nightTime: 200 });
  m.skipToNight(1, []);
  assert.ok(m.queuedKinds.length === hordeSize(1, 1));
  assert.ok(!m.queuedKinds.some((k) => k !== ZombieKind.basic), 'night 1: basic only');
  const z1 = m.spawnZombie(ZombieKind.basic, STREET.x, STREET.y);
  assert.equal(z1.maxHp, ZOMBIES[ZombieKind.basic]!.hp);
  m.skipToNight(3, []);
  assert.equal(m.night, 3);
  const kinds: readonly number[] = m.queuedKinds;
  assert.ok(kinds.includes(ZombieKind.chubby), 'night 3 brings chubbies');
  assert.ok(kinds.includes(ZombieKind.crawler), 'and crawlers');
  assert.ok(!kinds.includes(ZombieKind.brute), 'but no brute yet');
  const z3 = m.spawnZombie(ZombieKind.basic, STREET.x + 2, STREET.y);
  assert.equal(z3.maxHp, Math.round(60 * 1.44));
  assert.ok(Math.abs(z3.damage - 10 * 1.24) < 1e-9);
  // The zombie that was already out got stronger too when night 3 fell.
  assert.ok(z1.maxHp >= z3.maxHp - 1);
  m.skipToNight(4, []);
  assert.ok((m.queuedKinds as readonly number[]).includes(ZombieKind.brute), 'the brute from night 4');
  m.skipToNight(5, []);
  assert.ok(m.blood, 'night 5 is a Blood Moon');
  assert.equal(m.queuedKinds.length, hordeSize(5, 1));
});

test('the horde spawns out of sight and converges', () => {
  const m = match(3, { spawnScale: 1, nightTime: 60 });
  m.invulnerable = true;
  m.place('a', STREET.x, STREET.y);
  m.skipToNight(1, []);
  run(m, 20);
  assert.ok(m.zombies.size > 4, `zombies out: ${m.zombies.size}`);
  const a = m.players.get('a')!;
  // One still on its way (the first may already be at the player's throat).
  const first = [...m.zombies.values()].find((z) => Math.hypot(z.x - a.x, z.y - a.y) > 6)!;
  assert.ok(first, 'a zombie still on its way');
  const d0 = Math.hypot(first.x - a.x, first.y - a.y);
  run(m, 6);
  const d1 = m.zombies.has(first.id) ? Math.hypot(first.x - a.x, first.y - a.y) : 0;
  assert.ok(d1 < d0, `closing in: ${d0.toFixed(1)} → ${d1.toFixed(1)}`);
});

test('melee: two knife stabs kill a day zombie; durability wears down; fists when it breaks', () => {
  const m = match();
  m.place('a', STREET.x, STREET.y);
  m.frozen = true;
  const z = m.spawnZombie(ZombieKind.basic, STREET.x + 1.2, STREET.y, false);
  const before = m.players.get('a')!.durability;
  aimAt(m, 'a', z.x, z.y, { melee: true });
  const ev = run(m, 1);
  assert.ok(!m.zombies.has(z.id), 'dead');
  assert.equal(ev.filter((e) => e.type === 'swing' && e.hits > 0).length, 2);
  const kill = ev.find((e) => e.type === 'kill');
  assert.ok(kill && kill.type === 'kill' && kill.by === 'a' && kill.cause === Item.knife);
  assert.equal(m.players.get('a')!.kills, 1);
  assert.equal(m.teamKills, 1);
  assert.equal(m.players.get('a')!.durability, before - 2);
  // Wear it out.
  const p = m.players.get('a')!;
  p.durability = 1;
  const z2 = m.spawnZombie(ZombieKind.basic, STREET.x + 1.2, STREET.y, false);
  aimAt(m, 'a', z2.x, z2.y, { melee: true });
  const ev2 = run(m, 0.5);
  assert.ok(ev2.some((e) => e.type === 'broke' && e.item === Item.knife));
  assert.equal(p.melee, Item.none);
  assert.equal(m.meleeOf(p).style, 'punch');
});

test('the guitar sends zombies flying and counts toward Unplugged', () => {
  const m = match();
  m.place('a', STREET.x, STREET.y);
  m.frozen = true;
  m.give('a', Item.guitar);
  const zs = [0, 1, 2].map((k) => m.spawnZombie(ZombieKind.basic, STREET.x + 1.3, STREET.y - 0.6 + k * 0.6, false));
  aimAt(m, 'a', STREET.x + 1.3, STREET.y, { melee: true });
  m.step(DT);
  for (const z of zs) assert.ok(Math.hypot(z.kx, z.ky) > 2, 'knocked back');
  m.frozen = false;
  run(m, 3);
  assert.ok(m.players.get('a')!.guitarKills >= 1);
});

test('guns: two pistol shots kill a night-1 zombie, ammo counts down, an empty gun clicks; the rifle pierces', () => {
  const m = match();
  m.place('a', STREET.x, STREET.y);
  m.frozen = true;
  m.skipToNight(1, []);
  const a = m.players.get('a')!;
  const ammo = a.ammo[0]!;
  const z = m.spawnZombie(ZombieKind.basic, STREET.x, STREET.y - 6);
  aimAt(m, 'a', z.x, z.y, { fire: true });
  const ev = run(m, 1);
  assert.ok(!m.zombies.has(z.id));
  assert.equal(ev.filter((e) => e.type === 'hit').length, 2);
  assert.ok(a.ammo[0]! < ammo);
  a.ammo[0] = 0;
  const z2 = m.spawnZombie(ZombieKind.basic, STREET.x, STREET.y - 6);
  aimAt(m, 'a', z2.x, z2.y, { fire: true });
  const empty = run(m, 0.5);
  assert.ok(empty.some((e) => e.type === 'empty'));
  assert.ok(m.zombies.has(z2.id));
  m.clearZombies();
  // The rifle: one round through two zombies.
  m.give('a', Item.rifle);
  m.give('a', Item.ammo_rifle);
  a.fireCd = 0;
  const near = m.spawnZombie(ZombieKind.basic, STREET.x, STREET.y - 4);
  const far = m.spawnZombie(ZombieKind.basic, STREET.x, STREET.y - 7);
  aimAt(m, 'a', near.x, near.y, { fire: true });
  const shot = run(m, DT);
  assert.equal(shot.filter((e) => e.type === 'hit').length, 2);
  assert.ok(!m.zombies.has(near.id) && !m.zombies.has(far.id), 'one round, two kills');
});

test('lag compensation: a shot at where the shooter saw a moving zombie hits it', () => {
  const m = match();
  m.place('a', STREET.x, STREET.y);
  m.skipToNight(1, []);
  m.invulnerable = true;
  const z = m.spawnZombie(ZombieKind.basic, STREET.x - 3, STREET.y - 8);
  z.hp = z.maxHp = 1000;
  // It strolls east; the client draws it 6 ticks late.
  m.frozen = true;
  for (let i = 0; i < 10; i++) {
    z.x += 0.12;
    m.step(DT);
  }
  const seen = m.zombieAt(z, m.tick - 6);
  assert.ok(Math.abs(seen.x - (z.x - 0.72)) < 1e-4, 'history');
  m.setViewTick('a', m.tick - 6);
  aimAt(m, 'a', seen.x, seen.y, { fire: true });
  const ev = run(m, DT);
  assert.ok(
    ev.some((e) => e.type === 'hit' && e.zombie === z.id),
    'hit where it was seen',
  );
});

test('chests: hold the context button next to one and the loot lands in your pockets', () => {
  const m = match();
  const chest = LOOT_SPOTS.find((s) => s.kind === 'chest' && s.zone === 0)!;
  standNear(m, 'a', chest.x, chest.y, 1.2);
  const a = m.players.get('a')!;
  const before = JSON.stringify([a.ammo, a.items, a.gun, a.melee, a.armor, m.scrap]);
  m.setInput('a', input({ act: true }));
  m.step(DT);
  assert.equal(a.action?.kind, Action.open);
  const ev = run(m, 1.3);
  assert.ok(m.opened[chest.id], 'opened');
  const open = ev.find((e) => e.type === 'open');
  assert.ok(open && open.type === 'open' && open.items >= 2, 'a common chest gives at least two things');
  run(m, 0.3);
  const after = JSON.stringify([a.ammo, a.items, a.gun, a.melee, a.armor, m.scrap]);
  const onGround = [...m.pickups.values()].filter((p) => Math.hypot(p.x - a.x, p.y - a.y) < 2).length;
  assert.ok(after !== before || onGround > 0, 'something was picked up (or a weapon waits at your feet)');
  // Holding on does nothing more: the chest is open (and a finished hold waits for a release).
  run(m, 1.2);
  assert.equal(a.action, null);
});

test('loot: chests never come up empty, specials always hold a gun, searches sometimes do', () => {
  const m = match(9);
  for (let i = 0; i < 200; i++) {
    assert.ok(m.rollLoot('chest', i % 3 === 0 ? 0 : 1, null).length >= 2);
    const special = m.rollLoot('special', 2, null);
    assert.ok(special.some((c) => [Item.shotgun, Item.rifle, Item.smg].includes(c as 2 | 3 | 4)));
  }
  let empty = 0;
  for (let i = 0; i < 200; i++) if (m.rollLoot('search', 0, null).length === 0) empty++;
  assert.ok(empty > 10 && empty < 90, `${empty} empty searches in 200`);
});

test('down and revive: crawling, a teammate holds 3 s; nobody comes and you bleed out until dawn', () => {
  const m = match(1, { firstDayTime: 100, dayTime: 100 });
  m.addPlayer('b', 'Bob');
  m.place('a', STREET.x, STREET.y);
  m.place('b', STREET.x + 1, STREET.y);
  const a = m.players.get('a')!;
  const b = m.players.get('b')!;
  const ev = run(m, DT);
  m.hurt(a, 500, ev);
  assert.equal(a.life, 'down');
  assert.ok(ev.some((e) => e.type === 'down' && e.id === 'a'));
  assert.equal(m.speedOf(a) < 0.3, true, 'crawling');
  // Bob holds the button: 3 s.
  m.setInput('b', input({ act: true }));
  run(m, REVIVE_TIME - 0.3);
  assert.equal(a.life, 'down');
  assert.ok(a.revive > 2, 'progress shows on the downed survivor');
  const up = run(m, 0.5);
  assert.equal(a.life, 'alive');
  assert.equal(a.hp, REVIVE_HP);
  assert.ok(up.some((e) => e.type === 'revive' && e.id === 'a' && e.by === 'b'));
  assert.equal(b.revives, 1);
  // Down again, nobody helps: dead after BLEED_OUT, back at dawn at the safehouse.
  m.setInput('b', input());
  m.hurt(a, 500, []);
  run(m, BLEED_OUT + 0.2);
  assert.equal(a.life, 'dead');
  assert.equal(m.phase === 'over', false, 'Bob still stands');
  m.setPhase_('night', 0.5, []);
  until(m, 'day');
  assert.equal(a.life, 'alive');
  assert.equal(a.hp, PLAYER_HP);
  assert.ok(a.x > SAFE.x0 && a.x < SAFE.x1 && a.y > SAFE.y0 && a.y < SAFE.y1, 'respawned at the safehouse');
});

test('solo: a second wind gets you up once a night; everyone down ends the run', () => {
  const m = match(4, { nightTime: 30 });
  m.place('a', STREET.x, STREET.y);
  m.skipToNight(1, []);
  const a = m.players.get('a')!;
  m.hurt(a, 500, []);
  assert.equal(a.life, 'down');
  run(m, 0.5);
  assert.equal(m.phase, 'night', 'not over: the second wind is there');
  m.setInput('a', input({ act: true }));
  run(m, REVIVE_TIME + 0.2);
  assert.equal(a.life, 'alive');
  assert.equal(a.secondWind, false);
  m.setInput('a', input());
  m.hurt(a, 500, []);
  const ev = run(m, DT * 2);
  assert.equal(m.phase, 'over', 'down twice in one night: the run is over');
  const over = ev.find((e) => e.type === 'runOver');
  assert.ok(over && over.type === 'runOver' && !over.summary.escaped && over.summary.nights === 0);
});

test('a group run ends the moment everyone is down', () => {
  const m = match();
  m.addPlayer('b', 'Bob');
  m.hurt(m.players.get('a')!, 500, []);
  run(m, 0.2);
  assert.equal(m.phase, 'day');
  m.hurt(m.players.get('b')!, 500, []);
  const ev = run(m, DT);
  assert.equal(m.phase, 'over');
  assert.ok(ev.some((e) => e.type === 'runOver'));
});

test('barricades: built from scrap or a kit, upgraded, smashed by zombies (brutes hardest); survivors walk through', () => {
  const m = match(1, { nightTime: 60 });
  const socket = 0;
  const s = SOCKETS[socket]!;
  const inside = { x: s.x, y: s.y + 1.4 };
  m.place('a', inside.x, inside.y);
  m.scrap = BARRICADES[0].cost + BARRICADES[1].cost;
  // The other half of the opening is walled up already.
  m.barricades[1] = { tier: 4, hp: 820, maxHp: 820 };
  m.setInput('a', input({ act: true }));
  const ev = run(m, 1.4);
  assert.ok(ev.some((e) => e.type === 'build' && e.tier === 1));
  assert.equal(m.barricades[socket]?.tier, 1);
  assert.equal(m.scrap, BARRICADES[1].cost);
  // Release and hold again: the upgrade.
  m.setInput('a', input());
  m.step(DT);
  m.setInput('a', input({ act: true }));
  run(m, 1.4);
  assert.equal(m.barricades[socket]?.tier, 2);
  assert.equal(m.scrap, 0);
  // A kit places its tier for free.
  m.setInput('a', input());
  m.step(DT);
  m.players.get('a')!.items[0] = Item.kit4;
  m.setInput('a', input({ act: true }));
  run(m, 1.4);
  assert.equal(m.barricades[socket]?.tier, 4);
  assert.equal(m.players.get('a')!.items[0], Item.none);
  // A survivor walks through it.
  m.setInput('a', input({ move: { x: 0, y: -1 } }));
  run(m, 1.5);
  assert.ok(m.players.get('a')!.y < s.y - 0.8, 'out through the barricade');
  // A zombie outside is stopped and smashes it.
  m.setInput('a', input());
  m.place('a', SAFE_CENTER.x, SAFE_CENTER.y + 2);
  m.skipToNight(1, []);
  m.invulnerable = true;
  const z = m.spawnZombie(ZombieKind.basic, s.x, s.y - 1.5);
  z.target = 'a';
  const total = () => (m.barricades[0]?.hp ?? 0) + (m.barricades[1]?.hp ?? 0);
  const hp0 = total();
  run(m, 3);
  assert.ok(z.y < s.y, 'held outside');
  assert.ok(total() < hp0, 'smashed');
  const byBasic = hp0 - total();
  m.clearZombies();
  const brute = m.spawnZombie(ZombieKind.brute, s.x, s.y - 2);
  brute.target = 'a';
  brute.rockCd = 99;
  const hp1 = total();
  run(m, 3);
  assert.ok(hp1 - total() > byBasic * 4, `the brute smashes harder (${hp1 - total()} vs ${byBasic})`);
});

test('the truck: carry parts home (slow, no guns), fit them, add scrap; from night 4 start it, hold out, escape', () => {
  const m = match(5);
  m.addPlayer('b', 'Bob');
  const a = m.players.get('a')!;
  // Pick up the wheel at the Junction.
  const wheel = PART_SPOTS.find((p) => p.item === 'wheel')!;
  standNear(m, 'a', wheel.x, wheel.y, 1);
  m.setInput('a', input({ act: true }));
  run(m, 0.6);
  assert.equal(a.carry, Item.wheel);
  assert.equal(m.speedOf(a), CARRY_SPEED);
  // No guns while carrying.
  m.frozen = true;
  const z = m.spawnZombie(ZombieKind.basic, a.x, a.y - 5, false);
  aimAt(m, 'a', z.x, z.y, { fire: true });
  const ev = run(m, 0.5);
  assert.ok(!ev.some((e) => e.type === 'shot'));
  m.clearZombies();
  // Fit it at the truck.
  m.setInput('a', input());
  m.step(DT);
  standNear(m, 'a', TRUCK.x, TRUCK.y, 3.6);
  m.setInput('a', input({ act: true }));
  const fit = run(m, 1.7);
  assert.ok(fit.some((e) => e.type === 'part' && e.item === Item.wheel));
  assert.equal(m.truck.wheels, 1);
  assert.equal(a.carry, Item.none);
  // Scrap from the team pool.
  m.setInput('a', input());
  m.step(DT);
  m.scrap = 100;
  m.setTruck(2, 2, 0);
  m.setInput('a', input({ act: true }));
  run(m, 1.4);
  assert.equal(m.truck.scrap, TRUCK_SCRAP);
  assert.equal(m.scrap, 100 - TRUCK_SCRAP);
  assert.ok(m.repaired);
  // Not before night 4.
  m.setInput('a', input());
  m.step(DT);
  assert.equal(m.canStart, false);
  m.skipToNight(ESCAPE_FROM_NIGHT, []);
  assert.ok(m.canStart);
  m.frozen = false;
  m.invulnerable = true;
  m.setInput('a', input({ act: true }));
  const start = run(m, 2.2);
  assert.ok(start.some((e) => e.type === 'holdout'));
  assert.equal(m.phase, 'holdout');
  const rest = until(m, 'over', 10);
  assert.ok(rest.some((e) => e.type === 'escape'));
  const over = rest.find((e) => e.type === 'runOver');
  assert.ok(over && over.type === 'runOver');
  const summary = over.summary;
  assert.equal(summary.escaped, true);
  assert.equal(summary.nights, ESCAPE_FROM_NIGHT - 1);
  assert.deepEqual(runBoardScores(summary, 'a'), { nights: 3, kills: null, escapes: 1 });
  assert.ok(runAchievements(summary, 'a').includes('getaway'));
  assert.ok(runAchievements(summary, 'a').includes('first_light'));
});

test('the dog: pet it in the back alleys; it follows, barks and bites; downed, it is back at dawn', () => {
  const m = match(6, { nightTime: 40 });
  m.addPlayer('b', 'Bob');
  standNear(m, 'a', DOG_SPOT.x, DOG_SPOT.y, 1.5);
  m.place('b', 0, -20);
  assert.equal(m.dog.state, 0);
  m.setInput('a', input({ act: true }));
  const ev = run(m, 0.6);
  assert.equal(m.dog.state, 1);
  assert.ok(ev.some((e) => e.type === 'dog' && e.state === 1 && e.by === 'a'));
  assert.equal(m.players.get('a')!.foundDog, true);
  assert.equal(m.players.get('b')!.foundDog, false, 'Bob was across town');
  // It follows Alice down the alley.
  m.setInput('a', input({ move: { x: 0, y: -1 } }));
  run(m, 2);
  m.setInput('a', input());
  run(m, 2);
  const a = m.players.get('a')!;
  assert.ok(Math.hypot(m.dog.x - a.x, m.dog.y - a.y) < 4, 'at heel');
  // A zombie comes: it barks, and bites it.
  m.skipToNight(1, []);
  m.invulnerable = true;
  const z = m.spawnZombie(ZombieKind.basic, m.dog.x + 3, m.dog.y);
  z.hp = z.maxHp = 500;
  const bites = run(m, 4);
  assert.ok(
    bites.some((e) => e.type === 'bark'),
    'barked',
  );
  assert.ok(z.hp < 500, 'bitten');
  // Downed (it never dies), up again at dawn.
  m.invulnerable = false;
  m.clearZombies();
  m.dog.hp = 1;
  const z2 = m.spawnZombie(ZombieKind.basic, m.dog.x + 0.8, m.dog.y);
  z2.target = 'dog';
  const down = run(m, 2);
  assert.ok(down.some((e) => e.type === 'dog' && e.state === 2));
  assert.equal(m.dog.state, 2);
  m.clearZombies();
  m.setPhase_('night', 0.5, []);
  until(m, 'day');
  assert.equal(m.dog.state, 1);
  assert.equal(m.dog.hp, DOG_HP);
});

test('specials: a chubby bursts into goo that slows; the brute winds up and its rock lands where you stood', () => {
  const m = match(7, { nightTime: 40 });
  m.place('a', STREET.x, STREET.y);
  m.skipToNight(3, []);
  const c = m.spawnZombie(ZombieKind.chubby, STREET.x, STREET.y - 5);
  const ev: MatchEvent[] = [];
  m.damageZombie(c, 10_000, 0, 0, m.players.get('a')!, Item.pistol, ev);
  assert.ok(ev.some((e) => e.type === 'goo'));
  assert.equal(m.goo.size, 1);
  const g = [...m.goo.values()][0]!;
  assert.ok(GOO_RADIUS > 1.5 && Math.hypot(g.x - STREET.x, g.y - (STREET.y - 5)) < 0.01);
  // The brute.
  m.clearZombies();
  m.skipToNight(4, []);
  const b = m.spawnZombie(ZombieKind.brute, STREET.x, STREET.y - 10);
  b.rockCd = 0;
  const wind = run(m, 0.5);
  const w = wind.find((e) => e.type === 'windup');
  assert.ok(w && w.type === 'windup', 'a telegraphed wind-up');
  assert.ok(Math.hypot(w.x - STREET.x, w.y - STREET.y) < 0.5, 'aimed at where Alice stands');
  // Step aside: the rock lands on the spot, not on her.
  m.place('a', STREET.x + 4, STREET.y);
  const hp = m.players.get('a')!.hp;
  const land = run(m, ROCK_WINDUP + 1.2);
  assert.ok(land.some((e) => e.type === 'rock'));
  assert.equal(m.players.get('a')!.hp, hp, 'dodged');
});

test('late joiners spawn at the safehouse, even at night; private rooms wait for start', () => {
  const m = match();
  m.skipToNight(2, []);
  const c = m.addPlayer('c', 'Cleo');
  assert.ok(c.inRun);
  assert.ok(c.x > SAFE.x0 && c.x < SAFE.x1 && c.y > SAFE.y0 && c.y < SAFE.y1);
  const p = new NorthdaleMatch({ rules: { ...FAST, autoStart: false } });
  p.addPlayer('a', 'Alice');
  run(p, 2);
  assert.equal(p.phase, 'waiting');
  p.requestStart();
  p.step(DT);
  assert.equal(p.phase, 'day');
});

test('zombies far from everyone are simulated coarsely; day wanderers give up the chase', () => {
  const m = match(8);
  m.place('a', STREET.x, STREET.y);
  const spot = STREET_POINTS.find((p) => {
    const d = Math.hypot(p.x - STREET.x, p.y - STREET.y);
    return d > 60 && d < 90;
  })!;
  const far = m.spawnZombie(ZombieKind.basic, spot.x, spot.y, false);
  m.step(DT);
  assert.ok(far.idle > 0, 'asleep between coarse steps');
  const z = m.spawnZombie(ZombieKind.basic, STREET.x, STREET.y - 6, false);
  run(m, 0.5);
  assert.equal(z.target, 'a', 'noticed');
  // (Not so far that the wanderer is recycled: those are removed beyond 100 units.)
  const away = STREET_POINTS.find((p) => {
    const d = Math.hypot(p.x - z.x, p.y - z.y);
    return d > 30 && d < 60;
  })!;
  m.place('a', away.x, away.y);
  run(m, 0.6);
  assert.ok(m.zombies.has(z.id));
  assert.equal(z.target, null, 'lost interest');
});

test('determinism: the same seed and inputs give the same town state', () => {
  const sim = () => {
    const m = new NorthdaleMatch({ seed: 42, rules: { dayTime: 4, firstDayTime: 4, duskTime: 1, nightTime: 20 } });
    m.addPlayer('a', 'Alice');
    m.addPlayer('b', 'Bob');
    for (let i = 0; i < 30 * 30; i++) {
      if (i % 40 === 0) {
        m.setInput('a', input({ move: { x: Math.cos(i), y: Math.sin(i) }, aim: { x: 0, y: -1 }, fire: i % 80 === 0 }));
        m.setInput('b', input({ move: { x: -Math.sin(i), y: Math.cos(i) }, melee: true }));
      }
      m.step(DT);
    }
    return JSON.stringify({
      phase: m.phase,
      zombies: [...m.zombies.values()].map((z) => [z.id, z.kind, z.x.toFixed(4), z.y.toFixed(4), z.hp.toFixed(2)]),
      players: m.playerList.map((p) => [p.x.toFixed(4), p.y.toFixed(4), p.hp, p.kills]),
    });
  };
  assert.equal(sim(), sim());
});

test('rules from a client are sanitized', () => {
  assert.deepEqual(sanitizeRules({ dayTime: 0, nightTime: 1e9, spawnScale: 'x', autoStart: false, bogus: 1 }), {
    autoStart: false,
    dayTime: 1,
    nightTime: 900,
  });
  assert.deepEqual(sanitizeRules(null), {});
});

test('a summary ranks survivors by kills', () => {
  const m = match();
  m.addPlayer('b', 'Bob');
  m.players.get('b')!.kills = 5;
  m.players.get('a')!.kills = 2;
  const s = m.standings();
  assert.deepEqual(
    s.map((x) => [x.name, x.placement]),
    [
      ['Bob', 1],
      ['Alice', 2],
    ],
  );
  const summary: RunSummary = {
    run: 1,
    nights: 5,
    duration: 900,
    escaped: false,
    bloodMoons: 1,
    teamKills: 7,
    standings: s,
  };
  assert.ok(runAchievements(summary, 'b').includes('blood_moon'));
  assert.equal(AMMO.length, 4);
});
