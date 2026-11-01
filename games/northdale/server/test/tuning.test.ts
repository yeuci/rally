import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLOOD_MOON_EVERY,
  MAX_ZOMBIES,
  NIGHT_TIME,
  ZOMBIES,
  ZombieKind,
  clockMinutes,
  dayPopulation,
  dayStrength,
  effectiveNight,
  hordeMix,
  hordeSize,
  isBloodMoon,
  nightStrength,
  spawnInterval,
} from '../src/index.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('night strength: HP +22 %, damage +12 %, speed +4 % (capped at +30 %) per night', () => {
  const table = [1, 2, 3, 4, 5, 6, 8, 9, 10, 20].map((n) => [n, nightStrength(n)] as const);
  const expected: Record<number, [number, number, number]> = {
    1: [1, 1, 1],
    2: [1.22, 1.12, 1.04],
    3: [1.44, 1.24, 1.08],
    4: [1.66, 1.36, 1.12],
    5: [1.88, 1.48, 1.16],
    6: [2.1, 1.6, 1.2],
    8: [2.54, 1.84, 1.28],
    9: [2.76, 1.96, 1.3],
    10: [2.98, 2.08, 1.3],
    20: [5.18, 3.28, 1.3],
  };
  for (const [n, s] of table) {
    const [hp, damage, speed] = expected[n]!;
    close(s.hp, hp);
    close(s.damage, damage);
    close(s.speed, speed);
  }
  // Monotonic: no night is ever easier than the one before.
  for (let n = 1; n < 30; n++) {
    const a = nightStrength(n);
    const b = nightStrength(n + 1);
    assert.ok(b.hp > a.hp && b.damage > a.damage && b.speed >= a.speed, `night ${n + 1} ≥ night ${n}`);
  }
});

test('day zombies scale at half the night rate', () => {
  close(dayStrength(1).hp, 1);
  close(dayStrength(2).hp, 1.11);
  close(dayStrength(3).hp, nightStrength(2).hp);
  close(dayStrength(5).damage, nightStrength(3).damage);
  close(dayStrength(7).speed, nightStrength(4).speed);
});

test('horde size: base × (0.55 + 0.45 p) × (1 + 0.3 (n − 1)), doubled on a Blood Moon', () => {
  assert.equal(hordeSize(1, 1), 32);
  assert.equal(hordeSize(1, 2), 46);
  assert.equal(hordeSize(1, 4), 75);
  assert.equal(hordeSize(2, 1), 42);
  assert.equal(hordeSize(3, 2), 74);
  assert.equal(hordeSize(4, 1), 61);
  assert.equal(hordeSize(4, 4), 143);
  // Night 5 is a Blood Moon: twice the curve.
  assert.equal(hordeSize(5, 1), Math.round(32 * 1 * 2.2 * 2));
  assert.equal(hordeSize(5, 4), Math.round(32 * 2.35 * 2.2 * 2));
  // Player counts are clamped to 1–4.
  assert.equal(hordeSize(1, 0), hordeSize(1, 1));
  assert.equal(hordeSize(1, 9), hordeSize(1, 4));
  // The horde arrives within the first 70 % of the night (and never faster than a spawn per 0.15 s).
  assert.ok(spawnInterval(1, 1) * hordeSize(1, 1) <= NIGHT_TIME * 0.7 + 1e-6);
  assert.equal(spawnInterval(10, 4), 0.15);
  // Phones draw at most this many at once; the rest queue.
  assert.ok(MAX_ZOMBIES >= 60 && MAX_ZOMBIES <= 80);
});

test('specials join by night: crawlers from 2, chubbies from 3, the brute from 4', () => {
  assert.deepEqual(hordeMix(1), { crawler: 0, chubby: 0, brutes: 0 });
  assert.equal(hordeMix(2).crawler, 0.15);
  assert.equal(hordeMix(2).chubby, 0);
  assert.equal(hordeMix(3).chubby, 0.08);
  assert.equal(hordeMix(3).brutes, 0);
  assert.equal(hordeMix(4).brutes, 1);
  assert.equal(hordeMix(6).brutes, 2);
  assert.equal(hordeMix(20).crawler, 0.3);
  assert.equal(hordeMix(20).chubby, 0.18);
  // A Blood Moon brings one more brute.
  assert.equal(hordeMix(5).brutes, hordeMix(4).brutes + 1);
});

test('Blood Moon every 5th night, at the next night strength', () => {
  assert.equal(BLOOD_MOON_EVERY, 5);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9, 10, 15].map(isBloodMoon), [
    false,
    false,
    false,
    false,
    true,
    false,
    false,
    true,
    true,
  ]);
  assert.equal(effectiveNight(4), 4);
  assert.equal(effectiveNight(5), 6);
  assert.equal(effectiveNight(10), 11);
  close(nightStrength(effectiveNight(5)).hp, nightStrength(6).hp);
});

test('the kinds: crawlers fast and fragile, chubbies spongy, the brute huge', () => {
  const basic = ZOMBIES[ZombieKind.basic]!;
  const crawler = ZOMBIES[ZombieKind.crawler]!;
  const chubby = ZOMBIES[ZombieKind.chubby]!;
  const brute = ZOMBIES[ZombieKind.brute]!;
  assert.ok(crawler.run > basic.run && crawler.hp < basic.hp);
  assert.ok(chubby.hp > basic.hp * 3 && chubby.run < basic.run);
  assert.ok(brute.hp > chubby.hp && brute.scale > 1.5 && brute.smash > chubby.smash);
});

test('day population and the clock', () => {
  assert.equal(dayPopulation(1, 1), 11);
  assert.equal(dayPopulation(1, 4), 20);
  assert.equal(dayPopulation(30, 4), 24);
  assert.equal(clockMinutes('day', 0), 360);
  assert.equal(clockMinutes('day', 1), 1080);
  assert.equal(clockMinutes('dusk', 1), 1170);
  assert.equal(clockMinutes('night', 0.5), 30);
});
