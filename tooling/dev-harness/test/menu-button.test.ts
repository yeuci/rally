import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BUTTON_PREFS,
  TUCK_PULL,
  buttonBounds,
  parseButtonPrefs,
  placeAt,
  restingPoint,
  rubberBand,
  setTucked,
  snapToEdge,
  tabPlacement,
  tuckSideFor,
  tuckTo,
} from '../src/menu-button.ts';
import { menuButtonRect } from '../src/settings.ts';

const SAFE = { top: 47, right: 0, bottom: 34, left: 0 };
const B = buttonBounds(390, 844, SAFE);

test('the default spot is the launch context rect; bounds keep the cog inside the safe area', () => {
  const rect = menuButtonRect(SAFE);
  assert.deepEqual({ x: B.minX, y: B.minY, width: 40, height: 40 }, rect);
  assert.deepEqual(B, { minX: 12, minY: 51, maxX: 338, maxY: 766 });
  assert.deepEqual(restingPoint(DEFAULT_BUTTON_PREFS, 'portrait', B), { x: 12, y: 51 });
});

test('drag feel: rubber band past the edges; drop snaps flush near an edge, drifts a little in the open', () => {
  assert.equal(rubberBand(100, 12, 338), 100);
  assert.ok(rubberBand(-100, 12, 338) > 12 - 36);
  assert.deepEqual(snapToEdge({ x: 30, y: 400 }, B), { x: 12, y: 400 });
  assert.deepEqual(snapToEdge({ x: 112, y: 420 }, B), { x: 97, y: 420 });
});

test('tuck: past a side edge, or a sideways fling that would coast past it', () => {
  assert.equal(tuckSideFor({ x: B.minX - TUCK_PULL - 1, vx: 0, vy: 0 }, B), 'left');
  assert.equal(tuckSideFor({ x: B.maxX + TUCK_PULL + 1, vx: 0, vy: 0 }, B), 'right');
  assert.equal(tuckSideFor({ x: 250, vx: 1600, vy: 0 }, B), 'right');
  assert.equal(tuckSideFor({ x: 200, vx: 500, vy: 0 }, B), null);
  assert.equal(tuckSideFor({ x: 30, vx: 1500, vy: 1400 }, B), null);
});

test('tucking keeps the last spot; the checkbox tucks to the nearer side', () => {
  const moved = placeAt(DEFAULT_BUTTON_PREFS, 'portrait', { x: 300, y: 500 }, B);
  const tucked = tuckTo(moved, 'portrait', 'left', B, 200);
  assert.equal(tucked.tucked, true);
  assert.deepEqual(tucked.portrait?.spot, moved.portrait?.spot);
  assert.equal(tabPlacement(tucked, 'portrait', B).side, 'left');
  assert.ok(Math.abs(restingPoint(setTucked(tucked, 'portrait', false, B), 'portrait', B).x - 300) < 0.5);
  assert.equal(tabPlacement(setTucked(moved, 'portrait', true, B), 'portrait', B).side, 'right');
});

test('stored prefs parse leniently', () => {
  assert.deepEqual(parseButtonPrefs(null), DEFAULT_BUTTON_PREFS);
  assert.deepEqual(parseButtonPrefs('{oops'), DEFAULT_BUTTON_PREFS);
  assert.deepEqual(parseButtonPrefs('{"tucked":true,"portrait":{"spot":{"x":0.5,"y":3}}}'), {
    tucked: true,
    portrait: null,
    landscape: null,
  });
  const prefs = tuckTo(placeAt(DEFAULT_BUTTON_PREFS, 'landscape', { x: 100, y: 100 }, B), 'landscape', 'right', B);
  assert.deepEqual(parseButtonPrefs(JSON.stringify(prefs)), prefs);
});
