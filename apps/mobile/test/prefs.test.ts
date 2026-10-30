import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPEARANCES, DEFAULTS, isAppearance, parsePrefs } from '../src/lib/prefs-parse';

test('stored preferences: defaults for missing, malformed or wrongly typed values', () => {
  assert.deepEqual(parsePrefs(null), DEFAULTS);
  assert.deepEqual(parsePrefs('garbage'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"showFps":"yes"}'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"showFps":true}'), { showFps: true, appearance: 'system' });
  assert.deepEqual(DEFAULTS, { showFps: false, appearance: 'system' });
});

test('appearance: system / dark / light are kept, anything else falls back to system', () => {
  assert.deepEqual(APPEARANCES, ['system', 'dark', 'light']);
  for (const a of APPEARANCES) assert.equal(parsePrefs(JSON.stringify({ appearance: a })).appearance, a);
  for (const bad of ['Dark', 'auto', '', 1, null, true]) {
    assert.equal(parsePrefs(JSON.stringify({ appearance: bad })).appearance, 'system', String(bad));
    assert.equal(isAppearance(bad), false);
  }
  // A pre-Settings record (FPS only) keeps its FPS choice and follows the system.
  assert.deepEqual(parsePrefs('{"showFps":true}'), { showFps: true, appearance: 'system' });
});
