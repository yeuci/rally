import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameHostController, type GameHostResult } from '../src/game-host/controller';
import type { PlaySessionService } from '../src/game-host/play-session';
import { createMemoryProgressStore, type ProgressStore } from '../src/game-host/progress';
import { createMemorySaveStore } from '../src/game-host/saves';
import { BUNDLE, NONCE, clock, device, req } from './helpers';

function setup(
  opts: { readyTimeoutMs?: number; playSessions?: PlaySessionService | null; progress?: ProgressStore; onPlayRecorded?: () => void } = {},
) {
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
    progress: opts.progress ?? createMemoryProgressStore({ id: 'u1', username: 'tester' }),
    soloScores: true,
    playSessions: opts.playSessions ?? null,
    onPlayRecorded: opts.onPlayRecorded,
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
  await new Promise((r) => setTimeout(r, 120));
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

/** Fake play-session service: records every call; `start` resolves when the test says so (or rejects). */
function fakeSessions(mode: 'ok' | 'fail' | 'manual' = 'ok') {
  const calls: string[] = [];
  let release!: (id: string) => void;
  const svc: PlaySessionService = {
    start: (game) => {
      calls.push(`start ${game.id}@${game.version}`);
      if (mode === 'fail') return Promise.reject(new Error('offline'));
      if (mode === 'manual') return new Promise<string>((r) => (release = r));
      return Promise.resolve('sess-1');
    },
    end: async (id, playtimeS) => {
      calls.push(`end ${id} ${playtimeS}`);
    },
    recordPlay: async (gameId, playtimeS) => {
      calls.push(`record ${gameId} ${playtimeS}`);
    },
  };
  return { svc, calls, release: (id: string) => release(id) };
}

test('play session: started once at mount (StrictMode replay included), ended once with the playtime', async () => {
  const s = fakeSessions();
  let recorded = 0;
  const { controller, c } = setup({ playSessions: s.svc, onPlayRecorded: () => (recorded += 1) });
  assert.deepEqual(s.calls, ['start spike@0.1.0'], 'fired at start(), before the game is ready');
  controller.unmount();
  controller.start(); // StrictMode effect replay
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(25_000);
  controller.handleMessage(req('exit', { reason: 'quit' }), BUNDLE);
  await tick();
  controller.finish('forced');
  controller.unmount();
  await tick();
  assert.deepEqual(s.calls, ['start spike@0.1.0', 'end sess-1 25']);
  assert.equal(recorded, 1);
});

test('play session: a game that never became ready still closes its session (0 s)', async () => {
  const s = fakeSessions();
  const { controller } = setup({ playSessions: s.svc });
  await tick();
  controller.unmount();
  await tick();
  assert.deepEqual(s.calls, ['start spike@0.1.0', 'end sess-1 0']);
});

test('play session: falls back to record_play when the session failed to start', async () => {
  const s = fakeSessions('fail');
  let recorded = 0;
  const { controller, c } = setup({ playSessions: s.svc, onPlayRecorded: () => (recorded += 1) });
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(8_000);
  controller.finish('forced');
  await tick();
  assert.deepEqual(s.calls, ['start spike@0.1.0', 'record spike 8']);
  assert.equal(recorded, 1);

  // Never ready and no session: nothing to record.
  const none = fakeSessions('fail');
  const idle = setup({ playSessions: none.svc });
  idle.controller.finish('forced');
  await tick();
  assert.deepEqual(none.calls, ['start spike@0.1.0']);
});

test('play session: leaderboard.submit waits for a slow session start and sends its id', async () => {
  const s = fakeSessions('manual');
  const submitted: (string | null)[] = [];
  const progress: ProgressStore = {
    ...createMemoryProgressStore({ id: 'u1', username: 'tester' }),
    submitScore: async (_b, score, sessionId) => {
      submitted.push(sessionId);
      return { accepted: true, best: score };
    },
  };
  const { controller, delivered } = setup({ playSessions: s.svc, progress });
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready', 'the load did not wait for the session');
  controller.handleMessage(req('leaderboard.submit', { boardId: 'high', score: 7 }), BUNDLE);
  await tick();
  assert.deepEqual(submitted, []);
  s.release('sess-slow');
  await tick();
  assert.deepEqual(submitted, ['sess-slow']);
  assert.ok(delivered().some((e) => e.kind === 'res' && e.params?.accepted === true));
  controller.finish('forced');
  await tick();
  assert.deepEqual(s.calls.at(-1), 'end sess-slow 0');
});

test('without a play session service (Developer launcher) nothing is recorded', async () => {
  let recorded = 0;
  const { controller } = setup({ onPlayRecorded: () => (recorded += 1) });
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  controller.finish('forced');
  await tick();
  assert.equal(recorded, 0);
});

test('page diagnostics from the injected script are shown in the load-timeout error, never treated as bridge traffic', async () => {
  const warnings: string[] = [];
  const { controller } = setup({ readyTimeoutMs: 5 });
  (controller as unknown as { opts: { warn: (m: string) => void } }).opts.warn = (m) => warnings.push(m);
  controller.handleMessage('{"rallyDiag":1,"kind":"boot","message":"injected script ran (ReactNativeWebView present, https://cdn.example.com/games/spike/0.1.0/index.html)"}', BUNDLE);
  controller.handleMessage('{"rallyDiag":1,"kind":"csp","message":"script-src-elem blocked https://cdn.example.com/games/spike/0.1.0/assets/index.js"}', BUNDLE);
  await new Promise((r) => setTimeout(r, 120));
  const v = controller.getSnapshot();
  assert.equal(v.phase, 'failed');
  assert.match(v.error ?? '', /no messages from the game/);
  assert.match(v.error ?? '', /injected script ran/);
  assert.match(v.error ?? '', /csp: script-src-elem blocked/);
  assert.doesNotMatch(v.error ?? '', /dropped/);
  assert.deepEqual(warnings, ['[game csp] script-src-elem blocked https://cdn.example.com/games/spike/0.1.0/assets/index.js']);
  controller.stop();
});

test('a load timeout without the injected script having run says so', async () => {
  const { controller } = setup({ readyTimeoutMs: 5 });
  await new Promise((r) => setTimeout(r, 120));
  assert.match(controller.getSnapshot().error ?? '', /injected script did not run/);
  controller.stop();
});

test('fps reports update the view only while the overlay is on, and never land in the diagnostics', async () => {
  const { controller } = setup({ readyTimeoutMs: 5 });
  const js: string[] = [];
  controller.setWebView(() => ({ injectJavaScript: (s: string) => js.push(s) }) as never);
  controller.handleMessage('{"rallyDiag":1,"kind":"fps","message":"58"}', BUNDLE);
  assert.equal(controller.getSnapshot().fps, null);
  controller.setFpsOverlay(true);
  assert.match(js.at(-1) ?? '', /__rallyDiag\.fps\(true\)/);
  controller.handleMessage('{"rallyDiag":1,"kind":"fps","message":"58"}', BUNDLE);
  assert.equal(controller.getSnapshot().fps, 58);
  controller.setFpsOverlay(false);
  assert.equal(controller.getSnapshot().fps, null);
  await new Promise((r) => setTimeout(r, 120));
  assert.doesNotMatch(controller.getSnapshot().error ?? '', /fps/);
  controller.stop();
});

test('launch timings: entry, page start and ready are measured from start()', async () => {
  const { controller, c, exits } = setup();
  c.advance(150);
  controller.onEntryLoaded();
  c.advance(100);
  controller.onMainFrameLoadStart(BUNDLE);
  c.advance(1000);
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  controller.finish('exit');
  await tick();
  assert.equal(exits[0]?.entryMs, 150);
  assert.equal(exits[0]?.pageMs, 250);
  assert.equal(exits[0]?.readyMs, 1250);
});

test('a main-frame load outside the bundle is stopped and fails the session (Android fail-open guard)', () => {
  const { controller } = setup();
  const calls: string[] = [];
  controller.setWebView(() => ({ injectJavaScript: () => {}, stopLoading: () => calls.push('stop') }) as never);
  controller.onMainFrameLoadStart('https://phish.example.com/login');
  assert.deepEqual(calls, ['stop']);
  assert.equal(controller.getSnapshot().phase, 'failed');
  assert.match(controller.getSnapshot().error ?? '', /outside the game bundle/);
  controller.stop();
});

test('oversized diagnostics messages are ignored; a game cannot exit with the host-only reason "unmount"', async () => {
  const { controller, exits } = setup();
  controller.handleMessage(`{"rallyDiag":1,"kind":"error","message":"${'x'.repeat(5000)}"}`, BUNDLE);
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  controller.handleMessage(req('exit', { reason: 'unmount' }), BUNDLE);
  await tick();
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.reason, 'game');
});
