import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameSetting } from '@rally/protocol';
import { createMemoryStorage } from '../src/game-host/rejoin-journal';
import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTINGS_KEY,
  autoGraphics,
  coerceGameValue,
  createGameSettingsStore,
  gameSettingsKey,
  menuButtonRect,
  netBars,
  parseGameValues,
  parsePlatformSettings,
  patchPlatform,
  playerSettings,
  valuesFor,
} from '../src/game-host/settings';

const DEFS: GameSetting[] = [
  { type: 'toggle', key: 'aimAssist', label: 'Aim assist', default: true },
  { type: 'slider', key: 'sensitivity', label: 'Stick sensitivity', min: 0.5, max: 2, step: 0.25, default: 1 },
  {
    type: 'choice',
    key: 'camera',
    label: 'Camera',
    options: [
      { value: 'near', label: 'Near' },
      { value: 'far', label: 'Far' },
    ],
    default: 'near',
  },
];

test('platform settings: stored JSON parsed defensively; missing or malformed fields fall back', () => {
  assert.deepEqual(parsePlatformSettings(null), DEFAULT_PLATFORM_SETTINGS);
  assert.deepEqual(parsePlatformSettings('not json'), DEFAULT_PLATFORM_SETTINGS);
  assert.deepEqual(
    parsePlatformSettings(
      JSON.stringify({
        volume: { master: 0.5, music: 7, effects: 'x' },
        graphics: 'ultra',
        haptics: false,
        controls: { swapSticks: true, stickSize: 9, stickOpacity: 0.05, aimAssist: 'no' },
      }),
    ),
    {
      volume: { master: 0.5, music: 1, effects: 1 },
      graphics: 'auto',
      haptics: false,
      controls: { swapSticks: true, stickSize: 1.5, stickOpacity: 0.2, aimAssist: true },
    },
  );
  assert.equal(parsePlatformSettings(JSON.stringify({ graphics: 'low' })).graphics, 'low');
  assert.deepEqual(
    parsePlatformSettings(JSON.stringify({ graphics: 'low' })).controls,
    DEFAULT_PLATFORM_SETTINGS.controls,
    'settings saved before controls existed get the defaults',
  );
});

test('connection bars: by round-trip time, then reconnecting and offline', () => {
  assert.deepEqual(netBars({ state: 'connected', rttMs: 48 }), { bars: 4, tone: 'good', label: '48 ms' });
  assert.deepEqual(netBars({ state: 'connected', rttMs: 120 }), { bars: 3, tone: 'good', label: '120 ms' });
  assert.deepEqual(netBars({ state: 'connected', rttMs: 200 }), { bars: 2, tone: 'fair', label: '200 ms' });
  assert.deepEqual(netBars({ state: 'connected', rttMs: 640.4 }), { bars: 1, tone: 'poor', label: '640 ms' });
  assert.deepEqual(netBars({ state: 'connected' }), { bars: 4, tone: 'good', label: 'Connected' });
  assert.deepEqual(netBars({ state: 'reconnecting', rttMs: 30 }), { bars: 1, tone: 'fair', label: 'Reconnecting' });
  assert.deepEqual(netBars({ state: 'disconnected' }), { bars: 0, tone: 'offline', label: 'Offline' });
});

test('game values: only primitives survive; each is checked against its definition when used', () => {
  assert.deepEqual(parseGameValues(JSON.stringify({ a: 1, b: 'x', c: true, d: { no: 1 }, e: null })), {
    a: 1,
    b: 'x',
    c: true,
  });
  assert.deepEqual(parseGameValues('[1,2]'), {});
  assert.equal(coerceGameValue(DEFS[0]!, 'yes'), null);
  assert.equal(coerceGameValue(DEFS[1]!, 1.3), 1.25, 'slider snaps to its step');
  assert.equal(coerceGameValue(DEFS[1]!, 9), 2, 'and stays in range');
  assert.equal(coerceGameValue(DEFS[2]!, 'far'), 'far');
  assert.equal(coerceGameValue(DEFS[2]!, 'top'), null);
  assert.deepEqual(valuesFor(DEFS, { aimAssist: false, sensitivity: 'fast', camera: 'top', stale: 1 }), {
    aimAssist: false,
    sensitivity: 1,
    camera: 'near',
  });
});

test('Auto graphics: recent iPhones high, older iOS and Android medium, very old systems low', () => {
  assert.equal(autoGraphics({ os: 'ios', version: '17.4', pixelRatio: 3 }), 'high');
  assert.equal(autoGraphics({ os: 'ios', version: '16.0', pixelRatio: 3 }), 'medium');
  assert.equal(autoGraphics({ os: 'ios', version: '14.8', pixelRatio: 2 }), 'low');
  assert.equal(autoGraphics({ os: 'android', version: 34, pixelRatio: 2.75 }), 'medium');
  assert.equal(autoGraphics({ os: 'android', version: 28, pixelRatio: 2 }), 'low');
  assert.equal(autoGraphics({ os: 'web', version: '', pixelRatio: 1 }), 'high');
});

test('player settings: Auto resolved, volumes patched and clamped', () => {
  const p = patchPlatform(DEFAULT_PLATFORM_SETTINGS, {
    volume: { music: 0.25, effects: -1 },
    haptics: false,
    controls: { swapSticks: true, stickSize: 0.5 },
  });
  const controls = { swapSticks: true, stickSize: 0.75, stickOpacity: 0.8, aimAssist: true };
  assert.deepEqual(p, { volume: { master: 1, music: 0.25, effects: 0 }, graphics: 'auto', haptics: false, controls });
  assert.deepEqual(playerSettings(p, { camera: 'far' }, 'medium'), {
    volume: { master: 1, music: 0.25, effects: 0 },
    graphics: 'medium',
    haptics: false,
    controls,
    game: { camera: 'far' },
  });
  assert.equal(playerSettings({ ...p, graphics: 'low' }, {}, 'high').graphics, 'low');
  assert.equal(patchPlatform(p, { graphics: 'bogus' as never }).graphics, 'auto');
});

test('menu button: top-left inside the safe area, never closer than 12 pt to the edge', () => {
  assert.deepEqual(menuButtonRect({ top: 47, left: 0 }), { x: 12, y: 51, width: 40, height: 40 });
  assert.deepEqual(menuButtonRect({ top: 0, left: 47 }), { x: 51, y: 12, width: 40, height: 40 });
});

test('store: platform settings once per device, game values per game id', async () => {
  const storage = createMemoryStorage();
  const store = createGameSettingsStore(storage);
  assert.deepEqual(await store.load('gunrun'), { platform: DEFAULT_PLATFORM_SETTINGS, game: {} });
  await store.savePlatform({ ...DEFAULT_PLATFORM_SETTINGS, graphics: 'low' });
  await store.saveGame('gunrun', { aimAssist: false });
  assert.deepEqual(await store.load('gunrun'), {
    platform: { ...DEFAULT_PLATFORM_SETTINGS, graphics: 'low' },
    game: { aimAssist: false },
  });
  assert.deepEqual((await store.load('sumo')).game, {}, 'another game keeps its own');
  assert.equal((await store.load('sumo')).platform.graphics, 'low', 'platform settings are shared');
  assert.ok(await storage.getItem(PLATFORM_SETTINGS_KEY));
  assert.ok(await storage.getItem(gameSettingsKey('gunrun')));

  const broken = createGameSettingsStore({
    getItem: async () => {
      throw new Error('disk');
    },
    setItem: async () => {
      throw new Error('disk');
    },
    removeItem: async () => {},
  });
  assert.deepEqual(await broken.load('x'), { platform: DEFAULT_PLATFORM_SETTINGS, game: {} });
  await broken.saveGame('x', { a: 1 });
});
