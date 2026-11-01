import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTabletDevice, shapeOf, shellTurnFor } from '../src/game-host/orientation-model.ts';

test('tablets: an iPad, or an Android screen with a 600 dp short side; phones otherwise', () => {
  assert.equal(isTabletDevice('ios', true, { width: 1024, height: 1366 }), true);
  assert.equal(isTabletDevice('ios', false, { width: 428, height: 926 }), false);
  // iOS trusts isPad, never the size (a big iPhone held sideways is still a phone).
  assert.equal(isTabletDevice('ios', false, { width: 926, height: 700 }), false);
  assert.equal(isTabletDevice('android', false, { width: 800, height: 1280 }), true);
  assert.equal(isTabletDevice('android', false, { width: 1280, height: 600 }), true, 'held sideways');
  assert.equal(isTabletDevice('android', false, { width: 412, height: 915 }), false);
});

test('after a game a phone always turns back to portrait; a tablet the way the player held it', () => {
  for (const before of [0, 1, 2, 3, 4, null]) assert.equal(shellTurnFor(before, false), 'portrait', String(before));
  assert.equal(shellTurnFor(1, true), 'portrait');
  assert.equal(shellTurnFor(2, true), 'portrait');
  assert.equal(shellTurnFor(3, true), 'landscape');
  assert.equal(shellTurnFor(4, true), 'landscape');
  assert.equal(shellTurnFor(0, true), 'portrait', 'unknown: portrait');
  assert.equal(shellTurnFor(null, true), 'portrait');
});

test('window shape: wider than tall is landscape, a square is portrait', () => {
  assert.equal(shapeOf({ width: 926, height: 428 }), 'landscape');
  assert.equal(shapeOf({ width: 428, height: 926 }), 'portrait');
  assert.equal(shapeOf({ width: 800, height: 800 }), 'portrait');
});
