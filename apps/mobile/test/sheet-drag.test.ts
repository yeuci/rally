import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sheetDragCloses, sheetDragOffset, sheetDragStarts, sheetOverscrollCloses } from '../src/lib/sheet-drag.ts';

test('a sheet drag starts on a clear downward move, never on a tap, an upward move or a swipe across', () => {
  assert.equal(sheetDragStarts(0, 12), true);
  assert.equal(sheetDragStarts(4, 12), true);
  assert.equal(sheetDragStarts(0, 5), false, 'jitter of a tap');
  assert.equal(sheetDragStarts(0, -20), false, 'upward');
  assert.equal(sheetDragStarts(20, 15), false, 'mostly sideways');
});

test('the sheet follows the finger down and only gives a little going up', () => {
  assert.equal(sheetDragOffset(0), 0);
  assert.equal(sheetDragOffset(80), 80);
  assert.ok(sheetDragOffset(-9) < 0 && sheetDragOffset(-9) > -9);
  assert.equal(sheetDragOffset(-400), -14, 'capped');
});

test('letting go closes past the distance, or on a quick flick that moved a little', () => {
  assert.equal(sheetDragCloses(150, 0), true);
  assert.equal(sheetDragCloses(60, 0.2), false, 'slow and short: springs back');
  assert.equal(sheetDragCloses(40, 1.4), true, 'flick');
  assert.equal(sheetDragCloses(10, 2), false, 'a flick has to move the sheet first');
  assert.equal(sheetDragCloses(-30, -1), false);
});

test('scrolling content: pulling it down past its top and letting go closes the sheet', () => {
  assert.equal(sheetOverscrollCloses(-80, 0), true, 'pulled well past the top');
  assert.equal(sheetOverscrollCloses(-30, 0), false, 'a small bounce springs back');
  assert.equal(sheetOverscrollCloses(-30, -1.2), true, 'a downward flick from a small pull');
  assert.equal(sheetOverscrollCloses(-8, -2), false, 'a flick has to pull past the top first');
  assert.equal(sheetOverscrollCloses(0, -2), false, 'at the top, not past it');
  assert.equal(sheetOverscrollCloses(120, 0), false, 'scrolled down inside the content');
});
