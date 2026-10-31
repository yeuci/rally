import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { ColyseusTestServer } from '@colyseus/testing';
import { CloseCode, ErrorCode } from 'colyseus';
import type appConfig from '../src/app.config.js';
import type { HelloRoom } from '../src/rooms/HelloRoom.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { testServer } from './server.js';

/**
 * Fake time, but only while no client request is open. `mock.timers` swaps the process-global setTimeout and
 * clearTimeout, and the client side of these tests (the SDK's matchmaking `fetch` and its `WebSocket`) is Node's
 * bundled undici, which uses those same globals: undici arms a real keep-alive timer on every idle pooled socket, and
 * when the SDK's WebSocket upgrade reuses that socket under the mock, the mocked clearTimeout ignores the real timer
 * (it only knows its own). The upgrade then frees the socket's parser while its timer stays armed; ~3 s later it fires
 * on the garbage-collected parser and throws an uncaught `TypeError: Cannot destructure property 'socket' of
 * 'parser.deref(...)'`, and Colyseus shuts the shared test server down, failing every later test file. Whether GC ran
 * first decided whether a run failed. So: enable around a drop and the tick, `real()` before any HTTP or SDK call.
 */
function fake() {
  mock.timers.enable({ apis: ['setTimeout'] });
}
/** Back to real timers. Mocked timers still queued are dropped, so run what must run first. */
function real() {
  mock.timers.reset();
}

/** Wait without timers (setTimeout is mocked while the grace runs). */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * What the shell's `resume` target does (design §4): split the SDK's `<roomId>:<token>` on its first `:` and
 * `POST /matchmake/reconnect/<roomId>` with `{ reconnectionToken }`; the game bundle consumes the reservation.
 */
function splitReconnectionToken(full: string): { roomId: string; reconnectionToken: string } {
  const i = full.indexOf(':');
  assert.ok(i > 0, `token "${full}" has the <roomId>:<token> shape`);
  return { roomId: full.slice(0, i), reconnectionToken: full.slice(i + 1) };
}

describe('reconnection grace (60 s)', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => {
    RallyRoom.configureAuth(null);
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });
  afterEach(() => {
    // A test that failed with the mock on: run what it still queues (e.g. the room's auto-dispose), then restore.
    try {
      mock.timers.runAll();
    } catch {
      // not enabled
    }
    real();
  });

  it('POST /matchmake/reconnect/<roomId> gets the seat back 59 s after a drop; after 60 s the seat is gone', async () => {
    const alice = await colyseus.sdk.joinOrCreate('hello', { username: 'Alice' });
    const bob = await colyseus.sdk.joinOrCreate('hello', { username: 'Bob' });
    for (const r of [alice, bob]) r.onMessage('hello', () => {});
    assert.equal(bob.roomId, alice.roomId);
    const room = colyseus.getRoomById<HelloRoom>(alice.roomId);
    assert.equal(room.reconnectSeconds, 60, 'every Rally room defaults to a 60 s grace');
    alice.reconnection.enabled = false; // the shell resumes over HTTP, not the SDK's auto-reconnect
    const id = alice.sessionId;
    const target = splitReconnectionToken(alice.reconnectionToken);
    assert.equal(target.roomId, alice.roomId);

    // Drop, then let 59 s pass on the grace timer. Only setTimeout is mocked (Colyseus' grace and auto-dispose timers).
    fake();
    room.clients.get(id)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await until(() => !room.isConnected(id), 'alice dropped');
    mock.timers.tick(59_000);
    await until(() => true, 'a turn');
    assert.equal(room.seatCount, 2, 'the seat is still held at 59 s');
    // Real timers again before the client reconnects (see `fake`). The grace timer is dropped with the mock: it was
    // not due, and the reconnection cancels it. If the reconnection fails, the next cleanup() rejects the held seat.
    real();

    const res = await colyseus.http.post(`/matchmake/reconnect/${target.roomId}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reconnectionToken: target.reconnectionToken }),
    });
    const reservation = res.data as { sessionId: string; name: string; roomId: string };
    assert.equal(reservation.sessionId, id);
    assert.equal(reservation.roomId, alice.roomId);
    const back = await colyseus.sdk.consumeSeatReservation({
      ...(res.data as object),
      reconnectionToken: target.reconnectionToken,
    } as Parameters<typeof colyseus.sdk.consumeSeatReservation>[0]);
    back.onMessage('hello', () => {});
    assert.equal(back.sessionId, id, 'same seat');
    await until(() => room.isConnected(id), 'alice back');

    // Drop again and let the whole grace run out: the seat is freed and the token is dead.
    back.reconnection.enabled = false;
    const again = splitReconnectionToken(back.reconnectionToken);
    fake();
    room.clients.get(id)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await until(() => !room.isConnected(id), 'alice dropped again');
    mock.timers.tick(60_001);
    await until(() => room.seatCount === 1, 'seat freed after 60 s');
    mock.timers.runAll();
    real();
    await assert.rejects(
      colyseus.http.post(`/matchmake/reconnect/${again.roomId}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reconnectionToken: again.reconnectionToken }),
      }),
      (e: { statusCode: number; data: { code: number } }) => {
        assert.equal(e.data.code, ErrorCode.MATCHMAKE_EXPIRED);
        return true;
      },
    );
  });
});
