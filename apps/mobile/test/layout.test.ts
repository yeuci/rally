import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLUMN_MAX_WIDTH,
  GUTTER,
  ROW_GAP,
  ROW_TILES_VISIBLE,
  columnPadding,
  contentWidth,
  gameCoverColumnWidth,
  gameHeroHeight,
  gridColumns,
  gridTileWidth,
  isLandscape,
  isWideLayout,
  pageIndex,
  pagePadding,
  rowTileWidth,
  snapInterval,
} from '../src/lib/layout';

// iPhone 15-class window and insets, both ways round.
const PORTRAIT = { width: 393, height: 852 };
const LANDSCAPE = { width: 852, height: 393 };
const PORTRAIT_INSETS = { top: 59, right: 0, bottom: 34, left: 0 };
const LANDSCAPE_INSETS = { top: 0, right: 59, bottom: 21, left: 59 };

/** Tiles visible in a row that starts at padLeft and runs to the window's right edge. */
const visibleTiles = (width: number, padLeft: number, tile: number) => {
  const span = width - padLeft;
  const whole = Math.floor((span + ROW_GAP) / (tile + ROW_GAP));
  return whole + Math.max(0, span - whole * (tile + ROW_GAP)) / tile;
};

test('wide layout: landscape, or at least 700 pt wide', () => {
  assert.equal(isWideLayout(PORTRAIT), false);
  assert.equal(isWideLayout(LANDSCAPE), true);
  assert.equal(isWideLayout({ width: 820, height: 1180 }), true); // tablet portrait
  assert.equal(isLandscape({ width: 820, height: 1180 }), false);
  assert.equal(isLandscape(LANDSCAPE), true);
});

test('page padding adds the safe-area inset on each side (the notch side in landscape)', () => {
  assert.deepEqual(pagePadding(PORTRAIT_INSETS), { left: GUTTER, right: GUTTER });
  assert.deepEqual(pagePadding(LANDSCAPE_INSETS), { left: GUTTER + 59, right: GUTTER + 59 });
  assert.deepEqual(pagePadding({ left: 59, right: 0 }), { left: 75, right: 16 });
  assert.equal(contentWidth(393, PORTRAIT_INSETS), 361);
  assert.equal(contentWidth(852, LANDSCAPE_INSETS), 852 - 150);
});

test('row tiles: ≈2.45 visible in portrait, ≈4.4 in landscape', () => {
  const portrait = rowTileWidth(PORTRAIT.width, GUTTER, false);
  // The original portrait formula, unchanged: floor((width - gutter - 2 gaps) / 2.45).
  assert.equal(portrait, Math.floor((393 - 16 - 24) / 2.45));
  assert.ok(Math.abs(visibleTiles(PORTRAIT.width, GUTTER, portrait) - ROW_TILES_VISIBLE.narrow) < 0.05);

  const padLeft = pagePadding(LANDSCAPE_INSETS).left;
  const landscape = rowTileWidth(LANDSCAPE.width, padLeft, true);
  assert.ok(Math.abs(visibleTiles(LANDSCAPE.width, padLeft, landscape) - ROW_TILES_VISIBLE.wide) < 0.05);

  // Capped on big windows (tablets): more tiles show instead of giant ones.
  assert.equal(rowTileWidth(1366, 16, true), 220);
  assert.equal(rowTileWidth(700, 16, false), 172);
  // Never collapses on tiny windows.
  assert.equal(rowTileWidth(200, 16, false), 96);
});

test('rotation round-trip recomputes identical portrait numbers (no state, no caching)', () => {
  const before = [rowTileWidth(393, 16, false), gridTileWidth(361, gridColumns(361)), gameHeroHeight(PORTRAIT, 59)];
  rowTileWidth(852, 75, true);
  gridTileWidth(702, gridColumns(702));
  gameHeroHeight(LANDSCAPE, 0);
  const after = [rowTileWidth(393, 16, false), gridTileWidth(361, gridColumns(361)), gameHeroHeight(PORTRAIT, 59)];
  assert.deepEqual(after, before);
});

test('snap interval is item width plus the row gap', () => {
  assert.equal(snapInterval(142), 142 + ROW_GAP);
  assert.equal(snapInterval(0), ROW_GAP);
});

test('achievements grid: at least 3 columns, more as the window widens, tiles fill the width', () => {
  assert.equal(gridColumns(361), 3);
  assert.equal(gridColumns(568), 4);
  assert.ok(gridColumns(702) >= 4);
  assert.ok(gridColumns(3000) <= 8);
  for (const w of [361, 568, 702, 1100]) {
    const cols = gridColumns(w);
    const tile = gridTileWidth(w, cols);
    assert.ok(tile * cols + ROW_GAP * (cols - 1) <= w);
    assert.ok(tile >= 110, `${w}: ${tile}`);
  }
});

test('game page: ≈4:3 hero below the status bar in portrait, 45 % cover column in landscape', () => {
  assert.equal(gameHeroHeight(PORTRAIT, 59), Math.round(393 * 0.75 + 59));
  assert.ok(gameHeroHeight({ width: 600, height: 700 }, 24) <= 700 * 0.6);
  assert.equal(gameCoverColumnWidth(852, LANDSCAPE_INSETS), Math.round((852 - 118) * 0.45));
  assert.equal(gameCoverColumnWidth(844, { left: 0, right: 0 }), Math.round(844 * 0.45));
});

test('column padding centres a max-width column inside the safe area', () => {
  // Portrait phone: just the gutter.
  assert.deepEqual(columnPadding(393, PORTRAIT_INSETS), { paddingLeft: 16, paddingRight: 16 });
  // Landscape phone: centred, the column is exactly the max width.
  const l = columnPadding(852, LANDSCAPE_INSETS);
  assert.equal(852 - l.paddingLeft - l.paddingRight, COLUMN_MAX_WIDTH);
  assert.equal(l.paddingLeft, l.paddingRight);
  // A large inset on one side wins over centring; the column only shrinks.
  const lopsided = columnPadding(700, { left: 100, right: 0 }, 600);
  assert.equal(lopsided.paddingLeft, 116);
  assert.ok(700 - lopsided.paddingLeft - lopsided.paddingRight <= 600);
  // Custom gutter (auth screens use 24).
  assert.deepEqual(columnPadding(393, PORTRAIT_INSETS, 560, 24), { paddingLeft: 24, paddingRight: 24 });
});

test('pageIndex rounds to the nearest page and clamps', () => {
  assert.equal(pageIndex(0, 300, 3), 0);
  assert.equal(pageIndex(160, 300, 3), 1);
  assert.equal(pageIndex(10_000, 300, 3), 2);
  assert.equal(pageIndex(-50, 300, 3), 0);
  assert.equal(pageIndex(100, 0, 3), 0);
});
