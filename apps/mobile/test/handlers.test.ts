import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HostBridge } from '../src/game-host/bridge';
import { createHostHandlers, PROGRESS_LIMITS_PER_MINUTE, SESSION_LIMITS_PER_MINUTE, type HostHandlerDeps } from '../src/game-host/handlers';
import { isPrivateNetworkHost, mayAttachToken } from '../src/game-host/matchmake';
import {
  createMemoryProgressStore,
  mapProgressError,
  mapSubmitResult,
  mapTopRows,
  mapUnlockResult,
  unlockNeedsSession,
  type ProgressStore,
} from '../src/game-host/progress';
import { TokenBucket } from '../src/game-host/rate-limit';
import { recordPlayRefusal } from '../src/game-host/play-session';
import { createMemorySaveStore, mapSaveError } from '../src/game-host/saves';
import { BUNDLE, NONCE, Outbox, clock, launchContext, req } from './helpers';

function setup(overrides: Partial<HostHandlerDeps> = {}) {
  const out = new Outbox();
  const calls = { ready: 0, exit: [] as string[], loading: [] as number[] };
  const handlers = createHostHandlers({
    getLaunchContext: () => launchContext,
    saves: createMemorySaveStore(),
    progress: createMemoryProgressStore({ id: 'u1', username: 'tester' }),
    soloScores: true,
    getPlaySessionId: async () => 'session-1',
    matchmaking: null,
    onReady: () => (calls.ready += 1),
    onLoading: (p) => calls.loading.push(p),
    onExit: (r) => calls.exit.push(r),
    ...overrides,
  });
  const bridge = new HostBridge({ nonce: NONCE, bundleUrl: BUNDLE, deliver: out.deliver, handlers });
  const call = async (method: string, params?: unknown) => {
    const raw = req(method, params);
    bridge.handleMessage(raw, BUNDLE);
    return out.response(raw);
  };
  return { call, calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('ready returns the launch context once', async () => {
  const { call, calls } = setup();
  assert.deepEqual((await call('ready', { sdkVersion: '1.0.0' })).params, launchContext);
  assert.equal((await call('ready', { sdkVersion: '1.0.0' })).error?.code, 'ALREADY_READY');
  assert.equal(calls.ready, 1);
});

test('session.join: NOT_READY before ready, NOT_SUPPORTED without a server, matchmakes with the JWT', async () => {
  const solo = setup();
  assert.equal((await solo.call('session.join')).error?.code, 'NOT_READY');
  await solo.call('ready', { sdkVersion: '1' });
  assert.equal((await solo.call('session.join')).error?.code, 'NOT_SUPPORTED');

  let seen: { url: string; auth: string | undefined } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, auth: (init.headers as Record<string, string>).Authorization };
    return new Response(JSON.stringify({ sessionId: 's1', room: { roomId: 'r1' } }), { status: 200 });
  }) as typeof fetch;
  const multi = setup({
    matchmaking: { httpUrl: 'https://gs.example.com', wsUrl: 'wss://gs.example.com', roomName: 'arena', getAccessToken: async () => 'jwt' },
  });
  await multi.call('ready', { sdkVersion: '1' });
  const res = await multi.call('session.join');
  assert.deepEqual(res.params, { endpoint: 'wss://gs.example.com', seatReservation: { sessionId: 's1', room: { roomId: 'r1' } } });
  assert.deepEqual(seen, { url: 'https://gs.example.com/matchmake/joinOrCreate/arena', auth: 'Bearer jwt' });
});

test('session.join never sends the JWT over plain http, except to a private host in dev builds', async () => {
  const urls: string[] = [];
  let tokenReads = 0;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ sessionId: 's1' }), { status: 200 });
  }) as typeof fetch;
  const getAccessToken = async () => {
    tokenReads += 1;
    return 'jwt';
  };
  const target = (httpUrl: string, allowPrivateHttp?: boolean) => ({ httpUrl, wsUrl: 'ws://x', roomName: 'arena', getAccessToken, allowPrivateHttp });

  const prod = setup({ matchmaking: target('http://10.0.0.201:2567') });
  await prod.call('ready', { sdkVersion: '1' });
  assert.equal((await prod.call('session.join')).error?.code, 'MATCHMAKE_FAILED');
  const publicDev = setup({ matchmaking: target('http://gs.example.com:2567', true) });
  await publicDev.call('ready', { sdkVersion: '1' });
  assert.equal((await publicDev.call('session.join')).error?.code, 'MATCHMAKE_FAILED');
  assert.equal(tokenReads, 0, 'the token is not even read');
  assert.deepEqual(urls, []);

  const lan = setup({ matchmaking: target('http://10.0.0.201:2567', true) });
  await lan.call('ready', { sdkVersion: '1' });
  assert.equal((await lan.call('session.join')).error, undefined);
  assert.deepEqual(urls, ['http://10.0.0.201:2567/matchmake/joinOrCreate/arena']);

  // No token to send (Developer launcher): plain http anywhere is fine.
  const dev = setup({ matchmaking: { httpUrl: 'http://gs.example.com:2567', wsUrl: 'ws://x', roomName: 'hello' } });
  await dev.call('ready', { sdkVersion: '1' });
  assert.equal((await dev.call('session.join')).error, undefined);
});

test('mayAttachToken / isPrivateNetworkHost', () => {
  assert.equal(mayAttachToken('https://gs.example.com', false), true);
  assert.equal(mayAttachToken('wss://gs.example.com:443/x', false), true);
  assert.equal(mayAttachToken('http://gs.example.com', true), false);
  assert.equal(mayAttachToken('http://localhost:2567', false), false);
  for (const ok of ['http://localhost:2567', 'http://127.0.0.1:2567', 'http://10.0.2.2:2567', 'http://192.168.1.20', 'http://172.16.0.1', 'http://172.31.255.255:2567', 'http://[::1]:2567']) {
    assert.equal(mayAttachToken(ok, true), true, ok);
  }
  for (const bad of ['http://172.32.0.1', 'http://192.169.0.1', 'http://11.0.0.1', 'http://10.0.0.256', 'http://10.0.0.1.evil.com', 'http://user@10.0.0.1', 'https://user:pw@gs.example.com', 'ftp://10.0.0.1', '10.0.0.1:2567', '']) {
    assert.equal(mayAttachToken(bad, true), false, bad);
  }
  assert.equal(isPrivateNetworkHost('LOCALHOST'), true);
  assert.equal(isPrivateNetworkHost('localhost.example.com'), false);
});

test('session.join is single-flight and limited per minute', async () => {
  const c = clock();
  const pending: ((r: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>((r) => pending.push(r))) as typeof fetch;
  const { call } = setup({ now: c.now, matchmaking: { httpUrl: 'https://gs.example.com', wsUrl: 'wss://gs.example.com', roomName: 'arena' } });
  await call('ready', { sdkVersion: '1' });

  const inFlight = call('session.join');
  await new Promise((r) => setTimeout(r, 5));
  const second = await call('session.join');
  assert.equal(second.error?.code, 'RATE_LIMITED');
  assert.match(second.error?.message ?? '', /in progress/);
  assert.equal(pending.length, 1, 'only one matchmaking request went out');
  pending[0]!(new Response(JSON.stringify({ sessionId: 's1' }), { status: 200 }));
  assert.equal((await inFlight).error, undefined);

  // Sequential joins: the bucket allows SESSION_LIMITS_PER_MINUTE.join per minute (the first one counted).
  globalThis.fetch = (async () => new Response(JSON.stringify({ sessionId: 's' }), { status: 200 })) as typeof fetch;
  for (let i = 1; i < SESSION_LIMITS_PER_MINUTE.join; i++) assert.equal((await call('session.join')).error, undefined);
  assert.equal((await call('session.join')).error?.code, 'RATE_LIMITED');
  c.advance(60_000 / SESSION_LIMITS_PER_MINUTE.join);
  assert.equal((await call('session.join')).error, undefined);
});

test('save.get is rate limited', async () => {
  const c = clock();
  const { call } = setup({ now: c.now });
  for (let i = 0; i < SESSION_LIMITS_PER_MINUTE.saveGet; i++) assert.equal((await call('save.get', { slot: 'a' })).error, undefined);
  assert.equal((await call('save.get', { slot: 'a' })).error?.code, 'RATE_LIMITED');
});

test('save.get / save.put with optimistic concurrency', async () => {
  const { call } = setup();
  assert.deepEqual((await call('save.get', { slot: 'main' })).params, { data: null, version: 0 });
  assert.deepEqual((await call('save.put', { slot: 'main', data: { lvl: 1 } })).params, { version: 1 });
  assert.deepEqual((await call('save.put', { slot: 'main', data: { lvl: 2 }, ifVersion: 1 })).params, { version: 2 });
  assert.equal((await call('save.put', { slot: 'main', data: { lvl: 3 }, ifVersion: 1 })).error?.code, 'CONFLICT');
  assert.deepEqual((await call('save.get', { slot: 'main' })).params, { data: { lvl: 2 }, version: 2 });
});

test('save.put validates slot, presence and size', async () => {
  const { call } = setup();
  assert.equal((await call('save.put', { slot: 'bad slot!', data: 1 })).error?.code, 'INVALID_PARAMS');
  assert.equal((await call('save.get', { slot: 'a/b' })).error?.code, 'INVALID_PARAMS');
  assert.equal((await call('save.put', { slot: 'a' })).error?.code, 'INVALID_PARAMS');
  assert.equal((await call('save.put', { slot: 'a', data: 'x'.repeat(70_000) })).error?.code, 'INVALID_PARAMS');
});

test('save.put is rate limited to 10 per minute', async () => {
  const c = clock();
  const { call } = setup({ now: c.now });
  for (let i = 0; i < 10; i++) assert.equal((await call('save.put', { slot: 'a', data: i })).error, undefined);
  assert.equal((await call('save.put', { slot: 'a', data: 10 })).error?.code, 'RATE_LIMITED');
  c.advance(6_000); // one token refills every 6 s
  assert.equal((await call('save.put', { slot: 'a', data: 11 })).error, undefined);
  assert.equal((await call('save.put', { slot: 'a', data: 12 })).error?.code, 'RATE_LIMITED');
});

test('capability methods stay NOT_SUPPORTED; ui.loading, party.get, exit keep M0 behaviour', async () => {
  const { call, calls } = setup();
  assert.equal((await call('haptics', { kind: 'light' })).error?.code, 'NOT_SUPPORTED');
  assert.equal((await call('invite.open')).error?.code, 'NOT_SUPPORTED');
  assert.equal((await call('ui.loading', { progress: 0.5 })).params, null);
  assert.equal((await call('party.get')).params, null);
  assert.equal((await call('exit', { reason: 'done' })).params, null);
  assert.deepEqual(calls.loading, [0.5]);
  assert.deepEqual(calls.exit, ['done']);
});

test('TokenBucket refills continuously up to capacity', () => {
  const c = clock();
  const b = new TokenBucket(2, 1000, c.now);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  c.advance(500);
  assert.equal(b.tryTake(), true);
  c.advance(60_000);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
});

test('mapSaveError maps save_put errors to bridge codes', () => {
  assert.equal(mapSaveError({ message: 'CONFLICT: slot is at version 3', code: '40001' }).code, 'CONFLICT');
  assert.equal(mapSaveError({ message: 'INVALID: data must be JSON', code: '23514' }).code, 'INVALID_PARAMS');
  assert.equal(mapSaveError({ message: 'UNAUTHENTICATED', code: '42501' }).code, 'INTERNAL');
  assert.equal(mapSaveError({ message: 'RATE_LIMITED: save_put', code: 'P0001' }).code, 'RATE_LIMITED');
  assert.equal(mapSaveError({ message: 'INVALID: at most 8 save slots per game', code: '22023' }).code, 'INVALID_PARAMS');
});

test('resetHandshake lets a reloaded page call ready() again', async () => {
  const handlers = createHostHandlers({
    getLaunchContext: () => launchContext,
    saves: createMemorySaveStore(),
    progress: createMemoryProgressStore({ id: 'u1', username: 'tester' }),
    soloScores: true,
    getPlaySessionId: async () => null,
    matchmaking: null,
    onReady: () => {},
    onLoading: () => {},
    onExit: () => {},
  });
  await handlers.ready!({ sdkVersion: '0.1.0' });
  assert.throws(() => handlers.ready!({ sdkVersion: '0.1.0' }), /already called/);
  handlers.resetHandshake();
  assert.equal((await handlers.ready!({ sdkVersion: '0.1.0' })).game.id, launchContext.game.id);
});

/** Records what the handlers pass to the store; answers like the RPCs would. */
function recordingStore(submit: (boardId: string, score: number) => { accepted: boolean; best: number | null } = (_b, score) => ({ accepted: true, best: score })) {
  const seen = { submit: [] as [string, number, string | null][], top: [] as [string, string, number][], unlock: [] as [string, string | null][] };
  const store: ProgressStore = {
    async submitScore(boardId, score, sessionId) {
      seen.submit.push([boardId, score, sessionId]);
      return submit(boardId, score);
    },
    async top(boardId, scope, limit) {
      seen.top.push([boardId, scope, limit]);
      return { entries: [{ rank: 1, userId: 'u1', username: 'tester', score: 42 }] };
    },
    async unlockAchievement(key, sessionId) {
      seen.unlock.push([key, sessionId]);
      return { unlocked: true, alreadyHad: false };
    },
  };
  return { store, seen };
}

test('leaderboard.submit passes the play session id, awaiting a start still in flight', async () => {
  const { store, seen } = recordingStore((_b, score) => ({ accepted: score > 10, best: score > 10 ? score : 10 }));
  let resolveSession!: (id: string | null) => void;
  const session = new Promise<string | null>((r) => (resolveSession = r));
  const { call } = setup({ progress: store, getPlaySessionId: () => session });
  const pending = call('leaderboard.submit', { boardId: 'high', score: 25 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.submit.length, 0, 'waits for the session');
  resolveSession('sess-42');
  assert.deepEqual((await pending).params, { accepted: true, best: 25 });
  assert.deepEqual((await call('leaderboard.submit', { boardId: 'high', score: 3 })).params, { accepted: false, best: 10 });
  assert.deepEqual(seen.submit, [
    ['high', 25, 'sess-42'],
    ['high', 3, 'sess-42'],
  ]);
});

test('leaderboard.submit is NOT_SUPPORTED for multiplayer games and validates params', async () => {
  const { store, seen } = recordingStore();
  const multi = setup({ progress: store, soloScores: false });
  const res = await multi.call('leaderboard.submit', { boardId: 'high', score: 1 });
  assert.equal(res.error?.code, 'NOT_SUPPORTED');
  assert.equal(seen.submit.length, 0);
  // Multiplayer games may still read boards and unlock achievements.
  assert.equal((await multi.call('leaderboard.top', { boardId: 'high' })).error, undefined);
  assert.deepEqual((await multi.call('achievement.unlock', { key: 'first-win' })).params, { unlocked: true, alreadyHad: false });

  const solo = setup({ progress: store });
  assert.equal((await solo.call('leaderboard.submit', { boardId: '', score: 1 })).error?.code, 'INVALID_PARAMS');
  assert.equal((await solo.call('leaderboard.submit', { boardId: 'b'.repeat(200), score: 1 })).error?.code, 'INVALID_PARAMS');
  assert.equal((await solo.call('leaderboard.submit', { boardId: 'high', score: 'x' })).error?.code, 'INVALID_PARAMS');
  assert.equal((await solo.call('achievement.unlock', { key: '' })).error?.code, 'INVALID_PARAMS');
});

test('leaderboard.top defaults scope/limit and maps entries; achievement.unlock passes the key', async () => {
  const { store, seen } = recordingStore();
  const { call } = setup({ progress: store });
  assert.deepEqual((await call('leaderboard.top', { boardId: 'high' })).params, {
    entries: [{ rank: 1, userId: 'u1', username: 'tester', score: 42 }],
  });
  await call('leaderboard.top', { boardId: 'high', scope: 'friends', limit: 5 });
  assert.deepEqual(seen.top, [
    ['high', 'global', 25],
    ['high', 'friends', 5],
  ]);
  await call('achievement.unlock', { key: 'first-win' });
  assert.deepEqual(seen.unlock, [['first-win', 'session-1']]);
});

test('progress methods are rate limited per method (submit 30, top 60, unlock 60 per minute)', async () => {
  const c = clock();
  const { store } = recordingStore();
  const { call } = setup({ progress: store, now: c.now });
  for (let i = 0; i < PROGRESS_LIMITS_PER_MINUTE.submit; i++) {
    assert.equal((await call('leaderboard.submit', { boardId: 'b', score: i })).error, undefined);
  }
  assert.equal((await call('leaderboard.submit', { boardId: 'b', score: 99 })).error?.code, 'RATE_LIMITED');
  // Separate buckets: reads and unlocks are unaffected by the exhausted submit bucket.
  for (let i = 0; i < PROGRESS_LIMITS_PER_MINUTE.top; i++) assert.equal((await call('leaderboard.top', { boardId: 'b' })).error, undefined);
  assert.equal((await call('leaderboard.top', { boardId: 'b' })).error?.code, 'RATE_LIMITED');
  for (let i = 0; i < PROGRESS_LIMITS_PER_MINUTE.unlock; i++) assert.equal((await call('achievement.unlock', { key: `k${i}` })).error, undefined);
  assert.equal((await call('achievement.unlock', { key: 'k' })).error?.code, 'RATE_LIMITED');
  c.advance(2_000); // submit refills one token every 2 s
  assert.equal((await call('leaderboard.submit', { boardId: 'b', score: 100 })).error, undefined);
  assert.equal((await call('leaderboard.submit', { boardId: 'b', score: 101 })).error?.code, 'RATE_LIMITED');
});

test('store errors reach the game with their bridge code', async () => {
  const failing: ProgressStore = {
    submitScore: async () => {
      throw mapProgressError({ message: 'RATE_LIMITED: too many scores' });
    },
    top: async () => {
      throw mapProgressError({ message: 'NOT_FOUND: leaderboard nope', code: 'P0002' });
    },
    unlockAchievement: async () => {
      throw mapProgressError({ message: 'ANONYMOUS_FORBIDDEN: link an account first', code: '42501' });
    },
  };
  const { call } = setup({ progress: failing });
  assert.equal((await call('leaderboard.submit', { boardId: 'b', score: 1 })).error?.code, 'RATE_LIMITED');
  assert.equal((await call('leaderboard.top', { boardId: 'nope' })).error?.code, 'INTERNAL');
  const anon = await call('achievement.unlock', { key: 'k' });
  assert.equal(anon.error?.code, 'NOT_SUPPORTED');
  assert.match(anon.error?.message ?? '', /link an account/);
});

test('RPC result mapping: submit (accepted=false keeps best, null best), top rows, unlock', () => {
  assert.deepEqual(mapSubmitResult({ accepted: true, best: 120, rank: 3, reason: null }), { accepted: true, best: 120 });
  assert.deepEqual(mapSubmitResult({ accepted: false, best: 150, rank: 2, reason: 'not_best' }), { accepted: false, best: 150 });
  assert.deepEqual(mapSubmitResult({ accepted: false, best: null, rank: null, reason: 'bounds' }), { accepted: false, best: null });
  assert.deepEqual(mapSubmitResult({ accepted: false, reason: 'rate_limited' }), { accepted: false, best: null });
  assert.deepEqual(mapSubmitResult(null), { accepted: false, best: null });
  assert.deepEqual(mapSubmitResult({ accepted: true, best: '42.5' }), { accepted: true, best: 42.5 });

  assert.deepEqual(
    mapTopRows([
      { rank: 1, user_id: 'a', username: 'ann', score: 300, avatar_url: 'x', is_me: false } as never,
      { rank: '2', user_id: 'b', username: 'bob', score: '250' },
      { rank: 0, user_id: 'c', username: 'bad', score: 1 },
    ]),
    {
      entries: [
        { rank: 1, userId: 'a', username: 'ann', score: 300 },
        { rank: 2, userId: 'b', username: 'bob', score: 250 },
      ],
    },
  );
  assert.deepEqual(mapTopRows(null), { entries: [] });

  assert.deepEqual(mapUnlockResult({ unlocked: true, alreadyHad: true }), { unlocked: true, alreadyHad: true });
  assert.deepEqual(mapUnlockResult({}), { unlocked: false, alreadyHad: false });
});

test('mapProgressError: RATE_LIMITED, INVALID → INVALID_PARAMS, ANONYMOUS_FORBIDDEN → NOT_SUPPORTED, everything else INTERNAL', () => {
  assert.equal(mapProgressError({ message: 'RATE_LIMITED: slow down' }).code, 'RATE_LIMITED');
  const anon = mapProgressError({ message: 'ANONYMOUS_FORBIDDEN: link an account first', code: '42501' });
  assert.equal(anon.code, 'NOT_SUPPORTED');
  assert.equal(anon.message, 'ANONYMOUS_FORBIDDEN: link an account first');
  assert.equal(mapProgressError({ message: 'INVALID: score must be a finite number >= 0', code: '22023' }).code, 'INVALID_PARAMS');
  assert.equal(mapProgressError({ message: 'NOT_FOUND: no play session', code: 'P0002' }).code, 'INTERNAL');
  assert.equal(mapProgressError({ message: 'UNAUTHENTICATED', code: '42501' }).code, 'INTERNAL');
});

test('memory progress store (Developer launcher) keeps the best score and unlocks once', async () => {
  const store = createMemoryProgressStore({ id: 'dev-user', username: 'dev-user' });
  assert.deepEqual(await store.top('b', 'global', 10), { entries: [] });
  assert.deepEqual(await store.submitScore('b', 10, null), { accepted: true, best: 10 });
  assert.deepEqual(await store.submitScore('b', 5, null), { accepted: false, best: 10 });
  assert.deepEqual(await store.top('b', 'global', 10), { entries: [{ rank: 1, userId: 'dev-user', username: 'dev-user', score: 10 }] });
  assert.deepEqual(await store.unlockAchievement('k', null), { unlocked: true, alreadyHad: false });
  assert.deepEqual(await store.unlockAchievement('k', null), { unlocked: true, alreadyHad: true });
});

test('achievement.unlock waits for the play session start and passes its id; without one the store says NOT_SUPPORTED', async () => {
  const { store, seen } = recordingStore();
  let resolveSession!: (id: string | null) => void;
  const session = new Promise<string | null>((r) => (resolveSession = r));
  const { call } = setup({ progress: store, getPlaySessionId: () => session });
  const pending = call('achievement.unlock', { key: 'first-win' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen.unlock, [], 'waits for the session');
  resolveSession('sess-7');
  assert.deepEqual((await pending).params, { unlocked: true, alreadyHad: false });
  assert.deepEqual(seen.unlock, [['first-win', 'sess-7']]);

  // The Supabase store's answer when the session could not be started.
  const noSession: ProgressStore = {
    ...store,
    unlockAchievement: async (_key, sessionId) => {
      if (!sessionId) throw unlockNeedsSession();
      return { unlocked: true, alreadyHad: false };
    },
  };
  const offline = setup({ progress: noSession, getPlaySessionId: async () => null });
  const res = await offline.call('achievement.unlock', { key: 'k' });
  assert.equal(res.error?.code, 'NOT_SUPPORTED');
  assert.match(res.error?.message ?? '', /no play session/);
});

test('recordPlayRefusal: the refusals record_play answers by design', () => {
  assert.equal(recordPlayRefusal('CONFLICT: a play session is open for this game, end it with end_play_session'), 'conflict');
  assert.equal(recordPlayRefusal('RATE_LIMITED: too many plays recorded for this game, try again later'), 'rate-limited');
  assert.equal(recordPlayRefusal('NOT_FOUND: game'), 'not-found');
  assert.equal(recordPlayRefusal('Network request failed'), null);
  assert.equal(recordPlayRefusal('the CONFLICT word later'), null);
});
