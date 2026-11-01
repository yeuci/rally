import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MENU_BUTTON_PREFS,
  MAX_PULL,
  RUBBER_MAX,
  TAB_HEIGHT,
  TUCK_PULL,
  buttonBounds,
  clampToBounds,
  createMenuButtonStore,
  fromSpot,
  menuButtonKey,
  nearestSide,
  parseMenuButtonPrefs,
  placeAt,
  restingPoint,
  rubberBand,
  setTucked,
  snapToEdge,
  tabPlacement,
  toSpot,
  tuckSideFor,
  tuckTo,
  type MenuButtonPrefs,
} from '../src/game-host/menu-button-model';
import { createMemoryStorage } from '../src/game-host/rejoin-journal';
import { MENU_BUTTON_SIZE, menuButtonRect } from '../src/game-host/settings';

// iPhone 14: 390 × 844 portrait (notch 47, home bar 34); 844 × 390 landscape.
const PORTRAIT = { top: 47, right: 0, bottom: 34, left: 0 };
const LANDSCAPE = { top: 0, right: 47, bottom: 21, left: 47 };
const P = buttonBounds(390, 844, PORTRAIT);
const L = buttonBounds(844, 390, LANDSCAPE);

test('bounds: the safe area less a gap; the top-left corner is the rect games are told about', () => {
  assert.equal(MENU_BUTTON_SIZE, 40);
  assert.deepEqual(P, { minX: 12, minY: 51, maxX: 390 - 8 - 4 - 40, maxY: 844 - 34 - 4 - 40 });
  assert.deepEqual(L, { minX: 51, minY: 12, maxX: 844 - 47 - 4 - 40, maxY: 390 - 21 - 4 - 40 });
  const rect = menuButtonRect(PORTRAIT);
  assert.deepEqual({ x: P.minX, y: P.minY }, { x: rect.x, y: rect.y });
  // A screen too small for any travel collapses to the corner instead of inverting.
  const tiny = buttonBounds(40, 40, PORTRAIT);
  assert.equal(tiny.maxX, tiny.minX);
  assert.equal(tiny.maxY, tiny.minY);
});

test('clamping keeps the disc inside the safe area', () => {
  assert.deepEqual(clampToBounds({ x: -50, y: 2000 }, P), { x: P.minX, y: P.maxY });
  assert.deepEqual(clampToBounds({ x: 9999, y: -5 }, P), { x: P.maxX, y: P.minY });
  assert.deepEqual(clampToBounds({ x: 100, y: 300 }, P), { x: 100, y: 300 });
});

test('rubber band: exact inside, resisting past the edges, never more than RUBBER_MAX', () => {
  assert.equal(rubberBand(100, 12, 338), 100);
  const a = rubberBand(12 - 10, 12, 338);
  const b = rubberBand(12 - 40, 12, 338);
  assert.ok(a < 12 && a > 2, `${a}`);
  assert.ok(b < a, 'further pulls give a little more');
  assert.ok(12 - b < 40, 'but less than the finger');
  assert.ok(rubberBand(-10_000, 12, 338) > 12 - RUBBER_MAX);
  assert.ok(rubberBand(10_000, 12, 338) < 338 + RUBBER_MAX);
  assert.ok(rubberBand(338 + 20, 12, 338) > 338);
});

test('snapping: flush against an edge within the snap zone', () => {
  // 30 pt from the left edge, far from the others → flush left.
  assert.deepEqual(snapToEdge({ x: P.minX + 30, y: 400 }, P), { x: P.minX, y: 400 });
  // Near the bottom.
  assert.deepEqual(snapToEdge({ x: 150, y: P.maxY - 12 }, P), { x: 150, y: P.maxY });
  // Near the right; released beyond the bounds → clamped, then flush.
  assert.deepEqual(snapToEdge({ x: P.maxX + 60, y: 500 }, P), { x: P.maxX, y: 500 });
});

test('snapping: out in the open, only a small drift toward the nearest edge', () => {
  // 100 pt from the left (nearest), → drifts 15 pt (EDGE_PULL 0.15).
  const a = snapToEdge({ x: P.minX + 100, y: 420 }, P);
  assert.deepEqual(a, { x: P.minX + 85, y: 420 });
  // Dead centre of the landscape area: nearest is top/bottom (the short axis); the drift is capped at MAX_PULL.
  const mid = { x: (L.minX + L.maxX) / 2, y: (L.minY + L.maxY) / 2 };
  const b = snapToEdge(mid, L);
  assert.equal(b.x, mid.x);
  assert.ok(Math.abs(b.y - mid.y) <= MAX_PULL && b.y !== mid.y, `${b.y}`);
});

test('nearest side', () => {
  assert.equal(nearestSide({ x: P.minX + 10, y: 0 }, P), 'left');
  assert.equal(nearestSide({ x: P.maxX - 10, y: 0 }, P), 'right');
});

test('tuck detection: dragged past a side edge', () => {
  assert.equal(tuckSideFor({ x: P.minX - TUCK_PULL - 1, vx: 0, vy: 0 }, P), 'left');
  assert.equal(tuckSideFor({ x: P.maxX + TUCK_PULL + 1, vx: 0, vy: 0 }, P), 'right');
  // Up to the edge (or a little past it) is a placement, not a tuck.
  assert.equal(tuckSideFor({ x: P.minX - 10, vx: 0, vy: 0 }, P), null);
  assert.equal(tuckSideFor({ x: P.maxX, vx: 0, vy: 0 }, P), null);
});

test('tuck detection: flung toward a side edge', () => {
  // From near the left third, a hard fling left coasts past the edge.
  assert.equal(tuckSideFor({ x: 80, vx: -1400, vy: 100 }, P), 'left');
  assert.equal(tuckSideFor({ x: 260, vx: 1400, vy: -200 }, P), 'right');
  // Too slow, or mostly vertical, or not far enough to coast past the edge.
  assert.equal(tuckSideFor({ x: 80, vx: -600, vy: 0 }, P), null);
  assert.equal(tuckSideFor({ x: 80, vx: -1400, vy: 1300 }, P), null);
  assert.equal(tuckSideFor({ x: 200, vx: -1000, vy: 0 }, P), null);
  // A fling away from the edge never tucks into it.
  assert.equal(tuckSideFor({ x: 30, vx: 1100, vy: 0 }, P), null);
});

test('spots: fractions of the free area, the same relative place on another screen', () => {
  assert.deepEqual(toSpot({ x: P.minX, y: P.minY }, P), { x: 0, y: 0 });
  assert.deepEqual(toSpot({ x: P.maxX, y: P.maxY }, P), { x: 1, y: 1 });
  assert.deepEqual(toSpot({ x: -100, y: 5000 }, P), { x: 0, y: 1 });
  const spot = toSpot({ x: 175, y: 400 }, P);
  const back = fromSpot(spot, P);
  assert.ok(Math.abs(back.x - 175) < 0.1 && Math.abs(back.y - 400) < 0.1);
  // On an iPad the same spot is the same proportion of the way across.
  const ipad = buttonBounds(820, 1180, { top: 24, right: 0, bottom: 20, left: 0 });
  const there = fromSpot(spot, ipad);
  assert.ok(Math.abs(toSpot(there, ipad).x - spot.x) < 1e-3);
});

test('resting point: top-left until moved, per orientation', () => {
  assert.deepEqual(restingPoint(DEFAULT_MENU_BUTTON_PREFS, 'portrait', P), { x: P.minX, y: P.minY });
  const moved = placeAt(DEFAULT_MENU_BUTTON_PREFS, 'portrait', { x: P.maxX, y: 600 }, P);
  assert.equal(restingPoint(moved, 'portrait', P).x, P.maxX);
  assert.ok(Math.abs(restingPoint(moved, 'portrait', P).y - 600) < 0.5);
  assert.deepEqual(restingPoint(moved, 'landscape', L), { x: L.minX, y: L.minY }, 'landscape untouched');
});

test('tucking keeps the last spot; untucking returns to it', () => {
  const moved = placeAt(DEFAULT_MENU_BUTTON_PREFS, 'portrait', { x: 200, y: 300 }, P);
  const tucked = tuckTo(moved, 'portrait', 'right', P, 500);
  assert.equal(tucked.tucked, true);
  assert.deepEqual(tucked.portrait?.spot, moved.portrait?.spot);
  const tab = tabPlacement(tucked, 'portrait', P);
  assert.equal(tab.side, 'right');
  assert.ok(Math.abs(tab.top - (500 + MENU_BUTTON_SIZE / 2 - TAB_HEIGHT / 2)) < 0.5);
  const back = setTucked(tucked, 'portrait', false, P);
  assert.equal(back.tucked, false);
  assert.ok(Math.abs(restingPoint(back, 'portrait', P).x - 200) < 0.5);
  // Dropping the disc somewhere new also untucks (and remembers the tab's last side).
  const dropped = placeAt(tucked, 'portrait', { x: P.minX, y: 700 }, P);
  assert.equal(dropped.tucked, false);
  assert.equal(dropped.portrait?.tab?.side, 'right');
});

test('the menu switch tucks to the nearer side at the resting height', () => {
  const home = setTucked(DEFAULT_MENU_BUTTON_PREFS, 'portrait', true, P);
  assert.equal(home.tucked, true);
  assert.deepEqual(tabPlacement(home, 'portrait', P), {
    side: 'left',
    top: P.minY + MENU_BUTTON_SIZE / 2 - TAB_HEIGHT / 2,
  });
  const right = setTucked(
    placeAt(DEFAULT_MENU_BUTTON_PREFS, 'landscape', { x: L.maxX, y: 200 }, L),
    'landscape',
    true,
    L,
  );
  assert.equal(tabPlacement(right, 'landscape', L).side, 'right');
  // With no tab stored yet, the side follows the resting spot.
  assert.equal(
    tabPlacement(placeAt(DEFAULT_MENU_BUTTON_PREFS, 'portrait', { x: P.maxX, y: 0 }, P), 'portrait', P).side,
    'right',
  );
});

test('parsing tolerates junk and keeps what is valid', () => {
  assert.deepEqual(parseMenuButtonPrefs(null), DEFAULT_MENU_BUTTON_PREFS);
  assert.deepEqual(parseMenuButtonPrefs('not json'), DEFAULT_MENU_BUTTON_PREFS);
  assert.deepEqual(parseMenuButtonPrefs('42'), DEFAULT_MENU_BUTTON_PREFS);
  assert.deepEqual(
    parseMenuButtonPrefs('{"tucked":"yes","portrait":{"spot":{"x":2,"y":0}}}'),
    DEFAULT_MENU_BUTTON_PREFS,
  );
  const prefs = parseMenuButtonPrefs(
    JSON.stringify({
      tucked: true,
      portrait: { spot: { x: 1, y: 0.25 }, tab: { side: 'up', y: 0.5 } },
      landscape: { spot: { x: 0.5, y: 0.5 }, tab: { side: 'left', y: 0.75 } },
      extra: 1,
    }),
  );
  assert.deepEqual(prefs, {
    tucked: true,
    portrait: { spot: { x: 1, y: 0.25 } },
    landscape: { spot: { x: 0.5, y: 0.5 }, tab: { side: 'left', y: 0.75 } },
  });
});

test('store: per game, round trip, defaults on failure', async () => {
  const storage = createMemoryStorage();
  const store = createMenuButtonStore(storage);
  assert.deepEqual(await store.load('stack'), DEFAULT_MENU_BUTTON_PREFS);
  const prefs: MenuButtonPrefs = tuckTo(
    placeAt(DEFAULT_MENU_BUTTON_PREFS, 'portrait', { x: 100, y: 200 }, P),
    'portrait',
    'left',
    P,
  );
  await store.save('stack', prefs);
  assert.deepEqual(await store.load('stack'), prefs);
  assert.deepEqual(await store.load('sumo'), DEFAULT_MENU_BUTTON_PREFS, 'per game');
  assert.ok((await storage.getItem(menuButtonKey('stack')))?.includes('"tucked":true'));
  const broken = createMenuButtonStore({
    getItem: () => Promise.reject(new Error('disk')),
    setItem: () => Promise.reject(new Error('disk')),
    removeItem: () => Promise.reject(new Error('disk')),
  });
  assert.deepEqual(await broken.load('stack'), DEFAULT_MENU_BUTTON_PREFS);
  await broken.save('stack', prefs);
});
