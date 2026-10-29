import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HostBridge } from '../src/game-host/bridge';
import { createHostHandlers, type HostHandlerDeps } from '../src/game-host/handlers';
import { TokenBucket } from '../src/game-host/rate-limit';
import { createMemorySaveStore, mapSaveError } from '../src/game-host/saves';
import { BUNDLE, NONCE, Outbox, clock, launchContext, req } from './helpers';

function setup(overrides: Partial<HostHandlerDeps> = {}) {
  const out = new Outbox();
  const calls = { ready: 0, exit: [] as string[], loading: [] as number[] };
  const handlers = createHostHandlers({
    getLaunchContext: () => launchContext,
    saves: createMemorySaveStore(),
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
    matchmaking: { httpUrl: 'http://gs.local:2567', wsUrl: 'ws://gs.local:2567', roomName: 'arena', getAccessToken: async () => 'jwt' },
  });
  await multi.call('ready', { sdkVersion: '1' });
  const res = await multi.call('session.join');
  assert.deepEqual(res.params, { endpoint: 'ws://gs.local:2567', seatReservation: { sessionId: 's1', room: { roomId: 'r1' } } });
  assert.deepEqual(seen, { url: 'http://gs.local:2567/matchmake/joinOrCreate/arena', auth: 'Bearer jwt' });
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

test('M2 methods stay NOT_SUPPORTED; ui.loading, party.get, exit keep M0 behaviour', async () => {
  const { call, calls } = setup();
  assert.equal((await call('leaderboard.submit', { boardId: 'b', score: 1 })).error?.code, 'NOT_SUPPORTED');
  assert.equal((await call('achievement.unlock', { key: 'k' })).error?.code, 'NOT_SUPPORTED');
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
});
