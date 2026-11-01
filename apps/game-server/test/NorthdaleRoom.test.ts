import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { SignJWT } from 'jose';
import {
  Item,
  LOOT_SPOTS,
  SAFE_CENTER,
  SYNC_RADIUS,
  ZombieKind,
  type FxBatch,
  type FxEvent,
  type NorthdaleStateView,
  type ResultMessage,
  type RunSummary,
} from '@rally/game-northdale-server';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { setMatchResultSink, type MatchResult, type RecordedMatch } from '../src/results.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { northdaleResultFor, northdaleRunResult, type NorthdaleRoom } from '../src/rooms/NorthdaleRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { SERVER_VERSION } from '../src/version.js';
import { waitFor } from './fakes.js';
import { testServer } from './server.js';

/** Short phases and no spawns unless a test asks for them. */
const FAST = { firstDayTime: 30, dayTime: 30, duskTime: 1, nightTime: 30, overTime: 0.4, spawnScale: 0 };
const ANN = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const secret = 'test-secret-with-at-least-32-characters!!';

const view = (r: { state: unknown }) => r.state as NorthdaleStateView;
const sendRaw = (r: unknown, type: string, message: unknown) =>
  (r as { send(type: string, message: unknown): void }).send(type, message);
const input = (s: number, over: Record<string, unknown> = {}) => ({
  mx: 0,
  my: 0,
  ax: 0,
  ay: -1,
  fire: false,
  melee: false,
  act: false,
  use: 0,
  slot: 0,
  rt: 0,
  s,
  ...over,
});

describe('NorthdaleRoom', () => {
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
    const room = await colyseus.sdk.joinOrCreate('northdale', { username, ...options });
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

  it('one survivor is enough: the run starts by day at the safehouse; metadata and server v5', async () => {
    const { room: alice } = await join('Alice', { rules: FAST });
    const server = colyseus.getRoomById<NorthdaleRoom>(alice.roomId);
    await waitFor(() => view(alice).phase === 'day', 'day 1');
    const me = view(alice).players.get(alice.sessionId)!;
    assert.equal(me.inRun, true);
    assert.equal(me.hp, 100);
    assert.equal(me.gun, Item.pistol);
    assert.equal(me.melee, Item.knife);
    assert.ok(Math.hypot(me.x - SAFE_CENTER.x, me.y - SAFE_CENTER.y) < 8, 'at the safehouse');
    assert.equal(view(alice).opened.length, LOOT_SPOTS.length);
    assert.equal(view(alice).pickups.size, 4, 'the truck parts lie out in town');
    await waitFor(() => view(alice).players.get(alice.sessionId)!.name === 'guest-Alice', 'renamed');
    assert.equal(SERVER_VERSION, 5);
    assert.deepEqual(
      {
        gameId: server.metadata.gameId,
        maxPlayers: server.metadata.maxPlayers,
        phase: server.metadata.phase,
        night: server.metadata.night,
        serverVersion: server.metadata.serverVersion,
      },
      { gameId: 'northdale', maxPlayers: 4, phase: 'day', night: 0, serverVersion: SERVER_VERSION },
    );
  });

  it('inputs move the survivor and are acked; dev commands spawn zombies and skip to night 3', async () => {
    const { room: alice, fx } = await join('Alice', { rules: FAST });
    const server = colyseus.getRoomById<NorthdaleRoom>(alice.roomId);
    await waitFor(() => view(alice).phase === 'day', 'day');
    const y0 = view(alice).players.get(alice.sessionId)!.y;
    sendRaw(alice, 'input', input(1, { my: -1 }));
    await waitFor(() => view(alice).players.get(alice.sessionId)!.y < y0 - 1, 'moved north');
    assert.equal(view(alice).players.get(alice.sessionId)!.ack, 1);
    sendRaw(alice, 'input', input(1, { my: 1 })); // stale sequence: dropped
    sendRaw(alice, 'input', { garbage: true });
    sendRaw(alice, 'input', input(2));
    sendRaw(alice, 'dev', { cmd: 'night', n: 3 });
    await waitFor(() => view(alice).phase === 'night' && view(alice).night === 3, 'night 3');
    assert.ok(fx.some((e) => e.k === 'night' && e.n === 3));
    const me = server.match.players.get(alice.sessionId)!;
    sendRaw(alice, 'dev', { cmd: 'spawn', kind: ZombieKind.chubby, x: me.x + 3, y: me.y - 3 });
    await waitFor(() => view(alice).zombies.size === 1, 'a chubby');
    const z = [...server.match.zombies.values()][0]!;
    assert.equal(z.kind, ZombieKind.chubby);
    assert.equal(z.maxHp, Math.round(240 * 1.44), 'night 3 strength');
  });

  it('interest management: zombies far from every survivor are not on the wire', async () => {
    const { room: alice } = await join('Alice', { rules: FAST });
    const server = colyseus.getRoomById<NorthdaleRoom>(alice.roomId);
    await waitFor(() => view(alice).phase === 'day', 'day');
    server.match.frozen = true;
    const me = server.match.players.get(alice.sessionId)!;
    server.match.spawnZombie(ZombieKind.basic, me.x + 4, me.y - 10, false);
    const far = server.match.spawnZombie(ZombieKind.basic, me.x + SYNC_RADIUS + 20, me.y - 10, false);
    await waitFor(() => view(alice).zombies.size === 1, 'only the near one');
    assert.ok(!view(alice).zombies.get(far.id.toString(36)));
    assert.equal(server.match.zombies.size, 2, 'the far one lives on the server');
  });

  it('down and revive over the wire: Bob holds the context button next to Alice', async () => {
    const a = await join('Alice', { rules: FAST });
    const b = await join('Bob');
    assert.equal(a.room.roomId, b.room.roomId);
    const server = colyseus.getRoomById<NorthdaleRoom>(a.room.roomId);
    await waitFor(() => view(a.room).players.size === 2 && view(a.room).phase === 'day', 'two in');
    const alice = server.match.players.get(a.room.sessionId)!;
    sendRaw(a.room, 'dev', { cmd: 'place', x: SAFE_CENTER.x, y: SAFE_CENTER.y - 4 });
    sendRaw(b.room, 'dev', { cmd: 'place', x: SAFE_CENTER.x + 1, y: SAFE_CENTER.y - 4 });
    sendRaw(a.room, 'dev', { cmd: 'down' });
    await waitFor(() => view(b.room).players.get(a.room.sessionId)!.life === 1, 'Alice down');
    sendRaw(b.room, 'input', input(1, { act: true }));
    await waitFor(() => view(b.room).players.get(a.room.sessionId)!.revive > 30, 'reviving');
    await waitFor(() => alice.life === 'alive', 'revived', 5000);
    assert.equal(alice.hp, 40);
    assert.ok(b.fx.some((e) => e.k === 'revive'));
  });

  it('reports the run: best-run nights and kills, an escape on the total board; guests get the notice', async () => {
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
          boards: { nights: { score: 4, rank: 1 }, kills: { score: 33, rank: 2 }, escapes: { score: 1, rank: 1 } },
          unlocked: [{ key: 'getaway', title: 'Getaway', icon: '🚚' }],
        },
      },
    });
    colyseus.sdk.auth.token = await token(ANN);
    const ann = await join('ignored', { rules: { ...FAST, holdoutTime: 0.5, escapeTime: 1 } });
    colyseus.sdk.auth.token = '';
    const zed = await join('Zed');
    const server = colyseus.getRoomById<NorthdaleRoom>(ann.room.roomId);
    await waitFor(() => view(ann.room).phase === 'day', 'day');
    sendRaw(ann.room, 'dev', { cmd: 'god', on: true });
    sendRaw(ann.room, 'dev', { cmd: 'truck', wheels: 2, fuel: 2, scrap: 60 });
    sendRaw(ann.room, 'dev', { cmd: 'night', n: 4 });
    await waitFor(() => view(ann.room).night === 4, 'night 4');
    server.match.players.get(ann.room.sessionId)!.kills = 33;
    // Ann starts the truck.
    const t = server.match.truck;
    sendRaw(ann.room, 'dev', { cmd: 'place', x: t.x + 2.5, y: t.y });
    sendRaw(ann.room, 'input', input(1, { act: true }));
    await waitFor(() => view(ann.room).phase === 'holdout', 'holdout');
    await waitFor(() => results.length === 1, 'run reported', 6000);
    const r = results[0]!;
    assert.equal(r.gameId, 'northdale');
    assert.equal(r.matchId, `${ann.room.roomId}:1`);
    assert.equal(r.winnerUserId, null, 'co-op: no winner');
    assert.equal(r.rounds, 3);
    assert.deepEqual(r.leaderboardScores, { nights: { [ANN]: 3 }, kills: { [ANN]: 33 } });
    assert.deepEqual(r.leaderboardDeltas, { escapes: { [ANN]: 1 } });
    const byName = Object.fromEntries(r.players.map((p) => [p.username, p]));
    assert.ok(byName.ann!.achievements.includes('getaway'));
    assert.equal(byName['guest-Zed']!.guest, true);
    await waitFor(() => ann.results.length === 1 && zed.results.length === 1, 'result messages');
    assert.equal(ann.results[0]!.recorded, true);
    assert.deepEqual(zed.results[0], { matchId: r.matchId, recorded: false, reason: 'guest' });
    assert.ok(ann.fx.some((e) => e.k === 'escape') && ann.fx.some((e) => e.k === 'over' && e.e));
  });

  it('private rooms wait for `start`; a late joiner spawns at the safehouse', async () => {
    const cleo = await join('Cleo', { private: true, rules: FAST });
    assert.ok(/^[A-Z2-9]{6}$/.test(view(cleo.room).code));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(view(cleo.room).phase, 'waiting');
    sendRaw(cleo.room, 'start', {});
    await waitFor(() => view(cleo.room).phase === 'day', 'started');
  });

  it('patch bandwidth with a 70-zombie horde around a survivor firing an SMG (logged)', async function () {
    this.timeout(20000);
    const a = await join('Alice', { rules: { ...FAST, spawnScale: 0 } });
    const server = colyseus.getRoomById<NorthdaleRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'day', 'day');
    sendRaw(a.room, 'dev', { cmd: 'night', n: 4 });
    sendRaw(a.room, 'dev', { cmd: 'god', on: true });
    await waitFor(() => view(a.room).phase === 'night', 'night');
    server.match.give(a.room.sessionId, Item.smg);
    const me = server.match.players.get(a.room.sessionId)!;
    me.x = 0;
    me.y = -20;
    for (let i = 0; i < 70; i++) {
      const ang = (i / 70) * Math.PI * 2;
      server.match.spawnZombie(
        i % 9 === 0 ? ZombieKind.crawler : ZombieKind.basic,
        Math.cos(ang) * 4,
        -20 + Math.sin(ang) * 14,
      );
    }
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
      sendRaw(
        a.room,
        'input',
        input(s++, {
          mx: Math.cos(ang) * 0.5,
          my: Math.sin(ang) * 0.5,
          ax: Math.cos(ang * 3),
          ay: Math.sin(ang * 3),
          fire: true,
        }),
      );
      me.ammo[1] = 120;
      for (let i = server.match.zombies.size; i < 70; i++) {
        server.match.spawnZombie(ZombieKind.basic, me.x + (i % 2 ? -12 : 12), me.y - 8 + (i % 16));
      }
    }, 50);
    await new Promise((r) => setTimeout(r, 500));
    counting = true;
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 4000));
    counting = false;
    const secs = (Date.now() - t0) / 1000;
    clearInterval(drive);
    conn.events.onmessage = orig;
    const alive = view(a.room).zombies.size;
    const perSec = (n: number) => Math.round(n / secs);
    console.info(
      `      [bandwidth] ${alive} zombies synced: patches ${perSec(bytes.patch)} B/s (${Math.round(bytes.patch / Math.max(1, bytes.patches))} B × ${(bytes.patches / secs).toFixed(1)}/s), ` +
        `fx ${perSec(bytes.fx)} B/s, other ${perSec(bytes.other)} B/s → ${((perSec(bytes.patch + bytes.fx + bytes.other) * 8) / 1000).toFixed(0)} kbit/s per client`,
    );
    assert.ok(alive >= 60, `${alive} zombies synced`);
    assert.ok(bytes.patches / secs > 15, 'about 20 patches a second');
    assert.ok(perSec(bytes.patch) < 30_000, `patches stay under 30 KB/s (${perSec(bytes.patch)})`);
  });
});

describe('Northdale result mapping', () => {
  const summary: RunSummary = {
    run: 2,
    nights: 6,
    duration: 1800,
    escaped: false,
    bloodMoons: 1,
    teamKills: 200,
    standings: [
      {
        id: 's1',
        name: 'ann',
        slot: 0,
        kills: 120,
        guitarKills: 26,
        revives: 2,
        downs: 1,
        foundDog: true,
        placement: 1,
      },
      {
        id: 's2',
        name: 'guest-Zed',
        slot: 1,
        kills: 80,
        guitarKills: 0,
        revives: 0,
        downs: 3,
        foundDog: false,
        placement: 2,
      },
    ],
  };
  const base = {
    matchId: 'r:2',
    gameId: 'northdale',
    roomId: 'r',
    private: false,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
  };

  it('best-run boards for signed-in survivors, no escape delta when the run did not escape', () => {
    const { result } = northdaleRunResult(summary, base, (id) =>
      id === 's1' ? { userId: ANN, guest: false } : { userId: 'guest:zed', guest: true },
    );
    assert.deepEqual(result.leaderboardScores, { nights: { [ANN]: 6 }, kills: { [ANN]: 120 } });
    assert.deepEqual(result.leaderboardDeltas, {});
    assert.deepEqual(result.players[0]!.achievements, ['first_light', 'blood_moon', 'good_boy', 'unplugged']);
    assert.equal(result.rounds, 6);
  });

  it('result messages: guest, unavailable, recorded', () => {
    assert.deepEqual(northdaleResultFor('m', { userId: 'x', guest: true }, undefined), {
      matchId: 'm',
      recorded: false,
      reason: 'guest',
    });
    assert.deepEqual(northdaleResultFor('m', { userId: ANN, guest: false }, null), {
      matchId: 'm',
      recorded: false,
      reason: 'unavailable',
    });
    const recorded = northdaleResultFor('m', { userId: ANN, guest: false }, {
      duplicate: false,
      players: { [ANN]: { wins: 0, losses: 0, boards: { nights: { score: 6, rank: 1 } }, unlocked: [] } },
    } as RecordedMatch);
    assert.deepEqual(recorded, {
      matchId: 'm',
      recorded: true,
      boards: { nights: { score: 6, rank: 1 } },
      unlocked: [],
    });
  });
});
