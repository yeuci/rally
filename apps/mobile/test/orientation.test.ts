import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellTurnFor } from '../src/game-host/orientation-model.ts';

test('after a game the shell turns back the way the player held it: landscape tablets stay landscape', () => {
  assert.equal(shellTurnFor(1), 'portrait');
  assert.equal(shellTurnFor(2), 'portrait');
  assert.equal(shellTurnFor(3), 'landscape');
  assert.equal(shellTurnFor(4), 'landscape');
  assert.equal(shellTurnFor(0), 'portrait', 'unknown: portrait');
  assert.equal(shellTurnFor(null), 'portrait');
});
