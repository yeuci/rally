import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComboDisplay, formatScore } from '../src/combo.ts';

test('the combo shows from x2, pops when it climbs, colours by level, drains with the window', () => {
  const c = new ComboDisplay();
  assert.equal(c.update(1, 0).visible, false);
  const x2 = c.update(2, 100);
  assert.deepEqual(x2, { visible: true, text: 'x2', left: 1, level: 0, pop: true });
  assert.equal(c.update(2, 40).pop, false, 'same multiplier: no pop');
  assert.equal(c.update(2, 40).left, 0.4);
  assert.deepEqual(
    [4, 6, 8].map((m) => c.update(m, 90)).map((v) => [v.text, v.level, v.pop]),
    [
      ['x4', 1, true],
      ['x6', 2, true],
      ['x8', 3, true],
    ],
  );
  assert.equal(c.update(12, 90).text, 'x8', 'capped');
  assert.equal(c.update(1, 0).visible, false, 'lapsed');
  assert.equal(c.update(3, 100).pop, true, 'a new chain pops again');
});

test('scores get thin-space thousands separators', () => {
  assert.equal(formatScore(0), '0');
  assert.equal(formatScore(950), '950');
  assert.equal(formatScore(12340), '12 340');
  assert.equal(formatScore(1234567.8), '1 234 567');
});
