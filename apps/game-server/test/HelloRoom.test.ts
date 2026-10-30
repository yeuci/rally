import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { PINGS_PER_SECOND } from '../src/rooms/HelloRoom.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import type { HelloState } from '../src/rooms/schema/HelloState.js';
import { resetRateLimits } from '../src/routes.js';
import { testServer } from './server.js';

describe('HelloRoom', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => {
    RallyRoom.configureAuth(null);
    resetRateLimits();
    await colyseus.cleanup();
  });

  it('joins, counts players and answers ping with pong', async () => {
    const room = await colyseus.createRoom<HelloState>('hello', {});
    const client = await colyseus.connectTo(room);
    client.onMessage('hello', () => {});
    assert.equal(client.sessionId, room.clients[0]?.sessionId);

    const pong = new Promise<{ t: number; serverTime: number }>((resolve) => {
      client.onMessage('pong', (msg: { t: number; serverTime: number }) => resolve(msg));
    });
    client.send('ping', { t: 42 });
    const msg = await pong;
    assert.equal(msg.t, 42);
    assert.ok(msg.serverTime > 0);

    await room.waitForNextPatch();
    assert.equal(client.state.players, 1);
  });

  it('ticks the state at the simulation rate', async () => {
    const room = await colyseus.createRoom<HelloState>('hello', {});
    const client = await colyseus.connectTo(room);
    client.onMessage('hello', () => {});
    await room.waitForNextPatch();
    const first = client.state.tick;
    await new Promise((r) => setTimeout(r, 250));
    await room.waitForNextPatch();
    assert.ok(client.state.tick > first, `tick should advance (${first} -> ${client.state.tick})`);
  });

  it('is a RallyRoom: matchmaking goes through onAuth (no guests → no token, no seat)', async () => {
    RallyRoom.configureAuth(createAuthenticator({ allowGuests: false }));
    await assert.rejects(colyseus.sdk.joinOrCreate('hello', {}), /missing token/);
    RallyRoom.configureAuth(null);
    const room = await colyseus.sdk.joinOrCreate('hello', { username: 'Spike' });
    room.onMessage('hello', () => {});
    room.onMessage('pong', () => {});
    const server = colyseus.getRoomById(room.roomId) as RallyRoom;
    assert.equal(server.authOf(room.sessionId)?.username, 'guest-Spike');
    assert.equal(server.metadata.gameId, 'hello');
  });

  it('ping: ignores malformed payloads and answers at most PINGS_PER_SECOND per client', async () => {
    const room = await colyseus.createRoom<HelloState>('hello', {});
    const client = await colyseus.connectTo(room);
    client.onMessage('hello', () => {});
    const pongs: unknown[] = [];
    client.onMessage('pong', (msg: { t: unknown }) => pongs.push(msg.t));
    for (const bad of [null, 'x', { t: 'big' }, { t: Infinity }, { t: { nested: true } }]) client.send('ping', bad);
    for (let i = 0; i < 30; i++) client.send('ping', { t: i });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      pongs,
      Array.from({ length: PINGS_PER_SECOND }, (_, i) => i),
    );
    assert.equal(room.clients.length, 1, 'not kicked (below the 60/s flood cap)');
  });
});
