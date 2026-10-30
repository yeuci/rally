import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { LaunchContext } from '@rally/protocol';
import { HostBridge } from '../src/game-host/bridge';
import { GameHostController } from '../src/game-host/controller';
import {
  MATCH_ENDED_EXIT,
  createHostHandlers,
  createJoinState,
  reservationCode,
  reservationRoomId,
  type HostHandlerDeps,
  type MatchmakingTarget,
} from '../src/game-host/handlers';
import { RoomLookupError, clearServerVersionCache, listRooms, matchmake, roomByCode, serverVersion } from '../src/game-host/matchmake';
import { createMemoryProgressStore } from '../src/game-host/progress';
import {
  REJOIN_GRACE_S,
  createMemoryStorage,
  createRejoinJournal,
  rejoinKey,
  rejoinSecondsLeft,
  splitReconnectionToken,
  type RejoinJournal,
} from '../src/game-host/rejoin-journal';
import { createMemorySaveStore } from '../src/game-host/saves';
import type { KeyValueStorage } from '../src/game-host/session-journal';
import {
  cleanRoomName,
  intentFor,
  joinTargetParams,
  normalizeJoinCode,
  parseFriendJoinTarget,
  parseJoinTarget,
  targetForCode,
  type JoinTarget,
} from '../src/lib/join-target';
import { BUNDLE, NONCE, Outbox, clock, device, launchContext, req } from './helpers';

// --- fetch fake -----------------------------------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Route = (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Every request is recorded; `routes` answers by `METHOD path` prefix (first match), else 404. */
function fakeFetch(routes: Record<string, Route>) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(url).pathname;
    for (const [key, route] of Object.entries(routes)) {
      const [m, prefix] = key.split(' ') as [string, string];
      if (m === call.method && path.startsWith(prefix)) return route(call);
    }
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
}
const seat = (roomId: string, extra: Record<string, unknown> = {}) => json({ name: 'arena', roomId, sessionId: 's-' + roomId, processId: 'p', ...extra });
/** A server where every matchmaking call lands in room `r1` (joinOrCreate, joinById, reconnect). */
const okServer = (overrides: Record<string, Route> = {}) =>
  fakeFetch({
    'POST /matchmake/joinOrCreate/': () => seat('r1'),
    'POST /matchmake/joinById/': (c) => seat(c.url.split('/').pop()!),
    'POST /matchmake/reconnect/': (c) => seat(c.url.split('/').pop()!),
    ...overrides,
  });
const paths = () => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

beforeEach(() => {
  calls = [];
  clearServerVersionCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- handler harness ------------------------------------------------------------------------------------------------

const HTTP = 'https://gs.example.com';
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

function target(join: JoinTarget, extra: Partial<MatchmakingTarget> = {}): MatchmakingTarget {
  return { httpUrl: HTTP, wsUrl: 'wss://gs.example.com', roomName: 'arena', join, ...extra };
}

function setup(mm: MatchmakingTarget, overrides: Partial<HostHandlerDeps> = {}) {
  const out = new Outbox();
  const exits: string[] = [];
  const handlers = createHostHandlers({
    getLaunchContext: () => launchContext,
    saves: createMemorySaveStore(),
    progress: createMemoryProgressStore({ id: 'u1', username: 'tester' }),
    soloScores: false,
    getPlaySessionId: async () => null,
    matchmaking: mm,
    onReady: () => {},
    onLoading: () => {},
    onExit: (r) => exits.push(r),
    ...overrides,
  });
  const bridge = new HostBridge({ nonce: NONCE, bundleUrl: BUNDLE, deliver: out.deliver, handlers });
  const call = async (method: string, params?: unknown) => {
    const raw = req(method, params);
    bridge.handleMessage(raw, BUNDLE);
    return out.response(raw);
  };
  return { call, exits, handlers };
}

/** A journal over memory storage with a manual clock, plus the raw storage to inspect. */
function journal(c = clock()) {
  const storage = createMemoryStorage();
  return { storage, j: createRejoinJournal(storage, 'u1', c.now), c };
}

// --- lib/join-target.ts ---------------------------------------------------------------------------------------------

test('parseJoinTarget: quick by default, each kind, first array value, malformed → null', () => {
  assert.deepEqual(parseJoinTarget({}), { join: 'quick' });
  assert.deepEqual(parseJoinTarget({ join: '' }), { join: 'quick' });
  assert.deepEqual(parseJoinTarget({ join: 'create' }), { join: 'create' });
  assert.deepEqual(parseJoinTarget({ join: 'create', name: '  Friday \n night <b>  ' }), { join: 'create', name: 'Friday night b' });
  assert.deepEqual(parseJoinTarget({ join: 'room', room: 'aB3_x-9' }), { join: 'room', room: 'aB3_x-9' });
  assert.deepEqual(parseJoinTarget({ join: 'room', room: 'r1', code: 'k7m-2pq' }), { join: 'room', room: 'r1', code: 'K7M2PQ' });
  assert.deepEqual(parseJoinTarget({ join: ['room', 'quick'], room: ['r1'] }), { join: 'room', room: 'r1' });
  const uuid = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
  assert.deepEqual(parseJoinTarget({ join: 'friend', friend: uuid }), { join: 'friend', friend: uuid.toLowerCase() });
  assert.deepEqual(parseJoinTarget({ join: 'resume' }), { join: 'resume' });

  assert.equal(parseJoinTarget({ join: 'party' }), null);
  assert.equal(parseJoinTarget({ join: 'room' }), null, 'room needs an id');
  assert.equal(parseJoinTarget({ join: 'room', room: '../versions' }), null);
  assert.equal(parseJoinTarget({ join: 'room', room: 'r1', code: 'O0O0O0' }), null, 'O and 0 are not in the alphabet');
  assert.equal(parseJoinTarget({ join: 'friend', friend: 'bob' }), null);
});

test('joinTargetParams round-trips through parseJoinTarget; intents per kind', () => {
  const targets: JoinTarget[] = [
    { join: 'quick' },
    { join: 'create' },
    { join: 'create', name: 'Dojo' },
    { join: 'room', room: 'r1' },
    { join: 'room', room: 'r1', code: 'K7M2PQ' },
    { join: 'friend', friend: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
    { join: 'resume' },
  ];
  for (const t of targets) assert.deepEqual(parseJoinTarget(joinTargetParams(t)), t);
  assert.deepEqual(
    (['quick', 'create', 'room', 'friend'] as const).map(intentFor),
    ['quick', 'private', 'joinById', 'joinById'],
  );
});

test('join codes and room names are normalised like the game server does', () => {
  assert.equal(normalizeJoinCode(' k7m 2pq '), 'K7M2PQ');
  assert.equal(normalizeJoinCode('K7M-2PQ'), 'K7M2PQ');
  assert.equal(normalizeJoinCode('K7M2P'), null);
  assert.equal(normalizeJoinCode('K7M2PI'), null);
  assert.equal(normalizeJoinCode(42), null);
  assert.equal(cleanRoomName('   '), undefined);
  assert.equal(cleanRoomName('x'.repeat(30)), 'x'.repeat(20));
});

test('parseFriendJoinTarget reads friend_join_target and refuses junk', () => {
  assert.deepEqual(parseFriendJoinTarget({ game_id: 'sumo', room_id: 'r9', code: 'k7m2pq' }), { gameId: 'sumo', roomId: 'r9', code: 'K7M2PQ' });
  assert.deepEqual(parseFriendJoinTarget({ game_id: 'sumo', room_id: 'r9', code: null }), { gameId: 'sumo', roomId: 'r9' });
  assert.equal(parseFriendJoinTarget({ game_id: 'sumo', room_id: 'r/9' }), null);
  assert.equal(parseFriendJoinTarget({ game_id: 'sumo', room_id: 'r9', code: 'nope' }), null);
  assert.equal(parseFriendJoinTarget(null), null);
});

test('targetForCode: bad codes make no request, another game is refused, else join=room with the code', async () => {
  const looked: string[] = [];
  const lookup = async (code: string) => {
    looked.push(code);
    return { roomId: 'priv1', roomName: code === 'AAAAAA' ? 'hello' : 'sumo' };
  };
  assert.deepEqual(await targetForCode('K7M', 'sumo', lookup), { ok: false, reason: 'bad-code' });
  assert.deepEqual(looked, []);
  assert.deepEqual(await targetForCode('aaa-aaa', 'sumo', lookup), { ok: false, reason: 'other-game' });
  assert.deepEqual(await targetForCode('k7m-2pq', 'sumo', lookup), { ok: true, target: { join: 'room', room: 'priv1', code: 'K7M2PQ' } });
  assert.deepEqual(looked, ['AAAAAA', 'K7M2PQ']);
});

// --- matchmake.ts lookups -------------------------------------------------------------------------------------------

test('listRooms / roomByCode: parse the server answers; 404 → NO_ROOM, 429 → RATE_LIMITED', async () => {
  fakeFetch({
    'GET /rooms/code/K7M2PQ': () => json({ roomName: 'sumo', roomId: 'priv1', clients: 2, maxClients: 8, locked: false, metadata: { private: true } }),
    'GET /rooms/code/ZZZZZZ': () => json({ error: 'slow down' }, 429),
    'GET /rooms/sumo': () =>
      json({ rooms: [{ roomId: 'a', clients: 3, maxClients: 8, locked: false, metadata: { name: 'A', phase: 'lobby' } }, { junk: true }] }),
  });
  assert.deepEqual(await listRooms(HTTP, 'sumo'), [
    { roomId: 'a', clients: 3, maxClients: 8, locked: false, metadata: { name: 'A', phase: 'lobby' } },
  ]);
  await assert.rejects(listRooms(HTTP, 'nope'), (e: unknown) => e instanceof RoomLookupError && e.code === 'NO_ROOM');
  assert.deepEqual(await roomByCode(HTTP, 'K7M2PQ'), {
    roomName: 'sumo',
    roomId: 'priv1',
    clients: 2,
    maxClients: 8,
    locked: false,
    metadata: { private: true },
  });
  await assert.rejects(roomByCode(HTTP, 'AAAAAA'), (e: unknown) => e instanceof RoomLookupError && e.code === 'NO_ROOM');
  await assert.rejects(roomByCode(HTTP, 'ZZZZZZ'), (e: unknown) => e instanceof RoomLookupError && e.code === 'RATE_LIMITED');
  globalThis.fetch = (async () => {
    throw new TypeError('Network request failed');
  }) as typeof fetch;
  await assert.rejects(listRooms(HTTP, 'sumo'), (e: unknown) => e instanceof RoomLookupError && e.code === 'UNREACHABLE');
});

test('serverVersion is cached for 60 s; matchmaking 429 → RATE_LIMITED', async () => {
  let version = 1;
  fakeFetch({
    'GET /versions': () => json({ serverVersion: version, rooms: ['sumo'] }),
    'POST /matchmake/': () => json({ error: 'too many rooms created' }, 429),
  });
  const c = clock();
  assert.equal(await serverVersion(HTTP, { now: c.now }), 1);
  version = 2;
  c.advance(59_000);
  assert.equal(await serverVersion(HTTP, { now: c.now }), 1);
  c.advance(2_000);
  assert.equal(await serverVersion(HTTP, { now: c.now }), 2);
  assert.equal(calls.length, 2);
  await assert.rejects(matchmake(HTTP, 'create', 'sumo'), { code: 'RATE_LIMITED' });
});

// --- session.join: target → calls -----------------------------------------------------------------------------------

test('session.join: each target makes the designed matchmaking call, without username/avatar in the body', async () => {
  const cases: [JoinTarget, string, unknown][] = [
    [{ join: 'quick' }, 'POST /matchmake/joinOrCreate/arena', {}],
    [{ join: 'create' }, 'POST /matchmake/joinOrCreate/arena', { private: true }],
    [{ join: 'create', name: 'Dojo' }, 'POST /matchmake/joinOrCreate/arena', { private: true, name: 'Dojo' }],
    [{ join: 'room', room: 'pub1' }, 'POST /matchmake/joinById/pub1', {}],
    [{ join: 'room', room: 'priv1', code: 'K7M2PQ' }, 'POST /matchmake/joinById/priv1', { code: 'K7M2PQ' }],
  ];
  for (const [join, path, body] of cases) {
    calls = [];
    okServer();
    const { call } = setup(target(join));
    await call('ready', { sdkVersion: '1' });
    const res = await call('session.join');
    assert.equal(res.error, undefined, JSON.stringify(join));
    assert.equal(paths()[0], path);
    assert.deepEqual(calls[0]!.body, body);
  }
});

test('session.join friend: resolved once through friend_join_target, then sticky as room + code', async () => {
  okServer();
  const resolved: string[] = [];
  const joined: unknown[] = [];
  const { call } = setup(
    target(
      { join: 'friend', friend: 'f-1' },
      {
        resolveFriend: async (id) => {
          resolved.push(id);
          return { gameId: 'spike', roomId: 'priv7', code: 'K7M2PQ' };
        },
        onJoined: (info) => joined.push(info),
      },
    ),
  );
  await call('ready', { sdkVersion: '1' });
  assert.equal((await call('session.join')).error, undefined);
  assert.equal((await call('session.join')).error, undefined);
  assert.deepEqual(resolved, ['f-1']);
  assert.deepEqual(paths(), ['POST /matchmake/joinById/priv7', 'POST /matchmake/joinById/priv7']);
  assert.deepEqual(calls[1]!.body, { code: 'K7M2PQ' });
  // The code the friend's room was joined with rides along (the play route's "Room code · Share" pill).
  assert.deepEqual(joined, [
    { roomId: 'priv7', gameId: 'spike', code: 'K7M2PQ' },
    { roomId: 'priv7', gameId: 'spike', code: 'K7M2PQ' },
  ]);

  // A friend in another game, or not joinable: refused before any matchmaking.
  calls = [];
  const other = setup(target({ join: 'friend', friend: 'f-2' }, { resolveFriend: async () => ({ gameId: 'sumo', roomId: 'x' }) }));
  await other.call('ready', { sdkVersion: '1' });
  assert.equal((await other.call('session.join')).error?.code, 'MATCHMAKE_FAILED');
  const gone = setup(target({ join: 'friend', friend: 'f-3' }, { resolveFriend: async () => Promise.reject(new Error('NOT_FOUND')) }));
  await gone.call('ready', { sdkVersion: '1' });
  assert.equal((await gone.call('session.join')).error?.code, 'MATCHMAKE_FAILED');
  assert.deepEqual(calls, []);
});

test('session.join is sticky: a second join repeats quick / create', async () => {
  okServer();
  for (const join of [{ join: 'quick' }, { join: 'create' }] as JoinTarget[]) {
    calls = [];
    const { call } = setup(target(join));
    await call('ready', { sdkVersion: '1' });
    await call('session.join');
    await call('session.join');
    assert.deepEqual(paths(), ['POST /matchmake/joinOrCreate/arena', 'POST /matchmake/joinOrCreate/arena']);
    assert.deepEqual(calls[0]!.body, calls[1]!.body);
  }
});

test('reservationCode reads a private room code defensively (code, metadata.code, room.metadata.code)', () => {
  assert.equal(reservationCode({ code: 'k7m-2pq' }), 'K7M2PQ');
  assert.equal(reservationCode({ metadata: { code: 'K7M2PQ' } }), 'K7M2PQ');
  assert.equal(reservationCode({ room: { roomId: 'r', metadata: { code: 'abc 234' } } }), 'ABC234');
  // Colyseus 0.16+ reservations carry no metadata; junk is never shown as a code.
  assert.equal(reservationCode({ name: 'arena', roomId: 'r', sessionId: 's', processId: 'p' }), null);
  assert.equal(reservationCode({ code: 'O0I1L1' }), null);
  assert.equal(reservationCode({ code: 42, metadata: null, room: 'x' }), null);
});

test('onJoined: create surfaces the code from the reservation; quick play and code-less reservations carry none', async () => {
  okServer({ 'POST /matchmake/joinOrCreate/': (c) => seat('priv9', (c.body as { private?: boolean }).private ? { metadata: { code: 'Q7M2PK' } } : {}) });
  const joined: { roomId: string | null; gameId: string; code?: string }[] = [];
  const create = setup(target({ join: 'create' }, { onJoined: (info) => joined.push(info) }));
  await create.call('ready', { sdkVersion: '1' });
  assert.equal((await create.call('session.join')).error, undefined);
  const quick = setup(target({ join: 'quick' }, { onJoined: (info) => joined.push(info) }));
  await quick.call('ready', { sdkVersion: '1' });
  assert.equal((await quick.call('session.join')).error, undefined);
  assert.deepEqual(joined, [
    { roomId: 'priv9', gameId: 'spike', code: 'Q7M2PK' },
    { roomId: 'priv9', gameId: 'spike' },
  ]);
  // Today's server (Colyseus 0.18 reservations without metadata): a created room has no code to show.
  calls = [];
  okServer();
  const plainJoined: unknown[] = [];
  const plain = setup(target({ join: 'create' }, { onJoined: (info) => plainJoined.push(info) }));
  await plain.call('ready', { sdkVersion: '1' });
  assert.equal((await plain.call('session.join')).error, undefined);
  assert.deepEqual(plainJoined, [{ roomId: 'r1', gameId: 'spike' }]);
});

test('reservationRoomId reads roomId defensively', () => {
  assert.equal(reservationRoomId({ roomId: 'a' }), 'a');
  assert.equal(reservationRoomId({ room: { roomId: 'b' } }), 'b');
  assert.equal(reservationRoomId({ roomId: 7, room: null }), null);
  assert.equal(reservationRoomId({}), null);
});

// --- resume ---------------------------------------------------------------------------------------------------------

test('resume: reconnect/<roomId> with the token split on its first ":", used once, then room with the same id and code', async () => {
  okServer();
  const { j } = journal();
  await j.save({ gameId: 'spike', roomId: 'priv1', token: 'priv1:tok:with:colons', code: 'K7M2PQ', join: 'friend', ttlSec: 60 });
  const ctx: LaunchContext = { ...launchContext, intent: 'joinById', resume: { reconnectionToken: 'priv1:tok:with:colons' } };
  const { call, handlers } = setup(target({ join: 'resume' }, { rejoin: j }), { getLaunchContext: () => ctx });

  const first = await call('ready', { sdkVersion: '1' });
  assert.deepEqual((first.params as LaunchContext).resume, { reconnectionToken: 'priv1:tok:with:colons' });
  const res = await call('session.join');
  assert.equal(paths()[0], 'POST /matchmake/reconnect/priv1');
  assert.deepEqual(calls[0]!.body, { reconnectionToken: 'tok:with:colons' });
  // consumeSeatReservation forwards reconnectionToken: the host adds it to the reservation.
  assert.equal((res.params as { seatReservation: Record<string, unknown> }).seatReservation.reconnectionToken, 'tok:with:colons');

  // After a reload the launch context no longer carries `resume`, and with no report since, the next join is the
  // room by id with its code (not another reconnect).
  handlers.resetHandshake();
  const again = (await call('ready', { sdkVersion: '1' })).params as LaunchContext;
  assert.equal(again.resume, undefined);
  assert.equal(again.intent, 'joinById');
  assert.equal((await call('session.join')).error, undefined);
  assert.equal(paths()[1], 'POST /matchmake/joinById/priv1');
  assert.deepEqual(calls[1]!.body, { code: 'K7M2PQ' });
});

test('resume: a failed reconnect or a missing record says the match ended, clears the record and exits', async () => {
  fakeFetch({ 'POST /matchmake/reconnect/': () => json({ error: 'reconnection token invalid or expired.' }, 400) });
  const { j, storage } = journal();
  await j.save({ gameId: 'spike', roomId: 'r1', token: 'r1:t', join: 'quick', ttlSec: 60 });
  const failed = setup(target({ join: 'resume' }, { rejoin: j }));
  await failed.call('ready', { sdkVersion: '1' });
  const res = await failed.call('session.join');
  assert.equal(res.error?.code, 'MATCHMAKE_FAILED');
  assert.match(res.error!.message, /match has ended/);
  await tick();
  assert.deepEqual(failed.exits, [MATCH_ENDED_EXIT]);
  assert.equal(await storage.getItem(rejoinKey('u1')), null);
  assert.deepEqual(paths(), ['POST /matchmake/reconnect/r1'], 'no silent quick play');

  calls = [];
  const none = setup(target({ join: 'resume' }, { rejoin: j }));
  await none.call('ready', { sdkVersion: '1' });
  assert.equal((await none.call('session.join')).error?.code, 'MATCHMAKE_FAILED');
  await tick();
  assert.deepEqual(none.exits, [MATCH_ENDED_EXIT]);
  assert.deepEqual(calls, []);

  // A record for another game is not this game's match.
  await j.save({ gameId: 'sumo', roomId: 'r2', token: 'r2:t', join: 'quick', ttlSec: 60 });
  const other = setup(target({ join: 'resume' }, { rejoin: j }));
  await other.call('ready', { sdkVersion: '1' });
  assert.equal((await other.call('session.join')).error?.code, 'MATCHMAKE_FAILED');
  assert.deepEqual(calls, []);
});

// --- reportReconnection ---------------------------------------------------------------------------------------------

test('reportReconnection is journaled only for the joined room, with the code, origin and a TTL clamped to 60 s', async () => {
  okServer();
  const { j, storage, c } = journal();
  const { call } = setup(target({ join: 'room', room: 'priv1', code: 'K7M2PQ' }, { rejoin: j }), { now: c.now });
  await call('ready', { sdkVersion: '1' });

  // Before any join: nothing to check against.
  assert.equal((await call('session.reportReconnection', { roomId: 'priv1', token: 'priv1:t0', ttlSec: 30 })).error, undefined);
  assert.equal(await storage.getItem(rejoinKey('u1')), null);

  await call('session.join');
  // Another room, a token for another room, a token without the roomId prefix: ignored.
  await call('session.reportReconnection', { roomId: 'evil', token: 'evil:t', ttlSec: 30 });
  await call('session.reportReconnection', { roomId: 'priv1', token: 'evil:t', ttlSec: 30 });
  await call('session.reportReconnection', { roomId: 'priv1', token: 'bare-token', ttlSec: 30 });
  assert.equal(await j.get(), null);

  await call('session.reportReconnection', { roomId: 'priv1', token: 'priv1:t1', ttlSec: 600 });
  assert.deepEqual(await j.get(), {
    gameId: 'spike',
    roomId: 'priv1',
    token: 'priv1:t1',
    code: 'K7M2PQ',
    join: 'room',
    ttlSec: REJOIN_GRACE_S,
    expiresAt: c.now() + REJOIN_GRACE_S * 1000,
  });
});

test('an in-session reload reconnects with the reported token first, else falls back to the sticky target', async () => {
  let reconnectOk = true;
  okServer({
    'POST /matchmake/reconnect/': (call) => (reconnectOk ? seat(call.url.split('/').pop()!) : json({ error: 'expired' }, 400)),
  });
  const { j } = journal();
  const { call, handlers } = setup(target({ join: 'quick' }, { rejoin: j }));
  await call('ready', { sdkVersion: '1' });
  await call('session.join');
  await call('session.reportReconnection', { roomId: 'r1', token: 'r1:t1', ttlSec: 60 });

  handlers.resetHandshake(); // the page reloaded
  await call('ready', { sdkVersion: '1' });
  await call('session.join');
  reconnectOk = false;
  await call('session.join');
  await call('session.join');
  assert.deepEqual(paths(), [
    'POST /matchmake/joinOrCreate/arena',
    'POST /matchmake/reconnect/r1',
    'POST /matchmake/reconnect/r1',
    'POST /matchmake/joinOrCreate/arena', // the failed reconnect dropped the report
    'POST /matchmake/joinOrCreate/arena',
  ]);
  assert.deepEqual(calls[1]!.body, { reconnectionToken: 't1' });
});

test('joining another room and a consented exit clear the record; background re-stamps it', async () => {
  okServer({ 'POST /matchmake/joinOrCreate/': () => seat('r2') });
  const { j, c } = journal();
  await j.save({ gameId: 'sumo', roomId: 'old', token: 'old:t', join: 'quick', ttlSec: 60 });
  const { call, handlers } = setup(target({ join: 'quick' }, { rejoin: j }), { now: c.now });
  await call('ready', { sdkVersion: '1' });
  await call('session.join');
  assert.equal(await j.get(), null, 'joined r2: the old match is given up');

  await call('session.reportReconnection', { roomId: 'r2', token: 'r2:t', ttlSec: 45 });
  c.advance(30_000);
  handlers.background();
  assert.equal((await j.get())?.expiresAt, c.now() + 45_000);

  await call('exit', {});
  assert.equal(await j.get(), null);
});

test('the controller keeps the join state across an overlay reload and re-stamps on background', async () => {
  okServer();
  const c = clock();
  const { j } = journal(c);
  const injected: string[] = [];
  let n = 0;
  const controller = new GameHostController({
    bundleUrl: BUNDLE,
    game: { id: 'spike', version: '0.1.0' },
    user: { id: 'u1', username: 'tester', avatarUrl: null },
    intent: 'joinById',
    saves: createMemorySaveStore(),
    progress: createMemoryProgressStore({ id: 'u1', username: 'tester' }),
    soloScores: false,
    playSessions: null,
    matchmaking: target({ join: 'friend', friend: 'f-1' }, { rejoin: j, resolveFriend: async () => ({ gameId: 'spike', roomId: 'p1' }) }),
    device,
    onExit: () => {},
    createNonce: () => (n++ === 0 ? NONCE : 'fedcba9876543210fedcba9876543210'),
    now: c.now,
    readyTimeoutMs: 60_000,
    warn: () => {},
  });
  controller.setWebView(() => ({ injectJavaScript: (js: string) => injected.push(js) }) as never);
  controller.start();
  const send = async (method: string, params?: unknown, nonce = NONCE) => {
    controller.handleMessage(req(method, params, nonce), BUNDLE);
    await tick(5);
  };
  await send('ready', { sdkVersion: '1' });
  await send('session.join');
  await send('session.reportReconnection', { roomId: 'p1', token: 'p1:t', ttlSec: 60 });
  c.advance(20_000);
  controller.setAppActive(false);
  await tick();
  assert.equal((await j.get())?.expiresAt, c.now() + 60_000);

  controller.reload(); // new bridge, new handlers: the friend was resolved already, the report still counts
  const nonce2 = 'fedcba9876543210fedcba9876543210';
  await send('ready', { sdkVersion: '1' }, nonce2);
  await send('session.join', undefined, nonce2);
  assert.deepEqual(paths(), ['POST /matchmake/joinById/p1', 'POST /matchmake/reconnect/p1']);
  controller.stop();
});

test('createJoinState: resume starts with a placeholder origin', () => {
  assert.equal(createJoinState().target.join, 'quick');
  assert.equal(createJoinState({ join: 'resume' }).origin, 'quick');
  assert.equal(createJoinState({ join: 'create' }).origin, 'create');
});

// --- minVersion -----------------------------------------------------------------------------------------------------

test('session.join refuses while the game server is older than manifest.server.minVersion', async () => {
  let version = 1;
  okServer({ 'GET /versions': () => json({ serverVersion: version, rooms: ['arena'] }) });
  const c = clock();
  const { call } = setup(target({ join: 'quick' }, { minServerVersion: 2 }), { now: c.now });
  await call('ready', { sdkVersion: '1' });
  const res = await call('session.join');
  assert.equal(res.error?.code, 'MATCHMAKE_FAILED');
  assert.equal(res.error?.message, 'game server is updating');
  assert.deepEqual(paths(), ['GET /versions'], 'no seat reserved');

  version = 2;
  assert.equal((await call('session.join')).error?.code, 'MATCHMAKE_FAILED', 'cached for 60 s');
  c.advance(60_000);
  assert.equal((await call('session.join')).error, undefined);
  assert.deepEqual(paths(), ['GET /versions', 'GET /versions', 'POST /matchmake/joinOrCreate/arena']);

  // minVersion 0 (Developer launcher) never asks; an unreachable /versions lets matchmaking answer.
  calls = [];
  clearServerVersionCache();
  const dev = setup(target({ join: 'quick' }));
  await dev.call('ready', { sdkVersion: '1' });
  await dev.call('session.join');
  assert.deepEqual(paths(), ['POST /matchmake/joinOrCreate/arena']);
  calls = [];
  okServer({ 'GET /versions': () => json({ error: 'boom' }, 500) });
  const unknown = setup(target({ join: 'quick' }, { minServerVersion: 2 }));
  await unknown.call('ready', { sdkVersion: '1' });
  assert.equal((await unknown.call('session.join')).error, undefined);
});

// --- rejoin-journal.ts ----------------------------------------------------------------------------------------------

test('splitReconnectionToken splits on the first ":" only', () => {
  assert.deepEqual(splitReconnectionToken('abc123:xyz'), { roomId: 'abc123', token: 'xyz' });
  assert.deepEqual(splitReconnectionToken('abc123:x:y'), { roomId: 'abc123', token: 'x:y' });
  assert.equal(splitReconnectionToken('abc123'), null);
  assert.equal(splitReconnectionToken(':xyz'), null);
  assert.equal(splitReconnectionToken('abc123:'), null);
});

test('rejoin journal: records expire, TTLs are clamped to the 60 s grace, re-stamps only touch their room', async () => {
  const { j, storage, c } = journal();
  await j.save({ gameId: 'sumo', roomId: 'r1', token: 'r1:t', join: 'quick', ttlSec: 30 });
  const rec = await j.get();
  assert.equal(rec?.expiresAt, c.now() + 30_000);
  assert.equal(rejoinSecondsLeft(rec!, c.now() + 12_500), 17);

  c.advance(29_000);
  await j.restamp('other');
  assert.equal(rejoinSecondsLeft((await j.get())!, c.now()), 1);
  await j.restamp('r1');
  assert.equal(rejoinSecondsLeft((await j.get())!, c.now()), 30);

  c.advance(30_000);
  assert.equal(await j.get(), null, 'expired');
  assert.equal(await storage.getItem(rejoinKey('u1')), null, 'and dropped');
  assert.equal(rejoinSecondsLeft({ expiresAt: 0 }, c.now()), 0);

  await j.save({ gameId: 'sumo', roomId: 'r1', token: 'r1:t', join: 'create', ttlSec: 3600 });
  assert.equal((await j.get())?.ttlSec, 60);
  assert.equal((await j.get())?.expiresAt, c.now() + 60_000);
  await j.save({ gameId: 'sumo', roomId: 'r1', token: 'r1:t', join: 'create', ttlSec: 0 });
  assert.equal((await j.get())?.ttlSec, 1);
});

test('rejoin journal: clear with a filter, unreadable records dropped, storage errors swallowed', async () => {
  const { j, storage } = journal();
  await j.save({ gameId: 'sumo', roomId: 'r1', token: 'r1:t', join: 'quick', ttlSec: 60 });
  await j.clear((r) => r.gameId === 'spike');
  assert.notEqual(await j.get(), null);
  await j.clear((r) => r.gameId === 'sumo');
  assert.equal(await j.get(), null);

  await storage.setItem(rejoinKey('u1'), '{"gameId":1}');
  assert.equal(await j.get(), null);
  assert.equal(await storage.getItem(rejoinKey('u1')), null);

  const broken: KeyValueStorage = {
    getItem: async () => {
      throw new Error('disk');
    },
    setItem: async () => {
      throw new Error('disk');
    },
    removeItem: async () => {
      throw new Error('disk');
    },
  };
  const b: RejoinJournal = createRejoinJournal(broken, 'u1');
  await b.save({ gameId: 'sumo', roomId: 'r1', token: 'r1:t', join: 'quick', ttlSec: 60 });
  await b.restamp('r1');
  await b.clear();
  assert.equal(await b.get(), null);
});
