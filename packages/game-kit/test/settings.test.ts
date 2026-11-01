import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlayerSettings } from '@rally/protocol';
import { assistAim } from '../src/aim.ts';
import { createLifecycle } from '../src/lifecycle.ts';
import { createNetStatus } from '../src/net.ts';
import {
  bindSettings,
  effectsVolume,
  graphicsPreset,
  musicVolume,
  rememberGraphics,
  rememberedGraphics,
  stickLook,
} from '../src/settings.ts';
import { TwinStickTracker } from '../src/twinstick.ts';
import { fakeRally } from './helpers.ts';

const SETTINGS: PlayerSettings = {
  volume: { master: 0.5, music: 0.4, effects: 0.8 },
  graphics: 'medium',
  haptics: true,
  controls: { swapSticks: false, stickSize: 1, stickOpacity: 0.8, aimAssist: true },
  game: {},
};

test('graphics presets: low is lowfx without the frame cap; high is today’s quality', () => {
  assert.deepEqual(graphicsPreset('low'), {
    maxPixelRatio: 1,
    antialias: false,
    shadows: false,
    effects: false,
    clusteredLighting: false,
  });
  assert.equal(graphicsPreset('medium').maxPixelRatio, 1.5);
  assert.equal(graphicsPreset('high').maxPixelRatio, 2);
  assert.equal(graphicsPreset('bogus' as never).maxPixelRatio, 2);
});

test('the last graphics quality is remembered for the next launch’s boot-only options', () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(rememberedGraphics('high', storage), 'high');
  rememberGraphics('low', storage);
  assert.equal(rememberedGraphics('high', storage), 'low');
  m.set('rally:graphics', 'ultra');
  assert.equal(rememberedGraphics('medium', storage), 'medium');
  assert.equal(rememberedGraphics('high', null), 'high');
});

test('volumes and stick look from the settings', () => {
  assert.equal(effectsVolume(SETTINGS), 0.4);
  assert.equal(musicVolume(SETTINGS), 0.2);
  assert.deepEqual(stickLook({ stickSize: 2, stickOpacity: 0 }), { scale: 1.5, opacity: 0.2 });
  assert.deepEqual(stickLook({ stickSize: Number.NaN, stickOpacity: 0.5 }), { scale: 1, opacity: 0.5 });
});

test('bindSettings applies now, on every settingsChanged, and on refresh', () => {
  const { rally, emit } = fakeRally();
  let current = SETTINGS;
  const applied: PlayerSettings[] = [];
  const fake = {
    ...rally,
    get settings() {
      return current;
    },
  };
  const b = bindSettings(fake as never, (s) => applied.push(s));
  current = { ...SETTINGS, graphics: 'low' };
  emit('settingsChanged', current);
  b.refresh();
  assert.deepEqual(
    applied.map((s) => s.graphics),
    ['medium', 'low', 'low'],
  );
  b.off();
  emit('settingsChanged', current);
  assert.equal(applied.length, 3);
});

test('twin sticks: left-handed swaps the sides; stick size scales the travel', () => {
  const t = new TwinStickTracker({ radius: 50 });
  assert.equal(t.down(1, 100, 300, 800), 'move');
  t.up(1);
  t.configure({ swapSticks: true, stickSize: 1.5 });
  assert.equal(t.down(2, 100, 300, 800), 'aim', 'the left side aims when swapped');
  assert.equal(t.down(3, 700, 300, 800), 'move');
  assert.equal(t.radius, 75);
  t.drag(3, 775, 300);
  assert.deepEqual(t.move, { x: 1, y: 0 }, 'a full deflection at the scaled radius');
  t.configure({ swapSticks: false, stickSize: 9 });
  assert.equal(t.radius, 75, 'clamped to 1.5×');
});

test('aim assist: snaps to the best target inside the cone and range, else leaves the aim alone', () => {
  const from = { x: 0, y: 0 };
  const aim = { x: 1, y: 0 };
  const snapped = assistAim(aim, from, [{ x: 10, y: 1 }], { cone: (12 * Math.PI) / 180, range: 20 });
  assert.ok(Math.abs(snapped.x - 10 / Math.hypot(10, 1)) < 1e-9 && snapped.y > 0);
  assert.deepEqual(assistAim(aim, from, [{ x: 10, y: 5 }]), aim, 'outside the 12° cone');
  assert.deepEqual(assistAim(aim, from, [{ x: 30, y: 0 }], { range: 20 }), aim, 'out of range');
  const best = assistAim(aim, from, [
    { x: 10, y: 1.5 },
    { x: 8, y: 0.2 },
    { x: 4, y: 0.1 },
  ]);
  assert.ok(Math.abs(best.y / best.x - 0.1 / 4) < 1e-9, 'the smallest angle wins');
  assert.deepEqual(assistAim({ x: 0, y: 0 }, from, [{ x: 1, y: 0 }]), { x: 0, y: 0 });
});

test('net status: changes at once, the round-trip time every interval while connected, nothing standalone', () => {
  const sent: [string, number | undefined][] = [];
  const timers: (() => void)[] = [];
  let rtt: number | null = 48;
  const host = {
    isHosted: true,
    net: { status: (state: 'connected' | 'reconnecting' | 'disconnected', ms?: number) => void sent.push([state, ms]) },
  };
  const net = createNetStatus(host, {
    rtt: () => rtt,
    setInterval: (fn) => timers.push(fn),
    clearInterval: () => timers.splice(0),
  });
  net.set('connected');
  net.set('connected');
  rtt = 60.4;
  timers[0]!();
  net.set('reconnecting');
  assert.equal(timers.length, 0, 'no interval while reconnecting');
  net.set('disconnected');
  net.stop();
  net.set('connected');
  assert.deepEqual(sent, [
    ['connected', 48],
    ['connected', 60.4],
    ['reconnecting', undefined],
    ['disconnected', undefined],
  ]);

  const quiet: unknown[] = [];
  const standalone = createNetStatus({ isHosted: false, net: { status: () => void quiet.push(1) } }, { rtt: () => 1 });
  standalone.set('connected');
  standalone.stop();
  assert.equal(quiet.length, 0);
});

test('lifecycle: the host menu calls onMenu, and pauses a solo game while open when asked', () => {
  const { rally, emit } = fakeRally();
  const app = { timeScale: 1 };
  const seen: boolean[] = [];
  const lc = createLifecycle(rally, app, { onMenu: (open) => seen.push(open), pauseWhileMenuOpen: true });
  emit('menu', { open: true });
  assert.equal(lc.isPaused, true);
  assert.equal(app.timeScale, 0);
  emit('menu', { open: false });
  assert.equal(lc.isPaused, false);
  assert.deepEqual(seen, [true, false]);
  lc.destroy();
});
