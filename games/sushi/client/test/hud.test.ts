import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Kind, STATIONS, SEATS, itemCode, matMask, type SushiStateView } from '@rally/game-sushi-server';
import { LESSONS, clockText, dayName, orderHtml, patienceColor, yen } from '../src/hud.ts';
import { effectsVolume, rememberGraphics, rememberedGraphics, renderQuality } from '../src/quality.ts';
import { parseResultMessage, resultLine } from '../src/result.ts';
import { actionLabel, worldOf } from '../src/world.ts';
import { actionFor, workFor } from '@rally/game-sushi-server';

test('the day and its clock: Monday to Sunday then Overtime; 11:00 to 21:00 in quarter hours', () => {
  assert.equal(dayName(1), 'Monday');
  assert.equal(dayName(7), 'Sunday');
  assert.equal(dayName(9), 'Overtime 2');
  assert.equal(clockText(0), '11:00');
  assert.equal(clockText(0.5), '16:00');
  assert.equal(clockText(1), '21:00');
  assert.equal(clockText(0.13), '12:15');
  assert.equal(yen(12345), '¥12,345');
  for (const m of ['belt', 'rolls', 'tables', 'dishes', 'vip', 'delivery', 'festival', 'stale', 'angry']) {
    assert.ok(LESSONS[m], `a lesson for ${m}`);
  }
});

test('order bubbles: the dish icon, the recipe hint when on, the patience bar and colour', () => {
  const icons = new Map([
    [Kind.SalmonNigiri, 'data:a'],
    [Kind.Rice, 'data:r'],
    [Kind.Salmon, 'data:s'],
  ]);
  const html = orderHtml(icons, [Kind.SalmonNigiri], 0, 0.5, true);
  assert.ok(html.includes('data:a') && html.includes('data:r') && html.includes('data:s'));
  assert.ok(html.includes('--p:0.500'));
  assert.ok(!orderHtml(icons, [Kind.SalmonNigiri], 0, 0.5, false).includes('data:r'), 'hints off');
  assert.ok(orderHtml(new Map(), [Kind.Ramen], 0, 1, true).includes('Ramen'), 'no icon: the name');
  const vip = orderHtml(icons, [Kind.Onigiri, Kind.SalmonNigiri, Kind.Roll], 1, 1, false);
  assert.ok(vip.includes('dish done') && vip.includes('dish next'), 'the VIP sees the course');
  assert.equal(patienceColor(0.9), '#5cc46a');
  assert.equal(patienceColor(0.4), '#f2b324');
  assert.equal(patienceColor(0.1), '#e0453a');
});

test('graphics quality: low ≈ lowfx without the fps cap; remembered for the next launch; volumes multiply', () => {
  assert.deepEqual(renderQuality('low'), {
    maxPixelRatio: 1,
    antialias: false,
    shadows: false,
    crowdShadows: false,
    effects: false,
  });
  assert.equal(renderQuality('medium').crowdShadows, false);
  assert.equal(renderQuality('high').maxPixelRatio, 2);
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  assert.equal(rememberedGraphics(storage), 'high');
  rememberGraphics(storage, 'low');
  assert.equal(rememberedGraphics(storage), 'low');
  assert.equal(rememberedGraphics(null), 'high');
  assert.equal(effectsVolume({ master: 0.5, effects: 0.5 }), 0.25);
});

test('results: guests, failures, boards and unlocks; malformed messages dropped', () => {
  assert.deepEqual(resultLine({ matchId: 'm', recorded: false, reason: 'guest' }), {
    kind: 'guest',
    text: 'Guest: sign in to keep your stats',
  });
  const r = parseResultMessage({
    matchId: 'm',
    recorded: true,
    boards: { days: { score: 4, rank: 2 }, tips: { score: 900, rank: 9 }, bad: { score: -1 } },
    unlocked: [{ key: 'gold_rush', title: 'Gold Rush', icon: '🥇' }, { nope: 1 }],
  });
  assert.ok(r && r.recorded);
  assert.deepEqual(resultLine(r!).text, 'Days #2 · Tips #9 · 🥇 Gold Rush unlocked');
  assert.equal(parseResultMessage({ matchId: 1 }), null);
  assert.equal(parseResultMessage({ matchId: 'm', recorded: false, reason: 'x' }), null);
  assert.equal(resultLine('pending').kind, 'pending');
});

/** A minimal synced state, as the client reads it. */
function state(over: Partial<SushiStateView> = {}): SushiStateView {
  return {
    phase: 'open',
    timer: 60,
    run: 1,
    day: 1,
    clock: 0.3,
    stars: 5,
    money: 0,
    earned: 0,
    tips: 0,
    served: 0,
    angry: 0,
    zones: 0,
    owned: '',
    today: '',
    cards: '',
    chosen: -1,
    dishes: false,
    helper: false,
    crew: 2,
    beltS: 0,
    beltSpeed: 0.9,
    summary: '',
    code: '',
    isPrivate: false,
    maxPlayers: 4,
    tick: 0,
    players: new Map(),
    customers: new Map(),
    stations: STATIONS.map(() => ({ item: 0, mat: 0, state: 0, count: -1, progress: 0 })),
    slots: Array.from({ length: 18 }, () => ({ item: 0, stale: false, age: 0 })),
    seats: SEATS.map(() => ({ dirty: 0, eating: 0 })),
    ...over,
  };
}

test('the client world view drives the same actions as the server: a crate, the mat, the button labels', () => {
  const st = state();
  const crate = STATIONS.find((s) => s.crate === Kind.SalmonFish)!;
  const mat = STATIONS.find((s) => s.type === 'mat')!;
  const w = worldOf(st);
  assert.equal(actionFor(w, null, crate.id), 'crate');
  assert.deepEqual(actionLabel('crate', null), { label: 'Pick up', icon: '✋' });
  st.stations[mat.id] = { item: 0, mat: matMask([Kind.Rice, Kind.Salmon]), state: 0, count: 0, progress: 0 };
  const w2 = worldOf(st);
  assert.equal(workFor(w2, null, mat.id), 'roll');
  assert.equal(actionLabel(actionFor(w2, null, mat.id), workFor(w2, null, mat.id)).label, 'Roll');
  // A crew of three gets the second board without the card.
  const board2 = STATIONS.find((s) => s.upgrade === 'board2')!;
  assert.equal(worldOf(state({ crew: 3 })).board2, true);
  assert.equal(worldOf(state({ crew: 2, owned: 'knives,board2' })).board2, true);
  assert.equal(worldOf(state({ crew: 2 })).board2, false);
  assert.equal(actionFor(worldOf(state({ crew: 3 })), { kind: Kind.Tuna, plated: false, n: 1 }, board2.id), 'put');
  void itemCode;
});
