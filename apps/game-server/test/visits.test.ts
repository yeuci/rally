import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { CloseCode } from 'colyseus';
import { SignJWT } from 'jose';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { ServiceRpcError, createServiceApi } from '../src/supabase.js';
import {
  VisitCounter,
  configureVisitCounter,
  createDefaultVisitCounter,
  dryRunVisitApi,
  shutdownVisits,
} from '../src/visits.js';
import { fakeClock, fakeRpc, flush, waitFor } from './fakes.js';
import { testServer } from './server.js';

const RPC = 'server_record_visits';
const notFound = (game: string) => new ServiceRpcError(`rpc ${RPC}: HTTP 400 NOT_FOUND: game ${game}`, 400, 'P0002');

function setup(answers: Record<string, unknown> = {}, opts: { shutdownTimeoutMs?: number } = {}) {
  const fake = fakeRpc(answers);
  const clock = fakeClock();
  const logs: string[] = [];
  const counter = new VisitCounter(createServiceApi(fake.rpc), { timers: clock, log: (m) => logs.push(m), ...opts });
  const sent = () => fake.of(RPC).map((a) => `${a.p_game_id as string}+${a.p_count as number}`);
  /** Advance the fake clock and let the fake RPC answer. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    await flush();
    await counter.settled();
  };
  return { fake, clock, logs, counter, sent, advance };
}

describe('VisitCounter', () => {
  it('batches per game: one call per game 10 s after its first visit, nothing more without new visits', async () => {
    const { fake, counter, sent, advance, clock } = setup();
    counter.record('sumo');
    await advance(4000);
    counter.record('sumo');
    counter.record('chess');
    await advance(5999);
    assert.deepEqual(sent(), [], 'nothing before the window ends');
    await advance(1); // t = 10 s: sumo's window
    assert.deepEqual(sent(), ['sumo+2']);
    assert.deepEqual(fake.of(RPC)[0], { p_game_id: 'sumo', p_count: 2 }, 'the RPC arguments');
    await advance(4000); // t = 14 s: chess' window (opened at 4 s)
    assert.deepEqual(sent(), ['sumo+2', 'chess+1']);
    await advance(60_000);
    assert.deepEqual(sent(), ['sumo+2', 'chess+1'], 'no empty batches');
    assert.equal(clock.pending(), 0, 'no timer left when idle');
    assert.equal(counter.unrecorded(), 0);
  });

  it('a batch of 100 goes out at once; never more than 1000 per call; the next batch opens a new 10 s window', async () => {
    const { counter, sent, advance } = setup();
    for (let i = 0; i < 99; i++) counter.record('sumo');
    await advance(0);
    assert.deepEqual(sent(), []);
    counter.record('sumo');
    await advance(0);
    assert.deepEqual(sent(), ['sumo+100'], 'the 100th visit sends the batch');

    counter.record('sumo', 2500);
    await advance(0);
    assert.deepEqual(sent(), ['sumo+100', 'sumo+1000', 'sumo+1000', 'sumo+500'], 'split at the RPC limit');

    counter.record('sumo');
    await advance(9999);
    assert.equal(sent().length, 4);
    await advance(1);
    assert.deepEqual(sent().at(-1), 'sumo+1');
  });

  it('visits arriving while a call is in flight wait for it and go in the next batch', async () => {
    const { fake, counter, sent, advance, clock } = setup();
    counter.record('sumo');
    fake.holding = true;
    clock.advance(10_000);
    await flush();
    counter.record('sumo');
    counter.record('sumo');
    clock.advance(30_000);
    await flush();
    assert.deepEqual(sent(), ['sumo+1'], 'one call per game at a time');
    fake.holding = false;
    fake.release();
    await counter.settled();
    await advance(10_000);
    assert.deepEqual(sent(), ['sumo+1', 'sumo+2']);
  });

  it('retries transient failures after 1 s, 5 s and 30 s, then drops the batch; logs once per outage', async () => {
    const { fake, counter, sent, advance, logs } = setup();
    fake.failing = true;
    counter.record('sumo', 3);
    await advance(10_000);
    assert.deepEqual(sent(), ['sumo+3']);
    counter.record('sumo'); // waits for the failed batch
    await advance(999);
    assert.equal(sent().length, 1);
    await advance(1); // 1 s
    await advance(5000); // 5 s
    assert.deepEqual(sent(), ['sumo+3', 'sumo+3', 'sumo+3']);
    await advance(30_000); // 30 s: the fourth and last attempt
    assert.deepEqual(sent(), ['sumo+3', 'sumo+3', 'sumo+3', 'sumo+3']);
    assert.equal(logs.length, 2, 'the outage once, then the drop');
    assert.match(logs[0]!, /^\[visits\] recording 3 visit\(s\) of sumo failed \(fake server_record_visits failure\)/);
    assert.match(logs[1]!, /^\[visits\] dropped 3 visit\(s\) of sumo after 4 attempt\(s\)/);

    // The visit that arrived meanwhile is sent in its own batch; recovery is logged.
    fake.failing = false;
    await advance(10_000);
    assert.deepEqual(sent().at(-1), 'sumo+1');
    assert.match(logs.at(-1)!, /^\[visits\] recording recovered/);
    assert.equal(counter.unrecorded(), 0);
  });

  it('NOT_FOUND (an unknown game, e.g. hello) is permanent: logged once, never retried, later visits never sent', async () => {
    const { counter, sent, advance, logs, clock } = setup({
      [RPC]: (args: { p_game_id: string }) => {
        if (args.p_game_id === 'hello') throw notFound('hello');
        return null;
      },
    });
    counter.record('hello', 2);
    counter.record('sumo');
    await advance(10_000);
    assert.deepEqual(sent().sort(), ['hello+2', 'sumo+1']);
    await advance(120_000);
    for (let i = 0; i < 150; i++) counter.record('hello');
    await advance(120_000);
    assert.deepEqual(sent().sort(), ['hello+2', 'sumo+1'], 'no retry, no new batch');
    assert.equal(counter.unrecorded('hello'), 0);
    assert.deepEqual(logs, [
      '[visits] hello is not a catalog game (rpc server_record_visits: HTTP 400 NOT_FOUND: game hello): its visits are not recorded',
    ]);
    assert.equal(clock.pending(), 0);
  });

  it('other permanent errors (INVALID, a rejected key) drop the batch without a retry', async () => {
    const { counter, sent, advance, logs } = setup({
      [RPC]: () => {
        throw new ServiceRpcError(`rpc ${RPC}: HTTP 400 INVALID: count`, 400, '22023');
      },
    });
    counter.record('sumo');
    await advance(60_000);
    assert.deepEqual(sent(), ['sumo+1']);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /dropped 1 visit\(s\) of sumo after 1 attempt\(s\).*INVALID/);
  });

  it('without a service key: a dry run that logs in development, nothing otherwise', async () => {
    assert.ok(createDefaultVisitCounter({ mode: 'development' }, null) instanceof VisitCounter);
    assert.equal(createDefaultVisitCounter({ mode: 'test' }, null), null);
    assert.equal(createDefaultVisitCounter({ mode: 'production' }, null), null);

    const clock = fakeClock();
    const lines: string[] = [];
    const counter = new VisitCounter(
      dryRunVisitApi((m) => lines.push(m)),
      { timers: clock },
    );
    counter.record('sumo');
    counter.record('sumo');
    clock.advance(10_000);
    await flush();
    await counter.settled();
    assert.deepEqual(lines, ['[visits] (no service key) sumo +2']);
  });

  it('shutdown sends everything pending (and failed batches) at once, one call per game, then stops', async () => {
    const { fake, counter, sent, advance, clock, logs } = setup();
    fake.failing = true;
    counter.record('chess', 4);
    await advance(10_000); // fails, waits 1 s for a retry
    fake.failing = false;
    counter.record('sumo', 3);
    counter.record('chess');
    await counter.shutdown();
    assert.deepEqual(sent(), ['chess+4', 'chess+5', 'sumo+3'], 'the failed batch and the new visits together');
    assert.equal(counter.unrecorded(), 0);
    assert.equal(clock.pending(), 0, 'no timer left');
    assert.equal(logs.length, 2, 'the outage and the recovery, nothing lost');
    assert.match(logs[1]!, /recovered/);
  });

  it('shutdown gives up after shutdownTimeoutMs when Supabase hangs, and says what was lost', async () => {
    const { fake, counter, clock, logs } = setup({}, { shutdownTimeoutMs: 500 });
    fake.holding = true;
    counter.record('sumo', 7);
    const done = counter.shutdown();
    await flush();
    clock.advance(500);
    await done;
    assert.deepEqual(logs, ['[visits] shutdown: 7 visit(s) not recorded (gave up after 500 ms)']);
    fake.holding = false;
    fake.release();
    await counter.settled();
  });

  it("the server's graceful shutdown hook flushes the process counter", async () => {
    const colyseus = await testServer();
    const { counter, sent } = setup();
    configureVisitCounter(counter);
    try {
      counter.record('sumo', 2);
      // What Colyseus runs after disposing the rooms on SIGINT / SIGTERM (`server.onShutdown`).
      const hook = (colyseus.server as unknown as { onShutdownCallback: () => Promise<void> }).onShutdownCallback;
      await hook();
      assert.deepEqual(sent(), ['sumo+2']);
      await shutdownVisits(); // idempotent: nothing left
      assert.deepEqual(sent(), ['sumo+2']);
    } finally {
      configureVisitCounter(null);
    }
  });
});

describe('RallyRoom → visits', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const secret = 'test-secret-with-at-least-32-characters!!';
  const USER = '6f1c1c2e-0d1b-4d55-9a57-3b8a2d0e9f01';
  let t: ReturnType<typeof setup>;

  const signIn = async () => {
    colyseus.sdk.auth.token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
  };

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => {
    RallyRoom.configureAuth(createAuthenticator({ jwtSecret: secret, allowGuests: true }));
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
    t = setup(); // the fake clock never fires on its own: visits stay pending until the test advances it
    RallyRoom.configureVisits(t.counter);
  });
  afterEach(async () => {
    RallyRoom.configureVisits(null);
    RallyRoom.configureAuth(null);
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });
  after(() => {
    RallyRoom.configureVisits(undefined);
  });

  it('each join is a visit; a reconnection within the grace is not; a rejoin after the grace is', async () => {
    await signIn();
    const alice = await colyseus.sdk.joinOrCreate('hello', {});
    colyseus.sdk.auth.token = '';
    const bob = await colyseus.sdk.joinOrCreate('hello', { username: 'Bob' });
    for (const r of [alice, bob]) r.onMessage('hello', () => {});
    assert.equal(alice.roomId, bob.roomId);
    const room = colyseus.getRoomById<RallyRoom>(alice.roomId);
    await waitFor(() => t.counter.unrecorded('hello') === 2, 'two visits');

    // Drop and reconnect inside the grace (what the shell's rejoin sheet does): same seat, no visit.
    alice.reconnection.enabled = false;
    const id = alice.sessionId;
    const full = alice.reconnectionToken;
    const reconnectionToken = full.slice(full.indexOf(':') + 1);
    room.clients.get(id)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await waitFor(() => !room.isConnected(id), 'alice dropped');
    const res = await colyseus.http.post(`/matchmake/reconnect/${alice.roomId}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reconnectionToken }),
    });
    const back = await colyseus.sdk.consumeSeatReservation({
      ...(res.data as object),
      reconnectionToken,
    } as Parameters<typeof colyseus.sdk.consumeSeatReservation>[0]);
    back.onMessage('hello', () => {});
    assert.equal(back.sessionId, id);
    await waitFor(() => room.isConnected(id), 'alice back');
    assert.equal(t.counter.unrecorded('hello'), 2, 'a reconnection is not a visit');

    // A fresh join while her old seat is still inside its grace (a second tab, a lost token): not a visit either.
    back.reconnection.enabled = false;
    room.reconnectSeconds = 0.3;
    room.clients.get(id)!.leave(CloseCode.MAY_TRY_RECONNECT);
    await waitFor(() => !room.isConnected(id), 'alice dropped again');
    await signIn();
    const second = await colyseus.sdk.joinById(alice.roomId, {});
    second.onMessage('hello', () => {});
    assert.equal(room.seatCount, 3);
    assert.equal(t.counter.unrecorded('hello'), 2, 'still holds a seat here');

    // The grace runs out, she leaves for good, and joins again: a new visit.
    await waitFor(() => room.seatCount === 2, 'held seat freed after the grace');
    await second.leave();
    await waitFor(() => room.seatCount === 1, 'alice gone');
    const again = await colyseus.sdk.joinById(alice.roomId, {});
    again.onMessage('hello', () => {});
    await waitFor(() => t.counter.unrecorded('hello') === 3, 'rejoin after the grace counted');

    await t.advance(10_000);
    assert.deepEqual(t.sent(), ['hello+3']);
  });

  it('two rooms of one game share a batch; two games are batched apart', async () => {
    const a = await colyseus.sdk.create('sumo', { username: 'A' });
    const b = await colyseus.sdk.create('sumo', { username: 'B' });
    const h = await colyseus.sdk.joinOrCreate('hello', { username: 'H' });
    for (const r of [a, b]) r.onMessage('fx', () => {});
    h.onMessage('hello', () => {});
    assert.notEqual(a.roomId, b.roomId);
    await waitFor(() => t.counter.unrecorded() === 3, 'three visits');
    assert.equal(t.counter.unrecorded('sumo'), 2);
    await t.advance(10_000);
    assert.deepEqual(t.sent().sort(), ['hello+1', 'sumo+2']);
  });
});
