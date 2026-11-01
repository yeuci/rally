import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE,
  COMEBACK,
  DAY_LENGTH,
  FESTIVAL_ARRIVALS,
  LAST_ORDERS,
  NO_MODS,
  OVERTIME,
  TABLE_PATIENCE,
  WEEK_DAYS,
  arrivalShape,
  crewArrivals,
  crewPatience,
  crewStools,
  dayTuning,
  expectedCustomers,
} from '../src/index.ts';

test('the week tightens every day: more customers, less patience, plates stale sooner, a richer order mix', () => {
  for (let d = 2; d <= WEEK_DAYS; d++) {
    const a = dayTuning(d - 1, 1);
    const b = dayTuning(d, 1);
    assert.ok(b.arrivalsPerMin > a.arrivalsPerMin, `arrivals grow on day ${d}`);
    assert.ok(b.patience < a.patience, `patience shrinks on day ${d}`);
    assert.ok(b.staleTime < a.staleTime, `stale time shrinks on day ${d}`);
    assert.ok(b.complexity > a.complexity, `complexity grows on day ${d}`);
  }
  const mon = dayTuning(1, 1);
  assert.equal(mon.arrivalsPerMin, BASE.arrivalsPerMin);
  assert.equal(mon.patience, Math.round(BASE.patience * crewPatience(1) * 100) / 100);
  assert.equal(mon.complexity, 0);
  assert.equal(dayTuning(WEEK_DAYS, 1).complexity, 1);
  // +12 % a day, and Sunday's festival on top.
  const sat = dayTuning(6, 1);
  const sun = dayTuning(7, 1);
  assert.ok(Math.abs(sun.arrivalsPerMin / sat.arrivalsPerMin - 1.12 * FESTIVAL_ARRIVALS) < 0.02);
  // Patience × 0.94 a day.
  assert.ok(Math.abs(dayTuning(4, 1).patience / dayTuning(3, 1).patience - 0.94) < 0.01);
  assert.equal(mon.tableShare, 0, 'no tables before Wednesday');
  assert.ok(dayTuning(3, 1).tableShare > 0);
  assert.equal(dayTuning(4, 1).vips, 0);
  assert.equal(dayTuning(5, 1).vips, 1, 'the VIP from Friday');
});

test('Overtime keeps escalating from a normal Sunday, within its caps', () => {
  const sunNoFestival = dayTuning(7, 1).arrivalsPerMin / FESTIVAL_ARRIVALS;
  assert.ok(dayTuning(8, 1).arrivalsPerMin > sunNoFestival * 1.05);
  let prev = dayTuning(8, 1);
  for (let d = 9; d <= 40; d++) {
    const t = dayTuning(d, 1);
    assert.ok(t.arrivalsPerMin >= prev.arrivalsPerMin, `arrivals never drop (day ${d})`);
    assert.ok(t.patience <= prev.patience, `patience never grows (day ${d})`);
    assert.ok(t.arrivalsPerMin <= BASE.arrivalsPerMin * OVERTIME.arrivalsCap + 1e-9, 'arrivals capped');
    assert.ok(t.patience >= OVERTIME.patienceFloor * crewPatience(1) - 1e-9, 'patience floor');
    assert.ok(t.staleTime >= OVERTIME.staleFloor - 1e-9, 'stale floor');
    prev = t;
  }
  assert.equal(dayTuning(40, 1).arrivalsPerMin, Math.round(BASE.arrivalsPerMin * OVERTIME.arrivalsCap * 100) / 100);
  assert.equal(dayTuning(12, 1).vips, 2, 'two VIPs deep into Overtime');
});

test('crew size: arrivals 0.55 + 0.45 n, a little more patience for small crews, stools grow with the crew', () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => Math.round(crewArrivals(n) * 100) / 100),
    [1, 1.45, 1.9, 2.35],
  );
  assert.deepEqual([1, 2, 3, 4].map(crewPatience), [1.15, 1.05, 1, 1]);
  assert.deepEqual([1, 2, 3, 4].map(crewStools), [6, 8, 10, 11]);
  const solo = dayTuning(3, 1);
  const four = dayTuning(3, 4);
  assert.ok(Math.abs(four.arrivalsPerMin / solo.arrivalsPerMin - 2.35) < 0.01);
  assert.ok(solo.patience > four.patience);
  assert.ok(Math.abs(four.tablePatience - four.patience * TABLE_PATIENCE) < 0.05);
});

test('cards and reputation: extra seating, tea, the critic, happy hour, the comeback at one star', () => {
  const base = dayTuning(4, 2);
  const expand = dayTuning(4, 2, { ...NO_MODS, expand: 1 });
  assert.equal(expand.stools, base.stools + 2);
  assert.ok(Math.abs(expand.arrivalsPerMin / base.arrivalsPerMin - 1.12) < 0.01);
  const critic = dayTuning(4, 2, { ...NO_MODS, critic: true });
  assert.equal(critic.tipFactor, 2);
  assert.ok(Math.abs(critic.patience / base.patience - 0.8) < 0.01);
  const rush = dayTuning(4, 2, { ...NO_MODS, rush: true });
  assert.equal(rush.tipFactor, 1.5);
  assert.ok(Math.abs(rush.arrivalsPerMin / base.arrivalsPerMin - 1.25) < 0.01);
  assert.ok(Math.abs(dayTuning(4, 2, { ...NO_MODS, tea: true }).patience / base.patience - 1.12) < 0.01);
  assert.equal(dayTuning(4, 2, NO_MODS, 2).patience, base.patience, 'no comeback at two stars');
  assert.ok(Math.abs(dayTuning(4, 2, NO_MODS, 1).patience / base.patience - COMEBACK) < 0.01, 'comeback at one');
});

test('the day: a light morning, two rushes, a lull, nothing after last orders, no sudden wall', () => {
  const n = 1000;
  let sum = 0;
  let maxStep = 0;
  let prev = arrivalShape(0);
  for (let i = 0; i < n; i++) {
    const u = ((i + 0.5) / n) * LAST_ORDERS;
    const v = arrivalShape(u);
    sum += v;
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(Math.abs(sum / n - 1) < 0.01, `mean over the open hours is 1 (got ${sum / n})`);
  assert.ok(maxStep < 0.05, `smooth (largest step ${maxStep})`);
  const lunch = arrivalShape(0.28);
  const lull = arrivalShape(0.5);
  const dinner = arrivalShape(0.7);
  assert.ok(arrivalShape(0.02) < lunch / 2, 'light morning');
  assert.ok(lull < lunch && lull < dinner, 'a lull between the rushes');
  assert.ok(dinner > lunch, 'dinner is the bigger rush');
  assert.equal(arrivalShape(LAST_ORDERS), 0);
  assert.equal(arrivalShape(0.97), 0);
  // Monday solo: about five customers; Sunday with four chefs: a full house and more.
  assert.ok(Math.abs(expectedCustomers(dayTuning(1, 1)) - 4.3) < 0.3);
  assert.ok(expectedCustomers(dayTuning(7, 4)) > 22);
  assert.equal(DAY_LENGTH, 120);
});
