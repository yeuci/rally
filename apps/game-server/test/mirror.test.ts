import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { SignJWT } from 'jose';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { RoomMirror, createDefaultMirror } from '../src/mirror.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import type { SumoRoom } from '../src/rooms/SumoRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { createServiceApi, type GameRoomSnapshot } from '../src/supabase.js';
import { SERVER_VERSION } from '../src/version.js';
import { fakeClock, fakeRpc, flush, waitFor } from './fakes.js';
import { testServer } from './server.js';

function snap(roomId: string, clients: number, extra: Partial<GameRoomSnapshot> = {}): GameRoomSnapshot {
  return {
    roomId,
    gameId: 'sumo',
    roomName: 'sumo',
    name: `Sumo ${roomId}`,
    private: false,
    code: null,
    clients,
    maxClients: 8,
    locked: false,
    phase: 'waiting',
    serverVersion: 2,
    playerIds: [],
    ...extra,
  };
}

const clientsOf = (args: Record<string, unknown>[]) =>
  args.map((a) => {
    const room = a.p_room as { roomId: string; clients: number };
    return `${room.roomId}:${room.clients}`;
  });

describe('RoomMirror', () => {
  function setup() {
    const fake = fakeRpc({ server_touch_game_rooms: 1 });
    const clock = fakeClock();
    const logs: string[] = [];
    const mirror = new RoomMirror(createServiceApi(fake.rpc), { timers: clock, log: (m) => logs.push(m) });
    return { fake, clock, logs, mirror };
  }

  it('coalesces writes to at most one per room every 2 s, always sending the newest snapshot', async () => {
    const { fake, clock, mirror } = setup();
    mirror.update(snap('A', 1));
    clock.advance(0);
    await flush();
    assert.deepEqual(clientsOf(fake.of('server_upsert_game_room')), ['A:1'], 'the first write goes out at once');

    // A burst inside the window: nothing until the window ends, then only the newest.
    for (let n = 2; n <= 6; n++) {
      mirror.update(snap('A', n));
      clock.advance(300);
      await flush();
    }
    assert.equal(fake.of('server_upsert_game_room').length, 1);
    clock.advance(500); // t = 2000
    await flush();
    assert.deepEqual(clientsOf(fake.of('server_upsert_game_room')), ['A:1', 'A:6']);

    // Rooms have independent windows; nothing more is written without a change.
    mirror.update(snap('B', 1));
    clock.advance(0);
    await flush();
    clock.advance(10_000);
    await flush();
    assert.deepEqual(clientsOf(fake.of('server_upsert_game_room')), ['A:1', 'A:6', 'B:1']);

    // The full row, in the shape server_upsert_game_room reads (camelCase).
    assert.deepEqual(fake.of('server_upsert_game_room')[2], {
      p_room: {
        roomId: 'B',
        gameId: 'sumo',
        roomName: 'sumo',
        name: 'Sumo B',
        private: false,
        code: null,
        clients: 1,
        maxClients: 8,
        locked: false,
        phase: 'waiting',
        serverVersion: 2,
        playerIds: [],
      },
    });
    mirror.stop();
  });

  it('a write in flight is never doubled: changes made meanwhile follow it after the window', async () => {
    const { fake, clock, mirror } = setup();
    fake.holding = true;
    mirror.update(snap('A', 1));
    clock.advance(0);
    await flush();
    mirror.update(snap('A', 2));
    mirror.update(snap('A', 3));
    clock.advance(5000);
    await flush();
    assert.equal(fake.of('server_upsert_game_room').length, 1, 'still waiting for the first');
    fake.holding = false;
    fake.release();
    await flush();
    clock.advance(0);
    await flush();
    assert.deepEqual(clientsOf(fake.of('server_upsert_game_room')), ['A:1', 'A:3']);
    mirror.stop();
  });

  it('touches every live room in one call every 30 s, and stops when the process has no rooms', async () => {
    const { fake, clock, mirror } = setup();
    mirror.update(snap('A', 1));
    mirror.update(snap('B', 2));
    clock.advance(0);
    await flush();
    clock.advance(30_000);
    await flush();
    assert.deepEqual(fake.of('server_touch_game_rooms'), [{ p_room_ids: ['A', 'B'] }]);
    clock.advance(30_000);
    await flush();
    assert.equal(fake.of('server_touch_game_rooms').length, 2);

    mirror.remove('A');
    mirror.remove('B');
    await mirror.settled();
    assert.deepEqual(fake.of('server_remove_game_room'), [{ p_room_id: 'A' }, { p_room_id: 'B' }]);
    assert.equal(clock.pending(), 0, 'no interval left once idle');
  });

  it('failures are logged once and retried on the next tick; the room is never blocked', async () => {
    const { fake, clock, logs, mirror } = setup();
    fake.failing = true;
    mirror.update(snap('A', 1)); // returns at once, whatever Supabase does
    clock.advance(0);
    await flush();
    mirror.update(snap('A', 2));
    clock.advance(2000);
    await flush();
    assert.equal(fake.of('server_upsert_game_room').length, 2, 'a newer snapshot still tries after the window');
    clock.advance(10_000);
    await flush();
    assert.equal(fake.of('server_upsert_game_room').length, 2, 'no retry storm between ticks');
    assert.equal(logs.length, 1, 'one line per outage');
    assert.match(logs[0]!, /^\[mirror\] upsert A failed \(fake server_upsert_game_room failure\)/);

    fake.failing = false;
    clock.advance(18_000); // t = 30 s: the tick retries the write
    await mirror.settled();
    assert.deepEqual(clientsOf(fake.of('server_upsert_game_room')).at(-1), 'A:2');
    assert.match(logs.at(-1)!, /recovered/);

    // A failed touch re-upserts the rooms on the next tick (their rows may have aged out meanwhile).
    fake.failing = (name) => name === 'server_touch_game_rooms';
    clock.advance(30_000);
    await mirror.settled();
    const before = fake.of('server_upsert_game_room').length;
    fake.failing = false;
    clock.advance(30_000);
    await mirror.settled();
    assert.equal(fake.of('server_upsert_game_room').length, before + 1);

    // A failed removal is retried too.
    fake.failing = true;
    mirror.remove('A');
    await mirror.settled();
    fake.failing = false;
    clock.advance(30_000);
    await mirror.settled();
    assert.deepEqual(fake.of('server_remove_game_room'), [{ p_room_id: 'A' }, { p_room_id: 'A' }]);
    assert.equal(clock.pending(), 0);
  });

  it('remove waits for a write in flight, drops queued ones, and late updates never resurrect the row', async () => {
    const { fake, clock, mirror } = setup();
    mirror.update(snap('A', 1));
    clock.advance(0);
    await flush();
    mirror.update(snap('A', 2)); // queued for t = 2 s
    fake.holding = true;
    mirror.remove('A');
    mirror.update(snap('A', 3));
    clock.advance(5000);
    await flush();
    fake.holding = false;
    fake.release();
    await mirror.settled();
    assert.deepEqual(
      fake.calls.map((c) => c.name),
      ['server_upsert_game_room', 'server_remove_game_room'],
    );
    assert.deepEqual(mirror.roomIds, []);

    // Remove right after an upsert started: the delete is sent only once the upsert answered.
    fake.holding = true;
    mirror.update(snap('B', 1));
    clock.advance(0);
    await flush();
    mirror.remove('B');
    await flush();
    assert.deepEqual(fake.calls.at(-1), {
      name: 'server_upsert_game_room',
      args: fake.of('server_upsert_game_room').at(-1),
    });
    assert.equal(fake.of('server_remove_game_room').length, 1, 'B not removed while its upsert is pending');
    fake.holding = false;
    fake.release();
    await mirror.settled();
    assert.deepEqual(fake.calls.at(-1), { name: 'server_remove_game_room', args: { p_room_id: 'B' } });
  });

  it('without a service client: a dry run that logs in development, nothing otherwise', () => {
    assert.ok(createDefaultMirror({ mode: 'development' }, null) instanceof RoomMirror);
    assert.equal(createDefaultMirror({ mode: 'test' }, null), null);
    assert.equal(createDefaultMirror({ mode: 'production' }, null), null);
  });
});

describe('RallyRoom → game_rooms mirror', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const secret = 'test-secret-with-at-least-32-characters!!';
  const USER = '6f1c1c2e-0d1b-4d55-9a57-3b8a2d0e9f01';

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => {
    RallyRoom.configureAuth(null);
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });
  after(() => {
    RallyRoom.configureMirror(undefined);
    RallyRoom.configureAuth(null);
    colyseus.sdk.auth.token = '';
  });

  it('mirrors creation, joins (non-guest player ids only), phase changes and leaves; dispose removes the row', async () => {
    const fake = fakeRpc();
    const mirror = new RoomMirror(createServiceApi(fake.rpc), { minIntervalMs: 20 });
    RallyRoom.configureMirror(mirror);
    RallyRoom.configureAuth(createAuthenticator({ jwtSecret: secret, allowGuests: true }));
    try {
      colyseus.sdk.auth.token = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(USER)
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(secret));
      const user = await colyseus.sdk.joinOrCreate('sumo', {});
      user.onMessage('fx', () => {});
      colyseus.sdk.auth.token = '';
      const guest = await colyseus.sdk.joinOrCreate('sumo', { username: 'G' });
      guest.onMessage('fx', () => {});
      assert.equal(guest.roomId, user.roomId);
      const roomId = user.roomId;
      const room = colyseus.getRoomById<SumoRoom>(roomId);

      const rows = () =>
        fake
          .of('server_upsert_game_room')
          .map((a) => a.p_room as Record<string, unknown>)
          .filter((r) => r.roomId === roomId);
      await waitFor(() => rows().some((r) => r.clients === 2), 'two seats mirrored');
      const two = rows().find((r) => r.clients === 2)!;
      assert.deepEqual(
        { ...two, phase: undefined },
        {
          roomId,
          gameId: 'sumo',
          roomName: 'sumo',
          name: room.roomTitle,
          private: false,
          code: null,
          clients: 2,
          maxClients: 8,
          locked: false,
          phase: undefined,
          serverVersion: SERVER_VERSION,
          playerIds: [USER],
        },
        'guests are not in player_ids',
      );
      // Two players start the countdown: the phase change is mirrored through syncMetadata.
      await waitFor(() => rows().some((r) => r.phase === 'countdown' || r.phase === 'playing'), 'phase mirrored');
      assert.deepEqual(mirror.roomIds, [roomId]);

      await guest.leave();
      await waitFor(() => rows().at(-1)?.clients === 1, 'leave mirrored');
      await user.leave();
      await waitFor(() => fake.of('server_remove_game_room').length > 0, 'row removed on dispose');
      await mirror.settled();
      assert.deepEqual(fake.of('server_remove_game_room'), [{ p_room_id: roomId }]);
      assert.equal(fake.calls.at(-1)!.name, 'server_remove_game_room', 'nothing is written after the removal');
      assert.deepEqual(mirror.roomIds, []);
    } finally {
      mirror.stop();
      RallyRoom.configureMirror(null);
    }
  });

  it('a failing Supabase never blocks matchmaking or the room', async () => {
    const fake = fakeRpc();
    fake.holding = true; // every call hangs
    const mirror = new RoomMirror(createServiceApi(fake.rpc), { minIntervalMs: 20, log: () => {} });
    RallyRoom.configureMirror(mirror);
    try {
      const a = await colyseus.sdk.joinOrCreate('hello', { username: 'A' });
      a.onMessage('hello', () => {});
      const b = await colyseus.sdk.joinOrCreate('hello', { username: 'B' });
      b.onMessage('hello', () => {});
      assert.equal(a.roomId, b.roomId);
      await a.leave();
      await b.leave();
      await waitFor(() => colyseus.getRoomById(a.roomId) === undefined, 'room disposed while the mirror hangs');
    } finally {
      fake.holding = false;
      fake.release();
      await mirror.settled();
      mirror.stop();
      RallyRoom.configureMirror(null);
    }
  });
});
