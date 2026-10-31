import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { SignJWT } from 'jose';
import {
  ZombieKind,
  type FxBatch,
  type FxEvent,
  type OverrunStateView,
  type ResultMessage,
  type RunSummary,
} from '@rally/game-overrun-server';
import type appConfig from '../src/app.config.js';
import { createAuthenticator } from '../src/auth.js';
import { setMatchResultSink, type MatchResult, type RecordedMatch } from '../src/results.js';
import { RallyRoom } from '../src/rooms/RallyRoom.js';
import { overrunBoardScores, overrunResultFor, type OverrunRoom } from '../src/rooms/OverrunRoom.js';
import { resetRateLimits } from '../src/routes.js';
import { waitFor } from './fakes.js';
import { testServer } from './server.js';

/** Fast rules so a run fits in a test. */
const FAST = { firstBreatherTime: 0.2, breatherTime: 0.3, overTime: 0.4, waveSize: 3 };
const ANN = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const BEN = '1c8a7d3f-7b62-4d4a-8b9f-3c9a2c4d0e21';
const secret = 'test-secret-with-at-least-32-characters!!';

const view = (r: { state: unknown }) => r.state as OverrunStateView;
const sendRaw = (r: unknown, type: string, message: unknown) =>
  (r as { send(type: string, message: unknown): void }).send(type, message);

describe('OverrunRoom', () => {
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
  /**
   * An HTTP request every second while a test waits: an undici keep-alive socket left idle for ~4 s can trip an
   * undici bug (an uncaught parser-timeout TypeError), and Colyseus shuts the shared test server down on uncaught
   * errors, failing every later test file. Some of these tests wait several seconds (revives, bandwidth).
   */
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  /** Every client room a test opened: left with consent afterwards, so no socket is closed from the server side. */
  let opened: { leave(consented?: boolean): Promise<unknown> }[] = [];
  beforeEach(() => {
    keepAlive = setInterval(() => void colyseus.http.get('/healthz').catch(() => {}), 1000);
    opened = [];
  });
  afterEach(async () => {
    clearInterval(keepAlive);
    await Promise.all(opened.map((r) => r.leave(true).catch(() => {})));
    RallyRoom.configureAuth(null);
    colyseus.sdk.auth.token = '';
  });

  async function join(username: string, options: Record<string, unknown> = {}) {
    const room = await colyseus.sdk.joinOrCreate('overrun', { username, ...options });
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

  it('one player is enough: the run starts, the breather counts down and wave 1 spawns', async () => {
    const { room: alice } = await join('Alice', { rules: FAST });
    const server = colyseus.getRoomById<OverrunRoom>(alice.roomId);
    await waitFor(() => view(alice).phase === 'breather', 'breather');
    assert.equal(view(alice).wave, 1);
    assert.equal(view(alice).run, 1);
    await waitFor(() => view(alice).phase === 'wave', 'wave 1');
    await waitFor(() => view(alice).zombies.size > 0, 'zombies spawned');
    const me = view(alice).players.get(alice.sessionId)!;
    assert.equal(me.active, true);
    assert.equal(me.hp, 100);
    assert.equal(me.guest, true);
    await waitFor(() => view(alice).players.get(alice.sessionId)!.name === 'guest-Alice', 'renamed');
    assert.deepEqual(
      {
        gameId: server.metadata.gameId,
        players: server.metadata.players,
        maxPlayers: server.metadata.maxPlayers,
        private: server.metadata.private,
        phase: server.metadata.phase,
        wave: server.metadata.wave,
        serverVersion: server.metadata.serverVersion,
      },
      { gameId: 'overrun', players: 1, maxPlayers: 4, private: false, phase: 'wave', wave: 1, serverVersion: 3 },
    );
    // Zombies arrive quantized but where the simulation has them (≈0.001 u).
    const [id, z] = [...server.match.zombies.entries()][0]!;
    await server.waitForNextPatch();
    const seen = view(alice).zombies.get(id.toString(36));
    if (seen) assert.ok(Math.abs(seen.x - z.x) < 0.5 && seen.kind === z.kind);
  });

  it('validates inputs: moves, aims and fires; acks the sequence; drops garbage, stale and excess messages', async () => {
    const a = await join('Alice', { rules: { ...FAST, firstBreatherTime: 30 } });
    const server = colyseus.getRoomById<OverrunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'breather', 'breather');
    const x0 = view(a.room).players.get(a.room.sessionId)!.x;
    sendRaw(a.room, 'input', { mx: 5, my: 0, ax: 0, ay: -1, fire: true, weapon: 0, s: 1 });
    await waitFor(() => view(a.room).players.get(a.room.sessionId)!.ack === 1, 'ack 1');
    assert.deepEqual(server.match.players.get(a.room.sessionId)!.input.move, { x: 1, y: 0 }, 'clamped');
    await waitFor(() => view(a.room).players.get(a.room.sessionId)!.x > x0 + 1, 'moved right');
    await waitFor(() => a.fx.some((e) => e.k === 'shot'), 'shot fx');
    const shot = a.fx.find((e) => e.k === 'shot') as Extract<FxEvent, { k: 'shot' }>;
    assert.equal(shot.p, 0);
    assert.equal(shot.w, 0);
    assert.ok(shot.r[3]! < shot.r[1]!, 'fired up the screen');
    const aim = view(a.room).players.get(a.room.sessionId)!.aim;
    assert.ok((Math.abs(Math.cos(aim)) < 0.05 && Math.sin(aim) < 0) || aim > 4.6, `aim ${aim}`);

    sendRaw(a.room, 'input', { mx: 'left', my: 0, ax: 0, ay: 0, fire: false, weapon: 0, s: 2 });
    sendRaw(a.room, 'input', { mx: 0, my: 1, ax: 0, ay: 0, fire: false, weapon: 0, s: 1 }); // stale
    sendRaw(a.room, 'input', { mx: 0, my: 1, ax: 0, ay: 0, fire: false, weapon: 9, s: 3 }); // bad weapon
    sendRaw(a.room, 'input', null);
    await server.waitForNextPatch();
    assert.deepEqual(server.match.players.get(a.room.sessionId)!.input.move, { x: 1, y: 0 });
    // 45 more in the same second (under the room's 60 messages/s kick): only MAX_INPUTS_PER_SECOND are applied.
    for (let s = 10; s < 55; s++) sendRaw(a.room, 'input', { mx: 0, my: 0, ax: 1, ay: 0, fire: false, weapon: 0, s });
    await waitFor(() => (view(a.room).players.get(a.room.sessionId)?.ack ?? 0) >= 10, 'some applied');
    await server.waitForNextPatch(100);
    const ack = view(a.room).players.get(a.room.sessionId)!.ack;
    assert.ok(ack < 54, `excess inputs dropped (ack ${ack})`);
    assert.equal(server.clients.length, 1, 'not disconnected');
  });

  it('a shot kills a zombie: every client sees the kill fx and the zombie leave the state', async () => {
    const a = await join('Alice', { rules: { ...FAST, waveSize: 1 } });
    const b = await join('Bob');
    assert.equal(b.room.roomId, a.room.roomId);
    const server = colyseus.getRoomById<OverrunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'wave', 'wave');
    // Dev commands (NODE_ENV=test): freeze the horde, clear it, put one zombie in front of Alice.
    sendRaw(a.room, 'dev', { cmd: 'freeze', on: true });
    sendRaw(a.room, 'dev', { cmd: 'clear' });
    sendRaw(a.room, 'dev', { cmd: 'place', x: 0, y: 2 });
    sendRaw(a.room, 'dev', { cmd: 'spawn', kind: ZombieKind.walker, x: 0, y: 6 });
    sendRaw(a.room, 'dev', { cmd: 'spawn', kind: ZombieKind.walker, x: 22, y: 14 });
    await waitFor(() => server.match.zombies.size === 2, 'two zombies');
    const target = [...server.match.zombies.values()].find((z) => z.y < 10)!;
    await waitFor(() => !!view(b.room).zombies.get(target.id.toString(36)), 'Bob sees it');
    sendRaw(a.room, 'input', { mx: 0, my: 0, ax: 0, ay: 1, fire: true, weapon: 0, s: 1 });
    await waitFor(() => !view(b.room).zombies.get(target.id.toString(36)), 'gone for Bob');
    await waitFor(() => b.fx.some((e) => e.k === 'kill' && e.z === target.id), 'kill fx for Bob');
    const kill = b.fx.find((e) => e.k === 'kill') as Extract<FxEvent, { k: 'kill' }>;
    assert.equal(kill.p, 0, 'by Alice (slot 0)');
    assert.ok(b.fx.some((e) => e.k === 'hit' && e.z === target.id));
    await waitFor(() => view(b.room).teamKills === 1, 'team kills');
    assert.equal(view(b.room).players.get(a.room.sessionId)!.kills, 1);
  });

  it('reports the run with per-player boards and achievements; signed-in players get their boards, guests the notice', async () => {
    RallyRoom.configureAuth(
      createAuthenticator({
        jwtSecret: secret,
        allowGuests: true,
        profiles: async (id) => ({ username: id === ANN ? 'ann' : 'ben', avatarUrl: null }),
      }),
    );
    answer = () => ({
      duplicate: false,
      players: {
        [ANN]: {
          wins: 0,
          losses: 0,
          boards: { wave: { score: 7, rank: 2 }, kills: { score: 31, rank: 5 } },
          unlocked: [{ key: 'medic', title: 'Field Medic', icon: '⛑️' }],
        },
      },
    });
    colyseus.sdk.auth.token = await token(ANN);
    const ann = await join('ignored', { rules: { ...FAST, waveSize: 1 } });
    colyseus.sdk.auth.token = '';
    const zed = await join('Zed');
    assert.equal(zed.room.roomId, ann.room.roomId);
    const server = colyseus.getRoomById<OverrunRoom>(ann.room.roomId);
    await waitFor(() => view(ann.room).phase === 'wave', 'wave');
    // Ann gets three revives in (straight on the match: the rules are tested in the game package), then everyone
    // goes down.
    const annP = server.match.players.get(ann.room.sessionId)!;
    annP.revives = 3;
    annP.kills = 12;
    server.match.reached = 2;
    for (const p of server.match.players.values()) server.match.hurt(p, 999, []);
    await waitFor(() => results.length === 1, 'run reported');
    const r = results[0]!;
    assert.equal(r.gameId, 'overrun');
    assert.equal(r.matchId, `${ann.room.roomId}:1`);
    assert.equal(r.winnerUserId, null, 'co-op: no winner');
    assert.equal(r.private, false);
    assert.equal(r.rounds, 2);
    assert.deepEqual(r.leaderboardScores, { wave: { [ANN]: 2 }, kills: { [ANN]: 12 } }, 'best-run scores; guests get none');
    assert.deepEqual(r.leaderboardDeltas, {}, 'no total boards');
    const byName = Object.fromEntries(r.players.map((p) => [p.username, p]));
    assert.deepEqual(byName.ann!.achievements, ['medic']);
    assert.equal(byName.ann!.guest, false);
    assert.equal(byName.ann!.userId, ANN);
    assert.equal(byName['guest-Zed']!.guest, true);
    assert.equal((r.details as { players: Record<string, { kills: number }> }).players.ann!.kills, 12);
    await waitFor(() => ann.results.length === 1 && zed.results.length === 1, 'result messages');
    assert.deepEqual(ann.results[0], {
      matchId: r.matchId,
      recorded: true,
      boards: { wave: { score: 7, rank: 2 }, kills: { score: 31, rank: 5 } },
      unlocked: [{ key: 'medic', title: 'Field Medic', icon: '⛑️' }],
    });
    assert.deepEqual(zed.results[0], { matchId: r.matchId, recorded: false, reason: 'guest' });
    await waitFor(() => view(ann.room).phase === 'over', 'run-over screen');
    // ...then a new run starts by itself (public room).
    await waitFor(() => view(ann.room).run === 2 && view(ann.room).phase !== 'over', 'next run', 3000);
  });

  it('private rooms: a code, hidden from the listing, wait for `start`; joinById needs the code', async () => {
    const pub = await join('Pub');
    const host = await join('Host', { private: true, rules: FAST });
    assert.notEqual(host.room.roomId, pub.room.roomId);
    const code = view(host.room).code;
    assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(view(host.room).phase, 'waiting', 'private rooms wait for the crew');
    const list = (await colyseus.http.get('/rooms/overrun')).data as { rooms: { roomId: string }[] };
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
    sendRaw(friend, 'start', {});
    await waitFor(() => view(host.room).phase === 'breather', 'started');
  });

  it('a player joining mid-wave waits (not active) and spawns at the next breather; the room holds 4', async () => {
    const a = await join('Alice', { rules: { ...FAST, waveSize: 2 } });
    const server = colyseus.getRoomById<OverrunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'wave', 'wave');
    server.match.frozen = true;
    const b = await join('Bob');
    assert.equal(b.room.roomId, a.room.roomId);
    await waitFor(() => view(a.room).players.size === 2, 'Bob seated');
    assert.equal(view(a.room).players.get(b.room.sessionId)!.active, false, 'waits for the breather');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(view(b.room).players.get(b.room.sessionId)!.active, false);
    server.match.clearZombies();
    await waitFor(() => view(b.room).phase === 'breather', 'breather');
    await waitFor(() => view(b.room).players.get(b.room.sessionId)!.active === true, 'Bob spawned');
    const c = await join('Cleo');
    const d = await join('Dan');
    assert.ok([c, d].every((x) => x.room.roomId === a.room.roomId));
    const e = await join('Eve');
    assert.notEqual(e.room.roomId, a.room.roomId, 'a fifth player gets another room');
  });

  it('dev commands: hurt downs a player, a teammate next to them revives them; ignored keys are harmless', async () => {
    const a = await join('Alice', { rules: { ...FAST, waveSize: 1 } });
    const b = await join('Bob');
    await waitFor(() => view(a.room).phase === 'wave', 'wave');
    sendRaw(a.room, 'dev', { cmd: 'freeze', on: true });
    sendRaw(a.room, 'dev', { cmd: 'clear' });
    sendRaw(a.room, 'dev', { cmd: 'spawn', x: 22, y: 14 });
    sendRaw(a.room, 'dev', { cmd: 'place', x: -2, y: 0 });
    sendRaw(b.room, 'dev', { cmd: 'place', x: 6, y: 0 });
    sendRaw(b.room, 'dev', { cmd: 'hurt', name: 'guest-Alice', damage: 500 });
    sendRaw(a.room, 'dev', { cmd: 'nope', x: 1 });
    sendRaw(a.room, 'dev', 'garbage');
    await waitFor(() => view(b.room).players.get(a.room.sessionId)!.down === true, 'Alice down');
    await waitFor(() => b.fx.some((e) => e.k === 'down' && e.p === 0), 'down fx');
    sendRaw(b.room, 'dev', { cmd: 'place', x: -1, y: 0 });
    await waitFor(() => (view(b.room).players.get(a.room.sessionId)!.revive ?? 0) > 20, 'revive progress');
    await waitFor(() => view(b.room).players.get(a.room.sessionId)!.down === false, 'revived', 5000);
    assert.equal(view(b.room).players.get(a.room.sessionId)!.hp, 50);
    assert.equal(view(b.room).players.get(b.room.sessionId)!.revives, 1);
    assert.ok(b.fx.some((e) => e.k === 'revive' && e.p === 0 && e.by === 1));
  });

  it('patch bandwidth with 120 zombies on the move and an uzi firing (logged)', async function () {
    this.timeout(20000);
    const a = await join('Alice', { rules: { ...FAST, waveSize: 400, maxAlive: 120 } });
    const server = colyseus.getRoomById<OverrunRoom>(a.room.roomId);
    await waitFor(() => view(a.room).phase === 'wave', 'wave');
    // Fill the yard: 120 zombies walking at Alice, who runs in circles (and never goes down).
    server.match.clearZombies();
    for (let i = 0; i < 120; i++) {
      const g = i % 4;
      server.match.spawnZombie(
        ZombieKind.walker,
        g < 2 ? -20 + (i % 10) : 12 + (i % 10),
        g % 2 ? -12 + (i % 7) : 6 + (i % 7),
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
    // Alice fires the uzi at the horde the whole time (shots, hits, kills: the effects traffic of a real fight); the
    // horde is topped up to 120 as she kills.
    server.match.unlocked = 2;
    let s = 1;
    const drive = setInterval(() => {
      const ang = s * 0.15;
      sendRaw(a.room, 'input', {
        mx: Math.cos(ang),
        my: Math.sin(ang),
        ax: Math.cos(ang * 3),
        ay: Math.sin(ang * 3),
        fire: true,
        weapon: 1,
        s: s++,
      });
      for (const p of server.match.players.values()) {
        p.hp = 100;
        p.ammo[1] = 300;
      }
      for (let i = server.match.zombies.size; i < 120; i++) {
        server.match.spawnZombie(ZombieKind.walker, i % 2 ? -22 : 22, -14 + (i % 28));
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
    const alive = server.match.zombies.size;
    const perSec = (n: number) => Math.round(n / secs);
    console.info(
      `      [bandwidth] ${alive} zombies: patches ${perSec(bytes.patch)} B/s (${Math.round(bytes.patch / Math.max(1, bytes.patches))} B × ${(bytes.patches / secs).toFixed(1)}/s), ` +
        `fx ${perSec(bytes.fx)} B/s, other ${perSec(bytes.other)} B/s → ${((perSec(bytes.patch + bytes.fx + bytes.other) * 8) / 1000).toFixed(0)} kbit/s per client`,
    );
    assert.ok(alive >= 110, `${alive} zombies alive`);
    assert.ok(bytes.patches / secs > 15, 'about 20 patches a second');
    assert.ok(perSec(bytes.patch) < 40_000, `patches stay under 40 KB/s (${perSec(bytes.patch)})`);
    assert.ok(bytes.fx > 0, 'effects of the fight');
  });
});

describe('Overrun result mapping', () => {
  const summary: RunSummary = {
    run: 1,
    wave: 12,
    duration: 300,
    teamScore: 1000,
    teamKills: 40,
    standings: [
      {
        id: 's1',
        name: 'ann',
        slot: 0,
        score: 700,
        kills: 35,
        revives: 0,
        downs: 1,
        placement: 1,
        cleanWaves: 0,
        bestBlast: 0,
      },
      {
        id: 's2',
        name: 'ben',
        slot: 1,
        score: 300,
        kills: 0,
        revives: 0,
        downs: 2,
        placement: 2,
        cleanWaves: 0,
        bestBlast: 0,
      },
    ],
  };

  it('board scores are the run’s wave and the player’s kills, uncapped (best-run boards)', () => {
    assert.deepEqual(overrunBoardScores(summary, 's1'), { wave: 12, kills: 35 });
    assert.deepEqual(overrunBoardScores(summary, 's2'), { wave: 12, kills: null });
    assert.deepEqual(overrunBoardScores({ ...summary, wave: 3 }, 's1'), { wave: 3, kills: 35 });
    assert.deepEqual(overrunBoardScores(summary, 'nobody'), { wave: null, kills: null });
  });

  it('result messages: guest, unavailable (no write, duplicate, no entry), recorded', () => {
    const ann = { userId: ANN, guest: false };
    assert.deepEqual(overrunResultFor('m:1', { userId: 'guest:x', guest: true }, undefined), {
      matchId: 'm:1',
      recorded: false,
      reason: 'guest',
    });
    for (const rec of [null, { duplicate: true } as const, { duplicate: false, players: {} } as const]) {
      assert.deepEqual(overrunResultFor('m:1', ann, rec), { matchId: 'm:1', recorded: false, reason: 'unavailable' });
    }
    assert.deepEqual(
      overrunResultFor(
        'm:1',
        { userId: ANN.toUpperCase(), guest: false },
        {
          duplicate: false,
          players: { [ANN]: { wins: 0, losses: 0, boards: { wave: { score: 3, rank: 1 } }, unlocked: [] } },
        },
      ),
      { matchId: 'm:1', recorded: true, boards: { wave: { score: 3, rank: 1 } }, unlocked: [] },
    );
    void BEN;
  });
});
