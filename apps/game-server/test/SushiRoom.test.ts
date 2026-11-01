import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { SignJWT } from 'jose';
import {
  BELT_LENGTH,
  BELT_SLOTS,
  Kind,
  SEATS,
  STATIONS,
  Zone,
  beltPoint,
  decodeItem,
  type DaySummary,
  type FxBatch,
  type FxEvent,
  type ResultMessage,
  type SushiStateView,
} from '@rally/game-sushi-server';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { setMatchResultSink, type MatchResult, type RecordedMatch } from '../src/results.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { sushiDayResult, sushiResultFor, type SushiRoom } from '../src/rooms/SushiRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { SERVER_VERSION } from '../src/version.js';
import { waitFor } from './fakes.js';
import { testServer } from './server.js';

/** Fast phases so a day fits in a test; customers only when a test asks for them. */
const FAST = { morningTime: 0.3, lobbyTime: 0.1, voteTime: 1.5, noArrivals: true };
const ANN = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const secret = 'test-secret-with-at-least-32-characters!!';

const view = (r: { state: unknown }) => r.state as SushiStateView;
const sendRaw = (r: unknown, type: string, message: unknown) =>
  (r as { send(type: string, message: unknown): void }).send(type, message);
const me = (r: { state: unknown; sessionId: string }) => view(r).players.get(r.sessionId)!;

describe('SushiRoom', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let results: MatchResult[] = [];
  let answer: (m: MatchResult) => RecordedMatch | null = () => null;
  let restoreSink: ReturnType<typeof setMatchResultSink>;

  before(async () => {
    colyseus = await testServer();
    restoreSink = setMatchResultSink((r) => {
      results.push(r);
      return answer(r);
    });
  });
  after(async () => {
    setMatchResultSink(restoreSink);
    await colyseus.cleanup();
  });
  let opened: { leave(consented?: boolean): Promise<unknown> }[] = [];
  beforeEach(async () => {
    results = [];
    answer = () => null;
    opened = [];
    RallyRoom.configureAuth(null);
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });
  afterEach(async () => {
    await Promise.all(opened.map((r) => r.leave(true).catch(() => {})));
    RallyRoom.configureAuth(null);
    colyseus.sdk.auth.token = '';
  });

  async function join(username: string, options: Record<string, unknown> = {}) {
    const room = await colyseus.sdk.joinOrCreate('sushi', { username, ...options });
    opened.push(room);
    const fx: FxEvent[] = [];
    const got: ResultMessage[] = [];
    room.onMessage('fx', (b: FxBatch) => fx.push(...b.e));
    room.onMessage('result', (m: ResultMessage) => got.push(m));
    await room.waitForInitialState();
    sendRaw(room, 'profile', { username });
    return { room, fx, results: got };
  }

  let seq = 0;
  /** A tap on `target` (press and release in one input). */
  const tap = (r: unknown, target: number, presses: number) =>
    sendRaw(r, 'input', { mx: 0, my: 0, b: 0, p: presses, t: target, s: ++seq });

  it('two chefs share one room; the run starts by itself; inputs move the chef, garbage and stale ones are dropped', async () => {
    const a = await join('Alice', { rules: FAST });
    const b = await join('Bob');
    assert.equal(b.room.roomId, a.room.roomId);
    const server = colyseus.getRoomById<SushiRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'open', 'the doors opened');
    await waitFor(() => view(b.room).players.size === 2 && me(a.room).name === 'guest-Alice', 'both chefs');
    assert.deepEqual([...[me(a.room).slot, me(b.room).slot]].sort(), [0, 1]);
    assert.equal(view(a.room).day, 1);
    assert.equal(view(a.room).stations.length, STATIONS.length);
    assert.equal(view(a.room).seats.length, SEATS.length);
    assert.equal(server.metadata.phase, 'open');
    assert.equal(server.metadata.day, 1);
    assert.equal(server.metadata.serverVersion, SERVER_VERSION);
    assert.equal(SERVER_VERSION, 5);
    const x0 = me(a.room).x;
    seq = 0;
    sendRaw(a.room, 'input', { mx: 3, my: 0, b: 0, p: 0, t: -1, s: ++seq });
    await waitFor(() => me(a.room).ack === seq, 'acked');
    assert.deepEqual(server.game.chefs.get(a.room.sessionId)!.input.move, { x: 1, y: 0 }, 'clamped');
    await waitFor(() => me(a.room).x > x0 + 0.5, 'moved');
    sendRaw(a.room, 'input', { mx: 'left', my: 0, b: 0, p: 0, s: seq + 1 });
    sendRaw(a.room, 'input', { mx: 0, my: 1, b: 0, p: 0, s: 0 }); // stale
    await server.waitForNextPatch();
    assert.deepEqual(server.game.chefs.get(a.room.sessionId)!.input.move, { x: 1, y: 0 });
  });

  it('a nigiri on the belt: the customer takes it (coin fx with the tip); closing the day reports it, guests are told', async () => {
    const a = await join('Alice', { rules: FAST });
    const server = colyseus.getRoomById<SushiRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'open', 'open');
    const stool = SEATS.find((s) => s.kind === 'stool' && s.rank === 0)!;
    sendRaw(a.room, 'dev', { cmd: 'customer', seat: stool.id, order: Kind.SalmonNigiri, patience: 120 });
    sendRaw(a.room, 'dev', { cmd: 'give', kind: Kind.SalmonNigiri, plated: true });
    sendRaw(a.room, 'dev', { cmd: 'place', x: -1, y: -1.6 });
    await waitFor(() => decodeItem(me(a.room).held)?.kind === Kind.SalmonNigiri, 'holding a plate');
    // The empty slot nearest the pass.
    const st = view(a.room);
    let slot = 0;
    let best = Infinity;
    for (let i = 0; i < BELT_SLOTS; i++) {
      const p = beltPoint(st.beltS + 0.3 + (i * BELT_LENGTH) / BELT_SLOTS);
      const d = Math.hypot(p.x + 1, p.y + 1.6);
      if (d < best) [slot, best] = [i, d];
    }
    tap(a.room, 200 + slot, 1);
    await waitFor(() => view(a.room).slots[slot]!.item !== 0, 'on the belt');
    await waitFor(() => a.fx.some((e) => e.k === 'coin'), 'the customer took it', 40_000);
    const coin = a.fx.find((e) => e.k === 'coin') as Extract<FxEvent, { k: 'coin' }>;
    assert.equal(coin.how, 'grab');
    assert.equal(coin.i, Kind.SalmonNigiri);
    assert.equal(coin.v, 120);
    assert.ok(coin.tip > 0);
    await waitFor(() => view(a.room).money === coin.v + coin.tip && view(a.room).served === 1, 'money in the state');
    sendRaw(a.room, 'dev', { cmd: 'close' });
    await waitFor(() => view(a.room).phase === 'night', 'night', 20_000);
    await waitFor(() => results.length === 1 && a.results.length === 1, 'the day reported');
    const r = results[0]!;
    assert.equal(r.gameId, 'sushi');
    assert.equal(r.matchId, `${a.room.roomId}:1:1`);
    assert.equal(r.winnerUserId, null, 'co-op: no winner');
    assert.deepEqual(r.leaderboardScores, {}, 'guests post no scores');
    assert.equal(r.players.length, 1);
    assert.deepEqual(a.results[0], { matchId: r.matchId, recorded: false, reason: 'guest' });
    const summary = JSON.parse(view(a.room).summary) as DaySummary;
    assert.equal(summary.served, 1);
    assert.equal(summary.perfect, true);
    assert.equal(server.game.phase, 'night');
    assert.equal(view(a.room).cards.split(',').length, 3, 'three cards');
    // The vote: one chef, one vote, the card applied, Tuesday's morning.
    sendRaw(a.room, 'vote', { i: 2 });
    const card = view(a.room).cards.split(',')[2]!;
    await waitFor(() => a.fx.some((e) => e.k === 'vote' && e.card === card), 'tallied');
    await waitFor(() => view(a.room).day === 2, 'Tuesday', 10_000);
    assert.ok(`${view(a.room).owned},${view(a.room).today}`.split(',').some((c) => c.split(':')[0] === card));
    assert.ok(a.fx.some((e) => e.k === 'morning' && e.d === 2 && e.teach.includes('rolls')));
    // A belt ride, a closing and a vote in real time: slower than the default on a loaded machine.
  }).timeout(60_000);

  it('dev commands: skip to Wednesday (the dining room opens), stars, a stale plate', async () => {
    const a = await join('Alice', { rules: FAST });
    await waitFor(() => view(a.room).phase === 'open', 'open');
    sendRaw(a.room, 'dev', { cmd: 'day', day: 3 });
    await waitFor(() => view(a.room).day === 3 && (view(a.room).zones & Zone.dining) !== 0, 'the dining room');
    sendRaw(a.room, 'dev', { cmd: 'stars', n: 2 });
    await waitFor(() => view(a.room).stars === 2, 'stars');
    sendRaw(a.room, 'dev', { cmd: 'belt', slot: 4, kind: Kind.Onigiri, age: 999 });
    await waitFor(() => view(a.room).slots[4]!.stale, 'stale');
    assert.ok(a.fx.some((e) => e.k === 'stale' && e.n === 4));
  });

  it('a signed-in chef: the day posts both best boards and the team achievements; their result comes back', async () => {
    RallyRoom.configureAuth(
      createAuthenticator({
        jwtSecret: secret,
        allowGuests: true,
        profiles: async () => ({ username: 'ann', avatarUrl: null }),
      }),
    );
    answer = () => ({
      duplicate: false,
      players: {
        [ANN]: {
          wins: 0,
          losses: 0,
          boards: { days: { score: 1, rank: 3 } },
          unlocked: [{ key: 'five_star_day', title: 'Five-Star Day', icon: '⭐' }],
        },
      },
    });
    colyseus.sdk.auth.token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(ANN)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    const ann = await join('ignored', { rules: FAST });
    colyseus.sdk.auth.token = '';
    await waitFor(() => view(ann.room).phase === 'open' && me(ann.room).name === 'ann', 'open');
    assert.equal(me(ann.room).uid, ANN, 'the People list gets the Rally id');
    assert.equal(me(ann.room).guest, false);
    sendRaw(ann.room, 'dev', { cmd: 'close' });
    await waitFor(() => results.length === 1 && ann.results.length === 1, 'reported');
    const r = results[0]!;
    assert.deepEqual(r.leaderboardScores, { days: { [ANN]: 1 } }, 'no tips: no tips score');
    assert.deepEqual(r.players[0]!.achievements, ['five_star_day']);
    assert.deepEqual(ann.results[0], {
      matchId: r.matchId,
      recorded: true,
      boards: { days: { score: 1, rank: 3 } },
      unlocked: [{ key: 'five_star_day', title: 'Five-Star Day', icon: '⭐' }],
    });
  });

  it('private rooms wait in the lobby (chefs can walk round) until `start`', async () => {
    const host = await join('Host', { private: true, rules: FAST });
    assert.match(view(host.room).code, /^[A-HJKMNP-Z2-9]{6}$/);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(view(host.room).phase, 'lobby');
    sendRaw(host.room, 'start', {});
    await waitFor(() => view(host.room).phase === 'morning' || view(host.room).phase === 'open', 'started');
    const list = (await colyseus.http.get('/rooms/sushi')).data as { rooms: unknown[] };
    assert.equal(list.rooms.length, 0, 'private rooms are not listed');
  });

  it('result helpers: guests are told at once; bots never appear in a day', () => {
    const summary: DaySummary = {
      run: 2,
      day: 4,
      duration: 150,
      earned: 3000,
      tips: 900,
      served: 12,
      angry: 1,
      stale: 0,
      gold: 0,
      perfect: false,
      fullHouse: true,
      stars: 4,
      closed: false,
      week: false,
      crew: [
        { id: 's1', name: 'ann', bot: false },
        { id: 'bot:1', name: 'Miso', bot: true },
      ],
    };
    const { result, seats } = sushiDayResult(
      summary,
      { matchId: 'r:2:4', gameId: 'sushi', roomId: 'r', private: false, startedAt: '', endedAt: '' },
      () => ({ userId: ANN, guest: false }),
    );
    assert.equal(seats.length, 1);
    assert.deepEqual(result.leaderboardScores, { days: { [ANN]: 4 }, tips: { [ANN]: 900 } });
    assert.deepEqual(result.players[0]!.achievements, ['belt_master', 'full_house']);
    assert.deepEqual(sushiResultFor('m', { userId: 'g', guest: true }, undefined), {
      matchId: 'm',
      recorded: false,
      reason: 'guest',
    });
  });
});
