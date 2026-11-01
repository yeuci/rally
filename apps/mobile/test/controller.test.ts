import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameHostController, type GameHostResult } from '../src/game-host/controller';
import type { PlaySessionService } from '../src/game-host/play-session';
import { createMemoryProgressStore, type ProgressStore } from '../src/game-host/progress';
import { createMemorySaveStore } from '../src/game-host/saves';
import { BUNDLE, NONCE, clock, device, req } from './helpers';

function setup(
  opts: {
    readyTimeoutMs?: number;
    revealTimeoutMs?: number;
    leaveGraceMs?: number;
    playSessions?: PlaySessionService | null;
    progress?: ProgressStore;
    onPlayRecorded?: () => void;
    title?: string | null;
    pageBytes?: number | null;
  } = {},
) {
  const c = clock();
  const injected: string[] = [];
  const exits: GameHostResult[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  let n = 0;
  const controller = new GameHostController({
    bundleUrl: BUNDLE,
    game: { id: 'spike', version: '0.1.0' },
    title: opts.title ?? null,
    pageBytes: opts.pageBytes ?? null,
    revealTimeoutMs: opts.revealTimeoutMs,
    leaveGraceMs: opts.leaveGraceMs,
    log: (m) => logs.push(m),
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
    warn: (m) => warnings.push(m),
  });
  controller.setWebView(() => ({ injectJavaScript: (js: string) => injected.push(js) }) as never);
  controller.start();
  const delivered = () =>
    injected.map((js) => JSON.parse(JSON.parse(js.slice(js.indexOf('recv(') + 5, js.lastIndexOf(');')))));
  return { controller, c, exits, delivered, warnings, logs };
}

const SECOND_NONCE = 'fedcba9876543210fedcba9876543210';
/** The game's `ui.loading` (optionally labelled) and `ready()` over the bridge, as a page would send them. */
const loading = (progress: number, label?: string, nonce = NONCE) =>
  req('ui.loading', label === undefined ? { progress } : { progress, label }, nonce);
const ready = (nonce = NONCE) => req('ready', { sdkVersion: '1' }, nonce);

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
    checkpoint: (id, playtimeS, played) => {
      calls.push(`checkpoint ${id} ${playtimeS} ${played}`);
    },
    abandon: async (id) => {
      calls.push(`abandon ${id}`);
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
  assert.deepEqual(s.calls, ['start spike@0.1.0', 'checkpoint sess-1 0 true', 'end sess-1 25']);
  assert.equal(recorded, 1);
});

test('play session: a launch that never became ready records no play (abandoned, not ended)', async () => {
  const s = fakeSessions();
  let recorded = 0;
  const { controller, exits } = setup({ playSessions: s.svc, onPlayRecorded: () => (recorded += 1) });
  await tick();
  controller.setAppActive(false); // backgrounded while loading: journaled as not played
  controller.setAppActive(true);
  await tick();
  controller.unmount();
  await tick();
  assert.deepEqual(s.calls, ['start spike@0.1.0', 'checkpoint sess-1 0 false', 'abandon sess-1']);
  assert.equal(exits[0]?.played, false);
  assert.equal(recorded, 0);
});

test('play session: checkpoints carry the playtime when the app goes to the background', async () => {
  const s = fakeSessions();
  const { controller, c } = setup({ playSessions: s.svc });
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(42_000);
  controller.setAppActive(false);
  await tick();
  assert.equal(s.calls.at(-1), 'checkpoint sess-1 42 true');
  c.advance(3_600_000); // killed in the background: this is what the next launch closes the session with
  controller.finish('forced');
  await tick();
  assert.equal(s.calls.at(-1), 'end sess-1 42');
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
  // (`record_play` is only for a game that became ready.)
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
  controller.handleMessage(
    '{"rallyDiag":1,"kind":"boot","message":"injected script ran (ReactNativeWebView present, https://cdn.example.com/games/spike/0.1.0/index.html)"}',
    BUNDLE,
  );
  controller.handleMessage(
    '{"rallyDiag":1,"kind":"csp","message":"script-src-elem blocked https://cdn.example.com/games/spike/0.1.0/assets/index.js"}',
    BUNDLE,
  );
  await new Promise((r) => setTimeout(r, 120));
  const v = controller.getSnapshot();
  assert.equal(v.phase, 'failed');
  assert.match(v.error ?? '', /no messages from the game/);
  assert.match(v.error ?? '', /injected script ran/);
  assert.match(v.error ?? '', /csp: script-src-elem blocked/);
  assert.doesNotMatch(v.error ?? '', /dropped/);
  assert.deepEqual(warnings, [
    '[game csp] script-src-elem blocked https://cdn.example.com/games/spike/0.1.0/assets/index.js',
  ]);
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

test('playtime survives an in-page reload and an overlay reload of the same session', async () => {
  const s = fakeSessions();
  const { controller, c, exits } = setup({ playSessions: s.svc });
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(30_000);
  controller.onMainFrameLoadStart(BUNDLE); // location.reload(): the page loads again and calls ready() again
  c.advance(2_000); // reloading does not count
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  c.advance(10_000);
  controller.onProcessGone('WebView render process gone');
  c.advance(5_000); // on the crash overlay
  controller.reload();
  c.advance(1_000);
  controller.handleMessage(req('ready', { sdkVersion: '1' }, 'fedcba9876543210fedcba9876543210'), BUNDLE); // new nonce
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  c.advance(4_000);
  controller.finish('forced');
  await tick();
  assert.equal(exits[0]?.playtimeS, 44);
  assert.equal(exits[0]?.played, true);
  assert.equal(exits[0]?.readyMs, 1_000, 'launch timing is per attempt');
  assert.equal(s.calls.at(-1), 'end sess-1 44');

  // Crashed after playing, then Back without reloading: still a play, with the time before the crash.
  const t = setup();
  t.controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  t.c.advance(7_000);
  t.controller.onProcessGone('gone');
  t.c.advance(9_000);
  t.controller.finish('crashed');
  assert.equal(t.exits[0]?.playtimeS, 7);
  assert.equal(t.exits[0]?.played, true);
});

test('a background stretch while loading is not subtracted from the playtime after ready()', async () => {
  const { controller, c, exits } = setup();
  controller.setAppActive(false);
  c.advance(60_000);
  controller.setAppActive(true);
  controller.handleMessage(req('ready', { sdkVersion: '1' }), BUNDLE);
  await tick();
  c.advance(20_000);
  controller.finish('forced');
  assert.equal(exits[0]?.playtimeS, 20);
});

test('reload() starts the load diagnostics over', async () => {
  const { controller } = setup({ readyTimeoutMs: 5 });
  controller.handleMessage('{"rallyDiag":1,"kind":"csp","message":"script-src blocked old.js"}', BUNDLE);
  controller.handleMessage(req('ping', { t: 1 }), BUNDLE);
  controller.handleMessage(req('ready', { sdkVersion: '1' }, 'bad-nonce'.padEnd(32, '0')), BUNDLE);
  await new Promise((r) => setTimeout(r, 120));
  assert.match(controller.getSnapshot().error ?? '', /old\.js/);
  assert.match(controller.getSnapshot().error ?? '', /1 dropped/);
  controller.reload();
  await new Promise((r) => setTimeout(r, 120));
  const err = controller.getSnapshot().error ?? '';
  assert.equal(controller.getSnapshot().phase, 'failed');
  assert.match(err, /no messages from the game/);
  assert.doesNotMatch(err, /old\.js|dropped|ping/);
  controller.stop();
});

test('page diagnostics are only accepted from the bundle directory while the session is live', async () => {
  const warnings: string[] = [];
  const { controller } = setup({ readyTimeoutMs: 5 });
  (controller as unknown as { opts: { warn: (m: string) => void } }).opts.warn = (m) => warnings.push(m);
  controller.handleMessage(
    '{"rallyDiag":1,"kind":"error","message":"from an ad iframe"}',
    'https://ads.example.com/frame.html',
  );
  controller.handleMessage('{"rallyDiag":1,"kind":"error","message":"no url"}', undefined);
  for (let i = 0; i < 30; i++) controller.handleMessage(`{"rallyDiag":1,"kind":"error","message":"spam ${i}"}`, BUNDLE);
  await new Promise((r) => setTimeout(r, 120));
  const err = controller.getSnapshot().error ?? '';
  assert.doesNotMatch(err, /ad iframe|no url/);
  assert.match(err, /spam 11/);
  assert.doesNotMatch(err, /spam 12/);
  assert.equal(warnings.length, 12, 'only what is kept is logged');
  controller.finish('forced');
  controller.handleMessage('{"rallyDiag":1,"kind":"error","message":"after exit"}', BUNDLE);
  assert.equal(warnings.length, 12);
});

// --- the loading screen and the hold contract --------------------------------------------------------------------

test('a game that never sends a label is revealed at ready(), exactly as before', async () => {
  const { controller } = setup();
  controller.handleMessage(loading(0.5), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'loading');
  assert.equal(controller.getSnapshot().label, null);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.equal(controller.getSnapshot().progress, 1);
  controller.handleMessage(loading(1), BUNDLE); // the old games' loading(1) after ready() changes nothing
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  controller.stop();
});

test('a labelled game stays behind the loading screen after ready() until progress 1, while already live', async () => {
  const s = fakeSessions();
  const { controller, c, exits, logs } = setup({ playSessions: s.svc, readyTimeoutMs: 20, title: 'Gun Run' });
  controller.handleMessage(loading(0.2, 'Downloading characters'), BUNDLE);
  await tick();
  let v = controller.getSnapshot();
  assert.equal(v.stage, 'game');
  assert.equal(v.status, 'Downloading characters');
  assert.match(v.detail ?? '', /^\d+%$/);
  c.advance(1_000);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  v = controller.getSnapshot();
  assert.equal(v.phase, 'loading', 'held: the loading screen stays up');
  // The ready timeout is cleared exactly as before: waiting past it does not fail the held game.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(controller.getSnapshot().phase, 'loading');
  // Live from ready(): playtime runs and the session is checkpointed when the app goes to the background.
  c.advance(3_000);
  controller.setAppActive(false);
  controller.setAppActive(true);
  await tick();
  assert.ok(
    s.calls.some((call) => call === 'checkpoint sess-1 3 true'),
    s.calls.join(', '),
  );
  controller.handleMessage(loading(0.85, 'Joining the match'), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().status, 'Joining the match');
  assert.equal(controller.getSnapshot().phase, 'loading');
  c.advance(2_000);
  controller.handleMessage(loading(1, 'Joining the match'), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.ok(
    logs.some((l) => /playable in 6000 ms \(5000 ms after ready\)/.test(l)),
    logs.join('\n'),
  );
  c.advance(4_000);
  controller.finish('forced');
  await tick();
  assert.equal(exits[0]?.playtimeS, 9, 'playtime counts from ready(), not from the reveal');
  assert.equal(exits[0]?.readyMs, 1_000);
  assert.equal(exits[0]?.played, true);
});

test('progress 1 before ready() reveals at ready(); progress without a label keeps the last label', async () => {
  const { controller } = setup();
  controller.handleMessage(loading(0.4, 'Building the tower'), BUNDLE);
  controller.handleMessage(loading(0.6), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().status, 'Building the tower');
  controller.handleMessage(loading(1, 'Starting'), BUNDLE);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  controller.stop();
});

test('safety reveal: a labelled game that never sends progress 1 is shown after the reveal timeout, and it is logged', async () => {
  const { controller, warnings } = setup({ revealTimeoutMs: 30 });
  controller.handleMessage(loading(0.5, 'Connecting to the server'), BUNDLE);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'loading');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.ok(
    warnings.some((w) => /spike@0\.1\.0 sent loading labels but no ui\.loading progress 1/.test(w)),
    warnings.join('\n'),
  );
  controller.stop();
});

test('the reveal timer stops with the session and is re-armed by start() (StrictMode replay)', async () => {
  const { controller } = setup({ revealTimeoutMs: 30 });
  controller.handleMessage(loading(0.5, 'Finding players'), BUNDLE);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  controller.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(controller.getSnapshot().phase, 'loading', 'no reveal while stopped');
  controller.start();
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(controller.getSnapshot().phase, 'ready');
  controller.stop();
});

test('Leave before ready() closes at once; during the hold the game may leave its room, then it is closed', async () => {
  const early = setup({ leaveGraceMs: 20 });
  early.controller.requestExit();
  assert.equal(early.exits[0]?.reason, 'forced');

  const held = setup({ leaveGraceMs: 20 });
  held.controller.handleMessage(loading(0.7, 'Joining the match'), BUNDLE);
  held.controller.handleMessage(ready(), BUNDLE);
  await tick();
  held.controller.requestExit();
  assert.ok(held.delivered().some((e) => e.kind === 'evt' && e.method === 'exitRequested'));
  assert.equal(held.controller.getSnapshot().status, 'Leaving…');
  assert.equal(held.exits.length, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(held.exits[0]?.reason, 'forced');
  assert.equal(held.exits[0]?.played, true);

  // A game that leaves within the grace exits with its own reason, once.
  const quick = setup({ leaveGraceMs: 40 });
  quick.controller.handleMessage(loading(0.7, 'Joining the match'), BUNDLE);
  quick.controller.handleMessage(ready(), BUNDLE);
  await tick();
  quick.controller.requestExit();
  quick.controller.handleMessage(req('exit', { reason: 'host' }), BUNDLE);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(quick.exits.length, 1);
  assert.equal(quick.exits[0]?.reason, 'host');
});

test('reload() starts the hold over: after a held, crashed attempt, one without labels is revealed at ready()', async () => {
  const { controller } = setup();
  controller.handleMessage(loading(0.5, 'Downloading characters'), BUNDLE);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'loading');
  controller.onProcessGone('WebView render process gone');
  assert.equal(controller.getSnapshot().phase, 'crashed');
  controller.reload();
  let v = controller.getSnapshot();
  assert.equal(v.phase, 'loading');
  assert.equal(v.attempt, 1);
  assert.equal(v.stage, 'entry');
  assert.equal(v.label, null);
  assert.equal(v.progress, 0);
  controller.handleMessage(ready(SECOND_NONCE), BUNDLE);
  await tick();
  v = controller.getSnapshot();
  assert.equal(v.phase, 'ready', 'the new attempt sent no label: revealed at ready()');
  controller.stop();
});

test('a new document starts the hold over (an in-page reload while held, and after the reveal)', async () => {
  const { controller } = setup();
  controller.handleMessage(loading(0.5, 'Finding players'), BUNDLE);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  controller.onMainFrameLoadStart(BUNDLE); // location.reload() during the hold
  let v = controller.getSnapshot();
  assert.equal(v.phase, 'loading');
  assert.equal(v.stage, 'page');
  assert.equal(v.label, null);
  assert.equal(v.progress, 0, 'a new load starts the bar over');
  controller.handleMessage(ready(), BUNDLE); // this page sends no labels
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');

  controller.onMainFrameLoadStart(BUNDLE); // and once more, labelled this time
  controller.handleMessage(loading(0.3, 'Downloading characters'), BUNDLE);
  controller.handleMessage(ready(), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'loading');
  controller.handleMessage(loading(1, 'Joining the match'), BUNDLE);
  await tick();
  assert.equal(controller.getSnapshot().phase, 'ready');
  controller.stop();
});

test('loading screen words: entry bytes, the page download in MB, then the game labels; the bar never goes back', async () => {
  const { controller } = setup({ title: 'Gun Run', pageBytes: 3_400_000 });
  let v = controller.getSnapshot();
  assert.equal(v.status, 'Getting Gun Run ready…');
  assert.equal(v.detail, null);
  controller.onEntryProgress(1_000, 4_000);
  v = controller.getSnapshot();
  assert.equal(v.detail, '1 of 4 KB');
  assert.ok(v.progress > 0 && v.progress < 0.05);
  controller.onEntryLoaded();
  v = controller.getSnapshot();
  assert.equal(v.stage, 'page');
  assert.equal(v.status, 'Downloading game files');
  assert.equal(v.detail, '0 of 3.4 MB');
  controller.onMainFrameLoadStart(BUNDLE);
  controller.onLoadProgress(0.5);
  v = controller.getSnapshot();
  assert.equal(v.detail, '1.7 of 3.4 MB');
  const pageProgress = v.progress;
  controller.handleMessage(loading(0, 'Starting the game'), BUNDLE);
  await tick();
  v = controller.getSnapshot();
  assert.equal(v.status, 'Starting the game');
  assert.ok(v.progress >= pageProgress);
  controller.handleMessage(loading(0.5, 'Downloading characters'), BUNDLE);
  await tick();
  const mid = controller.getSnapshot().progress;
  controller.onLoadProgress(1); // late WebView progress after the game took over: no going back, no page words
  controller.handleMessage(loading(0.2, 'Downloading characters'), BUNDLE);
  await tick();
  v = controller.getSnapshot();
  assert.equal(v.progress, mid);
  assert.equal(v.status, 'Downloading characters');
  assert.equal(v.detail, `${Math.floor(mid * 100)}%`);
  controller.stop();
});

test('without a title or a known download size the words stay generic', () => {
  const { controller } = setup();
  assert.equal(controller.getSnapshot().status, 'Getting the game ready…');
  controller.onEntryLoaded();
  controller.onLoadProgress(0.5);
  const v = controller.getSnapshot();
  assert.equal(v.status, 'Downloading game files');
  assert.match(v.detail ?? '', /^\d+%$/);
  controller.stop();
});
