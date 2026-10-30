import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { CloseCode } from 'colyseus';
import { SignJWT } from 'jose';
import type { FxEvent, SumoStateView } from '@rally/game-sumo-server';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { setMatchResultSink, type MatchResult } from '../src/results.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { resetRateLimits } from '../src/routes.js';
import type { SumoRoom } from '../src/rooms/SumoRoom.js';
import { testServer } from './server.js';

/** Fast rules so a whole match fits in a test. */
const FAST = { countdownTime: 0.1, roundOverTime: 0.1, matchOverTime: 0.2 };

async function waitFor(cond: () => boolean, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const view = (r: { state: unknown }) => r.state as SumoStateView;
/** `profile` is registered by RallyRoom with onMessage, so it is not in SumoRoom's typed message map. */
const sendProfile = (r: unknown, username: string) =>
  (r as { send(type: string, message: unknown): void }).send('profile', { username });

describe('SumoRoom', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let results: MatchResult[] = [];
  let restoreSink: ReturnType<typeof setMatchResultSink>;

  before(async () => {
    colyseus = await testServer();
    restoreSink = setMatchResultSink((r) => {
      results.push(r);
    });
  });
  after(() => {
    setMatchResultSink(restoreSink);
  });
  beforeEach(async () => {
    results = [];
    RallyRoom.configureAuth(null);
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });

  async function join(username: string, options: Record<string, unknown> = {}) {
    const room = await colyseus.sdk.joinOrCreate('sumo', { username, ...options });
    room.onMessage('fx', () => {});
    await room.waitForInitialState();
    return room;
  }

  it('two players land in one room, see each other by name, and a round starts', async () => {
    const alice = await join('Alice', { rules: FAST });
    assert.equal(view(alice).phase, 'waiting');
    const bob = await join('Bob');
    assert.equal(bob.roomId, alice.roomId, 'quick play fills the same room');
    for (const r of [alice, bob]) {
      await waitFor(() => view(r).players.size === 2, 'both players in state');
      const names: string[] = [];
      view(r).players.forEach((p) => names.push(p.name));
      assert.deepEqual(names.sort(), ['guest-Alice', 'guest-Bob'], 'guests are always guest-<name>');
    }
    await waitFor(() => view(alice).phase === 'playing', 'round start');
    assert.equal(view(alice).round, 1);
    const me = view(alice).players.get(alice.sessionId)!;
    assert.equal(me.alive, true);
    assert.equal(me.inRound, true);
    assert.equal(me.guest, true);
    const room = colyseus.getRoomById<SumoRoom>(alice.roomId);
    assert.deepEqual(
      {
        gameId: room.metadata.gameId,
        players: room.metadata.players,
        maxPlayers: room.metadata.maxPlayers,
        private: room.metadata.private,
      },
      { gameId: 'sumo', players: 2, maxPlayers: 8, private: false },
    );
  });

  it('validates inputs: moves the puck, acks the sequence, drops garbage, stale and excess messages', async () => {
    const alice = await join('Alice', { rules: FAST });
    const bob = await join('Bob');
    await waitFor(() => view(alice).phase === 'playing', 'round start');
    const room = colyseus.getRoomById<SumoRoom>(alice.roomId);
    const x0 = view(alice).players.get(alice.sessionId)!.x;

    alice.send('input', { x: 5, y: 0, s: 1 }); // clamped to (1, 0)
    await waitFor(() => view(alice).players.get(alice.sessionId)!.ack === 1, 'ack 1');
    assert.deepEqual(room.match.players.get(alice.sessionId)!.input, { x: 1, y: 0 });
    await waitFor(() => view(alice).players.get(alice.sessionId)!.x > x0 + 0.5, 'puck moved right');

    alice.send('input', { x: 'left', y: 0, s: 2 });
    alice.send('input', { x: 0, y: 1, s: 1 }); // stale
    alice.send('input', null);
    await room.waitForNextPatch();
    assert.deepEqual(room.match.players.get(alice.sessionId)!.input, { x: 1, y: 0 });

    // Flood: only MAX_INPUTS_PER_SECOND per rolling second are applied.
    for (let s = 10; s < 70; s++) bob.send('input', { x: 0, y: s % 2 ? 1 : -1, s });
    await waitFor(() => (view(bob).players.get(bob.sessionId)?.ack ?? 0) > 0, 'some applied');
    await room.waitForNextPatch(100);
    const ack = view(bob).players.get(bob.sessionId)!.ack;
    assert.ok(ack < 69 && ack >= 10, `excess inputs dropped (ack ${ack})`);
    assert.equal(room.clients.length, 2, 'nobody was disconnected');
  });

  it('reports the match result with standings, the wins board delta and achievements', async () => {
    const alice = await join('Alice', { rules: { ...FAST, winsToMatch: 1 } });
    const bob = await join('Bob');
    const fx: FxEvent[] = [];
    alice.onMessage('fx', (batch: FxEvent[]) => fx.push(...batch));
    await waitFor(() => view(alice).phase === 'playing', 'round start');
    const room = colyseus.getRoomById<SumoRoom>(alice.roomId);
    room.match.players.get(bob.sessionId)!.x = 50; // off the platform

    await waitFor(() => results.length === 1, 'match result');
    const r = results[0]!;
    const aliceAuth = room.authOf(alice.sessionId)!;
    assert.equal(r.gameId, 'sumo');
    assert.equal(r.roomId, alice.roomId);
    assert.equal(r.matchId, `${alice.roomId}:1`);
    assert.equal(r.private, false);
    assert.equal(r.winnerUserId, aliceAuth.userId);
    assert.match(aliceAuth.userId, /^guest:/);
    assert.equal(r.rounds, 1);
    assert.deepEqual(r.leaderboardDeltas, { wins: { [aliceAuth.userId]: 1 } });
    assert.deepEqual(
      r.players.map((p) => [p.username, p.placement, p.score, p.guest, p.achievements]),
      [
        ['guest-Alice', 1, 1, true, ['first_win', 'flawless']],
        ['guest-Bob', 2, 0, true, []],
      ],
    );
    assert.ok(Date.parse(r.endedAt) >= Date.parse(r.startedAt));

    await waitFor(() => fx.some((e) => e.k === 'match'), 'fx');
    assert.ok(fx.some((e) => e.k === 'out' && e.id === bob.sessionId));
    assert.ok(fx.some((e) => e.k === 'round' && e.winner === alice.sessionId));
    await waitFor(
      () => view(alice).matchWinner === alice.sessionId || view(alice).phase === 'matchOver',
      'winner in state',
    );
    // ...then the room resets for the next match.
    await waitFor(() => view(alice).phase === 'countdown' && view(alice).round === 1, 'next match', 3000);
    assert.equal(view(alice).players.get(alice.sessionId)!.score, 0);
  });

  it('private rooms: { private: true } creates a hidden room with a join code, reachable by code and joinById', async () => {
    const pub = await join('Pub');
    const host = await join('Host', { private: true });
    assert.notEqual(host.roomId, pub.roomId, 'never matched into a public room');
    const code = view(host).code;
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    assert.equal(view(host).isPrivate, true);
    const room = colyseus.getRoomById<SumoRoom>(host.roomId);
    assert.equal(room.metadata.code, code);
    assert.equal(room.metadata.private, true);

    const list = await colyseus.http.get('/rooms/sumo');
    const rooms = (
      list.data as {
        rooms: { roomId: string; clients: number; maxClients: number; locked: boolean; metadata: { name: string } }[];
      }
    ).rooms;
    assert.deepEqual(
      rooms.map((x) => x.roomId),
      [pub.roomId],
      'only public rooms are listed',
    );
    assert.equal(rooms[0]!.clients, 1);
    assert.equal(rooms[0]!.maxClients, 8);
    assert.equal(rooms[0]!.locked, false);
    assert.match(rooms[0]!.metadata.name, /^Sumo [A-Z0-9_-]{4}$/i);

    const byCode = await colyseus.http.get(`/rooms/code/${code.toLowerCase()}`);
    assert.equal((byCode.data as { roomId: string }).roomId, host.roomId);
    // Unknown and malformed codes get the same 404.
    const notFound: unknown[] = [];
    for (const bad of ['AAAAAA', 'O0O0O0', 'x']) {
      await assert.rejects(colyseus.http.get(`/rooms/code/${bad}`), (e: { statusCode: number; data: unknown }) => {
        notFound.push([e.statusCode, e.data]);
        return true;
      });
    }
    assert.deepEqual(notFound, Array(3).fill([404, { error: 'no room with that code' }]));
    await assert.rejects(colyseus.http.get('/rooms/nope'), (e: { statusCode: number }) => e.statusCode === 404);

    // joinById into a private room needs its code: knowing the room id is not enough.
    for (const opts of [{}, { code: 'AAAAAA' }, { code: 42 }]) {
      await assert.rejects(colyseus.sdk.joinById(host.roomId, { username: 'Snoop', ...opts }), /not found/);
    }
    assert.equal(colyseus.getRoomById<SumoRoom>(host.roomId).clients.length, 1, 'nobody got in');

    const guest = await colyseus.sdk.joinById(host.roomId, { username: 'Friend', code: ` ${code.toLowerCase()} ` });
    guest.onMessage('fx', () => {});
    await guest.waitForInitialState();
    await waitFor(() => view(host).players.size === 2, 'friend joined the private room');
    // A second private request gets its own room and code.
    const other = await join('Other', { private: true });
    assert.notEqual(other.roomId, host.roomId);
    assert.notEqual(view(other).code, code);
    // Public rooms still join by id alone.
    const byId = await colyseus.sdk.joinById(pub.roomId, { username: 'Direct' });
    byId.onMessage('fx', () => {});
    assert.equal(byId.roomId, pub.roomId);
  });

  it('a dropped player of a private room reconnects without the code', async () => {
    const host = await join('Host', { private: true });
    const room = colyseus.getRoomById<SumoRoom>(host.roomId);
    host.reconnection.enabled = false;
    const id = host.sessionId;
    room.clients.get(id)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await waitFor(() => !room.isConnected(id) && room.seatCount === 1, 'dropped, seat held');
    const back = await colyseus.sdk.reconnect(host.reconnectionToken);
    back.onMessage('fx', () => {});
    assert.equal(back.sessionId, id);
  });

  it('throttles join-code lookups per client (429), and limits room creation per identity', async () => {
    let throttled = 0;
    for (let i = 0; i < 22; i++) {
      await colyseus.http.get('/rooms/code/AAAAAA').catch((e: { statusCode: number }) => {
        if (e.statusCode === 429) throttled++;
      });
    }
    assert.equal(throttled, 2, '20 lookups per minute per client');
    // Another client address (behind a proxy that sets x-forwarded-for) has its own window.
    await assert.rejects(
      colyseus.http.get('/rooms/code/AAAAAA', { headers: { 'x-forwarded-for': '203.0.113.9' } }),
      (e: { statusCode: number }) => e.statusCode === 404,
    );

    // Five private rooms per minute per guest address; joinOrCreate into a public room is not a creation.
    for (let i = 0; i < 5; i++) await join(`Host${i}`, { private: true });
    await assert.rejects(join('Host5', { private: true }), /too many rooms/);
    await assert.rejects(colyseus.sdk.create('sumo', { username: 'Host6' }), /too many rooms/);
    await join('Quick');
    await join('Quick2');

    // Verified players are counted per user id, not per address.
    const secret = 'test-secret-with-at-least-32-characters!!';
    RallyRoom.configureAuth(createAuthenticator({ jwtSecret: secret, allowGuests: false }));
    colyseus.sdk.auth.token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-777')
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    const mine = await colyseus.sdk.create('sumo', {});
    mine.onMessage('fx', () => {});
    assert.equal(colyseus.getRoomById<SumoRoom>(mine.roomId).authOf(mine.sessionId)?.userId, 'user-777');
  });

  it('holds a dropped player’s seat (connected = false), restores it on reconnect, frees it after the grace', async () => {
    const alice = await join('Alice');
    const bob = await join('Bob');
    const room = colyseus.getRoomById<SumoRoom>(alice.roomId);
    room.reconnectSeconds = 0.6;
    bob.reconnection.enabled = false;
    const bobId = bob.sessionId;
    const token = bob.reconnectionToken;

    room.clients.get(bobId)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await waitFor(() => view(alice).players.get(bobId)?.connected === false, 'bob shown disconnected');
    assert.equal(room.seatCount, 2, 'seat held');
    assert.equal(room.metadata.players, 2);

    const back = await colyseus.sdk.reconnect(token);
    back.onMessage('fx', () => {});
    assert.equal(back.sessionId, bobId, 'same session');
    await waitFor(() => view(alice).players.get(bobId)?.connected === true, 'bob back');

    back.reconnection.enabled = false;
    room.clients.get(bobId)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await waitFor(() => view(alice).players.get(bobId)?.connected === false, 'dropped again');
    await waitFor(() => !view(alice).players.get(bobId), 'seat freed after the grace', 3000);
    assert.equal(room.seatCount, 1);
    await waitFor(() => room.metadata.players === 1, 'metadata updated');
  });

  it('a client kicked for flooding loses its seat at once (no reconnection grace); a stale socket keeps it', async () => {
    const alice = await join('Alice');
    const bob = await join('Bob');
    const room = colyseus.getRoomById<SumoRoom>(alice.roomId);
    // Stale socket: the same session reconnects while the server still sees it connected. Colyseus closes the old
    // socket with WITH_ERROR too; that must still be a drop with a grace, so the reconnect succeeds.
    const again = await colyseus.sdk.reconnect(bob.reconnectionToken);
    again.onMessage('fx', () => {});
    assert.equal(again.sessionId, bob.sessionId);
    await waitFor(() => room.isConnected(bob.sessionId), 'bob reconnected');
    assert.equal(room.seatCount, 2);

    // Flood: more than maxMessagesPerSecond (60) in one second → kicked, seat freed, token dead.
    alice.reconnection.enabled = false;
    const token = alice.reconnectionToken;
    for (let s = 1; s <= 80; s++) alice.send('input', { x: 0, y: 0, s });
    await waitFor(() => room.seatCount === 1, 'flooder removed', 3000);
    await waitFor(() => view(again).players.get(alice.sessionId) === undefined, 'gone from the state', 1000);
    await assert.rejects(colyseus.sdk.reconnect(token));
  });

  it('verified players get their name from profiles, never from token metadata or the options', async () => {
    const secret = 'test-secret-with-at-least-32-characters!!';
    const lookups: string[] = [];
    RallyRoom.configureAuth(
      createAuthenticator({
        jwtSecret: secret,
        allowGuests: false,
        profiles: async (userId) => {
          lookups.push(userId);
          return { username: 'verified_vic', avatarUrl: null };
        },
      }),
    );
    // user_metadata is user-writable (supabase.auth.updateUser), so it claims to be someone else here.
    const token = await new SignJWT({ role: 'authenticated', user_metadata: { username: 'alice' } })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));

    await assert.rejects(colyseus.sdk.joinOrCreate('sumo', { username: 'nobody' }), /missing token/);

    colyseus.sdk.auth.token = token;
    const vic = await colyseus.sdk.joinOrCreate('sumo', { username: 'spoofed', userId: 'admin' });
    vic.onMessage('fx', () => {});
    await vic.waitForInitialState();
    const room = colyseus.getRoomById<SumoRoom>(vic.roomId);
    assert.deepEqual(room.authOf(vic.sessionId), {
      userId: 'user-123',
      username: 'verified_vic',
      avatarUrl: null,
      guest: false,
    });
    assert.deepEqual(lookups, ['user-123']);
    await waitFor(() => view(vic).players.get(vic.sessionId)?.name === 'verified_vic', 'name from the profile');
    assert.equal(view(vic).players.get(vic.sessionId)!.guest, false);

    // The profile message only renames guests.
    sendProfile(vic, 'renamed');
    await room.waitForNextPatch(50);
    assert.equal(room.match.players.get(vic.sessionId)!.name, 'verified_vic');
  });

  it('guests may set their display name from the launch context (profile message)', async () => {
    const g = await colyseus.sdk.joinOrCreate('sumo', {});
    g.onMessage('fx', () => {});
    await g.waitForInitialState();
    assert.match(view(g).players.get(g.sessionId)!.name, /^guest-[a-z0-9]{4}$/);
    sendProfile(g, '  Phone\u0000 Player ');
    await waitFor(() => view(g).players.get(g.sessionId)!.name === 'guest-PhonePlayer', 'renamed');
    // Still a guest name when asking for a real user's: profile usernames never contain '-'.
    sendProfile(g, 'alice');
    await waitFor(() => view(g).players.get(g.sessionId)!.name === 'guest-alice', 'renamed again');
  });

  it('CORS: no credentials, and an Access-Control-Allow-Origin only for allowed origins (any, under test)', async () => {
    const res = await colyseus.http.get('/healthz', { headers: { origin: 'http://10.0.0.201:5182' } });
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    const mm = await colyseus.http.post('/matchmake/joinOrCreate/sumo', {
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'X' }),
    });
    assert.equal(mm.headers['access-control-allow-credentials'], undefined);
  });
});
