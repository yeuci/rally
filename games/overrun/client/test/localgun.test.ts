import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WEAPONS } from '@rally/game-overrun-server';
import { LocalGun, shotAngles, tracerLength } from '../src/localgun.ts';
import { cycleWeapon } from '../src/controls.ts';

function shotsPerSecond(weapon: number, fps: number, seconds = 3) {
  const g = new LocalGun();
  let n = 0;
  for (let i = 0; i <= fps * seconds; i++) n += g.update((i * 1000) / fps, true, weapon);
  return n / seconds;
}

test('your own shots follow the server cadence at any frame rate, at once when the trigger goes down', () => {
  for (const fps of [30, 60, 120]) {
    assert.ok(Math.abs(shotsPerSecond(1, fps) - 1 / WEAPONS[1]!.cooldown) < 0.6, `uzi at ${fps} fps`);
    assert.ok(Math.abs(shotsPerSecond(0, fps) - 1 / WEAPONS[0]!.cooldown) < 0.5, `pistol at ${fps} fps`);
  }
  const g = new LocalGun();
  assert.equal(g.update(0, false, 0), 0);
  assert.equal(g.update(16, true, 0), 1, 'first shot on the press');
  assert.equal(g.update(32, true, 0), 0);
  assert.equal(new LocalGun().update(0, true, 3), 0, 'barrels are placed by the server, no tracer');
});

test('shotgun fans five pellets over its spread; tracers stop at walls and drawn zombies', () => {
  const fan = shotAngles(2, 0);
  assert.equal(fan.length, 5);
  assert.ok(Math.abs(fan[4]! - fan[0]! - WEAPONS[2]!.spread) < 1e-12);
  assert.deepEqual(shotAngles(0, 1), [1]);
  // From below the north wall straight up: stops at its face (y = -7.7).
  assert.ok(Math.abs(tracerLength(-4, -6, 0, -1, 15, []) - 1.7) < 1e-9);
  assert.ok(Math.abs(tracerLength(0, 0, 1, 0, 15, [{ x: 3, y: 0, r: 0.5 }]) - 2.5) < 1e-9);
  assert.equal(tracerLength(0, 0, 0, 1, 2, []), 2, 'range');
});

test('weapon cycling skips locked and empty weapons; the pistol is always there', () => {
  const ammo = [Infinity, 30, 0, 2, 0];
  assert.equal(cycleWeapon(0, 1, 5, ammo), 1);
  assert.equal(cycleWeapon(1, 1, 5, ammo), 3, 'empty shotgun skipped');
  assert.equal(cycleWeapon(3, 1, 5, ammo), 0, 'wraps past the empty mines');
  assert.equal(cycleWeapon(0, -1, 5, ammo), 3);
  assert.equal(cycleWeapon(0, 1, 1, ammo), 0, 'only the pistol unlocked');
  assert.equal(cycleWeapon(1, 1, 2, ammo), 0);
});
