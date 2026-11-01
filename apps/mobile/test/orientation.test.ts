import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  frameFor,
  isTabletDevice,
  screenToFrame,
  shapeOf,
  shellTurnFor,
  turnForDevice,
  turnInsets,
  turnsInApp,
} from '../src/game-host/orientation-model.ts';

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

test('in-app turning: iPhones only; tablets and Android rotate natively', () => {
  assert.equal(turnsInApp('ios', false), true);
  assert.equal(turnsInApp('ios', true), false);
  assert.equal(turnsInApp('android', false), false);
  assert.equal(turnsInApp('android', true), false);
});

test('the held turn follows the notch: on the left turns the frame clockwise, on the right counter-clockwise', () => {
  assert.equal(turnForDevice(-90), 90);
  assert.equal(turnForDevice(90), -90);
  for (const o of [0, 180, 45]) assert.equal(turnForDevice(o), null, String(o));
});

test('frame: a landscape game on a portrait iPhone is a centred landscape box, turned to fill the screen', () => {
  const phone = { width: 428, height: 926 };
  assert.deepEqual(frameFor(phone, 'landscape', true, 90), { width: 926, height: 428, left: -249, top: 249, turn: 90 });
  assert.deepEqual(frameFor(phone, 'landscape', true, -90).turn, -90);
  const whole = { width: 428, height: 926, left: 0, top: 0, turn: 0 };
  assert.deepEqual(frameFor(phone, 'portrait', true, 90), whole, 'a portrait game fits as it is');
  assert.deepEqual(frameFor(phone, 'any', true, 90), whole, 'a game that takes any orientation is never turned');
  assert.deepEqual(frameFor(phone, 'landscape', false, 90), whole, 'devices that rotate natively are never turned');
  // A portrait game in a landscape window (never happens on a portrait-locked iPhone, but symmetric).
  assert.deepEqual(frameFor({ width: 926, height: 428 }, 'portrait', true, 90), {
    width: 428,
    height: 926,
    left: 249,
    top: -249,
    turn: 90,
  });
});

test('turned insets: the notch and the home indicator end up on the frame sides they are on in your hands', () => {
  const portrait = { top: 47, right: 0, bottom: 34, left: 0 };
  // Notch on the left (turn 90): the notch is the frame's left, the home indicator its right.
  assert.deepEqual(turnInsets(portrait, 90), { top: 0, right: 34, bottom: 0, left: 47 });
  // Notch on the right (turn -90): the other way round.
  assert.deepEqual(turnInsets(portrait, -90), { top: 0, right: 47, bottom: 0, left: 34 });
  assert.equal(turnInsets(portrait, 0), portrait);
});

test('screen movement in frame axes: down the screen is along the frame when it is turned', () => {
  // Turn 90: the frame's right points down the screen and its bottom points left.
  assert.deepEqual(screenToFrame(0, 10, 90), { dx: 10, dy: 0 });
  assert.deepEqual(screenToFrame(-10, 0, 90), { dx: 0, dy: 10 });
  // Turn -90: the frame's right points up the screen and its bottom points right.
  assert.deepEqual(screenToFrame(0, -10, -90), { dx: 10, dy: 0 });
  assert.deepEqual(screenToFrame(10, 0, -90), { dx: 0, dy: 10 });
  assert.deepEqual(screenToFrame(3, 4, 0), { dx: 3, dy: 4 });
});
