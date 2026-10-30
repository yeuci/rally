import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPEARANCES, DEFAULTS, FRIEND_ALERT_STYLES, isAppearance, isFriendAlertStyle, parsePrefs } from '../src/lib/prefs-parse';

test('stored preferences: defaults for missing, malformed or wrongly typed values', () => {
  assert.deepEqual(parsePrefs(null), DEFAULTS);
  assert.deepEqual(parsePrefs('garbage'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"showFps":"yes"}'), DEFAULTS);
  assert.deepEqual(parsePrefs('{"showFps":true}'), { ...DEFAULTS, showFps: true });
  assert.deepEqual(DEFAULTS, {
    showFps: false,
    appearance: 'system',
    haptics: true,
    friendAlerts: 'sheet',
    friendAlertsInGame: 'banner',
  });
});

test('appearance: system / dark / light are kept, anything else falls back to system', () => {
  assert.deepEqual(APPEARANCES, ['system', 'dark', 'light']);
  for (const a of APPEARANCES) assert.equal(parsePrefs(JSON.stringify({ appearance: a })).appearance, a);
  for (const bad of ['Dark', 'auto', '', 1, null, true]) {
    assert.equal(parsePrefs(JSON.stringify({ appearance: bad })).appearance, 'system', String(bad));
    assert.equal(isAppearance(bad), false);
  }
  // A pre-Settings record (FPS only) keeps its FPS choice and follows the system.
  assert.deepEqual(parsePrefs('{"showFps":true}'), { ...DEFAULTS, showFps: true, appearance: 'system' });
});

test('haptics: on by default, a stored boolean is kept, anything else falls back to on', () => {
  assert.equal(parsePrefs(null).haptics, true);
  assert.equal(parsePrefs('{"haptics":false}').haptics, false);
  assert.equal(parsePrefs('{"haptics":true,"appearance":"light"}').haptics, true);
  for (const bad of ['no', 0, null, 'false'])
    assert.equal(parsePrefs(JSON.stringify({ haptics: bad })).haptics, true, String(bad));
  // A record written before the toggle existed keeps its other choices and has haptics on.
  assert.deepEqual(parsePrefs('{"showFps":true,"appearance":"dark"}'), {
    ...DEFAULTS,
    showFps: true,
    appearance: 'dark',
    haptics: true,
  });
});

test('friend alerts: pop-up outside games and a banner while playing by default', () => {
  assert.deepEqual(FRIEND_ALERT_STYLES, ['sheet', 'banner', 'off']);
  assert.equal(parsePrefs(null).friendAlerts, 'sheet');
  assert.equal(parsePrefs(null).friendAlertsInGame, 'banner');
});

test('friend alerts: each stored style is kept, independently for in and out of games', () => {
  for (const out of FRIEND_ALERT_STYLES) {
    for (const inGame of FRIEND_ALERT_STYLES) {
      const p = parsePrefs(JSON.stringify({ friendAlerts: out, friendAlertsInGame: inGame }));
      assert.equal(p.friendAlerts, out);
      assert.equal(p.friendAlertsInGame, inGame);
    }
  }
});

test('friend alerts: anything else falls back per field, and other choices survive', () => {
  for (const bad of ['Sheet', 'toast', 'none', '', 0, null, true, ['off']]) {
    assert.equal(isFriendAlertStyle(bad), false, String(bad));
    const p = parsePrefs(JSON.stringify({ friendAlerts: bad, friendAlertsInGame: bad }));
    assert.equal(p.friendAlerts, 'sheet', String(bad));
    assert.equal(p.friendAlertsInGame, 'banner', String(bad));
  }
  // One bad field does not reset the other.
  assert.equal(parsePrefs('{"friendAlerts":"off","friendAlertsInGame":"loud"}').friendAlerts, 'off');
  assert.equal(parsePrefs('{"friendAlerts":"loud","friendAlertsInGame":"off"}').friendAlertsInGame, 'off');
  // A record from before Notifications existed keeps its choices and gets the defaults.
  assert.deepEqual(parsePrefs('{"showFps":true,"appearance":"light","haptics":false}'), {
    showFps: true,
    appearance: 'light',
    haptics: false,
    friendAlerts: 'sheet',
    friendAlertsInGame: 'banner',
  });
});
