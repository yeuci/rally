import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameHostController, type GameHostResult } from '../src/game-host/controller';
import { createMemorySaveStore } from '../src/game-host/saves';
import { BUNDLE, NONCE, clock, device, req } from './helpers';

function setup(opts: { readyTimeoutMs?: number } = {}) {
  const c = clock();
  const injected: string[] = [];
  const exits: GameHostResult[] = [];
  let n = 0;
  const controller = new GameHostController({
    bundleUrl: BUNDLE,
    game: { id: 'spike', version: '0.1.0' },
    user: { id: 'u1', username: 'tester', avatarUrl: null },
    intent: 'solo',
    saves: createMemorySaveStore(),
    matchmaking: null,
    device,
    onExit: (r) => exits.push(r),
    createNonce: () => (n++ === 0 ? NONCE : 'fedcba9876543210fedcba9876543210'),
    now: c.now,
    readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
    warn: () => {},
  });
  controller.setWebView(() => ({ injectJavaScript: (js: string) => injected.push(js) }) as never);
  controller.start();
  const delivered = () => injected.map((js) => JSON.parse(JSON.parse(js.slice(js.indexOf('recv(') + 5, js.lastIndexOf(');')))));
  return { controller, c, exits, delivered };
}

const tick = () => new Promise((r) => setTimeout(r, 2));

test('ready() flips the phase and hands over the launch context with current device info', async () => {
  const { controller, delivered } = setup();
  assert.equal(controller.getSnapshot().phase, 'loading');
  assert.equal(controller.getSnapshot().nonce, NONCE);
  controller.update({ device: { ...device, orientation: 'portrait' } });
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  const res = delivered().find((e) => e.kind === 'res');
  assert.equal(res.params.user.username, 'tester');
  assert.equal(res.params.device.orientation, 'portrait');
  controller.stop();
});

test('playtime excludes background time; exit is reported once', async () => {
  const { controller, c, exits } = setup();
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(30_000);
  controller.setAppActive(false);
  c.advance(600_000);
  controller.setAppActive(true);
  c.advance(10_000);
  controller.handleMessage(req('exit', { reason: 'quit' }), BUNDLE);
  await tick();
  controller.finish('forced');
  assert.equal(exits.length, 1);
  assert.equal(exits[0]!.reason, 'quit');
  assert.equal(exits[0]!.playtimeS, 40);
  assert.equal(exits[0]!.readyMs, 0);
});

test('requestExit asks the game first, then force-exits on a second request', async () => {
  const { controller, c, exits, delivered } = setup();
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  controller.requestExit();
  assert.ok(delivered().some((e) => e.kind === 'evt' && e.method === 'exitRequested'));
  assert.equal(controller.getSnapshot().status, 'Leaving…');
  assert.equal(exits.length, 0);
  c.advance(500);
  controller.requestExit();
  assert.equal(exits[0]?.reason, 'forced');
});

test('ready timeout fails the load; reload rotates the nonce and resets state', async () => {
  const { controller } = setup({ readyTimeoutMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(controller.getSnapshot().phase, 'failed');
  assert.match(controller.getSnapshot().error ?? '', /ready\(\)/);
  controller.reload();
  const v = controller.getSnapshot();
  assert.equal(v.phase, 'loading');
  assert.equal(v.attempt, 1);
  assert.notEqual(v.nonce, NONCE);
  assert.equal(v.error, null);
  // Old nonce is no longer accepted.
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'loading');
  controller.stop();
});

test('navigation outside the bundle is blocked; crashes surface in the view', () => {
  const { controller } = setup();
  assert.equal(controller.allowNavigation('https://cdn.example.com/games/spike/0.1.0/level2.html'), true);
  assert.equal(controller.allowNavigation('https://phish.example.com/'), false);
  controller.onProcessGone('WebView render process gone');
  assert.equal(controller.getSnapshot().phase, 'crashed');
  controller.stop();
});

test('unmount without an exit finishes once as "unmount"; a StrictMode effect replay does not', async () => {
  const replay = setup();
  replay.controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  replay.controller.unmount();
  replay.controller.start(); // StrictMode: cleanup then setup on the same mounted component
  await tick();
  assert.equal(replay.exits.length, 0);
  assert.equal(replay.controller.getSnapshot().phase, 'ready');

  const { controller, c, exits } = setup();
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(12_000);
  controller.unmount();
  controller.unmount();
  await tick();
  assert.equal(exits.length, 1);
  assert.equal(exits[0]!.reason, 'unmount');
  assert.equal(exits[0]!.playtimeS, 12);
  controller.finish('forced');
  assert.equal(exits.length, 1);
});

test('unmount after a normal exit reports nothing more', async () => {
  const { controller, exits } = setup();
  controller.finish('forced');
  controller.unmount();
  await tick();
  assert.equal(exits.length, 1);
  assert.equal(exits[0]!.reason, 'forced');
});
