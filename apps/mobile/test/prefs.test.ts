import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrefs } from '../src/lib/prefs-parse';

test('stored preferences: defaults for missing, malformed or wrongly typed values', () => {
  assert.deepEqual(parsePrefs(null), { showFps: false });
  assert.deepEqual(parsePrefs('garbage'), { showFps: false });
  assert.deepEqual(parsePrefs('{"showFps":"yes"}'), { showFps: false });
  assert.deepEqual(parsePrefs('{"showFps":true}'), { showFps: true });
});
