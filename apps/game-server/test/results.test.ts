import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { SignJWT } from 'jose';
import type { ResultMessage, SumoStateView } from '@rally/game-sumo-server';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import {
  createSupabaseResultSink,
  isRetryable,
  loggingResultSink,
  reportMatchResult,
  setMatchResultSink,
  type MatchResult,
  type MatchResultSink,
  type RecordedMatch,
} from '../src/results.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { resultMessageFor, type SumoRoom } from '../src/rooms/SumoRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { ServiceRpcError, createServiceApi } from '../src/supabase.js';
import { fakeRpc, waitFor } from './fakes.js';
import { testServer } from './server.js';

const ANN = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const BEN = '1c8a7d3f-7b62-4d4a-8b9f-3c9a2c4d0e21';

function match(extra: Partial<MatchResult> = {}): MatchResult {
  return {
    matchId: 'room1:1',
    gameId: 'sumo',
    roomId: 'room1',
    private: false,
    winnerUserId: ANN,
    startedAt: '2026-10-30T10:00:00.000Z',
    endedAt: '2026-10-30T10:01:00.000Z',
    durationSec: 55,
    rounds: 3,
    leaderboardDeltas: { wins: { [ANN]: 1 } },
    players: [
      { userId: ANN, username: 'ann', guest: false, placement: 1, score: 3, achievements: ['first_win'] },
      { userId: 'guest:abc', username: 'guest-Zed', guest: true, placement: 2, score: 1, achievements: [] },
    ],
    ...extra,
  };
}

const RECORDED: RecordedMatch = {
  duplicate: false,
  players: {
    [ANN]: {
      wins: 14,
      losses: 6,
      boards: { wins: { score: 14, rank: 3 } },
      unlocked: [{ key: 'first_win', title: 'Yokozuna', icon: '🏆' }],
    },
  },
};

/** A sink's sleeps, recorded and resolved at once (no real waiting). */
function instantSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('results sink', () => {
  it('records through server_record_match with the match as p_match, and returns the answer', async () => {
    const rpc = fakeRpc({ server_record_match: RECORDED });
    const s = instantSleep();
    const sink = createSupabaseResultSink(createServiceApi(rpc.rpc), { sleep: s.sleep });
    assert.deepEqual(await sink(match()), RECORDED);
    assert.deepEqual(rpc.of('server_record_match'), [{ p_match: match() }]);
    assert.deepEqual(s.waits, [], 'no retry');
  });

  it('retries after 1 s, 5 s and 30 s with the same matchId (the RPC is idempotent), then succeeds', async () => {
    let calls = 0;
    const rpc = fakeRpc({ server_record_match: () => RECORDED });
    rpc.failing = () => ++calls <= 3;
    const s = instantSleep();
    const warnings: string[] = [];
    const sink = createSupabaseResultSink(createServiceApi(rpc.rpc), { sleep: s.sleep, warn: (m) => warnings.push(m) });
    assert.deepEqual(await sink(match()), RECORDED);
    assert.deepEqual(s.waits, [1000, 5000, 30_000]);
    assert.deepEqual(
      rpc.of('server_record_match').map((a) => (a.p_match as MatchResult).matchId),
      ['room1:1', 'room1:1', 'room1:1', 'room1:1'],
    );
    assert.match(warnings.at(-1)!, /room1:1 recorded on attempt 4/);
  });

  it('a duplicate answer (an earlier attempt landed) is passed through, not retried', async () => {
    const rpc = fakeRpc({ server_record_match: { duplicate: true } });
    const s = instantSleep();
    const sink = createSupabaseResultSink(createServiceApi(rpc.rpc), { sleep: s.sleep });
    assert.deepEqual(await sink(match()), { duplicate: true });
    assert.equal(rpc.calls.length, 1);
  });

  it('after the last failure logs UNRECORDED <json> for replay and resolves null', async () => {
    const rpc = fakeRpc();
    rpc.failing = true;
    const s = instantSleep();
    const errors: string[] = [];
    const sink = createSupabaseResultSink(createServiceApi(rpc.rpc), {
      sleep: s.sleep,
      warn: () => {},
      error: (m) => errors.push(m),
    });
    assert.equal(await sink(match()), null);
    assert.equal(rpc.calls.length, 4, 'one attempt and three retries');
    assert.deepEqual(s.waits, [1000, 5000, 30_000]);
    const line = errors.find((e) => e.startsWith('[results] UNRECORDED '))!;
    assert.deepEqual(JSON.parse(line.slice('[results] UNRECORDED '.length)), match());
  });

  it('does not retry answers that cannot change (INVALID, NOT_FOUND, a rejected key)', async () => {
    assert.equal(isRetryable(new ServiceRpcError('rpc x: timed out', 0)), true);
    assert.equal(isRetryable(new ServiceRpcError('rpc x: HTTP 503', 503)), true);
    assert.equal(isRetryable(new ServiceRpcError('rpc x: HTTP 429', 429)), true);
    assert.equal(isRetryable(new Error('socket hang up')), true);
    assert.equal(isRetryable(new ServiceRpcError('rpc x: HTTP 400 INVALID: …', 400, '22023')), false);
    assert.equal(isRetryable(new ServiceRpcError('rpc x: HTTP 401', 401)), false);

    const api = {
      calls: 0,
      async recordMatch(): Promise<RecordedMatch> {
        api.calls++;
        throw new ServiceRpcError('rpc server_record_match: HTTP 400 NOT_FOUND: game sumo', 400, 'P0002');
      },
    };
    const s = instantSleep();
    const errors: string[] = [];
    const sink = createSupabaseResultSink(api, { sleep: s.sleep, error: (m) => errors.push(m) });
    assert.equal(await sink(match()), null);
    assert.equal(api.calls, 1);
    assert.deepEqual(s.waits, []);
    assert.ok(errors.some((e) => e.startsWith('[results] UNRECORDED {')));
  });

  it('without a service client the match is logged, not recorded; reportMatchResult never throws', async () => {
    const lines: string[] = [];
    const prev = setMatchResultSink(loggingResultSink((m) => lines.push(m)));
    try {
      assert.equal(await reportMatchResult(match()), null);
      assert.match(lines[0]!, /^\[results\] \(no service key, not recorded\) sumo room1:1 winner=0b7f6f2e/);
      assert.deepEqual(JSON.parse(lines[1]!.slice('[results] '.length)), match());

      setMatchResultSink(() => {
        throw new Error('boom');
      });
      const errors: unknown[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      try {
        assert.equal(await reportMatchResult(match()), null);
      } finally {
        console.error = consoleError;
      }
      assert.equal(errors.length, 1);
    } finally {
      setMatchResultSink(prev);
    }
  });

  it('resultMessageFor: the player’s entry, the wins rank, or why there is none', () => {
    assert.deepEqual(resultMessageFor('m:1', { userId: ANN.toUpperCase(), guest: false }, RECORDED), {
      matchId: 'm:1',
      recorded: true,
      wins: 14,
      losses: 6,
      rank: 3,
      boards: { wins: { score: 14, rank: 3 } },
      unlocked: [{ key: 'first_win', title: 'Yokozuna', icon: '🏆' }],
    });
    // Saved but not on the board this time (short or private match, hourly cap).
    const noBoard: RecordedMatch = {
      duplicate: false,
      players: { [ANN]: { wins: 1, losses: 0, boards: {}, unlocked: [] } },
    };
    assert.equal((resultMessageFor('m:1', { userId: ANN, guest: false }, noBoard) as { rank: unknown }).rank, null);
    const guest = { matchId: 'm:1', recorded: false, reason: 'guest' };
    const unavailable = { matchId: 'm:1', recorded: false, reason: 'unavailable' };
    assert.deepEqual(resultMessageFor('m:1', { userId: 'guest:x', guest: true }, RECORDED), guest);
    // An anonymous Supabase user has a uuid but is a guest for results.
    assert.deepEqual(resultMessageFor('m:1', { userId: BEN, guest: true }, undefined), guest);
    assert.deepEqual(resultMessageFor('m:1', { userId: ANN, guest: false }, null), unavailable);
    assert.deepEqual(resultMessageFor('m:1', { userId: ANN, guest: false }, { duplicate: true }), unavailable);
    // Skipped by the RPC (banned, no profile): absent from players.
    assert.deepEqual(resultMessageFor('m:1', { userId: BEN, guest: false }, RECORDED), unavailable);
  });
});

describe('SumoRoom results', () => {
  const secret = 'test-secret-with-at-least-32-characters!!';
  const FAST = { countdownTime: 0.1, roundOverTime: 0.1, matchOverTime: 0.5, winsToMatch: 1 };
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let prevSink: MatchResultSink | undefined;

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => {
    RallyRoom.configureAuth(
      createAuthenticator({
        jwtSecret: secret,
        allowGuests: true,
        profiles: async (id) => ({ username: id === ANN ? 'ann' : 'ben', avatarUrl: null }),
      }),
    );
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
    prevSink = setMatchResultSink(undefined);
  });
  afterEach(() => {
    setMatchResultSink(prevSink);
    RallyRoom.configureAuth(null);
    colyseus.sdk.auth.token = '';
  });

  const token = (sub: string) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));

  /** Join as `sub` (a uuid) or as a guest (null), collecting `result` messages. */
  async function join(sub: string | null, options: Record<string, unknown> = {}) {
    colyseus.sdk.auth.token = sub ? await token(sub) : '';
    const room = await colyseus.sdk.joinOrCreate('sumo', { username: sub ? 'ignored' : 'Zed', ...options });
    const results: ResultMessage[] = [];
    /** The room's phase when each result arrived. */
    const phases: string[] = [];
    room.onMessage('fx', () => {});
    room.onMessage('result', (m: ResultMessage) => {
      results.push(m);
      phases.push((room.state as SumoStateView).phase);
    });
    await room.waitForInitialState();
    return { room, results, phases };
  }

  const state = (r: { state: unknown }) => r.state as SumoStateView;

  /** Ann wins round 1 (Ben, or whoever is `loserId`, is pushed off). */
  async function playMatch(host: Awaited<ReturnType<typeof join>>, loserId: string) {
    await waitFor(() => state(host.room).phase === 'playing', 'round start');
    const room = colyseus.getRoomById<SumoRoom>(host.room.roomId);
    room.match.players.get(loserId)!.x = 50;
    return room;
  }

  it('sends each player their own `result`: entry for signed-in players, the guest reason for guests', async () => {
    const seen: MatchResult[] = [];
    setMatchResultSink((m) => {
      seen.push(m);
      return {
        duplicate: false,
        players: {
          [ANN]: {
            wins: 14,
            losses: 6,
            boards: { wins: { score: 14, rank: 3 } },
            unlocked: RECORDED.players[ANN]!.unlocked,
          },
          [BEN]: { wins: 2, losses: 9, boards: {}, unlocked: [] },
        },
      } satisfies RecordedMatch;
    });
    const ann = await join(ANN, { rules: FAST });
    const ben = await join(BEN);
    const zed = await join(null);
    assert.equal(ben.room.roomId, ann.room.roomId);
    assert.equal(zed.room.roomId, ann.room.roomId);
    await playMatch(ann, ben.room.sessionId);
    // Zed is pushed off too, so Ann is the last one standing.
    colyseus.getRoomById<SumoRoom>(ann.room.roomId).match.players.get(zed.room.sessionId)!.x = -50;

    for (const p of [ann, ben, zed]) await waitFor(() => p.results.length === 1, 'a result each');
    const matchId = `${ann.room.roomId}:1`;
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.matchId, matchId);
    assert.deepEqual(ann.results[0], {
      matchId,
      recorded: true,
      wins: 14,
      losses: 6,
      rank: 3,
      boards: { wins: { score: 14, rank: 3 } },
      unlocked: [{ key: 'first_win', title: 'Yokozuna', icon: '🏆' }],
    });
    assert.deepEqual(ben.results[0], {
      matchId,
      recorded: true,
      wins: 2,
      losses: 9,
      rank: null,
      boards: {},
      unlocked: [],
    });
    assert.deepEqual(zed.results[0], { matchId, recorded: false, reason: 'guest' });
    // The messages arrive with the deciding round (state patches may lag them by a tick), before the room resets.
    for (const p of [ann, ben, zed])
      assert.ok(['playing', 'roundOver', 'matchOver'].includes(p.phases[0]!), p.phases[0]);
  });

  it('never blocks the room: guests hear at once, the match resets while the write is retried, then "unavailable"', async () => {
    let release!: (v: RecordedMatch | null) => void;
    const pending = new Promise<RecordedMatch | null>((r) => (release = r));
    setMatchResultSink(() => pending);
    const ann = await join(ANN, { rules: FAST });
    const zed = await join(null);
    await playMatch(ann, zed.room.sessionId);

    await waitFor(() => zed.results.length === 1, 'guest result without waiting for the write');
    assert.deepEqual(zed.results[0], { matchId: `${ann.room.roomId}:1`, recorded: false, reason: 'guest' });
    // The next match starts although the write has not answered.
    await waitFor(() => state(ann.room).phase === 'playing' && state(ann.room).round === 1, 'next match', 4000);
    assert.equal(ann.results.length, 0);

    release(null); // every attempt failed (UNRECORDED was logged by the sink)
    await waitFor(() => ann.results.length === 1, 'late result');
    assert.deepEqual(ann.results[0], { matchId: `${ann.room.roomId}:1`, recorded: false, reason: 'unavailable' });
  });

  it('a player who left before the write answered gets nothing; nobody else is affected', async () => {
    let release!: (v: RecordedMatch | null) => void;
    setMatchResultSink(() => new Promise<RecordedMatch | null>((r) => (release = r)));
    const ann = await join(ANN, { rules: FAST });
    const ben = await join(BEN);
    await playMatch(ann, ben.room.sessionId);
    await waitFor(() => typeof release === 'function', 'write started');
    await ben.room.leave(true);
    release(RECORDED);
    await waitFor(() => ann.results.length === 1, 'ann result');
    assert.equal(ann.results[0]!.recorded, true);
    assert.equal(ben.results.length, 0);
  });
});
