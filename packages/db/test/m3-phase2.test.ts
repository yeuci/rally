// 20261031000000_m3_phase2.sql: presence (heartbeat, friends_presence, public_presence), the game_rooms mirror
// (server_* RPCs, live counts, friend_join_target), server-written match results (server_record_match), sanctions,
// the privacy `presence` key, the solo-only guards and the purge additions. See docs/m3-phase2.md §2, §3, §5, §8.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import {
  asAnon,
  asAnonymousUser,
  asRole,
  asService,
  asUser,
  createTestDb,
  insertGame,
  signUp,
  signUpAnonymously,
} from './harness.ts';
import type { FriendJoinTarget, HeartbeatResult, PublicPresence, RecordedMatch, SanctionStatus } from '../src/index.ts';

const NOBODY = '00000000-0000-0000-0000-000000000000';

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const anonymousForbidden = sqlstate('42501', /^ANONYMOUS_FORBIDDEN/);
const unauthenticated = sqlstate('42501', /^UNAUTHENTICATED/);
const notFound = sqlstate('P0002', /^NOT_FOUND/);
const invalid = sqlstate('22023', /^INVALID/);
const notSolo = sqlstate('22023', /^INVALID: \S+ is not a solo game$/);
const permissionDenied = /permission denied/;

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

/** Accepted friendship, written as superuser (the RPCs are covered by social.test.ts). */
const befriend = (db: PGlite, a: string, b: string) =>
  db.query(`insert into public.friendships (user_id, friend_id, status, accepted_at) values ($1, $2, 'accepted', now())`, [
    a,
    b,
  ]);

const setPrivacy = (db: PGlite, uid: string, privacy: object) =>
  asUser(db, uid, () => db.query(`update public.profiles set privacy = $2::jsonb where id = $1`, [uid, JSON.stringify(privacy)]));

/** A multiplayer game (no 'solo' mode), like Sumo. */
async function insertMultiplayerGame(db: PGlite, id: string): Promise<void> {
  await insertGame(db, id);
  await db.query(`update public.games set modes = '{quick,browser,private}', max_players = 8 where id = $1`, [id]);
}

interface RoomSnapshot {
  roomId: string;
  gameId: string;
  roomName?: string;
  name?: string;
  private?: boolean;
  code?: string | null;
  clients?: number;
  maxClients?: number;
  locked?: boolean;
  phase?: string | null;
  serverVersion?: number;
  playerIds?: unknown[];
}

const upsertRoom = (db: PGlite, room: RoomSnapshot | unknown) =>
  asService(db, () => db.query(`select public.server_upsert_game_room($1::jsonb)`, [JSON.stringify(room)]));

const heartbeat = (db: PGlite, uid: string, status: string, game: string | null = null, room: string | null = null) =>
  asUser(
    db,
    uid,
    async () =>
      (await db.query<{ r: HeartbeatResult }>(`select public.heartbeat($1, $2, $3) as r`, [status, game, room])).rows[0]!.r,
  );

interface PresenceRow {
  user_id: string;
  status: string;
  game_id: string | null;
  game_title: string | null;
  room_id: string | null;
  joinable: boolean;
}
const friendsPresence = (db: PGlite, uid: string) =>
  asUser(db, uid, async () => (await db.query<PresenceRow>(`select * from public.friends_presence()`)).rows);

const publicPresence = async (db: PGlite, viewer: string | null, owner: string): Promise<PublicPresence> => {
  const run = async () =>
    (await db.query<{ r: PublicPresence }>(`select public.public_presence($1) as r`, [owner])).rows[0]!.r;
  return viewer ? asUser(db, viewer, run) : asAnon(db, run);
};

const joinTarget = (db: PGlite, uid: string, friend: string) =>
  asUser(
    db,
    uid,
    async () => (await db.query<{ r: FriendJoinTarget }>(`select public.friend_join_target($1) as r`, [friend])).rows[0]!.r,
  );

const age = (db: PGlite, table: 'presence' | 'game_rooms', seconds: number, where = 'true') =>
  db.query(`update public.${table} set updated_at = now() - make_interval(secs => $1) where ${where}`, [seconds]);

// ---------------------------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------------------------

describe('grants', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  test('every server_* function is executable by service_role only', async () => {
    const fns = await db.query<{ sig: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              has_function_privilege('public', p.oid, 'execute') as pub
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'server\\_%' order by 1`,
    );
    assert.deepEqual(
      fns.rows.map((r) => r.sig),
      [
        'server_record_match(jsonb)',
        'server_record_visits(text,integer)',
        'server_remove_game_room(text)',
        'server_sanction_status(uuid)',
        'server_touch_game_rooms(text[])',
        'server_upsert_game_room(jsonb)',
      ],
    );
    for (const r of fns.rows) assert.deepEqual([r.anon, r.auth, r.svc, r.pub], [false, false, true, false], r.sig);
  });

  test('client RPCs: who may call what', async () => {
    const expect: Record<string, [anon: boolean, auth: boolean]> = {
      'public.heartbeat(text, text, text)': [false, true],
      'public.friends_presence()': [false, true],
      'public.friend_join_target(uuid)': [false, true],
      'public.public_presence(uuid)': [true, true],
      'public.game_live_counts()': [true, true],
    };
    for (const [fn, [anon, auth]] of Object.entries(expect)) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon, auth, svc: true }, fn);
    }
  });

  test('tables: game_rooms, presence, match_results are service-only; user_sanctions is select-own', async () => {
    for (const t of ['game_rooms', 'presence', 'match_results', 'user_sanctions']) {
      for (const priv of ['insert', 'update', 'delete']) {
        const r = await db.query<{ ok: boolean }>(
          `select has_table_privilege('authenticated', $1, $2) or has_table_privilege('anon', $1, $2) as ok`,
          [`public.${t}`, priv],
        );
        assert.equal(r.rows[0]!.ok, false, `${t} ${priv}`);
      }
      const sel = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_table_privilege('anon', $1, 'select') as anon, has_table_privilege('authenticated', $1, 'select') as auth,
                has_table_privilege('service_role', $1, 'select') as svc`,
        [`public.${t}`],
      );
      assert.deepEqual(sel.rows[0], { anon: false, auth: t === 'user_sanctions', svc: true }, t);
    }
    const rls = await db.query<{ relname: string; on: boolean }>(
      `select relname, relrowsecurity as on from pg_class
        where relnamespace = 'public'::regnamespace and relname in ('game_rooms', 'presence', 'match_results', 'user_sanctions')`,
    );
    assert.ok(rls.rows.length === 4 && rls.rows.every((r) => r.on));
  });

  test('clients calling server_* are refused; private helpers are unreachable', async () => {
    const alice = await user(db, 'grants_alice');
    for (const run of [(fn: () => Promise<void>) => asUser(db, alice, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(async () => {
        await assert.rejects(db.query(`select public.server_record_match('{}'::jsonb)`), permissionDenied);
        await assert.rejects(db.query(`select public.server_upsert_game_room('{}'::jsonb)`), permissionDenied);
        await assert.rejects(db.query(`select public.server_remove_game_room('x')`), permissionDenied);
        await assert.rejects(db.query(`select public.server_touch_game_rooms('{x}')`), permissionDenied);
        await assert.rejects(db.query(`select public.server_sanction_status($1)`, [alice]), permissionDenied);
        await assert.rejects(db.query(`select private.active_sanction($1, 'ban')`, [alice]), permissionDenied);
        await assert.rejects(db.query(`select * from private.presence_of($1)`, [alice]), permissionDenied);
        await assert.rejects(db.query(`select * from public.presence`), permissionDenied);
        await assert.rejects(db.query(`select * from public.game_rooms`), permissionDenied);
      });
    }
    const acl = await db.query<{ public_exec: boolean }>(
      `select has_function_privilege('public', oid, 'execute') as public_exec from pg_proc
        where pronamespace = 'private'::regnamespace and proname in ('active_sanction', 'presence_of', 'purge_stale_rows')`,
    );
    assert.deepEqual(acl.rows.map((r) => r.public_exec), [false, false, false]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Privacy key
// ---------------------------------------------------------------------------------------------------------------

describe('profiles.privacy.presence', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    alice = await user(db, 'alice');
  });
  after(() => db.close());

  test('checked like games / friends; my_privacy defaults it to friends', async () => {
    const mine = () => asUser(db, alice, async () => (await db.query<{ p: object }>(`select public.my_privacy() as p`)).rows[0]!.p);
    assert.deepEqual(await mine(), { games: 'public', friends: 'public', presence: 'friends' });
    for (const level of ['public', 'friends', 'private']) {
      await setPrivacy(db, alice, { presence: level });
      assert.deepEqual(await mine(), { games: 'public', friends: 'public', presence: level });
    }
    await assert.rejects(setPrivacy(db, alice, { presence: 'everyone' }), sqlstate('22023', /^INVALID: privacy\.presence/));
    await assert.rejects(setPrivacy(db, alice, { presence: true }), invalid);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat and presence visibility
// ---------------------------------------------------------------------------------------------------------------

describe('heartbeat', () => {
  let db: PGlite;
  let alice: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    alice = await user(db, 'alice');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() => db.exec(`delete from public.presence; delete from public.rate_limits; delete from public.user_sanctions;`));
  after(() => db.close());

  const row = async () =>
    (
      await db.query<{ status: string; game_id: string | null; room_id: string | null }>(
        `select status, game_id, room_id from public.presence where user_id = $1`,
        [alice],
      )
    ).rows[0];

  test('upserts the row; online drops game and room; offline deletes it', async () => {
    assert.deepEqual(await heartbeat(db, alice, 'online', 'sumo', 'r1'), { ok: true, ttl_s: 90, interval_s: 45 });
    assert.deepEqual(await row(), { status: 'online', game_id: null, room_id: null });
    assert.deepEqual(await heartbeat(db, alice, 'in_game', 'sumo', 'r1'), { ok: true, ttl_s: 90, interval_s: 45 });
    assert.deepEqual(await row(), { status: 'in_game', game_id: 'sumo', room_id: 'r1' });
    assert.deepEqual(await heartbeat(db, alice, 'offline'), { ok: true, ttl_s: 90, interval_s: 45 });
    assert.equal(await row(), undefined);
  });

  test('bad input is INVALID; anonymous and signed out are refused', async () => {
    await assert.rejects(heartbeat(db, alice, 'away'), invalid);
    await assert.rejects(heartbeat(db, alice, 'in_game'), invalid);
    await assert.rejects(heartbeat(db, alice, 'in_game', 'nope', 'r1'), invalid);
    await assert.rejects(heartbeat(db, alice, 'in_game', 'sumo', 'x'.repeat(129)), invalid);
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.heartbeat('online')`), anonymousForbidden);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.heartbeat('online')`), permissionDenied);
    });
    assert.equal(await count(db, `select 1 from public.presence`), 0);
  });

  test('token bucket of 10: then ok:false without writing (no raise); offline is never limited', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await heartbeat(db, alice, 'online')).ok, true);
    assert.deepEqual(await heartbeat(db, alice, 'in_game', 'sumo', 'r1'), { ok: false, ttl_s: 90, interval_s: 45 });
    assert.deepEqual(await row(), { status: 'online', game_id: null, room_id: null });
    assert.equal((await heartbeat(db, alice, 'offline')).ok, true);
    assert.equal(await row(), undefined);
  });

  test('a banned user is always deleted (ok:false); an expired or revoked ban does not count', async () => {
    await heartbeat(db, alice, 'online');
    await db.query(`insert into public.user_sanctions (user_id, kind, reason, expires_at) values ($1, 'ban', 'spam', now() + interval '1 day')`, [alice]);
    assert.equal((await heartbeat(db, alice, 'online')).ok, false);
    assert.equal(await row(), undefined);
    await db.query(`update public.user_sanctions set revoked_at = now()`);
    assert.equal((await heartbeat(db, alice, 'online')).ok, true);
    await db.query(`update public.user_sanctions set revoked_at = null, expires_at = now() - interval '1 second'`);
    assert.equal((await heartbeat(db, alice, 'online')).ok, true);
    // A mute is not a ban.
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'mute', 'chat')`, [alice]);
    assert.equal((await heartbeat(db, alice, 'online')).ok, true);
  });
});

describe('presence visibility', () => {
  let db: PGlite;
  let me: string;
  let ann: string; // friend, in a game
  let ben: string; // friend, online
  let cat: string; // stranger
  let dan: string; // friend who blocks
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    me = await user(db, 'meg');
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    dan = await user(db, 'dan');
  });
  beforeEach(async () => {
    await db.exec(`delete from public.presence; delete from public.game_rooms; delete from public.rate_limits;
                   delete from public.friendships; delete from public.blocks; delete from public.user_sanctions;
                   update public.profiles set privacy = '{}'`);
    await befriend(db, me, ann);
    await befriend(db, ben, me);
    await befriend(db, me, dan);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', roomName: 'sumo', clients: 2, maxClients: 8, playerIds: [ann, cat] });
    await heartbeat(db, ann, 'in_game', 'sumo', 'r1');
    await heartbeat(db, ben, 'online');
    await heartbeat(db, cat, 'in_game', 'sumo', 'r1');
    await heartbeat(db, dan, 'online');
  });
  after(() => db.close());

  const byUser = (rows: PresenceRow[]) => Object.fromEntries(rows.map((r) => [r.user_id, r]));

  test('friends_presence: accepted friends only, in_game confirmed by the mirror, joinable', async () => {
    const rows = byUser(await friendsPresence(db, me));
    assert.deepEqual(Object.keys(rows).sort(), [ann, ben, dan].sort());
    assert.deepEqual(rows[ann], { user_id: ann, status: 'in_game', game_id: 'sumo', game_title: 'sumo', room_id: 'r1', joinable: true });
    assert.deepEqual(rows[ben], { user_id: ben, status: 'online', game_id: null, game_title: null, room_id: null, joinable: false });
  });

  test('in_game downgrades to online when the room is not live, does not seat the user, or is another room', async () => {
    await age(db, 'game_rooms', 61);
    assert.deepEqual(
      byUser(await friendsPresence(db, me))[ann],
      { user_id: ann, status: 'online', game_id: null, game_title: null, room_id: null, joinable: false },
    );
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8, playerIds: [cat] });
    assert.equal(byUser(await friendsPresence(db, me))[ann]!.status, 'online');
    // A spoofed heartbeat naming a room the user is not seated in.
    await upsertRoom(db, { roomId: 'r2', gameId: 'sumo', clients: 1, maxClients: 8, playerIds: [ben] });
    await heartbeat(db, ann, 'in_game', 'sumo', 'r2');
    assert.equal(byUser(await friendsPresence(db, me))[ann]!.status, 'online');
  });

  test('joinable is false for a full or locked room', async () => {
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 8, maxClients: 8, playerIds: [ann] });
    assert.equal(byUser(await friendsPresence(db, me))[ann]!.joinable, false);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, locked: true, playerIds: [ann] });
    assert.equal(byUser(await friendsPresence(db, me))[ann]!.joinable, false);
  });

  test('stale presence (> 90 s) reads as offline: not listed, public_presence null', async () => {
    await age(db, 'presence', 89, `user_id = '${ben}'`);
    assert.ok(byUser(await friendsPresence(db, me))[ben]);
    await age(db, 'presence', 91, `user_id = '${ben}'`);
    assert.equal(byUser(await friendsPresence(db, me))[ben], undefined);
    assert.equal(await publicPresence(db, me, ben), null);
  });

  test("privacy.presence 'private' hides a friend; blocks hide; banned friends are hidden", async () => {
    await setPrivacy(db, ann, { presence: 'private' });
    assert.equal(byUser(await friendsPresence(db, me))[ann], undefined);
    await setPrivacy(db, ann, { presence: 'public' });
    assert.ok(byUser(await friendsPresence(db, me))[ann]);
    // A block (without the friendship being removed, as block_user would) still hides.
    await db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [dan, me]);
    assert.equal(byUser(await friendsPresence(db, me))[dan], undefined);
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'x')`, [ben]);
    assert.equal(byUser(await friendsPresence(db, me))[ben], undefined);
  });

  test('public_presence: default friends; public for strangers and signed out; never a room id', async () => {
    assert.deepEqual(await publicPresence(db, me, ann), { status: 'in_game', game_id: 'sumo', game_title: 'sumo' });
    assert.deepEqual(await publicPresence(db, ann, ann), { status: 'in_game', game_id: 'sumo', game_title: 'sumo' });
    assert.equal(await publicPresence(db, cat, ann), null);
    assert.equal(await publicPresence(db, null, ann), null);
    await setPrivacy(db, ann, { presence: 'public' });
    assert.deepEqual(await publicPresence(db, cat, ann), { status: 'in_game', game_id: 'sumo', game_title: 'sumo' });
    assert.deepEqual(await publicPresence(db, null, ann), { status: 'in_game', game_id: 'sumo', game_title: 'sumo' });
    assert.deepEqual(await publicPresence(db, me, ben), { status: 'online', game_id: null, game_title: null });
    await setPrivacy(db, ann, { presence: 'private' });
    assert.equal(await publicPresence(db, me, ann), null);
    assert.deepEqual(await publicPresence(db, ann, ann), { status: 'in_game', game_id: 'sumo', game_title: 'sumo' });
    // Blocks hide even public presence, both ways.
    await setPrivacy(db, ann, { presence: 'public' });
    await db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [cat, ann]);
    assert.equal(await publicPresence(db, cat, ann), null);
    await assert.rejects(publicPresence(db, me, NOBODY), notFound);
  });

  test('friends_presence: signed out is refused; anonymous sessions see nothing', async () => {
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.friends_presence()`), permissionDenied);
    });
    // The authenticated role without a subject (no auth.uid()).
    await asRole(db, 'authenticated', async () => {
      await assert.rejects(db.query(`select * from public.friends_presence()`), unauthenticated);
    });
    const ghost = await signUpAnonymously(db, { username: 'ghost_pres', birth_date: '2000-01-01' });
    await asAnonymousUser(db, ghost, async () => {
      assert.equal(await count(db, `select * from public.friends_presence()`), 0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// game_rooms mirror, live counts, friend_join_target
// ---------------------------------------------------------------------------------------------------------------

describe('game_rooms mirror', () => {
  let db: PGlite;
  let ann: string;
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    ann = await user(db, 'ann');
  });
  beforeEach(() => db.exec(`delete from public.game_rooms`));
  after(() => db.close());

  const rooms = async () =>
    (
      await db.query<Record<string, unknown>>(
        `select room_id, game_id, room_name, name, private, code, clients, max_clients, locked, phase, server_version,
                player_ids from public.game_rooms order by room_id`,
      )
    ).rows;

  test('upsert by room_id: full snapshot, then an update; defaults; player_ids filtered, distinct, capped at 64', async () => {
    await upsertRoom(db, {
      roomId: 'r1', gameId: 'sumo', roomName: 'sumo', name: 'Sumo AB12', private: true, code: 'K7M2PQ', clients: 3,
      maxClients: 8, locked: false, phase: 'waiting', serverVersion: 2, playerIds: [ann, 'guest:xyz', ann.toUpperCase(), 7],
    });
    assert.deepEqual(await rooms(), [{
      room_id: 'r1', game_id: 'sumo', room_name: 'sumo', name: 'Sumo AB12', private: true, code: 'K7M2PQ', clients: 3,
      max_clients: 8, locked: false, phase: 'waiting', server_version: 2, player_ids: [ann],
    }]);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 4, maxClients: 8, phase: 'playing', playerIds: [] });
    assert.deepEqual(await rooms(), [{
      room_id: 'r1', game_id: 'sumo', room_name: 'sumo', name: '', private: false, code: null, clients: 4,
      max_clients: 8, locked: false, phase: 'playing', server_version: 0, player_ids: [],
    }]);
    const many = Array.from({ length: 70 }, () => crypto.randomUUID());
    await upsertRoom(db, { roomId: 'r2', gameId: 'sumo', maxClients: 64, playerIds: many });
    const r2 = (await rooms()).find((r) => r.room_id === 'r2')!;
    assert.deepEqual(r2.player_ids, many.slice(0, 64));
  });

  test('an unknown game writes nothing; malformed snapshots are INVALID', async () => {
    await upsertRoom(db, { roomId: 'h1', gameId: 'hello', maxClients: 8 });
    assert.equal(await count(db, `select 1 from public.game_rooms`), 0);
    for (const bad of [[], 'x', { gameId: 'sumo' }, { roomId: 'r1' }, { roomId: '', gameId: 'sumo' },
      { roomId: 'r1', gameId: 'sumo', clients: 'many' }, { roomId: 'r1', gameId: 'sumo', private: 'maybe' },
      { roomId: 'r1', gameId: 'sumo', maxClients: 2.5 }]) {
      await assert.rejects(upsertRoom(db, bad), invalid, JSON.stringify(bad));
    }
  });

  test('remove deletes the row; touch bumps live rows and deletes rows older than 10 minutes', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await upsertRoom(db, { roomId: id, gameId: 'sumo', maxClients: 8 });
    await asService(db, () => db.query(`select public.server_remove_game_room('d')`));
    await asService(db, () => db.query(`select public.server_remove_game_room('nope')`));
    await age(db, 'game_rooms', 50, `room_id = 'a'`);
    await age(db, 'game_rooms', 601, `room_id in ('b', 'c')`);
    const touched = await asService(
      db,
      async () => (await db.query<{ n: number }>(`select public.server_touch_game_rooms('{a,b,zzz}') as n`)).rows[0]!.n,
    );
    assert.equal(touched, 2);
    const left = await db.query<{ room_id: string; fresh: boolean }>(
      `select room_id, updated_at > now() - interval '1 second' as fresh from public.game_rooms order by 1`,
    );
    assert.deepEqual(left.rows, [{ room_id: 'a', fresh: true }, { room_id: 'b', fresh: true }]);
  });

  test('game_live_counts: live rows only, private seats counted but not private rooms, published games only', async () => {
    await insertMultiplayerGame(db, 'arena');
    await insertGame(db, 'drafty', 'draft');
    await upsertRoom(db, { roomId: 'p1', gameId: 'sumo', clients: 3, maxClients: 8 });
    await upsertRoom(db, { roomId: 'p2', gameId: 'sumo', clients: 2, maxClients: 8 });
    await upsertRoom(db, { roomId: 'priv', gameId: 'sumo', private: true, code: 'ABCDEF', clients: 4, maxClients: 8 });
    await upsertRoom(db, { roomId: 'stale', gameId: 'sumo', clients: 5, maxClients: 8 });
    await upsertRoom(db, { roomId: 'a1', gameId: 'arena', clients: 1, maxClients: 8 });
    await upsertRoom(db, { roomId: 'd1', gameId: 'drafty', clients: 1, maxClients: 8 });
    await age(db, 'game_rooms', 61, `room_id = 'stale'`);
    for (const run of [(fn: () => Promise<void>) => asAnon(db, fn), (fn: () => Promise<void>) => asUser(db, ann, fn)]) {
      await run(async () => {
        const r = await db.query(`select * from public.game_live_counts()`);
        assert.deepEqual(r.rows, [
          { game_id: 'arena', players: 1, rooms: 1 },
          { game_id: 'sumo', players: 9, rooms: 2 },
        ]);
      });
    }
  });
});

describe('friend_join_target', () => {
  let db: PGlite;
  let me: string;
  let ann: string;
  let cat: string;
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    me = await user(db, 'meg');
    ann = await user(db, 'ann');
    cat = await user(db, 'cat');
  });
  beforeEach(async () => {
    await db.exec(`delete from public.game_rooms; delete from public.friendships; update public.profiles set privacy = '{}'`);
    await befriend(db, me, ann);
  });
  after(() => db.close());

  test('public room: {game_id, room_id, code: null}', async () => {
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, playerIds: [ann] });
    assert.deepEqual(await joinTarget(db, me, ann), { game_id: 'sumo', room_id: 'r1', code: null });
  });

  test("private room: the code goes to friends of the seated player only", async () => {
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', private: true, code: 'K7M2PQ', clients: 2, maxClients: 8, playerIds: [ann] });
    assert.deepEqual(await joinTarget(db, me, ann), { game_id: 'sumo', room_id: 'r1', code: 'K7M2PQ' });
    await assert.rejects(joinTarget(db, cat, ann), notFound);
  });

  test('NOT_FOUND: not friends, pending request, not seated, stale, full, locked, privacy private, unknown', async () => {
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, playerIds: [ann] });
    await assert.rejects(joinTarget(db, cat, ann), notFound);
    await db.query(`insert into public.friendships (user_id, friend_id) values ($1, $2)`, [cat, ann]);
    await assert.rejects(joinTarget(db, cat, ann), notFound);
    await assert.rejects(joinTarget(db, me, NOBODY), notFound);
    await assert.rejects(joinTarget(db, me, me), notFound);

    await setPrivacy(db, ann, { presence: 'private' });
    await assert.rejects(joinTarget(db, me, ann), notFound);
    await setPrivacy(db, ann, {});

    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 8, maxClients: 8, playerIds: [ann] });
    await assert.rejects(joinTarget(db, me, ann), notFound);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, locked: true, playerIds: [ann] });
    await assert.rejects(joinTarget(db, me, ann), notFound);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, playerIds: [cat] });
    await assert.rejects(joinTarget(db, me, ann), notFound);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, playerIds: [ann] });
    await age(db, 'game_rooms', 61);
    await assert.rejects(joinTarget(db, me, ann), notFound);
  });

  test('the seat comes from the mirror, not from the heartbeat; the freshest joinable room wins', async () => {
    // Ann's heartbeat claims r9 (a room she is not seated in); the mirror seats her in r2.
    await upsertRoom(db, { roomId: 'r9', gameId: 'sumo', clients: 1, maxClients: 8, playerIds: [cat] });
    await heartbeat(db, ann, 'in_game', 'sumo', 'r9');
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8, playerIds: [ann] });
    await age(db, 'game_rooms', 30, `room_id = 'r1'`);
    await upsertRoom(db, { roomId: 'r2', gameId: 'sumo', clients: 1, maxClients: 8, playerIds: [ann] });
    assert.equal((await joinTarget(db, me, ann)).room_id, 'r2');
  });

  test('anonymous and signed out are refused', async () => {
    const ghost = await signUpAnonymously(db, { username: 'ghost_join', birth_date: '2000-01-01' });
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.friend_join_target($1)`, [ann]), anonymousForbidden);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.friend_join_target($1)`, [ann]), permissionDenied);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// server_record_match
// ---------------------------------------------------------------------------------------------------------------

interface MatchPlayer {
  userId: string;
  username?: string;
  guest: boolean;
  placement?: number;
  score?: number;
  achievements?: string[];
}
interface Match {
  matchId: string;
  gameId: string;
  roomId: string;
  private: boolean;
  winnerUserId: string | null;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  rounds: number;
  leaderboardDeltas: Record<string, Record<string, number>>;
  players: MatchPlayer[];
  details?: Record<string, unknown>;
}

let matchSeq = 0;
function match(players: MatchPlayer[], over: Partial<Match> = {}): Match {
  const ended = over.endedAt ? new Date(over.endedAt) : new Date();
  const duration = over.durationSec ?? 95;
  return {
    matchId: `room${++matchSeq}:1`,
    gameId: 'sumo',
    roomId: `room${matchSeq}`,
    private: false,
    winnerUserId: null,
    startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
    endedAt: ended.toISOString(),
    durationSec: duration,
    rounds: 3,
    leaderboardDeltas: {},
    players: players.map((p, i) => ({ username: `p${i}`, placement: i + 1, score: 0, achievements: [], ...p })),
    ...over,
  };
}
const p = (userId: string, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ userId, guest: false, ...extra });

const record = (db: PGlite, m: unknown) =>
  asService(
    db,
    async () => (await db.query<{ r: RecordedMatch }>(`select public.server_record_match($1::jsonb) as r`, [JSON.stringify(m)])).rows[0]!.r,
  );

const statsOf = async (db: PGlite, uid: string, game = 'sumo') =>
  (
    await db.query<{ plays: number; wins: number; losses: number; playtime_s: number }>(
      `select plays, wins, losses, playtime_s from public.game_stats where user_id = $1 and game_id = $2`,
      [uid, game],
    )
  ).rows[0];

const entries = async (db: PGlite, key = 'wins') =>
  (
    await db.query<{ user_id: string; period_key: string; score: number; source: string }>(
      `select e.user_id, e.period_key, e.score, e.source from public.leaderboard_entries e
         join public.leaderboards b on b.id = e.leaderboard_id where b.game_id = 'sumo' and b.key = $1
        order by e.period_key, e.user_id`,
      [key],
    )
  ).rows;

describe('server_record_match', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    await db.exec(`
      insert into public.leaderboards (game_id, key, sort, period) values
        ('sumo', 'wins', 'desc', 'weekly'), ('sumo', 'total', 'desc', 'alltime');
      insert into public.achievements (game_id, key, title, icon) values
        ('sumo', 'first_win', 'First win', '🏆'), ('sumo', 'yokozuna', 'Yokozuna', null);
    `);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() =>
    db.exec(`delete from public.match_results; delete from public.game_stats; delete from public.leaderboard_entries;
             delete from public.user_achievements; delete from public.rate_limits; delete from public.user_sanctions;`),
  );
  after(() => db.close());

  test('stats: plays, wins, losses (ties count neither), playtime clamped to 2 h, last_played_at = ended', async () => {
    const ended = new Date(Date.now() - 60_000).toISOString();
    const r = await record(db, match([p(ann), p(ben)], { winnerUserId: ann, endedAt: ended }));
    assert.equal(r.duplicate, false);
    assert.deepEqual(await statsOf(db, ann), { plays: 1, wins: 1, losses: 0, playtime_s: 95 });
    assert.deepEqual(await statsOf(db, ben), { plays: 1, wins: 0, losses: 1, playtime_s: 95 });
    const lp = await db.query<{ ok: boolean }>(
      `select last_played_at = $2::timestamptz as ok from public.game_stats where user_id = $1`,
      [ann, ended],
    );
    assert.equal(lp.rows[0]!.ok, true);

    await record(db, match([p(ann), p(ben)], { winnerUserId: null, durationSec: 99999 })); // a tie
    assert.deepEqual(await statsOf(db, ann), { plays: 2, wins: 1, losses: 0, playtime_s: 95 + 7200 });
    assert.deepEqual(await statsOf(db, ben), { plays: 2, wins: 0, losses: 1, playtime_s: 95 + 7200 });

    // A guest winner still means everyone else lost.
    await record(db, match([p(ann), { userId: 'guest:abc', guest: true }], { winnerUserId: 'guest:abc' }));
    assert.deepEqual(await statsOf(db, ann), { plays: 3, wins: 1, losses: 1, playtime_s: 95 + 7200 + 95 });
  });

  test('idempotent on matchId: the second report returns {duplicate:true} and writes nothing', async () => {
    const m = match([p(ann), p(ben)], { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } });
    const first = await record(db, m);
    assert.equal(first.duplicate, false);
    assert.deepEqual(await record(db, m), { duplicate: true });
    assert.deepEqual(await record(db, { ...m, winnerUserId: ben }), { duplicate: true });
    assert.deepEqual(await statsOf(db, ann), { plays: 1, wins: 1, losses: 0, playtime_s: 95 });
    assert.deepEqual((await entries(db)).map((e) => e.score), [1]);
    assert.equal(await count(db, `select 1 from public.match_results`), 1);
    const row = await db.query<{ payload: Match; private: boolean; winner_id: string; rounds: number }>(
      `select payload, private, winner_id, rounds from public.match_results`,
    );
    assert.deepEqual(row.rows[0], { payload: m, private: false, winner_id: ann, rounds: 3 });
  });

  test('leaderboards: deltas add up with source server, in the weekly bucket of the match end', async () => {
    const lastWeek = new Date(Date.now() - 7 * 86400_000).toISOString();
    const pk = async (period: string, at: string) =>
      (await db.query<{ k: string }>(`select public.period_key($1, $2::timestamptz) as k`, [period, at])).rows[0]!.k;
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 }, total: { [ann]: 3, [ben]: 1 } } }));
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } }));
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, endedAt: lastWeek, leaderboardDeltas: { wins: { [ann]: 1 } } }));
    // A future endedAt is clamped to now() for the bucket.
    const future = new Date(Date.now() + 30 * 86400_000).toISOString();
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, endedAt: future, leaderboardDeltas: { wins: { [ann]: 1 } } }));
    const nowKey = await pk('weekly', new Date().toISOString());
    assert.deepEqual(await entries(db), [
      { user_id: ann, period_key: await pk('weekly', lastWeek), score: 1, source: 'server' },
      { user_id: ann, period_key: nowKey, score: 3, source: 'server' },
    ].sort((a, b) => a.period_key.localeCompare(b.period_key)));
    assert.deepEqual(
      (await entries(db, 'total')).map((e) => [e.user_id, e.period_key, e.score]).sort(),
      [[ann, 'all', 3], [ben, 'all', 1]].sort(),
    );
  });

  test('leaderboards: bad deltas, unknown boards and ineligible players are skipped silently', async () => {
    const r = await record(db, match([p(ann), p(ben), { userId: 'guest:1', guest: true }], {
      winnerUserId: ann,
      leaderboardDeltas: {
        wins: { [ann]: 11, [ben]: 0, 'guest:1': 1, [cat]: 1, [ghost]: 1 },
        total: { [ann]: 1.5, [ben]: -1 },
        nope: { [ann]: 1 },
      },
    }));
    assert.equal(r.duplicate, false);
    assert.equal(await count(db, `select 1 from public.leaderboard_entries`), 0);
    await record(db, match([p(ann), p(ben)], { leaderboardDeltas: { wins: { [ann.toUpperCase()]: 10 } } }));
    assert.deepEqual((await entries(db)).map((e) => [e.user_id, e.score]), [[ann, 10]]);
  });

  test('anti-boost: no board writes for matches under 20 s, or private with fewer than 2 eligible players', async () => {
    const deltas = { wins: { [ann]: 1 } };
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, durationSec: 19.9, leaderboardDeltas: deltas }));
    await record(db, match([p(ann), { userId: 'guest:1', guest: true }], { winnerUserId: ann, private: true, leaderboardDeltas: deltas }));
    await record(db, match([p(ann), p(ghost)], { winnerUserId: ann, private: true, leaderboardDeltas: deltas }));
    assert.equal(await count(db, `select 1 from public.leaderboard_entries`), 0);
    // Stats still count.
    assert.deepEqual(await statsOf(db, ann), { plays: 3, wins: 3, losses: 0, playtime_s: 20 + 95 + 95 });
    // Private with 2 eligible players, and public with 1, both count.
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, private: true, leaderboardDeltas: deltas }));
    await record(db, match([p(ann), { userId: 'guest:1', guest: true }], { winnerUserId: ann, leaderboardDeltas: deltas }));
    assert.deepEqual((await entries(db)).map((e) => e.score), [2]);
  });

  test('anti-boost: 60 board writes per player per hour (server_board bucket)', async () => {
    for (let i = 0; i < 62; i++) {
      await record(db, match([p(ann), p(ben)], { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } }));
    }
    assert.deepEqual((await entries(db)).map((e) => e.score), [60]);
    assert.equal((await statsOf(db, ann))!.wins, 62);
  });

  test('eligibility: guests, non-uuids, unknown users, anonymous and banned players are skipped', async () => {
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'cheating')`, [cat]);
    const r = await record(db, match([
      p(ann),
      { userId: ben, guest: true },
      p('session:abc'),
      p(NOBODY),
      p(ghost),
      p(cat),
      p(ann), // duplicate entry
      { userId: ann } as MatchPlayer, // no guest flag: not eligible on its own, but ann already is
    ], { winnerUserId: ann }));
    assert.equal(r.duplicate, false);
    assert.deepEqual(Object.keys((r as Extract<RecordedMatch, { duplicate: false }>).players), [ann]);
    assert.deepEqual(await statsOf(db, ann), { plays: 1, wins: 1, losses: 0, playtime_s: 95 });
    for (const u of [ben, ghost, cat]) assert.equal(await statsOf(db, u), undefined);
    // An expired ban does not exclude.
    await db.query(`update public.user_sanctions set expires_at = now() - interval '1 minute'`);
    await record(db, match([p(cat)]));
    assert.equal((await statsOf(db, cat))!.plays, 1);
  });

  test('at most 64 eligible players, the first ones sent', async () => {
    const many: string[] = [];
    for (let i = 0; i < 66; i++) many.push(await user(db, `crowd_${i}`));
    const r = await record(db, match(many.map((u) => p(u))));
    const players = (r as Extract<RecordedMatch, { duplicate: false }>).players;
    assert.equal(Object.keys(players).length, 64);
    assert.ok(!(many[64]! in players) && !(many[65]! in players) && many[0]! in players);
    assert.equal(await count(db, `select 1 from public.game_stats where game_id = 'sumo'`), 64);
  });

  test('achievements: known keys unlocked once, unknown ignored; result lists newly unlocked, wins, boards, ranks', async () => {
    await db.query(
      `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score, source)
       select id, public.period_key('weekly', now()), $1, 5, 'server' from public.leaderboards where key = 'wins'`,
      [cat],
    );
    const r1 = await record(db, match(
      [p(ann, { achievements: ['first_win', 'yokozuna', 'nope'] }), p(ben, { achievements: ['first_win'] }),
       p(ghost, { achievements: ['first_win'] })],
      { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } },
    ));
    assert.deepEqual(r1, {
      duplicate: false,
      players: {
        [ann]: {
          wins: 1,
          losses: 0,
          boards: { wins: { score: 1, rank: 2 } },
          unlocked: [{ key: 'first_win', title: 'First win', icon: '🏆' }, { key: 'yokozuna', title: 'Yokozuna', icon: null }],
        },
        [ben]: { wins: 0, losses: 1, boards: {}, unlocked: [{ key: 'first_win', title: 'First win', icon: '🏆' }] },
      },
    });
    assert.equal(await count(db, `select 1 from public.user_achievements where user_id = $1`, [ghost]), 0);
    const r2 = await record(db, match([p(ann, { achievements: ['first_win'] })], { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 5 } } }));
    assert.deepEqual(r2, {
      duplicate: false,
      players: { [ann]: { wins: 2, losses: 0, boards: { wins: { score: 6, rank: 1 } }, unlocked: [] } },
    });
    assert.equal(await count(db, `select 1 from public.user_achievements where user_id = $1`, [ann]), 2);
  });

  test('all or nothing: a failure rolls back every write, so a retry records the match', async () => {
    const m = match([p(ann), p(ben)], { winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } });
    await db.exec(`
      create function public.test_fail_achievements() returns trigger language plpgsql as $$
      begin raise exception 'boom'; end $$;
      create trigger test_fail before insert on public.user_achievements for each row execute function public.test_fail_achievements();
    `);
    try {
      await assert.rejects(record(db, { ...m, players: [p(ann, { achievements: ['first_win'] }), p(ben)] }), /boom/);
    } finally {
      await db.exec(`drop trigger test_fail on public.user_achievements; drop function public.test_fail_achievements();`);
    }
    assert.equal(await count(db, `select 1 from public.match_results`), 0);
    assert.equal(await count(db, `select 1 from public.game_stats`), 0);
    assert.equal(await count(db, `select 1 from public.leaderboard_entries`), 0);
    assert.equal((await record(db, m)).duplicate, false);
    assert.deepEqual(await statsOf(db, ann), { plays: 1, wins: 1, losses: 0, playtime_s: 95 });
  });

  test('malformed input is INVALID; an unknown game is NOT_FOUND', async () => {
    const good = match([p(ann)]);
    const bads: unknown[] = [
      [],
      { ...good, matchId: '' },
      { ...good, matchId: 7 },
      { ...good, gameId: undefined },
      { ...good, private: undefined },
      { ...good, private: 'no' },
      { ...good, players: {} },
      { ...good, leaderboardDeltas: [] },
      { ...good, durationSec: '95' },
      { ...good, durationSec: -1 },
      { ...good, startedAt: 'not a date' },
      { ...good, endedAt: undefined },
      { ...good, startedAt: good.endedAt, endedAt: good.startedAt },
      { ...good, rounds: 2.5 },
      { ...good, details: { blob: 'x'.repeat(70_000) } },
    ];
    for (const [i, bad] of bads.entries()) await assert.rejects(record(db, bad), invalid, `bad match #${i}`);
    await assert.rejects(record(db, { ...good, gameId: 'nope' }), notFound);
    assert.equal(await count(db, `select 1 from public.match_results`), 0);
    // Optional fields may be absent or null.
    const { rounds: _r, ...noRounds } = match([p(ann)], { leaderboardDeltas: undefined });
    assert.equal((await record(db, { ...noRounds, leaderboardDeltas: null })).duplicate, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Sanctions
// ---------------------------------------------------------------------------------------------------------------

describe('user_sanctions', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
  });
  beforeEach(() => db.exec(`delete from public.user_sanctions`));
  after(() => db.close());

  const status = (uid: string) =>
    asService(
      db,
      async () => (await db.query<{ s: SanctionStatus }>(`select public.server_sanction_status($1) as s`, [uid])).rows[0]!.s,
    );
  const sanction = (uid: string, kind: string, expires: string | null, revoked = false) =>
    db.query(
      `insert into public.user_sanctions (user_id, kind, reason, expires_at, revoked_at)
       values ($1, $2, 'test', $3::timestamptz, case when $4 then now() end)`,
      [uid, kind, expires, revoked],
    );

  test('server_sanction_status: none, temporary, permanent ("infinity"), expired, revoked, latest wins', async () => {
    assert.deepEqual(await status(ann), { banned_until: null, muted_until: null });
    assert.deepEqual(await status(NOBODY), { banned_until: null, muted_until: null });
    const until = new Date(Date.now() + 3600_000);
    await sanction(ann, 'mute', until.toISOString());
    const s1 = await status(ann);
    assert.equal(s1.banned_until, null);
    assert.equal(new Date(s1.muted_until!).getTime(), until.getTime());
    await sanction(ann, 'ban', null);
    assert.equal((await status(ann)).banned_until, 'infinity');
    await sanction(ben, 'ban', new Date(Date.now() - 1000).toISOString());
    await sanction(ben, 'mute', null, true);
    assert.deepEqual(await status(ben), { banned_until: null, muted_until: null });
    const later = new Date(Date.now() + 86400_000);
    await sanction(ben, 'ban', until.toISOString());
    await sanction(ben, 'ban', later.toISOString());
    assert.equal(new Date((await status(ben)).banned_until!).getTime(), later.getTime());
  });

  test('kind is checked; users read only their own rows and cannot write', async () => {
    await assert.rejects(sanction(ann, 'kick', null), /user_sanctions_kind/);
    await sanction(ann, 'ban', null);
    await sanction(ben, 'mute', null);
    await asUser(db, ann, async () => {
      const rows = await db.query<{ user_id: string; kind: string }>(`select user_id, kind from public.user_sanctions`);
      assert.deepEqual(rows.rows, [{ user_id: ann, kind: 'ban' }]);
      await assert.rejects(
        db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'mute', 'x')`, [ben]),
        permissionDenied,
      );
      await assert.rejects(db.query(`update public.user_sanctions set revoked_at = now()`), permissionDenied);
      await assert.rejects(db.query(`delete from public.user_sanctions`), permissionDenied);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.user_sanctions`), permissionDenied);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Solo-only guards
// ---------------------------------------------------------------------------------------------------------------

describe('solo-only guards: multiplayer stats are server-written only', () => {
  let db: PGlite;
  let ann: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack'); // solo
    await insertMultiplayerGame(db, 'sumo');
    await insertGame(db, 'both');
    await db.exec(`
      update public.games set modes = '{solo,quick}' where id = 'both';
      insert into public.achievements (game_id, key, title) values ('sumo', 'first_win', 'First win'), ('stack', 'a', 'A'), ('both', 'a', 'A');
    `);
    ann = await user(db, 'ann');
  });
  after(() => db.close());

  test('start_play_session, record_play and unlock_achievement refuse a game without the solo mode', async () => {
    await asUser(db, ann, async () => {
      await assert.rejects(db.query(`select public.start_play_session('sumo')`), notSolo);
      await assert.rejects(db.query(`select public.record_play('sumo', 10)`), notSolo);
      await assert.rejects(db.query(`select public.unlock_achievement('sumo', 'first_win')`), notSolo);
      await assert.rejects(db.query(`select public.unlock_achievement('sumo', 'unknown')`), notSolo);
      // Unknown games stay NOT_FOUND.
      await assert.rejects(db.query(`select public.start_play_session('nope')`), notFound);
      await assert.rejects(db.query(`select public.record_play('nope')`), notFound);
      await assert.rejects(db.query(`select public.unlock_achievement('nope', 'a')`), notFound);
    });
    assert.equal(await count(db, `select 1 from public.game_stats where game_id = 'sumo'`), 0);
    assert.equal(await count(db, `select 1 from public.play_sessions where game_id = 'sumo'`), 0);
  });

  test('solo games, and games with solo among other modes, work as before', async () => {
    for (const game of ['stack', 'both']) {
      await asUser(db, ann, async () => {
        const s = (await db.query<{ id: string }>(`select public.start_play_session($1) as id`, [game])).rows[0]!.id;
        const u = await db.query<{ r: { unlocked: boolean } }>(`select public.unlock_achievement($1, 'a') as r`, [game]);
        assert.equal(u.rows[0]!.r.unlocked, true);
        await db.query(`select public.end_play_session($1, 5)`, [s]);
      });
    }
    await db.query(`update public.game_stats set last_played_at = now() - interval '1 day'`);
    await asUser(db, ann, () => db.query(`select public.record_play('stack', 5)`));
    assert.equal((await statsOf(db, ann, 'stack'))!.plays, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------

describe('purge_stale_rows additions', () => {
  test('presence > 1 day, game_rooms > 10 min, match_results > 180 days; fresh rows stay', async () => {
    const db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    await heartbeat(db, ann, 'online');
    await heartbeat(db, ben, 'online');
    await age(db, 'presence', 86400 + 60, `user_id = '${ann}'`);
    await age(db, 'presence', 86400 - 60, `user_id = '${ben}'`);
    await upsertRoom(db, { roomId: 'old', gameId: 'sumo', maxClients: 8 });
    await upsertRoom(db, { roomId: 'new', gameId: 'sumo', maxClients: 8 });
    await age(db, 'game_rooms', 601, `room_id = 'old'`);
    await age(db, 'game_rooms', 599, `room_id = 'new'`);
    await record(db, match([p(ann)], { matchId: 'old:1' }));
    await record(db, match([p(ann)], { matchId: 'new:1' }));
    await db.query(`update public.match_results set recorded_at = now() - interval '181 days' where match_id = 'old:1'`);
    await db.query(`update public.match_results set recorded_at = now() - interval '179 days' where match_id = 'new:1'`);

    await db.exec(`select private.purge_stale_rows()`);
    assert.deepEqual((await db.query(`select user_id from public.presence`)).rows, [{ user_id: ben }]);
    assert.deepEqual((await db.query(`select room_id from public.game_rooms`)).rows, [{ room_id: 'new' }]);
    assert.deepEqual((await db.query(`select match_id from public.match_results`)).rows, [{ match_id: 'new:1' }]);
    assert.equal((await statsOf(db, ann))!.plays, 2);
    await db.close();
  });
});
