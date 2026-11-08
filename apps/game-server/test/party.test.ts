import assert from 'node:assert/strict';
import type { ColyseusTestServer } from '@colyseus/testing';
import { matchMaker } from 'colyseus';
import { SignJWT } from 'jose';
import type appConfig from '../src/app.config.js';
import { createTokenVerifier, type RallyAuth } from '../src/auth.js';
import {
  LAUNCHES_PER_MINUTE,
  LAUNCH_TTL_MS,
  SEAT_SAFETY_MS,
  configureParty,
  heldLaunch,
  heldLaunches,
  resetPartyState,
  roomNameForGame,
  type PartyLaunchAnswer,
  type PartySeatAnswer,
} from '../src/party.js';
import { PARTY_SEAT_RESERVATION_SECONDS, RallyRoom } from '../src/rooms/RallyRoom.js';
import { resetRateLimits, stripServerOnlyOptions } from '../src/routes.js';
import { ServiceRpcError, createServiceApi, isInvalid, rpcErrorDetail } from '../src/supabase.js';
import { fakePartyRpc, fakeRpc, rpcInvalid, rpcNotFound, waitFor, type FakePartyMember } from './fakes.js';
import { testServer } from './server.js';

const PARTY = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEADER = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';
const BOB = '1c8a7d3f-7b62-4d4a-8b9f-3c9a2c4d0e21';
const CARA = '2d9b8e40-8c73-4e5b-9ca0-4daa3d5e1f32';
const STRANGER = '3eac9f51-9d84-4f6c-8db1-5ebb4e6f2043';

const secret = 'party-test-secret-with-at-least-32-characters!!';
const verify = createTokenVerifier({ jwtSecret: secret });

function token(sub: string, extra: Record<string, unknown> = {}) {
  return new SignJWT({ role: 'authenticated', ...extra })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

const member = (user_id: string, username: string, avatar_url: string | null = null): FakePartyMember => ({
  user_id,
  username,
  avatar_url,
});

type Reservation = PartyLaunchAnswer['seatReservation'];
interface HttpError {
  statusCode: number;
  data: { error: string };
}

describe('party launch and seats (POST /party/launch, POST /party/seat)', () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let party: ReturnType<typeof fakePartyRpc>;
  let members: FakePartyMember[];
  /** Published games and their `max_players` (the fake database's `INVALID` rule). */
  let games: Record<string, number>;
  /** Added to the real clock for the party module only (seat freshness and launch eviction). */
  let skewMs = 0;

  before(async () => {
    colyseus = await testServer();
  });
  beforeEach(async () => {
    RallyRoom.configureAuth(null);
    resetRateLimits();
    dropReservations();
    resetPartyState();
    skewMs = 0;
    members = [member(LEADER, 'sloth', 'https://cdn.test/sloth.png'), member(BOB, 'bob')];
    games = { hello: 8, sumo: 8, sushi: 4 };
    party = fakePartyRpc({ partyId: PARTY, leaderId: LEADER, members, games });
    configureParty({ api: createServiceApi(party.rpc), verify, now: () => Date.now() + skewMs });
    colyseus.sdk.auth.token = '';
    await colyseus.cleanup();
  });
  after(() => {
    dropReservations();
    configureParty(null);
    RallyRoom.configureAuth(null);
  });

  /**
   * Colyseus disposes a room only once its unconsumed reservations lapsed (120 s for party rooms), so `cleanup()`
   * would wait that long after a test that left seats unclaimed. Drop them (test-only: Colyseus has no API for it).
   */
  interface RoomInternals {
    _reservedSeats: Record<string, unknown>;
    _reservedSeatTimeouts: Record<string, NodeJS.Timeout>;
    _autoDisposeTimeout: NodeJS.Timeout | undefined;
    resetAutoDisposeTimeout(seconds: number): void;
  }

  function dropReservations() {
    for (const launch of heldLaunches()) {
      const room = matchMaker.getLocalRoomById(launch.roomId) as unknown as RoomInternals | undefined;
      if (!room) continue;
      for (const sessionId of Object.keys(room._reservedSeats)) {
        clearTimeout(room._reservedSeatTimeouts[sessionId]);
        delete room._reservedSeatTimeouts[sessionId];
        delete room._reservedSeats[sessionId];
      }
      // A reservation also arms the room's auto-dispose timer for its lifetime, and dispose waits for that too.
      if (room._autoDisposeTimeout) room.resetAutoDisposeTimeout(0);
    }
  }

  async function post<T>(path: string, bearer: string | null, body: unknown): Promise<T> {
    const res = await colyseus.http.post(path, {
      headers: {
        'content-type': 'application/json',
        ...(bearer === null ? {} : { authorization: bearer }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return res.data as T;
  }
  const bearer = async (sub: string) => `Bearer ${await token(sub)}`;
  const launch = async (gameId = 'hello', sub = LEADER) =>
    post<PartyLaunchAnswer>('/party/launch', await bearer(sub), { gameId });
  const seat = async (launchId: string, sub: string) =>
    post<PartySeatAnswer>('/party/seat', await bearer(sub), { launchId });

  /** The request fails with `status`; returns the `{ error }` body. */
  async function failsWith(req: Promise<unknown>, status: number): Promise<{ error: string }> {
    let data: { error: string } | undefined;
    await assert.rejects(req, (e: HttpError) => {
      assert.equal(e.statusCode, status, `expected ${status}, got ${e.statusCode} ${JSON.stringify(e.data)}`);
      data = e.data;
      return true;
    });
    return data!;
  }

  async function consume(reservation: Reservation) {
    const room = await colyseus.sdk.consumeSeatReservation(reservation);
    room.onMessage('hello', () => {});
    room.onMessage('pong', () => {});
    return room;
  }

  it('launch: a private party room with a code and 120 s seats; every member gets one reservation, consumable once, without onAuth', async () => {
    // Were Colyseus to run the static onAuth for a pre-authenticated reservation, every join below would fail.
    RallyRoom.configureAuth(async () => {
      throw new Error('static onAuth must not run for party reservations');
    });
    members.push(member(CARA, 'cara'));
    const answer = await launch();
    assert.match(answer.launchId, /^0000000a-/);
    assert.match(answer.code ?? '', /^[A-HJKMNP-Z2-9]{6}$/, 'a private room with a join code');
    assert.equal(answer.seatReservation.roomId, answer.roomId);

    const room = colyseus.getRoomById<RallyRoom>(answer.roomId);
    assert.equal(room.roomName, 'hello');
    assert.equal(room.isPrivateRoom, true);
    assert.equal(room.joinCode, answer.code);
    assert.equal(room.partyId, PARTY);
    assert.equal(room.seatReservationTimeout, PARTY_SEAT_RESERVATION_SECONDS);
    assert.equal(PARTY_SEAT_RESERVATION_SECONDS, 120);
    assert.equal(room.roomTitle, "sloth's party");
    assert.equal(room.metadata.partyId, PARTY);
    assert.equal(room.metadata.name, "sloth's party");
    assert.equal(room.metadata.code, answer.code);
    assert.equal(room.metadata.private, true);
    assert.equal(room.metadata.players, 0, 'reservations are not seats yet');
    assert.equal(room.mirrorSnapshot().name, "sloth's party", 'what game_rooms shows');

    // The database saw begin and commit, in order, with the room the party plays in.
    assert.deepEqual(party.of('server_party_launch_begin'), [{ p_leader: LEADER, p_game_id: 'hello' }]);
    assert.deepEqual(party.of('server_party_launch_commit'), [
      { p_party_id: PARTY, p_leader: LEADER, p_game_id: 'hello', p_room_id: answer.roomId, p_code: answer.code },
    ]);
    const held = heldLaunch(answer.launchId)!;
    assert.deepEqual([...held.seats.keys()], [LEADER, BOB, CARA], 'one reservation per member');
    assert.equal(held.seatSeconds, 120);
    assert.deepEqual(held.seats.get(LEADER)!.reservation, answer.seatReservation);

    // The leader joins with the reservation from the launch; the auth inside it is the profile the RPC gave.
    const leader = await consume(answer.seatReservation);
    assert.deepEqual<RallyAuth | undefined>(room.authOf(leader.sessionId), {
      userId: LEADER,
      username: 'sloth',
      avatarUrl: 'https://cdn.test/sloth.png',
      guest: false,
    });
    await assert.rejects(consume(answer.seatReservation), 'a reservation is consumed once');

    // Members fetch theirs with /party/seat: the one made at launch, the same object each time while fresh.
    const bobSeat = await seat(answer.launchId, BOB);
    assert.deepEqual(bobSeat, {
      roomId: answer.roomId,
      code: answer.code,
      seatReservation: held.seats.get(BOB)!.reservation,
    });
    assert.deepEqual(await seat(answer.launchId, BOB), bobSeat);
    assert.deepEqual(party.of('server_party_member'), [
      { p_user: BOB, p_launch_id: answer.launchId },
      { p_user: BOB, p_launch_id: answer.launchId },
    ]);
    const bob = await consume(bobSeat.seatReservation);
    assert.equal(room.authOf(bob.sessionId)?.username, 'bob');
    const cara = await consume((await seat(answer.launchId, CARA)).seatReservation);
    assert.equal(room.authOf(cara.sessionId)?.username, 'cara');
    await waitFor(() => room.metadata.players === 3, 'three seated');
    assert.equal(room.metadata.connected, 3);

    // Friends outside the party can still find the room by its code.
    const byCode = await colyseus.http.get(`/rooms/code/${answer.code}`);
    assert.equal((byCode.data as { roomId: string }).roomId, answer.roomId);
    assert.equal((byCode.data as { metadata: { partyId: string } }).metadata.partyId, PARTY);
  });

  it('launch: a public, unlocked room with a seat for everyone is reused (fullest first); none for a locked or small one', async () => {
    const small = await colyseus.createRoom<object>('hello', { maxClients: 2 });
    const locked = await colyseus.createRoom<object>('hello', {});
    await locked.lock();
    const empty = await colyseus.createRoom<object>('hello', {});
    const busy = await colyseus.createRoom<object>('hello', {});
    const guest = await colyseus.connectTo(busy);
    guest.onMessage('hello', () => {});

    members.push(member(CARA, 'cara'));
    const answer = await launch();
    assert.equal(answer.roomId, busy.roomId, 'the fullest public room with 3 free seats');
    assert.equal(answer.code, null, 'no join code: a public room');
    assert.deepEqual(party.of('server_party_launch_commit')[0], {
      p_party_id: PARTY,
      p_leader: LEADER,
      p_game_id: 'hello',
      p_room_id: busy.roomId,
      p_code: null,
    });
    assert.equal(heldLaunch(answer.launchId)!.seatSeconds, 15, "Colyseus' default seat timeout, read from the room");
    assert.equal((busy as RallyRoom).partyId, null, 'the room is not turned into a party room');
    assert.equal(busy.metadata.name, `Hello ${busy.roomId.slice(0, 4).toUpperCase()}`);
    assert.equal((await matchMaker.query({ name: 'hello' })).length, 4, 'no room created');
    assert.ok([small.roomId, locked.roomId, empty.roomId].every((id) => id !== answer.roomId));

    // Everyone fits: the party plays with the guest already there.
    await consume(answer.seatReservation);
    await consume((await seat(answer.launchId, BOB)).seatReservation);
    await consume((await seat(answer.launchId, CARA)).seatReservation);
    await waitFor(() => busy.clients.length === 4, 'four in the busy room');
  });

  it('seat: the held reservation is returned until the room timeout minus 2 s, then a new one replaces it', async () => {
    const answer = await launch();
    assert.deepEqual((await seat(answer.launchId, LEADER)).seatReservation, answer.seatReservation, "the leader's own");
    const first = (await seat(answer.launchId, BOB)).seatReservation;
    skewMs = 120_000 - SEAT_SAFETY_MS - 500;
    assert.deepEqual((await seat(answer.launchId, BOB)).seatReservation, first, 'still fresh at 117.5 s');
    skewMs = 120_000 - SEAT_SAFETY_MS + 500;
    const second = (await seat(answer.launchId, BOB)).seatReservation;
    assert.notEqual(second.sessionId, first.sessionId, 'a new reservation at 118.5 s');
    assert.equal(second.roomId, answer.roomId);
    assert.deepEqual(heldLaunch(answer.launchId)!.seats.get(BOB)!.reservation, second, 'and it replaced the held one');
    assert.deepEqual((await seat(answer.launchId, BOB)).seatReservation, second, 'fresh again');
    const bob = await consume(second);
    assert.equal(colyseus.getRoomById<RallyRoom>(answer.roomId).authOf(bob.sessionId)?.username, 'bob');
    // The leader's seat, made at the same time, is as stale: the leader's app asking late also gets a new one.
    assert.notEqual((await seat(answer.launchId, LEADER)).seatReservation.sessionId, answer.seatReservation.sessionId);
  });

  it('seat: a member whose Colyseus seat really expired is re-seated (short timeout on a public room)', async () => {
    const room = await colyseus.createRoom<object>('hello', {});
    room.seatReservationTimeout = 2; // the room the party is seated in decides: 2 s here, 15 s by default, 120 s for party rooms
    const answer = await launch();
    assert.equal(answer.roomId, room.roomId);
    assert.equal(heldLaunch(answer.launchId)!.seatSeconds, 2);
    const leader = await consume(answer.seatReservation); // keeps the room alive while Bob's seat lapses
    const stale = heldLaunch(answer.launchId)!.seats.get(BOB)!.reservation;
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(room.clients.length, 1);
    await assert.rejects(consume(stale), 'the seat made at launch is gone');

    const fresh = (await seat(answer.launchId, BOB)).seatReservation;
    assert.notEqual(fresh.sessionId, stale.sessionId);
    const bob = await consume(fresh);
    assert.equal((room as RallyRoom).authOf(bob.sessionId)?.userId, BOB);
    assert.equal(leader.sessionId, answer.seatReservation.sessionId);
  });

  it('launch skips a member the room cannot seat; /party/seat answers 409 while the room is full', async () => {
    // hello rooms seat 8 (RallyRoom default); the fake database (max_players 9) lets a 9th member through.
    games.hello = 9;
    for (let i = 0; i < 7; i++)
      members.push(member(`4f${String(i).padStart(6, '0')}-0000-4000-8000-00000000000${i}`, `m${i}`));
    assert.equal(members.length, 9);
    const answer = await launch();
    const held = heldLaunch(answer.launchId)!;
    assert.equal(held.seats.size, 8, 'the 9th reservation failed and was skipped');
    const ninth = members[8]!.user_id;
    assert.equal(held.seats.has(ninth), false);
    const full = await failsWith(seat(answer.launchId, ninth), 409);
    assert.deepEqual(full, { error: 'the room is full' });
    // Bob takes his seat and leaves for good: one seat is free again, so the 9th member gets it.
    const bob = await consume((await seat(answer.launchId, BOB)).seatReservation);
    await bob.leave(true);
    const room = colyseus.getRoomById<RallyRoom>(answer.roomId);
    await waitFor(() => room.seatCount === 0, 'bob left');
    const seated = await seat(answer.launchId, ninth);
    assert.equal(seated.roomId, answer.roomId);
  });

  it('404 for a non-leader launch, a non-member or expired seat, a gone launch; 409 for a game that is too small; 410 for a gone room', async () => {
    assert.deepEqual(await failsWith(launch('hello', BOB), 404), { error: 'you are not leading a party' });
    members.push(member(CARA, 'cara'), member(STRANGER, 'dee'), member('5a000000-0000-4000-8000-000000000005', 'eve'));
    assert.deepEqual(await failsWith(launch('sushi'), 409), { error: 'your party is 5; sushi fits 4' });
    assert.deepEqual(await failsWith(launch('chess'), 409), { error: 'game chess is not published' });
    members.length = 2;
    assert.deepEqual(await failsWith(launch('nope'), 409), { error: 'game nope is not published' });
    assert.deepEqual(party.of('server_party_launch_commit'), [], 'nothing committed');

    const answer = await launch();
    assert.deepEqual(await failsWith(seat(answer.launchId, STRANGER), 404), {
      error: 'that launch is not yours or has expired',
    });
    assert.deepEqual(await failsWith(seat('0000000a-0000-4000-8000-000000000099', BOB), 404), {
      error: 'that launch is not yours or has expired',
    });
    // The database says the launch expired (10 min): 404, even though this process still holds the seats.
    party.expire(answer.launchId);
    await failsWith(seat(answer.launchId, BOB), 404);

    // A launch this process forgot (15 min eviction) while the database still has it: 410.
    const second = await launch();
    skewMs = LAUNCH_TTL_MS;
    assert.deepEqual(await failsWith(seat(second.launchId, BOB), 410), { error: 'that match has ended' });
    assert.equal(heldLaunch(second.launchId), undefined, 'evicted');
    skewMs = 0;

    // The room is gone (everyone left, or it was disposed): 410, and the launch is dropped.
    const third = await launch();
    colyseus.getRoomById(third.roomId).disconnect();
    await waitFor(() => matchMaker.getLocalRoomById(third.roomId) === undefined, 'room disposed');
    assert.deepEqual(await failsWith(seat(third.launchId, BOB), 410), { error: 'that match has ended' });
    assert.equal(heldLaunch(third.launchId), undefined);
  });

  it('401 without a signed-in user (no token, malformed, invalid, anonymous); 400 for a bad body; 503 without a service client', async () => {
    for (const path of ['/party/launch', '/party/seat']) {
      const body = path === '/party/launch' ? { gameId: 'hello' } : { launchId: PARTY };
      assert.deepEqual(await failsWith(post(path, null, body), 401), { error: 'sign in to play with your party' });
      await failsWith(post(path, 'Basic abc', body), 401);
      await failsWith(post(path, 'Bearer ', body), 401);
      const bad = await failsWith(post(path, 'Bearer not.a.jwt', body), 401);
      assert.match(bad.error, /^sign in to play with your party \(/);
      const anonymous = await token(LEADER, { is_anonymous: true });
      assert.deepEqual(await failsWith(post(path, `Bearer ${anonymous}`, body), 401), {
        error: 'guests cannot play with a party',
      });
    }
    assert.deepEqual(party.calls, [], 'nothing reaches the database without a user');

    const auth = await bearer(LEADER);
    assert.deepEqual(await failsWith(post('/party/launch', auth, {}), 400), { error: 'gameId is required' });
    await failsWith(post('/party/launch', auth, { gameId: 7 }), 400);
    await failsWith(post('/party/launch', auth, { gameId: 'x'.repeat(65) }), 400);
    await failsWith(post('/party/launch', auth, '[not json'), 400);
    assert.deepEqual(await failsWith(post('/party/seat', auth, { launchId: 'abc' }), 400), {
      error: 'launchId is required',
    });
    await failsWith(post('/party/seat', auth, { launchId: null }), 400);
    assert.deepEqual(party.calls, []);

    configureParty({ api: null, verify });
    assert.deepEqual(await failsWith(launch(), 503), { error: 'parties are not available on this server' });
    assert.deepEqual(await failsWith(seat(PARTY, BOB), 503), { error: 'parties are not available on this server' });
  });

  it('429 after 6 launches per minute per leader; a database failure is a 503 and nothing is committed', async () => {
    assert.equal(LAUNCHES_PER_MINUTE, 6);
    for (let i = 0; i < 6; i++) await launch();
    assert.deepEqual(await failsWith(launch(), 429), { error: 'too many launches; try again in a minute' });
    assert.equal(party.of('server_party_launch_begin').length, 6, 'the 7th never reached the database');
    skewMs = 60_001;
    await launch();
    assert.equal(party.of('server_party_launch_begin').length, 7, 'the window slid');

    party.failing = (name) => name === 'server_party_launch_begin';
    assert.deepEqual(await failsWith(launch(), 503), { error: 'party launch failed; try again' });
    party.failing = (name) => name === 'server_party_launch_commit';
    const roomsBefore = (await matchMaker.query({ name: 'hello' })).length;
    assert.deepEqual(await failsWith(launch(), 503), { error: 'party launch failed; try again' });
    assert.equal(
      (await matchMaker.query({ name: 'hello' })).length,
      roomsBefore + 1,
      'the room exists; its seats lapse',
    );
    party.failing = false;
  });

  it('a client cannot set the party options through matchmaking; the registry maps game ids to room types', async () => {
    assert.deepEqual(stripServerOnlyOptions({ party: true, partyId: 'x', partyLeaderName: 'evil', name: 'ok' }), {
      name: 'ok',
    });
    assert.deepEqual(stripServerOnlyOptions(null), {});
    const sdkRoom = await colyseus.sdk.joinOrCreate('hello', {
      username: 'Spike',
      party: true,
      partyId: PARTY,
      partyLeaderName: 'evil',
    } as object);
    sdkRoom.onMessage('hello', () => {});
    sdkRoom.onMessage('pong', () => {});
    const room = colyseus.getRoomById<RallyRoom>(sdkRoom.roomId);
    assert.equal(room.partyId, null);
    assert.equal(room.seatReservationTimeout, 15);
    assert.equal(room.metadata.partyId, undefined);
    assert.doesNotMatch(room.roomTitle, /party/);

    assert.equal(roomNameForGame('sumo'), 'sumo');
    assert.equal(roomNameForGame('overrun'), 'overrun');
    assert.equal(roomNameForGame('hello'), 'hello', 'the dev room has no gameId option: the key is the game id');
    assert.equal(roomNameForGame('chess'), null);
  });
});

describe('ServiceApi: server_party_* RPC names and shapes', () => {
  const LAUNCH = '0000000a-0000-4000-8000-000000000001';

  it('partyLaunchBegin / partyLaunchCommit / partyMember', async () => {
    const fake = fakeRpc({
      server_party_launch_begin: {
        party_id: PARTY,
        members: [
          { user_id: LEADER, username: 'sloth', avatar_url: 'https://cdn.test/s.png' },
          { user_id: BOB, username: 'bob', avatar_url: null },
          { user_id: CARA, username: 'cara', avatar_url: 'javascript:alert(1)' },
        ],
      },
      server_party_launch_commit: LAUNCH,
      server_party_member: ({ p_user }: { p_user: string }) =>
        p_user === BOB
          ? { party_id: PARTY, game_id: 'sumo', room_id: 'R1', code: 'ABCDEF', username: 'bob', avatar_url: null }
          : null,
    });
    const api = createServiceApi(fake.rpc);
    assert.deepEqual(await api.partyLaunchBegin(LEADER, 'sumo'), {
      partyId: PARTY,
      members: [
        { userId: LEADER, username: 'sloth', avatarUrl: 'https://cdn.test/s.png' },
        { userId: BOB, username: 'bob', avatarUrl: null },
        { userId: CARA, username: 'cara', avatarUrl: null },
      ],
    });
    assert.equal(
      await api.partyLaunchCommit({ partyId: PARTY, leaderId: LEADER, gameId: 'sumo', roomId: 'R1', code: 'ABCDEF' }),
      LAUNCH,
    );
    assert.deepEqual(await api.partyMember(BOB, LAUNCH), {
      partyId: PARTY,
      gameId: 'sumo',
      roomId: 'R1',
      code: 'ABCDEF',
      username: 'bob',
      avatarUrl: null,
    });
    assert.equal(await api.partyMember(STRANGER, LAUNCH), null);
    assert.equal(await api.partyMember('guest:abc', LAUNCH), null, 'not a uuid: no call');
    assert.equal(await api.partyMember(BOB, 'not-a-launch'), null);
    assert.deepEqual(fake.calls, [
      { name: 'server_party_launch_begin', args: { p_leader: LEADER, p_game_id: 'sumo' } },
      {
        name: 'server_party_launch_commit',
        args: { p_party_id: PARTY, p_leader: LEADER, p_game_id: 'sumo', p_room_id: 'R1', p_code: 'ABCDEF' },
      },
      { name: 'server_party_member', args: { p_user: BOB, p_launch_id: LAUNCH } },
      { name: 'server_party_member', args: { p_user: STRANGER, p_launch_id: LAUNCH } },
    ]);

    // A public room has no code: null travels as p_code.
    await api.partyLaunchCommit({ partyId: PARTY, leaderId: LEADER, gameId: 'sumo', roomId: 'R2', code: null });
    assert.equal(fake.calls.at(-1)!.args.p_code, null);

    // Garbage answers are errors, not seats.
    for (const bad of [null, {}, { party_id: PARTY, members: [{ user_id: 1 }] }]) {
      await assert.rejects(
        createServiceApi(fakeRpc({ server_party_launch_begin: bad }).rpc).partyLaunchBegin(LEADER, 'sumo'),
        (e: unknown) => e instanceof ServiceRpcError && /unexpected/.test(e.message),
      );
    }
    await assert.rejects(
      createServiceApi(fakeRpc({ server_party_launch_commit: 'nope' }).rpc).partyLaunchCommit({
        partyId: PARTY,
        leaderId: LEADER,
        gameId: 'sumo',
        roomId: 'R1',
        code: null,
      }),
      /unexpected answer/,
    );
    await assert.rejects(
      createServiceApi(fakeRpc({ server_party_member: { party_id: PARTY } }).rpc).partyMember(BOB, LAUNCH),
      /unexpected answer/,
    );
  });

  it('m2 error codes: INVALID (22023) and NOT_FOUND (P0002) with their detail', () => {
    const invalid = rpcInvalid('server_party_launch_begin', 'party is full');
    assert.equal(isInvalid(invalid), true);
    assert.equal(isInvalid(rpcNotFound('f', 'x')), false);
    assert.equal(isInvalid(new ServiceRpcError('rpc f: HTTP 400 INVALID: by message', 400)), true);
    assert.equal(isInvalid(new Error('INVALID')), false);
    assert.equal(rpcErrorDetail(invalid, 'fallback'), 'party is full');
    assert.equal(rpcErrorDetail(rpcNotFound('f', 'no such party'), 'fallback'), 'no such party');
    assert.equal(rpcErrorDetail(new ServiceRpcError('rpc f: timed out', 0), 'fallback'), 'fallback');
    assert.equal(rpcErrorDetail(new Error('x'), 'fallback'), 'fallback');
  });
});
