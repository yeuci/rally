import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insetsFromProbe } from '../src/lib/viewport-model.ts';

test('insets from the probe: each side is the gap around the safe content box', () => {
  // iPhone 14, portrait: 47 top, 34 bottom.
  const portrait = insetsFromProbe({ x: 0, y: 0, width: 390, height: 844 }, { x: 0, y: 47, width: 390, height: 763 });
  assert.deepEqual(portrait, { top: 47, left: 0, right: 0, bottom: 34 });
  // Landscape: 47 on both sides, 21 at the bottom, none on top.
  const landscape = insetsFromProbe({ x: 0, y: 0, width: 844, height: 390 }, { x: 47, y: 0, width: 750, height: 369 });
  assert.deepEqual(landscape, { top: 0, left: 47, right: 47, bottom: 21 });
  // Rounded to the half point, never negative.
  assert.deepEqual(
    insetsFromProbe({ x: 0, y: 0, width: 100, height: 100 }, { x: 0.26, y: 0, width: 100.4, height: 100 }),
    {
      top: 0,
      left: 0.5,
      right: 0,
      bottom: 0,
    },
  );
});
