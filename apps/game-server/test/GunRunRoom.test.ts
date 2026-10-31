import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { SignJWT } from 'jose';
import {
  FINAL_TIER,
  LADDER,
  type FxBatch,
  type FxEvent,
  type GunRunStateView,
  type MatchSummary,
  type ResultMessage,
  type Standing,
} from '@rally/game-gunrun-server';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { setMatchResultSink, type MatchResult, type RecordedMatch } from '../src/results.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { gunRunMatchResult, gunRunResultFor, type GunRunRoom } from '../src/rooms/GunRunRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { SERVER_VERSION } from '../src/version.js';
import { waitFor } from './fakes.js';
import { testServer } from './server.js';

/** Fast rules so a match fits in a test. */
const FAST = { startingTime: 0.2, overTime: 0.6, respawnTime: 0.3, protectionTime: 0.1 };
const ANN = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const secret = 'test-secret-with-at-least-32-characters!!';

const view = (r: { state: unknown }) => r.state as GunRunStateView;
const sendRaw = (r: unknown, type: string, message: unknown) =>
  (r as { send(type: string, message: unknown): void }).send(type, message);
const me = (r: { state: unknown; sessionId: string }) => view(r).players.get(r.sessionId)!;

describe('GunRunRoom', () => {
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
  beforeEach(async () => {
    results = [];
    answer = () => null;
    RallyRoom.configureAuth(null);
    resetRateLimits();
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });
  /** Every client room a test opened: left with consent afterwards, so no socket is closed from the server side. */
  let opened: { leave(consented?: boolean): Promise<unknown> }[] = [];
  beforeEach(() => {
    opened = [];
  });
  afterEach(async () => {
    await Promise.all(opened.map((r) => r.leave(true).catch(() => {})));
    RallyRoom.configureAuth(null);
    colyseus.sdk.auth.token = '';
  });

  async function join(username: string, options: Record<string, unknown> = {}) {
    const room = await colyseus.sdk.joinOrCreate('gunrun', { username, ...options });
    opened.push(room);
    const fx: FxEvent[] = [];
    const got: ResultMessage[] = [];
    room.onMessage('fx', (b: FxBatch) => fx.push(...b.e));
    room.onMessage('result', (m: ResultMessage) => got.push(m));
    await room.waitForInitialState();
    sendRaw(room, 'profile', { username });
    return { room, fx, results: got };
  }

  const token = (sub: string) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));

  it('quick play fills with bots to four: a lone player gets a match at once; bots leave as humans join', async () => {
    const a = await join('Alice', { rules: FAST });
    const server = colyseus.getRoomById<GunRunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).players.size === 4, 'three bots');
    const bots = [...server.match.players.values()].filter((p) => p.bot);
    assert.equal(bots.length, 3);
    await waitFor(() => view(a.room).phase === 'playing', 'the match started');
    await waitFor(() => me(a.room).name === 'guest-Alice', 'renamed');
    assert.equal(me(a.room).guest, true);
    assert.equal(me(a.room).bot, false);
    assert.ok(
      [...bots].every((b) => view(a.room).players.get(b.id)!.bot),
      'bots are marked',
    );
    assert.deepEqual(
      {
        gameId: server.metadata.gameId,
        players: server.metadata.players,
        maxPlayers: server.metadata.maxPlayers,
        private: server.metadata.private,
        phase: server.metadata.phase,
        bots: server.metadata.bots,
        serverVersion: server.metadata.serverVersion,
      },
      {
        gameId: 'gunrun',
        players: 1,
        maxPlayers: 8,
        private: false,
        phase: 'playing',
        bots: 3,
        serverVersion: SERVER_VERSION,
      },
    );
    assert.equal(SERVER_VERSION, 4);
    const b = await join('Bob');
    assert.equal(b.room.roomId, a.room.roomId);
    await waitFor(() => view(a.room).players.size === 4 && server.botCount === 2, 'a bot made room for Bob');
    // Bob joined a match under way: he spawns a moment later.
    await waitFor(() => me(b.room)?.alive === true, 'Bob spawned');
  });

  it('validates inputs: moves, aims and fires; acks the sequence; drops garbage, stale and excess messages', async () => {
    const a = await join('Alice', { rules: { ...FAST, startingTime: 30 }, bots: 1 });
    const server = colyseus.getRoomById<GunRunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'starting', 'get ready');
    sendRaw(a.room, 'dev', { cmd: 'start' });
    const x0 = me(a.room).x;
    sendRaw(a.room, 'input', { mx: 5, my: 0, ax: 0, ay: -1, fire: false, melee: false, rt: 0, s: 1 });
    await waitFor(() => me(a.room).ack === 1, 'ack 1');
    assert.deepEqual(server.match.players.get(a.room.sessionId)!.input.move, { x: 1, y: 0 }, 'clamped');
    await waitFor(() => Math.abs(me(a.room).x - x0) > 0.5, 'moved');
    sendRaw(a.room, 'input', { mx: 'left', my: 0, ax: 0, ay: 0, fire: false, s: 2 });
    sendRaw(a.room, 'input', { mx: 0, my: 1, ax: 0, ay: 0, fire: false, s: 1 }); // stale
    sendRaw(a.room, 'input', null);
    await server.waitForNextPatch();
    assert.deepEqual(server.match.players.get(a.room.sessionId)!.input.move, { x: 1, y: 0 });
    for (let s = 10; s < 55; s++) sendRaw(a.room, 'input', { mx: 0, my: 0, ax: 1, ay: 0, fire: false, rt: 0, s });
    await waitFor(() => (me(a.room)?.ack ?? 0) >= 10, 'some applied');
    await server.waitForNextPatch(100);
    assert.ok(me(a.room).ack < 54, `excess inputs dropped (ack ${me(a.room).ack})`);
    assert.equal(server.clients.length, 1, 'not disconnected');
  });

  it('a pistol kill: every client sees the shot, hit and kill effects; three kills promote (the tier fx)', async () => {
    const a = await join('Alice', { rules: FAST, bots: 0 });
    const b = await join('Bob');
    assert.equal(b.room.roomId, a.room.roomId);
    const server = colyseus.getRoomById<GunRunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'playing', 'playing');
    sendRaw(a.room, 'dev', { cmd: 'setTier', tier: 0, kills: 2 });
    sendRaw(a.room, 'dev', { cmd: 'place', x: -3, y: 0.2, aim: 0 });
    sendRaw(b.room, 'dev', { cmd: 'place', x: 2, y: 0.2 });
    sendRaw(a.room, 'dev', { cmd: 'hurt', name: 'guest-Bob', damage: 70 });
    await waitFor(() => me(b.room).hp === 30 && !me(b.room).prot, 'Bob hurt and out of protection');
    sendRaw(a.room, 'input', { mx: 0, my: 0, ax: 1, ay: 0, fire: true, melee: false, rt: view(a.room).tick, s: 1 });
    await waitFor(() => b.fx.some((e) => e.k === 'kill'), 'kill fx for Bob');
    sendRaw(a.room, 'input', { mx: 0, my: 0, ax: 1, ay: 0, fire: false, melee: false, rt: view(a.room).tick, s: 2 });
    const kill = b.fx.find((e) => e.k === 'kill') as Extract<FxEvent, { k: 'kill' }>;
    const slotA = me(a.room).slot;
    assert.equal(kill.by, slotA);
    assert.equal(kill.w, 0, 'the pistol');
    assert.ok(Number.isInteger(kill.x) && Number.isInteger(kill.y), 'positions in hundredths');
    assert.ok(b.fx.some((e) => e.k === 'shot' && e.p === slotA));
    assert.ok(b.fx.some((e) => e.k === 'hit' && e.by === slotA));
    await waitFor(() => b.fx.some((e) => e.k === 'tier' && e.p === slotA && e.tier === 1 && e.up), 'promoted');
    await waitFor(() => view(b.room).players.get(a.room.sessionId)!.tier === 1, 'tier in the state');
    assert.equal(server.match.weaponOf(server.match.players.get(a.room.sessionId)!).id, LADDER[1]);
    await waitFor(() => me(b.room).alive, 'Bob respawned');
  });

  it('a knife win ends the match: results with boards for the signed-in winner, the guest notice, no bots', async () => {
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
          wins: 1,
          losses: 0,
          boards: { wins: { score: 4, rank: 2 }, kills: { score: 9, rank: 7 } },
          unlocked: [{ key: 'first_win', title: 'Top Gun', icon: '🏆' }],
        },
      },
    });
    colyseus.sdk.auth.token = await token(ANN);
    const ann = await join('ignored', { rules: { ...FAST, overTime: 2 }, bots: 1 });
    colyseus.sdk.auth.token = '';
    const zed = await join('Zed');
    assert.equal(zed.room.roomId, ann.room.roomId);
    const server = colyseus.getRoomById<GunRunRoom>(ann.room.roomId);
    await waitFor(() => view(ann.room).phase === 'playing', 'playing');
    await waitFor(() => me(ann.room).name === 'ann' && !me(ann.room).prot && !me(zed.room).prot, 'unprotected');
    sendRaw(ann.room, 'dev', { cmd: 'freeze', on: true });
    sendRaw(ann.room, 'dev', { cmd: 'giveKills', n: 5 });
    sendRaw(ann.room, 'dev', { cmd: 'setTier', tier: FINAL_TIER });
    sendRaw(ann.room, 'dev', { cmd: 'place', x: 0, y: 0.2, aim: 0 });
    sendRaw(zed.room, 'dev', { cmd: 'place', x: 1.0, y: 0.2 });
    await waitFor(() => me(ann.room).tier === FINAL_TIER, 'on the knife');
    sendRaw(ann.room, 'input', { mx: 0, my: 0, ax: 1, ay: 0, fire: true, melee: false, rt: view(ann.room).tick, s: 1 });
    await waitFor(() => results.length === 1, 'match reported');
    await waitFor(() => view(zed.room).phase === 'over', 'the winner banner');
    assert.equal(view(zed.room).winner, ann.room.sessionId);
    const r = results[0]!;
    assert.equal(r.gameId, 'gunrun');
    assert.equal(r.matchId, `${ann.room.roomId}:1`);
    assert.equal(r.winnerUserId, ANN);
    assert.deepEqual(r.leaderboardDeltas, { wins: { [ANN]: 1 } }, 'a total board: one win');
    assert.deepEqual(r.leaderboardScores, { kills: { [ANN]: 6 } }, 'a best board: the match kills');
    assert.equal(r.players.length, 2, 'the bot is not in the result');
    const byName = Object.fromEntries(r.players.map((p) => [p.username, p]));
    assert.deepEqual(byName.ann!.achievements, ['first_win', 'flawless']);
    assert.equal(byName.ann!.placement, 1);
    assert.equal(byName['guest-Zed']!.guest, true);
    assert.equal((r.details as { reason: string }).reason, 'knife');
    await waitFor(() => ann.results.length === 1 && zed.results.length === 1, 'result messages');
    assert.deepEqual(ann.results[0], {
      matchId: r.matchId,
      recorded: true,
      boards: { wins: { score: 4, rank: 2 }, kills: { score: 9, rank: 7 } },
      unlocked: [{ key: 'first_win', title: 'Top Gun', icon: '🏆' }],
    });
    assert.deepEqual(zed.results[0], { matchId: r.matchId, recorded: false, reason: 'guest' });
    assert.ok(zed.fx.some((e) => e.k === 'win' && e.p === me(ann.room).slot));
    // ...then the next match by itself.
    await waitFor(() => view(ann.room).match === 2, 'next match', 5000);
    assert.equal(server.match.players.get(ann.room.sessionId)!.tier, 0);
  });

  it('private rooms: a code, no bots, hidden from the listing, wait for `start`; joinById needs the code', async () => {
    const pub = await join('Pub', { bots: 0 });
    const host = await join('Host', { private: true, rules: FAST });
    assert.notEqual(host.room.roomId, pub.room.roomId);
    const code = view(host.room).code;
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    const list = (await colyseus.http.get('/rooms/gunrun')).data as { rooms: { roomId: string }[] };
    assert.deepEqual(
      list.rooms.map((x) => x.roomId),
      [pub.room.roomId],
    );
    await assert.rejects(colyseus.sdk.joinById(host.room.roomId, { username: 'Snoop' }), /not found/);
    const friend = await colyseus.sdk.joinById(host.room.roomId, { username: 'Friend', code });
    opened.push(friend);
    friend.onMessage('fx', () => {});
    friend.onMessage('result', () => {});
    await waitFor(() => view(host.room).players.size === 2, 'friend in');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(view(host.room).phase, 'waiting', 'waits for the crew');
    let bots = 0;
    view(host.room).players.forEach((p) => (bots += p.bot ? 1 : 0));
    assert.equal(bots, 0, 'no bots in private rooms');
    sendRaw(friend, 'start', {});
    await waitFor(() => view(host.room).phase === 'starting' || view(host.room).phase === 'playing', 'started');
  });

  it('a room holds eight; a ninth player gets another room', async () => {
    const first = await join('P1', { bots: 0 });
    for (let i = 2; i <= 8; i++) {
      const p = await join(`P${i}`);
      assert.equal(p.room.roomId, first.room.roomId);
    }
    await waitFor(() => view(first.room).players.size === 8, 'eight seated');
    const slots = new Set<number>();
    view(first.room).players.forEach((p) => slots.add(p.slot));
    assert.equal(slots.size, 8, 'eight different colours');
    const ninth = await join('P9');
    assert.notEqual(ninth.room.roomId, first.room.roomId);
  });

  it('patch bandwidth with eight players running and shooting (logged)', async function () {
    this.timeout(20000);
    const a = await join('Alice', { rules: { ...FAST, timeLimit: 3600 }, bots: 7 });
    const server = colyseus.getRoomById<GunRunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).players.size === 8 && view(a.room).phase === 'playing', 'eight playing');
    // Alice runs in circles firing the SMG; the seven bots fight each other and her.
    sendRaw(a.room, 'dev', { cmd: 'god', on: true });
    sendRaw(a.room, 'dev', { cmd: 'setTier', tier: LADDER.indexOf('smg') });
    const conn = (a.room as unknown as { connection: { events: { onmessage: (e: { data: ArrayBuffer }) => void } } })
      .connection;
    const orig = conn.events.onmessage;
    const bytes = { patch: 0, fx: 0, other: 0, patches: 0 };
    let counting = false;
    conn.events.onmessage = (e) => {
      if (counting) {
        const u8 = new Uint8Array(e.data);
        if (u8[0] === 15) [bytes.patch, bytes.patches] = [bytes.patch + u8.byteLength, bytes.patches + 1];
        else if (u8[0] === 13) bytes.fx += u8.byteLength;
        else bytes.other += u8.byteLength;
      }
      orig(e);
    };
    let s = 1;
    const drive = setInterval(() => {
      const ang = s * 0.15;
      sendRaw(a.room, 'input', {
        mx: Math.cos(ang),
        my: Math.sin(ang),
        ax: Math.cos(ang * 3),
        ay: Math.sin(ang * 3),
        fire: true,
        melee: false,
        rt: view(a.room).tick,
        s: s++,
      });
    }, 50);
    await new Promise((r) => setTimeout(r, 500));
    counting = true;
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 4000));
    counting = false;
    const secs = (Date.now() - t0) / 1000;
    clearInterval(drive);
    conn.events.onmessage = orig;
    const perSec = (n: number) => Math.round(n / secs);
    console.info(
      `      [bandwidth] 8 players: patches ${perSec(bytes.patch)} B/s (${Math.round(bytes.patch / Math.max(1, bytes.patches))} B × ${(bytes.patches / secs).toFixed(1)}/s), ` +
        `fx ${perSec(bytes.fx)} B/s, other ${perSec(bytes.other)} B/s → ${((perSec(bytes.patch + bytes.fx + bytes.other) * 8) / 1000).toFixed(0)} kbit/s per client`,
    );
    assert.equal(server.match.players.size, 8);
    assert.ok(bytes.patches / secs > 15, 'about 20 patches a second');
    assert.ok(perSec(bytes.patch) < 8_000, `patches stay under 8 KB/s (${perSec(bytes.patch)})`);
    assert.ok(bytes.fx > 0, 'effects of the fight');
  });
});

describe('Gun Run result mapping', () => {
  const st = (over: Partial<Standing>): Standing => ({
    id: 's1',
    name: 'ann',
    slot: 0,
    bot: false,
    tier: 0,
    tierKills: 0,
    kills: 0,
    deaths: 0,
    knifeKills: 0,
    barrelKills: 0,
    bestBlast: 0,
    placement: 1,
    ...over,
  });
  const summary: MatchSummary = {
    match: 1,
    duration: 241.25,
    winner: 'bot:1',
    reason: 'knife',
    standings: [
      st({ id: 'bot:1', name: 'Ace', bot: true, tier: 8, kills: 30, placement: 1 }),
      st({ id: 's1', name: 'ann', tier: 6, kills: 12, placement: 2 }),
      st({ id: 's2', name: 'guest-Zed', tier: 3, kills: 4, placement: 3 }),
    ],
  };
  const base = {
    matchId: 'r:1',
    gameId: 'gunrun',
    roomId: 'r',
    private: false,
    startedAt: '2026-10-31T00:00:00.000Z',
    endedAt: '2026-10-31T00:04:01.000Z',
  };
  const auth = (id: string) =>
    id === 's1' ? { userId: ANN, guest: false } : id === 's2' ? { userId: 'guest:zed', guest: true } : undefined;

  it('a bot winner: no winner on the boards, bots left out, humans keep their placement and kills', () => {
    const { result, seats } = gunRunMatchResult(summary, base, auth);
    assert.equal(result.winnerUserId, null);
    assert.deepEqual(result.leaderboardDeltas, {});
    assert.deepEqual(result.leaderboardScores, { kills: { [ANN]: 12 } });
    assert.deepEqual(
      result.players.map((p) => [p.username, p.placement, p.guest]),
      [
        ['ann', 2, false],
        ['guest-Zed', 3, true],
      ],
    );
    assert.deepEqual(
      seats.map((s) => s.sessionId),
      ['s1', 's2'],
    );
    assert.equal(result.durationSec, 241.3);
  });

  it('result messages: guest, unavailable (no write, duplicate, no entry), recorded', () => {
    assert.deepEqual(gunRunResultFor('m:1', { userId: 'guest:x', guest: true }, undefined), {
      matchId: 'm:1',
      recorded: false,
      reason: 'guest',
    });
    const ann = { userId: ANN, guest: false };
    for (const rec of [null, { duplicate: true } as const, { duplicate: false, players: {} } as const]) {
      assert.deepEqual(gunRunResultFor('m:1', ann, rec), { matchId: 'm:1', recorded: false, reason: 'unavailable' });
    }
    assert.deepEqual(
      gunRunResultFor('m:1', ann, {
        duplicate: false,
        players: { [ANN]: { wins: 1, losses: 0, boards: { wins: { score: 1, rank: 1 } }, unlocked: [] } },
      }),
      { matchId: 'm:1', recorded: true, boards: { wins: { score: 1, rank: 1 } }, unlocked: [] },
    );
  });
});
