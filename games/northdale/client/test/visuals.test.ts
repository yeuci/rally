import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, ITEMS, MELEE, ZombieKind } from '@rally/game-northdale-server';
import { bodyState, weaponName } from '../src/characters.ts';
import { mirrorX } from '../src/controls.ts';
import { chooseZombieAnim, zombieFrame } from '../src/horde.ts';
import { DAWN_SHARE, EVENING_SHARE, skyAt } from '../src/lighting.ts';
import { MODELS } from '../src/models/meta.gen.ts';

test('the sky: full daylight on day 1, dawn lifting after a night, dusk into night, the Blood Moon', () => {
  const day = skyAt('day', 0.5, false);
  assert.equal(day.night, 0);
  assert.deepEqual(skyAt('day', 0, false, false), day, 'the first morning starts in daylight');
  assert.ok(skyAt('day', 0, false, true).night > 0.9, 'a morning after a night starts dark');
  assert.ok(skyAt('day', DAWN_SHARE / 2, false).night > 0 && skyAt('day', DAWN_SHARE / 2, false).night < 1);
  assert.deepEqual(skyAt('day', DAWN_SHARE + 0.01, false), day);
  const late = skyAt('day', 1 - EVENING_SHARE / 2, false);
  assert.ok(late.sunIntensity <= day.sunIntensity && late.sunPitch !== day.sunPitch, 'evening light');
  assert.equal(skyAt('dusk', 0.1, false).flicker, true, 'the street lamps stutter on');
  assert.equal(skyAt('dusk', 0.9, false).flicker, false);
  assert.ok(skyAt('dusk', 0.9, false).night > skyAt('dusk', 0.1, false).night, 'dusk darkens');
  const night = skyAt('night', 0.5, false);
  const blood = skyAt('night', 0.5, true);
  assert.equal(night.night, 1);
  assert.ok(blood.fog[0] > blood.fog[2] && blood.fog[0] > night.fog[0], 'a red Blood Moon haze');
  assert.deepEqual(skyAt('holdout', 0.2, true), blood, 'the holdout keeps the night');
  assert.deepEqual(skyAt('over', 0.2, true), skyAt('waiting', 0, false), 'the result screen is daylight');
});

test('survivor body clips: guns up when loaded, parts carried in both hands, down is down', () => {
  const s = { speed: 0, back: false, life: 0, gun: 0, loaded: false, carry: 0, firing: false, celebrating: false };
  assert.equal(bodyState(s), 'Idle');
  assert.equal(bodyState({ ...s, gun: 1, loaded: true }), 'IdleGun');
  assert.equal(bodyState({ ...s, gun: 1, loaded: false, speed: 1 }), 'Walk', 'an empty gun: melee in hand');
  assert.equal(bodyState({ ...s, gun: 1, loaded: true, speed: 4 }), 'RunGun');
  assert.equal(bodyState({ ...s, speed: 4 }), 'Run');
  assert.equal(bodyState({ ...s, speed: 4, back: true }), 'Back');
  assert.equal(bodyState({ ...s, speed: 2.5, carry: 23 }), 'WalkGun', 'carrying a wheel');
  assert.equal(bodyState({ ...s, speed: 2.5, carry: 23, back: true }), 'WalkGun', 'no backpedalling with a wheel');
  assert.equal(bodyState({ ...s, life: 1, speed: 1 }), 'Down');
  assert.equal(bodyState({ ...s, life: 2 }), 'Down');
  assert.equal(bodyState({ ...s, celebrating: true }), 'Wave');
});

test('every weapon item has its model; the rest have none', () => {
  for (const code of [...Object.keys(GUNS), ...Object.keys(MELEE)].map(Number)) {
    const name = weaponName(code);
    assert.ok(name && name in MODELS.weapons, `${ITEMS[code]?.id} has a model`);
    assert.equal(MODELS.weapons[name].muzzle !== null, code in GUNS, `${name}: a muzzle on guns only`);
  }
  assert.equal(weaponName(0), null);
  assert.equal(weaponName(24), null, 'a fuel barrel is not a weapon');
});

test('zombie clips: what each kind plays exists in its file; frames loop or hold', () => {
  const kinds = [ZombieKind.basic, ZombieKind.crawler, ZombieKind.chubby, ZombieKind.brute];
  assert.deepEqual(
    MODELS.zombies.map((z) => z.name),
    ['basic', 'crawler', 'chubby', 'brute'],
  );
  for (const kind of kinds) {
    const clips = new Set<string>(MODELS.zombies[kind]!.clips.map((c) => c.name));
    for (const c of ['Idle', 'HitReact', 'Death']) assert.ok(clips.has(c), `${kind}: ${c}`);
    for (const speed of [0, 0.3, 1, 2, 4])
      for (const near of [false, true]) {
        const windup = kind === ZombieKind.brute;
        for (const w of windup ? [false, true] : [false]) {
          const anim = chooseZombieAnim(kind, speed, near, w);
          assert.ok(clips.has(anim), `kind ${kind} at ${speed} (near ${near}, windup ${w}): ${anim}`);
        }
      }
  }
  assert.equal(chooseZombieAnim(ZombieKind.basic, 3, false, false), 'Run_Arms', 'night runners');
  assert.equal(chooseZombieAnim(ZombieKind.basic, 0.1, true, false), 'Punch', 'biting');
  assert.equal(chooseZombieAnim(ZombieKind.crawler, 3, false, false), 'Crawl');
  assert.equal(chooseZombieAnim(ZombieKind.brute, 0, false, true), 'Wave', 'the rock wind-up');
  const clips = new Map(MODELS.zombies[0]!.clips.map((c) => [c.name, c]));
  const walk = clips.get('Walk')!;
  assert.equal(zombieFrame(clips, 'Walk', 0), walk.start);
  assert.ok(Math.abs(zombieFrame(clips, 'Walk', walk.seconds * 1.5) - (walk.start + 0.5 * (walk.frames - 1))) < 1e-9);
  const death = clips.get('Death')!;
  assert.equal(zombieFrame(clips, 'Death', 99, false), death.start + death.frames - 1, 'the death holds');
  assert.equal(zombieFrame(clips, 'Nope', 0), clips.get('Idle')!.start, 'unknown clips idle');
});

test('swapped sticks mirror the stick vectors back to screen axes', () => {
  assert.deepEqual(mirrorX({ x: 0.6, y: -0.8 }, false), { x: 0.6, y: -0.8 });
  assert.deepEqual(mirrorX({ x: 0.6, y: -0.8 }, true), { x: -0.6, y: -0.8 });
});
