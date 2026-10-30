import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import type appConfig from '../src/app.config.js';
import type { HelloState } from '../src/rooms/schema/HelloState.js';
import { testServer } from './server.js';

describe('HelloRoom', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => colyseus.cleanup());

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
});
