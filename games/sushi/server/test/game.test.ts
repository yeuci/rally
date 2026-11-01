import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHOP_TIME,
  DT,
  GYOZA_BURN_AFTER,
  GYOZA_COOK_TIME,
  Kind,
  MAX_STARS,
  PRICES,
  RICE_COOK_TIME,
  ROLL_TIME,
  SEATS,
  SEAT_TARGET,
  SLOT_TARGET,
  STATIONS,
  SushiGame,
  TIP_RATE,
  Zone,
  BotCrew,
  beltPoint,
  BELT_LENGTH,
  BELT_SLOTS,
  type GameEvent,
  type StationType,
} from '../src/index.ts';

/** A game with a chef "a", the run started, Monday open, no customers unless a test spawns them. */
function open(rules = {}) {
  const g = new SushiGame({ seed: 1, rules: { noArrivals: true, morningTime: 0.2, lobbyTime: 0.05, ...rules } });
  g.addPlayer('a', 'Ann');
  const ev: GameEvent[] = [];
  for (let i = 0; i < 40 && g.phase !== 'open'; i++) ev.push(...g.step(DT));
  assert.equal(g.phase, 'open');
  return { g, ev };
}

const station = (type: StationType, n = 0) => STATIONS.filter((s) => s.type === type)[n]!;
const crate = (k: Kind) => STATIONS.find((s) => s.crate === k)!;

/** Stand in front of a station (the aisle side) and run `ticks` steps. */
function standAt(g: SushiGame, id: string, target: { x: number; y: number }) {
  const y = target.y < -4.5 ? -4.65 : target.y < -2 ? -2.2 : target.y + 0.9;
  g.place(id, target.x, y);
}

function run(g: SushiGame, seconds: number, ev: GameEvent[] = []) {
  for (let t = 0; t < seconds; t += DT) ev.push(...g.step(DT));
  return ev;
}

/** A quick tap on `target` (press and release inside one input). */
function tap(g: SushiGame, id: string, target: number) {
  const c = g.chefs.get(id)!;
  g.setInput(id, { move: { x: 0, y: 0 }, button: false, presses: c.input.presses + 1, target });
  return g.step(DT);
}

/** Press and hold on `target` for `seconds`, then let go. */
function hold(g: SushiGame, id: string, target: number, seconds: number) {
  const c = g.chefs.get(id)!;
  g.setInput(id, { move: { x: 0, y: 0 }, button: true, presses: c.input.presses + 1, target });
  const ev = run(g, seconds);
  g.setInput(id, { ...g.chefs.get(id)!.input, button: false });
  ev.push(...g.step(DT));
  return ev;
}

/** The empty belt slot nearest the chef. */
function nearestSlot(g: SushiGame, id: string, empty = true) {
  const c = g.chefs.get(id)!;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < BELT_SLOTS; i++) {
    if (empty === !!g.slots[i]!.item) continue;
    const p = beltPoint(g.beltS + (i * BELT_LENGTH) / BELT_SLOTS);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < bestD) [best, bestD] = [i, d];
  }
  return { slot: best, d: bestD };
}

test('a chef makes a salmon nigiri from the crate to the belt, and a seated customer takes it and tips', () => {
  const { g } = open();
  const a = g.chefs.get('a')!;
  standAt(g, 'a', crate(Kind.SalmonFish));
  tap(g, 'a', crate(Kind.SalmonFish).id);
  assert.equal(a.held?.kind, Kind.SalmonFish, 'from the crate');
  const board = station('board');
  standAt(g, 'a', board);
  tap(g, 'a', board.id);
  assert.equal(g.stations[board.id]!.item?.kind, Kind.SalmonFish, 'on the board');
  const chop = hold(g, 'a', board.id, CHOP_TIME + 0.3);
  assert.ok(chop.some((e) => e.type === 'chopped'));
  assert.equal(g.stations[board.id]!.item?.kind, Kind.Salmon, 'sliced');
  tap(g, 'a', board.id);
  const mat = station('mat');
  standAt(g, 'a', mat);
  tap(g, 'a', mat.id);
  assert.deepEqual(g.stations[mat.id]!.mat, [Kind.Salmon]);
  // The rice pot (a solo crew's comes with the auto cooker: it is already cooking).
  const rice = station('rice');
  assert.ok(g.helper, 'solo: the prep helper');
  run(g, RICE_COOK_TIME);
  standAt(g, 'a', rice);
  tap(g, 'a', rice.id);
  assert.equal(a.held?.kind, Kind.Rice);
  standAt(g, 'a', mat);
  tap(g, 'a', mat.id);
  const roll = hold(g, 'a', mat.id, ROLL_TIME + 0.3);
  assert.ok(roll.some((e) => e.type === 'rolled' && e.kind === Kind.SalmonNigiri));
  tap(g, 'a', mat.id);
  assert.equal(a.held?.kind, Kind.SalmonNigiri);
  const plates = station('plates');
  standAt(g, 'a', plates);
  tap(g, 'a', plates.id);
  assert.deepEqual(a.held, { kind: Kind.SalmonNigiri, plated: true, n: 1 }, 'plated (white plate)');

  // A customer on the middle stool orders it.
  const stool = SEATS.find((s) => s.kind === 'stool' && s.rank === 0)!;
  const cust = g.spawnCustomer({ seat: stool.id, order: Kind.SalmonNigiri }, [])!;
  run(g, 4);
  assert.equal(cust.state, 'wait');
  // Onto the belt from the pass.
  g.place('a', -1, -1.6);
  const { slot, d } = nearestSlot(g, 'a');
  assert.ok(d < 1.25, 'a slot within reach of the pass');
  tap(g, 'a', SLOT_TARGET + slot);
  assert.equal(g.slots[slot]!.item?.kind, Kind.SalmonNigiri, 'on the belt');
  const money = g.money;
  const ev = run(g, 30);
  const grab = ev.find((e) => e.type === 'grab');
  assert.ok(grab && grab.type === 'grab', 'the customer took it as it passed');
  assert.equal(grab.price, PRICES.white);
  assert.ok(grab.tip > 0 && grab.tip <= PRICES.white * TIP_RATE);
  assert.equal(g.money, money + grab.price + grab.tip);
  assert.equal(g.dayStats.served, 1);
  assert.ok(
    ev.some((e) => e.type === 'happy'),
    'happy after eating',
  );
});

test('a quick tap on a board with a raw fish picks it up; holding chops it', () => {
  const { g } = open();
  const board = station('board');
  g.give('a', Kind.Tuna);
  standAt(g, 'a', board);
  tap(g, 'a', board.id);
  tap(g, 'a', board.id);
  assert.equal(g.chefs.get('a')!.held?.kind, Kind.Tuna, 'tap: picked up, not chopped');
  tap(g, 'a', board.id);
  hold(g, 'a', board.id, CHOP_TIME + 0.4);
  assert.equal(g.stations[board.id]!.item?.kind, Kind.TunaSlice, 'hold: chopped');
});

test('plates that ride unclaimed go stale, and customers never take a stale plate', () => {
  const { g } = open();
  const stale = g.today.staleTime;
  g.putOnBelt(3, Kind.MaguroNigiri, stale - 0.5);
  const ev = run(g, 1);
  assert.ok(ev.some((e) => e.type === 'stale' && e.slot === 3));
  assert.ok(g.slots[3]!.stale);
  assert.equal(g.dayStats.stale, 1);
  const stool = SEATS.find((s) => s.kind === 'stool' && s.rank === 0)!;
  g.spawnCustomer({ seat: stool.id, order: Kind.MaguroNigiri }, []);
  assert.ok(!run(g, 35).some((e) => e.type === 'grab'), 'nobody wants a stale plate');
  // A chef pulls it off at the pass (once it comes round to the kitchen side) and bins it.
  for (let i = 0; i < 800; i++) {
    const p = beltPoint(g.slotS(3));
    if (p.y < -0.5 && p.x > -3.5 && p.x < 2.5) break;
    g.step(DT);
  }
  g.place('a', beltPoint(g.slotS(3)).x + 0.3, -1.6);
  tap(g, 'a', SLOT_TARGET + 3);
  assert.equal(g.chefs.get('a')!.held?.kind, Kind.MaguroNigiri);
  const bin = station('bin');
  g.place('a', bin.x + 0.8, bin.y + 0.6);
  tap(g, 'a', bin.id);
  assert.equal(g.chefs.get('a')!.held, null, 'binned (no plates counted before Thursday)');
});

test('Wednesday opens the dining room: a table customer gets ramen carried from the pot', () => {
  const { g } = open();
  g.skipToDay(3);
  run(g, 0.3);
  assert.ok(g.zones & Zone.dining);
  const seat = SEATS.find((s) => s.kind === 'table' && s.zone === Zone.dining)!;
  assert.ok(g.seatOpen(seat));
  const cust = g.spawnCustomer({ seat: seat.id, order: Kind.Ramen }, [])!;
  const pot = STATIONS.find((s) => s.dish === Kind.Ramen)!;
  standAt(g, 'a', pot);
  tap(g, 'a', pot.id);
  run(g, 8);
  tap(g, 'a', pot.id);
  assert.equal(g.chefs.get('a')!.held?.kind, Kind.Ramen);
  run(g, 8);
  assert.equal(cust.state, 'wait');
  g.place('a', seat.x, seat.y + 0.9);
  const ev = tap(g, 'a', SEAT_TARGET + seat.id);
  const serve = ev.find((e) => e.type === 'serve');
  assert.ok(serve && serve.type === 'serve' && serve.price === PRICES.hot);
});

test('gyoza burns when left in the pan: smoke first, then burnt (only good for the bin)', () => {
  const { g } = open();
  g.skipToDay(3);
  run(g, 0.3);
  const pan = station('pan');
  g.give('a', Kind.GyozaRaw);
  standAt(g, 'a', pan);
  tap(g, 'a', pan.id);
  const ev = run(g, GYOZA_COOK_TIME + GYOZA_BURN_AFTER + 0.5);
  const kinds = ev.map((e) => e.type);
  assert.ok(kinds.indexOf('cooked') < kinds.indexOf('smoke') && kinds.indexOf('smoke') < kinds.indexOf('burn'));
  assert.equal(g.stations[pan.id]!.item?.kind, Kind.GyozaBurnt);
  tap(g, 'a', pan.id);
  assert.equal(g.chefs.get('a')!.held?.kind, Kind.GyozaBurnt);
});

test('Thursday on: eaten plates pile up dirty at the seat; bussed, washed, they come back to the stack', () => {
  const { g } = open();
  g.skipToDay(4);
  run(g, 0.3);
  const plates = station('plates');
  const pool = g.stations[plates.id]!.count;
  assert.equal(pool, g.platePool);
  g.give('a', Kind.Onigiri);
  standAt(g, 'a', plates);
  tap(g, 'a', plates.id);
  assert.equal(g.stations[plates.id]!.count, pool - 1, 'plating uses a clean plate');
  const stool = SEATS.find((s) => s.kind === 'stool' && s.rank === 0)!;
  g.spawnCustomer({ seat: stool.id, order: Kind.Onigiri }, []);
  run(g, 4);
  g.place('a', -1, -1.6);
  tap(g, 'a', SLOT_TARGET + nearestSlot(g, 'a').slot);
  run(g, 32);
  assert.equal(g.seats[stool.id]!.dirty, 1, 'a dirty plate at the seat');
  g.place('a', stool.x, stool.y + 0.7);
  tap(g, 'a', SEAT_TARGET + stool.id);
  assert.deepEqual(g.chefs.get('a')!.held, { kind: Kind.DirtyPlate, plated: false, n: 1 });
  const sink = station('sink');
  standAt(g, 'a', sink);
  tap(g, 'a', sink.id);
  hold(g, 'a', sink.id, 1.4);
  assert.equal(g.stations[plates.id]!.count, pool, 'washed back onto the stack');
});

test('stars: an angry exit costs one, a perfect day wins one back, none left closes the restaurant', () => {
  const { g } = open();
  const stool = SEATS.find((s) => s.kind === 'stool' && s.rank === 0)!;
  g.spawnCustomer({ seat: stool.id, order: Kind.Onigiri, patience: 1 }, []);
  const ev = run(g, 6);
  assert.ok(ev.some((e) => e.type === 'angry'));
  assert.equal(g.stars, MAX_STARS - 1);
  // A perfect next day.
  const g2 = open().g;
  g2.setStars(4, []);
  g2.endOpen();
  const night = run(g2, 2);
  assert.ok(night.some((e) => e.type === 'dayOver'));
  assert.equal(g2.stars, 5, 'perfect day: a star back');
  // The last star.
  g.setStars(1, []);
  g.spawnCustomer({ seat: stool.id, order: Kind.Onigiri, patience: 0.5 }, []);
  const end = run(g, 6);
  assert.ok(end.some((e) => e.type === 'runOver'));
  assert.equal(g.phase, 'over');
});

test('the night: a majority vote picks the card; one-day cards last one day; a new day opens with its lesson', () => {
  const { g } = open({ voteTime: 3 });
  g.addPlayer('b', 'Bob');
  g.endOpen();
  run(g, 0.5);
  assert.equal(g.phase, 'night');
  assert.equal(g.cards.length, 3);
  g.vote('a', 1);
  g.vote('b', 1);
  const card = g.cards[1]!;
  const ev = run(g, 4);
  assert.ok(ev.some((e) => e.type === 'vote' && e.card === card));
  const morning = ev.find((e) => e.type === 'morning');
  assert.ok(morning && morning.type === 'morning' && morning.day === 2 && morning.teach.includes('rolls'));
  assert.ok(g.owned.has(card) || g.todayCards.has(card), 'applied');
});

test('chefs take the lowest free slot; zones open with the week', () => {
  const g = new SushiGame();
  for (const id of ['a', 'b', 'c', 'd']) g.addPlayer(id, id);
  assert.deepEqual(
    g.chefList.map((c) => c.slot),
    [0, 1, 2, 3],
  );
  g.removePlayer('b');
  assert.equal(g.addPlayer('e', 'e').slot, 1);
  for (const [day, zones] of [
    [1, 0],
    [3, Zone.dining],
    [6, Zone.dining | Zone.alley],
    [7, Zone.dining | Zone.alley | Zone.terrace],
  ] as const) {
    g.skipToDay(day);
    assert.equal(g.zones, zones, `day ${day}`);
  }
});

test('deterministic: the same seed and crew play the same day', () => {
  const play = () => {
    const g = new SushiGame({ seed: 42, rules: { morningTime: 1 } });
    const bots = new BotCrew(g);
    g.addPlayer('bot:1', 'A', true);
    g.addPlayer('bot:2', 'B', true);
    g.skipToDay(3);
    let summary = '';
    for (let t = 0; t < 300 && !summary; t += DT) {
      bots.think(DT);
      for (const e of g.step(DT)) if (e.type === 'dayOver' || e.type === 'runOver') summary = JSON.stringify(e.summary);
    }
    return summary;
  };
  const a = play();
  assert.ok(a.length > 0);
  assert.equal(play(), a);
});
