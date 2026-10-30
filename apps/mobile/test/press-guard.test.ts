import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAWER_EDGE_WIDTH } from '../src/lib/drawer';
import { EDGE_SWIPE_SLOP, TAP_SLOP, drawerGesture, pressPoint, shouldDropPress } from '../src/lib/press-guard';

const at = (x: number, y: number, epoch = 0) => ({ x, y, epoch });
const drop = (start: ReturnType<typeof at> | null, end: { x: number; y: number } | null, epoch = 0) =>
  shouldDropPress({ start, end, epoch, edgeWidth: DRAWER_EDGE_WIDTH });

test('a plain tap goes through, anywhere (including inside the edge strip)', () => {
  assert.equal(drop(at(200, 400), { x: 200, y: 400 }), false);
  assert.equal(drop(at(200, 400), { x: 203, y: 398 }), false);
  assert.equal(drop(at(10, 400), { x: 10, y: 401 }), false, 'first tile / search pill under the edge strip');
  assert.equal(drop(at(10, 400), { x: 12, y: 404 }), false, 'a tap that wobbles less than the pan needs');
});

test('the drawer gesture starting during the press drops it (the owner\'s "swipe opens Rally Spike too")', () => {
  assert.equal(drop(at(12, 300, 4), { x: 14, y: 300 }, 5), true);
  assert.equal(drop(at(12, 300, 5), { x: 14, y: 300 }, 5), false, 'same epoch: no drawer gesture in between');
});

test('a drag is not a tap: more than TAP_SLOP of travel drops it, in any direction', () => {
  assert.equal(drop(at(200, 400), { x: 200 + TAP_SLOP + 1, y: 400 }), true);
  assert.equal(drop(at(200, 400), { x: 200, y: 400 - TAP_SLOP - 1 }), true);
  assert.equal(drop(at(200, 400), { x: 206, y: 406 }), true, 'diagonal: √72 ≈ 8.5 pt');
  assert.equal(drop(at(200, 400), { x: 200 + TAP_SLOP, y: 400 }), false, 'exactly the slop still taps');
});

test("inside the edge strip, moving right by the pan's activation distance drops it even under TAP_SLOP", () => {
  assert.equal(drop(at(DRAWER_EDGE_WIDTH, 300), { x: DRAWER_EDGE_WIDTH + EDGE_SWIPE_SLOP, y: 300 }), true);
  assert.equal(drop(at(4, 300), { x: 4 + EDGE_SWIPE_SLOP, y: 302 }), true);
  // Leftwards, or starting just past the strip: the drawer pan never wanted it.
  assert.equal(drop(at(20, 300), { x: 20 - EDGE_SWIPE_SLOP, y: 300 }), false);
  assert.equal(drop(at(DRAWER_EDGE_WIDTH + 1, 300), { x: DRAWER_EDGE_WIDTH + 1 + EDGE_SWIPE_SLOP, y: 300 }), false);
  // No edge strip (edgeWidth 0): only the general rules apply.
  assert.equal(shouldDropPress({ start: at(4, 300), end: { x: 10, y: 300 }, epoch: 0, edgeWidth: 0 }), false);
});

test('presses without a touch behind them (accessibility activation, keyboard) always go through', () => {
  assert.equal(drop(null, { x: 0, y: 0 }), false);
  assert.equal(drop(at(10, 10, 1), null, 9), false, 'no end point: a click event, not a release');
  assert.equal(pressPoint({}), null);
  assert.equal(pressPoint(undefined), null);
  assert.equal(pressPoint({ pageX: Number.NaN, pageY: 3 }), null);
  assert.deepEqual(pressPoint({ pageX: 12.5, pageY: 40 }), { x: 12.5, y: 40 });
});

test('the drawer gesture epoch only moves forward', () => {
  const before = drawerGesture.epoch();
  drawerGesture.mark();
  drawerGesture.mark();
  assert.equal(drawerGesture.epoch(), before + 2);
});
