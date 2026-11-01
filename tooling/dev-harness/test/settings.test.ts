import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameSetting } from '@rally/protocol';
import { netBars } from '../src/menu.ts';
import {
  DEFAULT_PLATFORM,
  coerceGameValue,
  localSettingsStore,
  menuButtonRect,
  parsePlatform,
  patchPlatform,
  playerSettings,
  valuesFor,
} from '../src/settings.ts';

const DEFS: GameSetting[] = [
  { type: 'toggle', key: 'shake', label: 'Screen shake', default: true },
  { type: 'slider', key: 'zoom', label: 'Zoom', min: 0.8, max: 1.2, step: 0.1, default: 1 },
  {
    type: 'choice',
    key: 'hud',
    label: 'HUD',
    options: [
      { value: 'full', label: 'Full' },
      { value: 'min', label: 'Minimal' },
    ],
    default: 'full',
  },
];

test('platform settings: patched and parsed with every field checked and clamped', () => {
  const p = patchPlatform(DEFAULT_PLATFORM, {
    volume: { master: 2, effects: 0.5 },
    graphics: 'low',
    controls: { swapSticks: true, stickSize: 0.1 },
  });
  assert.deepEqual(p.volume, { master: 1, music: 1, effects: 0.5 });
  assert.equal(p.graphics, 'low');
  assert.deepEqual(p.controls, { swapSticks: true, stickSize: 0.75, stickOpacity: 0.8, aimAssist: true });
  assert.deepEqual(parsePlatform('nope'), DEFAULT_PLATFORM);
  assert.deepEqual(parsePlatform(JSON.stringify({ graphics: 'ultra', haptics: 'x' })), DEFAULT_PLATFORM);
});

test('game values: saved ones that still fit the definition, else defaults', () => {
  assert.deepEqual(valuesFor(DEFS, { shake: false, zoom: 1.13, hud: 'none' }), {
    shake: false,
    zoom: 1.1,
    hud: 'full',
  });
  assert.equal(coerceGameValue(DEFS[0]!, 'yes'), null);
  assert.equal(coerceGameValue(DEFS[2]!, 'min'), 'min');
});

test('player settings and the menu button rect match the shell', () => {
  assert.deepEqual(playerSettings({ ...DEFAULT_PLATFORM, graphics: 'auto' }, { shake: true }), {
    volume: { master: 1, music: 1, effects: 1 },
    graphics: 'high',
    haptics: true,
    controls: { swapSticks: false, stickSize: 1, stickOpacity: 0.8, aimAssist: true },
    game: { shake: true },
  });
  assert.deepEqual(menuButtonRect({ top: 0, left: 0 }), { x: 12, y: 12, width: 36, height: 36 });
  assert.deepEqual(menuButtonRect({ top: 47, left: 0 }), { x: 12, y: 51, width: 36, height: 36 });
});

test('the local store keeps platform settings per browser and game values per game', () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  const a = localSettingsStore('gunrun', storage);
  a.savePlatform({ ...DEFAULT_PLATFORM, graphics: 'medium' });
  a.saveGame({ shake: false });
  assert.deepEqual(a.load().game, { shake: false });
  const b = localSettingsStore('sumo', storage);
  assert.equal(b.load().platform.graphics, 'medium');
  assert.deepEqual(b.load().game, {});
  const blocked = localSettingsStore('x', null);
  blocked.saveGame({ a: 1 });
  assert.deepEqual(blocked.load().game, { a: 1 }, 'memory when storage is blocked');
});

test('ping bars like the shell', () => {
  assert.equal(netBars({ state: 'connected', rttMs: 40 }).bars, 4);
  assert.equal(netBars({ state: 'connected', rttMs: 300 }).bars, 1);
  assert.equal(netBars({ state: 'reconnecting' }).label, 'Reconnecting');
  assert.equal(netBars({ state: 'disconnected' }).bars, 0);
});
