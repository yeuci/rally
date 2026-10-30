import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPEARANCES, DEFAULTS, isAppearance, parsePrefs } from '../src/lib/prefs-parse';

test('stored preferences: defaults for missing, malformed or wrongly typed values', () => {
  assert.deepEqual(parsePrefs(null), DEFAULTS);
  assert.deepEqual(parsePrefs('garbage'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"showFps":"yes"}'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"showFps":true}'), { showFps: true, appearance: 'system', haptics: true });
  assert.deepEqual(DEFAULTS, { showFps: false, appearance: 'system', haptics: true });
});

test('appearance: system / dark / light are kept, anything else falls back to system', () => {
  assert.deepEqual(APPEARANCES, ['system', 'dark', 'light']);
  for (const a of APPEARANCES) assert.equal(parsePrefs(JSON.stringify({ appearance: a })).appearance, a);
  for (const bad of ['Dark', 'auto', '', 1, null, true]) {
    assert.equal(parsePrefs(JSON.stringify({ appearance: bad })).appearance, 'system', String(bad));
    assert.equal(isAppearance(bad), false);
  }
  // A pre-Settings record (FPS only) keeps its FPS choice and follows the system.
  assert.deepEqual(parsePrefs('{"showFps":true}'), { showFps: true, appearance: 'system', haptics: true });
});

test('haptics: on by default, a stored boolean is kept, anything else falls back to on', () => {
  assert.equal(parsePrefs(null).haptics, true);
  assert.equal(parsePrefs('{"haptics":false}').haptics, false);
  assert.equal(parsePrefs('{"haptics":true,"appearance":"light"}').haptics, true);
  for (const bad of ['no', 0, null, 'false'])
    assert.equal(parsePrefs(JSON.stringify({ haptics: bad })).haptics, true, String(bad));
  // A record written before the toggle existed keeps its other choices and has haptics on.
  assert.deepEqual(parsePrefs('{"showFps":true,"appearance":"dark"}'), {
    showFps: true,
    appearance: 'dark',
    haptics: true,
  });
});
