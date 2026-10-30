import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LaunchContext } from '@rally/protocol';
import {
  createHarnessHandlers,
  localRejoinJournal,
  type HarnessHandlerDeps,
  type JoinTarget,
  type RejoinJournal,
} from '../src/handlers.ts';
import type { HostError } from '../src/host-bridge.ts';
import { listRooms } from '../src/matchmake.ts';
import type { ProgressStore } from '../src/progress.ts';

const SERVER = 'http://game.test:2567';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Fake Colyseus HTTP API: records every request and answers from `route`. */
let calls: Call[] = [];
let route: (call: Call) => { status?: number; body: unknown } = () => ({ body: {} });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  route = (c) => {
    const m = /\/matchmake\/(\w+)\/([^/]+)$/.exec(c.url);
    if (!m) return { status: 404, body: { error: 'not found' } };
    const [, method, target] = m;
    const roomId = method === 'joinById' || method === 'reconnect' ? target : `new-${target}`;
    return { body: { name: 'sumo', roomId, sessionId: 'S1', processId: 'P' } };
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = route(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** In-memory localStorage stand-in. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function setup(join: JoinTarget, opts: { rejoin?: RejoinJournal; now?: () => number } = {}) {
  const joined: { roomId: unknown; kind: string }[] = [];
  const reconnections: { roomId: string; ttlSec: number; stored: boolean; note?: string }[] = [];
  const exits: string[] = [];
  const deps: HarnessHandlerDeps = {
    buildLaunchContext: (): LaunchContext => ({
      game: { id: 'sumo', version: '0.2.0' },
      user: { id: 'dev-alice', username: 'alice', avatarUrl: null },
      intent: join.kind === 'private' ? 'private' : 'quick',
      device: {
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        orientation: 'landscape',
        pixelRatio: 1,
        locale: 'en-US',
      },
    }),
    colyseusUrl: SERVER,
    room: 'sumo',
    join,
    rejoin: opts.rejoin,
    saves: { get: () => undefined, set: () => {}, clear: () => {} },
    leaderboards: [],
    achievements: [],
    progress: {} as ProgressStore,
    user: { id: 'dev-alice', username: 'alice' },
    onReady: () => {},
    onLoading: () => {},
    onExit: (r) => exits.push(r),
    onJoined: ({ roomId, kind }) => joined.push({ roomId, kind }),
    onReconnection: (info) => reconnections.push(info),
    now: opts.now,
  };
  const h = createHarnessHandlers(deps);
  return {
    h,
    joined,
    reconnections,
    exits,
    ready: () => h.ready!({ sdkVersion: '0.1.0' }),
    join: () => Promise.resolve(h['session.join']!(undefined)),
  };
}

test('matchmaking bodies never carry username/avatarUrl (quick, private, room, code)', async () => {
  for (const [join, expected] of [
    [{ kind: 'quick' }, [['POST', '/matchmake/joinOrCreate/sumo', {}]]],
    [{ kind: 'private' }, [['POST', '/matchmake/joinOrCreate/sumo', { private: true }]]],
    [{ kind: 'room', roomId: 'R7' }, [['POST', '/matchmake/joinById/R7', {}]]],
    [{ kind: 'room', roomId: 'R7', code: 'K7M2PQ' }, [['POST', '/matchmake/joinById/R7', { code: 'K7M2PQ' }]]],
  ] as [JoinTarget, [string, string, unknown][]][]) {
    calls = [];
    const s = setup(join);
    s.ready();
    const res = await s.join();
    assert.equal(res.endpoint, 'ws://game.test:2567');
    assert.deepEqual(
      calls.map((c) => [c.method, c.url.replace(SERVER, ''), c.body]),
      expected,
      join.kind,
    );
  }
});

test('code: GET /rooms/code then joinById with the code; a code for another game is refused', async () => {
  const lookup = { roomId: 'R5', roomName: 'sumo' };
  const base = route;
  route = (c) => (c.url.includes('/rooms/code/') ? { body: lookup } : base(c));
  const s = setup({ kind: 'code', code: 'K7M2PQ' });
  s.ready();
  await s.join();
  assert.deepEqual(
    calls.map((c) => [c.method, c.url.replace(SERVER, ''), c.body]),
    [
      ['GET', '/rooms/code/K7M2PQ', undefined],
      ['POST', '/matchmake/joinById/R5', { code: 'K7M2PQ' }],
    ],
  );

  lookup.roomName = 'hello';
  calls = [];
  const other = setup({ kind: 'code', code: 'K7M2PQ' });
  other.ready();
  await assert.rejects(other.join(), (e: HostError) => e.code === 'MATCHMAKE_FAILED' && /another game/.test(e.message));
  assert.equal(calls.length, 1);

  route = (c) => (c.url.includes('/rooms/code/') ? { status: 429, body: { error: 'slow down' } } : base(c));
  const limited = setup({ kind: 'code', code: 'K7M2PQ' });
  limited.ready();
  await assert.rejects(limited.join(), (e: HostError) => e.code === 'RATE_LIMITED');
});

test('resume: POST /matchmake/reconnect/<roomId> with the token, which the reservation carries to the socket', async () => {
  const s = setup({ kind: 'resume', roomId: 'R1', token: 'tok', code: 'K7M2PQ' });
  s.ready();
  const { seatReservation } = await s.join();
  assert.deepEqual(calls[0], {
    method: 'POST',
    url: `${SERVER}/matchmake/reconnect/R1`,
    body: { reconnectionToken: 'tok' },
  });
  // consumeSeatReservation forwards `reconnectionToken` from the reservation: that is the reconnection.
  assert.equal(seatReservation.reconnectionToken, 'tok');
  assert.equal(seatReservation.roomId, 'R1');
  assert.deepEqual(s.joined, [{ roomId: 'R1', kind: 'resume' }]);
});

test('resume is used once: the next session.join falls back to joinById with the same id and code (sticky)', async () => {
  const s = setup({ kind: 'resume', roomId: 'R1', token: 'tok', code: 'K7M2PQ' });
  s.ready();
  await s.join();
  await s.join();
  await s.join();
  assert.deepEqual(
    calls.map((c) => [c.url.replace(SERVER, ''), c.body]),
    [
      ['/matchmake/reconnect/R1', { reconnectionToken: 'tok' }],
      ['/matchmake/joinById/R1', { code: 'K7M2PQ' }],
      ['/matchmake/joinById/R1', { code: 'K7M2PQ' }],
    ],
  );
  assert.deepEqual(
    s.joined.map((j) => j.kind),
    ['resume', 'room', 'room'],
  );
});

test('a failed resume says the match ended, clears the record, and never falls back to quick play', async () => {
  const storage = memoryStorage();
  const journal = localRejoinJournal('sumo', 'dev-alice', storage);
  journal.put({
    gameId: 'sumo',
    roomId: 'R1',
    token: 'tok',
    intent: 'quick',
    ttlSec: 60,
    expiresAt: Date.now() + 60_000,
  });
  route = () => ({ status: 400, body: { code: 4214, error: 'reconnection token invalid or expired.' } });
  const s = setup({ kind: 'resume', roomId: 'R1', token: 'tok' }, { rejoin: journal });
  s.ready();
  await assert.rejects(
    s.join(),
    (e: HostError) =>
      e.code === 'MATCHMAKE_FAILED' && /^that match has ended \(400: reconnection token/.test(e.message),
  );
  assert.equal(journal.get(), null);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.url.includes('joinOrCreate')));

  // An unreachable server keeps the record for a retry.
  journal.put({
    gameId: 'sumo',
    roomId: 'R1',
    token: 'tok',
    intent: 'quick',
    ttlSec: 60,
    expiresAt: Date.now() + 60_000,
  });
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const offline = setup({ kind: 'resume', roomId: 'R1', token: 'tok' }, { rejoin: journal });
  offline.ready();
  await assert.rejects(offline.join(), /cannot reach/);
  assert.equal(journal.get()?.roomId, 'R1');
});

test('an invalid target fails session.join with its reason', async () => {
  const s = setup({ kind: 'invalid', reason: 'no reconnection token is stored' });
  s.ready();
  await assert.rejects(
    s.join(),
    (e: HostError) => e.code === 'MATCHMAKE_FAILED' && /no reconnection token/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test('reportReconnection stores the token only for the joined room, split and with the TTL clamped to 60 s', async () => {
  let t = 1_000_000;
  const now = () => t;
  const journal = localRejoinJournal('sumo', 'dev-alice', memoryStorage(), now);
  const s = setup({ kind: 'room', roomId: 'R7', code: 'K7M2PQ' }, { rejoin: journal, now });
  const report = (roomId: string, token: string, ttlSec: number) =>
    s.h['session.reportReconnection']!({ roomId, token, ttlSec });

  s.ready();
  report('R7', 'R7:tok', 30);
  assert.equal(journal.get(), null, 'nothing before a join');
  assert.equal(s.reconnections.at(-1)?.stored, false);

  await s.join();
  report('R8', 'R8:tok', 30);
  assert.equal(journal.get(), null, 'not the joined room');
  assert.match(s.reconnections.at(-1)?.note ?? '', /not the joined room \(R7\)/);
  report('R7', 'R8:tok', 30);
  assert.equal(journal.get(), null, 'a token for another room');

  report('R7', 'R7:tok', 300);
  assert.deepEqual(journal.get(), {
    gameId: 'sumo',
    roomId: 'R7',
    token: 'tok',
    code: 'K7M2PQ',
    intent: 'quick',
    ttlSec: 60,
    expiresAt: t + 60_000,
  });
  assert.deepEqual(s.reconnections.at(-1), { roomId: 'R7', ttlSec: 60, stored: true });
  // A bare token (no `<roomId>:`) is accepted too.
  report('R7', 'tok2', 20);
  assert.equal(journal.get()?.token, 'tok2');
  assert.equal(journal.get()?.ttlSec, 20);

  // Expiry; restamp pushes it out from "now" (the page is going away, the server's grace starts at the drop).
  t += 15_000;
  journal.restamp();
  assert.equal(journal.get()?.expiresAt, t + 20_000);
  t += 20_000;
  assert.equal(journal.get(), null);
});

test('the record is cleared on a consented exit and on joining another room, kept on rejoining its room', async () => {
  const journal = localRejoinJournal('sumo', 'dev-alice', memoryStorage());
  const put = (roomId: string) =>
    journal.put({ gameId: 'sumo', roomId, token: 'tok', intent: 'quick', ttlSec: 60, expiresAt: Date.now() + 60_000 });

  const s = setup({ kind: 'quick' }, { rejoin: journal });
  s.ready();
  put('R1');
  await s.join(); // → new-sumo
  assert.equal(journal.get(), null);

  const r = setup({ kind: 'resume', roomId: 'R1', token: 'tok' }, { rejoin: journal });
  r.ready();
  put('R1');
  await r.join();
  assert.equal(journal.get()?.roomId, 'R1');

  r.h.exit!({ reason: 'menu' });
  assert.equal(journal.get(), null);
  assert.deepEqual(r.exits, ['menu']);
});

test('localRejoinJournal: per game and user, drops expired, corrupt and foreign records, works without storage', () => {
  const storage = memoryStorage();
  let t = 0;
  const a = localRejoinJournal('sumo', 'dev-alice', storage, () => t);
  const b = localRejoinJournal('sumo', 'dev-bob', storage, () => t);
  a.put({ gameId: 'sumo', roomId: 'R1', token: 'x', intent: 'quick', ttlSec: 60, expiresAt: 60_000 });
  assert.equal(a.get()?.roomId, 'R1');
  assert.equal(b.get(), null);
  t = 60_000;
  assert.equal(a.get(), null);
  assert.equal(storage.getItem('rally-harness:rejoin:sumo:dev-alice'), null, 'expired record removed');

  storage.setItem('rally-harness:rejoin:sumo:dev-bob', '{nope');
  assert.equal(b.get(), null);
  storage.setItem(
    'rally-harness:rejoin:sumo:dev-bob',
    JSON.stringify({ gameId: 'stack', roomId: 'R', token: 'x', intent: 'quick', ttlSec: 1, expiresAt: 1e15 }),
  );
  assert.equal(b.get(), null);

  const mem = localRejoinJournal('sumo', 'dev-alice', null, () => 0);
  mem.put({ gameId: 'sumo', roomId: 'R2', token: 'x', intent: 'quick', ttlSec: 60, expiresAt: 1000 });
  assert.equal(mem.get()?.roomId, 'R2');
  mem.clear();
  assert.equal(mem.get(), null);
});

test('listRooms: GET /rooms/<name>, malformed rows dropped, 404 explained', async () => {
  route = () => ({
    body: {
      rooms: [
        { roomId: 'A', clients: 2, maxClients: 6, locked: false, metadata: { name: 'Sumo A' } },
        { roomId: 'B', clients: 'x', maxClients: 6, locked: false, metadata: null },
        { roomId: 'C', clients: 0, maxClients: 6, locked: false, metadata: null },
      ],
    },
  });
  const rooms = await listRooms(SERVER, 'sumo');
  assert.equal(calls[0]?.url, `${SERVER}/rooms/sumo`);
  assert.deepEqual(
    rooms.map((r) => r.roomId),
    ['A', 'C'],
  );
  route = () => ({ status: 404, body: { error: 'no room type' } });
  await assert.rejects(listRooms(SERVER, 'nope'), /no room type "nope"/);
});
