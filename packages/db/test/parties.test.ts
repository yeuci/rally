// 20261107000200_parties.sql: parties and invites (docs/social-phase.md §2). create_party / my_party (the shape,
// presence, the active launch), one party per user, invites (friends only, blocks, size, reuse, expiry, the rate limit),
// room invites (a live room of a published game with a server), my_invites, respond_invite (accept / decline / expiry /
// cancel, moving between parties), leave / kick / transfer (leader handover, the party ending with its last member), the
// server_* RPCs behind /party/launch and /party/seat, every realtime event with its exact payload (stubbed
// realtime.send, as social-realtime.test.ts), the party:<id> channel policy, privileges and retention.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const MIGRATION = readFileSync(new URL('../supabase/migrations/20261107000200_parties.sql', import.meta.url), 'utf8');
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
const noSuchFriend = sqlstate('P0002', /^NOT_FOUND: no such friend$/);
const roomEnded = sqlstate('P0002', /^NOT_FOUND: that room has ended$/);
const invalid = sqlstate('22023', /^INVALID/);
const alreadyInParty = sqlstate('22023', /^INVALID: already in a party$/);
const partyFull = sqlstate('22023', /^INVALID: party is full$/);
const leaderOnly = sqlstate('22023', /^INVALID: only the party leader can do that$/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const permissionDenied = /permission denied/;

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

/** Accepted friendship, written as superuser (the RPCs are covered by social.test.ts). */
const befriend = (db: PGlite, a: string, b: string) =>
  db.query(
    `insert into public.friendships (user_id, friend_id, status, accepted_at) values ($1, $2, 'accepted', now())`,
    [a, b],
  );
const block = (db: PGlite, blocker: string, blocked: string) =>
  asUser(db, blocker, () => db.query(`select public.block_user($1)`, [blocked]));

/** A published multiplayer game with a current version whose manifest has a `server` (like Sumo). */
async function insertServerGame(db: PGlite, id: string, maxPlayers = 8, status: 'published' | 'draft' = 'published') {
  await insertGame(db, id, status);
  const v = await db.query<{ id: string }>(
    `insert into public.game_versions (game_id, version, entry_url, manifest, sha256)
     values ($1, '1.0.0', 'https://cdn.example/' || $1 || '/index.html', $2::jsonb, 'abc') returning id`,
    [id, JSON.stringify({ id, server: { room: id, minVersion: 0 } })],
  );
  await db.query(
    `update public.games set modes = '{quick,browser,private}', max_players = $2, current_version_id = $3 where id = $1`,
    [id, maxPlayers, v.rows[0]!.id],
  );
}

const upsertRoom = (db: PGlite, room: { roomId: string; gameId: string; [k: string]: unknown }) =>
  asService(db, () => db.query(`select public.server_upsert_game_room($1::jsonb)`, [JSON.stringify(room)]));
const age = (db: PGlite, table: 'presence' | 'game_rooms', seconds: number, where = 'true') =>
  db.query(`update public.${table} set updated_at = now() - make_interval(secs => $1) where ${where}`, [seconds]);
const heartbeat = (db: PGlite, uid: string, status: string, game: string | null = null, room: string | null = null) =>
  asUser(db, uid, () => db.query(`select public.heartbeat($1, $2, $3)`, [status, game, room]));

interface PartyMember {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: string;
  status: string | null;
  game_id: string | null;
}
interface PartyLaunch {
  id: string;
  game_id: string;
  game_title: string;
  room_id: string;
  code: string | null;
  leader_id: string;
  created_at: string;
  expires_at: string;
}
interface Party {
  id: string;
  leader_id: string;
  conversation_id: string;
  channel_key: string;
  created_at: string;
  launch: PartyLaunch | null;
  members: PartyMember[];
}
interface InviteRow {
  id: string;
  kind: string;
  from_id: string;
  from_username: string;
  from_display_name: string | null;
  from_avatar_url: string | null;
  party_id: string | null;
  party_size: number | null;
  game_id: string | null;
  game_title: string | null;
  room_id: string | null;
  created_at: Date;
  expires_at: Date;
}
interface InviteState {
  status: string;
  responded_at: Date | null;
}

const api = (db: PGlite) => {
  const one = <T>(uid: string, sql: string, params: unknown[] = []) =>
    asUser(db, uid, async () => (await db.query<{ v: T }>(sql, params)).rows[0]!.v);
  const self = {
    createParty: (uid: string) => one<Party>(uid, `select public.create_party() as v`),
    myParty: (uid: string) => one<Party | null>(uid, `select public.my_party() as v`),
    invite: (uid: string, to: string) => one<string>(uid, `select public.invite_to_party($1) as v`, [to]),
    roomInvite: (uid: string, to: string, game: string | null, room: string | null, code: string | null = null) =>
      one<string>(uid, `select public.send_room_invite($1, $2, $3, $4) as v`, [to, game, room, code]),
    myInvites: (uid: string) =>
      asUser(db, uid, async () => (await db.query<InviteRow>(`select * from public.my_invites()`)).rows),
    respond: (uid: string, invite: string, accept: boolean | null) =>
      one<Record<string, unknown>>(uid, `select public.respond_invite($1, $2) as v`, [invite, accept]),
    cancel: (uid: string, invite: string) =>
      asUser(db, uid, () => db.query(`select public.cancel_invite($1)`, [invite])),
    leave: (uid: string) => asUser(db, uid, () => db.query(`select public.leave_party()`)),
    kick: (uid: string, target: string) =>
      asUser(db, uid, () => db.query(`select public.kick_from_party($1)`, [target])),
    transfer: (uid: string, target: string) =>
      asUser(db, uid, () => db.query(`select public.transfer_party_lead($1)`, [target])),
    serverBegin: (leader: string, game: string) =>
      asService(
        db,
        async () =>
          (
            await db.query<{
              v: { party_id: string; members: { user_id: string; username: string; avatar_url: string | null }[] };
            }>(`select public.server_party_launch_begin($1, $2) as v`, [leader, game])
          ).rows[0]!.v,
      ),
    serverCommit: (party: string, leader: string, game: string, room: string, code: string | null) =>
      asService(
        db,
        async () =>
          (
            await db.query<{ v: string }>(`select public.server_party_launch_commit($1, $2, $3, $4, $5) as v`, [
              party,
              leader,
              game,
              room,
              code,
            ])
          ).rows[0]!.v,
      ),
    serverMember: (uid: string, launch: string) =>
      asService(
        db,
        async () =>
          (
            await db.query<{ v: Record<string, unknown> | null }>(`select public.server_party_member($1, $2) as v`, [
              uid,
              launch,
            ])
          ).rows[0]!.v,
      ),
    /** A party of `members` (the first one leads) through the RPCs; everyone must be the leader's friend. */
    party: async (members: string[]) => {
      const [leader, ...rest] = members;
      const party = await self.createParty(leader!);
      for (const m of rest) await self.respond(m, await self.invite(leader!, m), true);
      return party;
    },
    invite_state: async (id: string): Promise<InviteState | undefined> =>
      (await db.query<InviteState>(`select status, responded_at from public.invites where id = $1`, [id])).rows[0],
    members: async (party: string) =>
      (
        await db.query<{ user_id: string }>(
          `select user_id from public.party_members where party_id = $1 order by joined_at`,
          [party],
        )
      ).rows.map((r) => r.user_id),
    leader: async (party: string) =>
      (await db.query<{ leader_id: string }>(`select leader_id from public.parties where id = $1`, [party])).rows[0]
        ?.leader_id,
  };
  return self;
};

/** Stub of Supabase's realtime.send(payload, event, topic, private) that records its calls. */
async function stubSend(db: PGlite, opts: { fail?: boolean } = {}): Promise<void> {
  await db.exec(`
    create schema if not exists realtime;
    create temp table if not exists sent (n serial primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
    returns void language plpgsql as $$
    begin
      ${opts.fail ? `raise exception 'realtime is down';` : ''}
      insert into pg_temp.sent (payload, event, topic, private) values (payload, event, topic, private);
    end $$;
  `);
}
interface Sent {
  topic: string;
  event: string;
  private: boolean;
  payload: Record<string, unknown>;
}
/** Calls recorded since the last call to `take`, in order (and clears them); `at` is checked and removed. */
async function take(db: PGlite): Promise<Sent[]> {
  const r = await db.query<Sent>(`select payload, event, topic, private from pg_temp.sent order by n`);
  await db.exec(`truncate pg_temp.sent`);
  return r.rows.map((row) => {
    const { at, ...payload } = row.payload;
    assert.match(String(at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(String(at)) - Date.now()) < 60_000);
    return { topic: row.topic, event: row.event, private: row.private, payload };
  });
}
const partyEv = (party: string, payload: Record<string, unknown>): Sent => ({
  topic: `party:${party}`,
  event: 'party',
  private: true,
  payload,
});
const userEv = (uid: string, event: string, payload: Record<string, unknown>): Sent => ({
  topic: `user:${uid}`,
  event,
  private: true,
  payload,
});

/** Everything the party tests create, so a describe can share one database. */
const RESET = `delete from public.parties; delete from public.invites; delete from public.conversations;
               delete from public.blocks; delete from public.rate_limits; delete from public.presence;
               delete from public.game_rooms;`;

// ---------------------------------------------------------------------------------------------------------------
// Privileges
// ---------------------------------------------------------------------------------------------------------------

describe('parties: privileges', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let ghost: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    await befriend(db, ann, ben);
  });
  after(() => db.close());

  test('tables: RLS on, no client access except a member reading their own party_members row', async () => {
    for (const t of ['parties', 'party_launches', 'invites']) {
      const r = await db.query<{ rls: boolean; anon: boolean; auth: boolean; svc: boolean; policies: number }>(
        `select relrowsecurity as rls,
                has_table_privilege('anon', $1, 'select') as anon,
                has_table_privilege('authenticated', $1, 'select') as auth,
                has_table_privilege('service_role', $1, 'select, insert, update, delete') as svc,
                (select count(*)::int from pg_policies where schemaname = 'public' and tablename = $2) as policies
           from pg_class where oid = $1::regclass`,
        [`public.${t}`, t],
      );
      // parties: one own-row policy and a column grant (id, channel_key) for the channel policy; no table-level select.
      assert.deepEqual(
        r.rows[0],
        { rls: true, anon: false, auth: false, svc: true, policies: t === 'parties' ? 1 : 0 },
        t,
      );
    }
    const cols = await db.query<{ column_name: string; ok: boolean }>(
      `select column_name, has_column_privilege('authenticated', 'public.parties', column_name, 'select') as ok
         from information_schema.columns where table_schema = 'public' and table_name = 'parties' order by 1`,
    );
    assert.deepEqual(
      cols.rows.filter((c) => c.ok).map((c) => c.column_name),
      ['channel_key', 'id'],
    );
    assert.equal(
      (await db.query<{ ok: boolean }>(`select has_any_column_privilege('anon', 'public.parties', 'select') as ok`))
        .rows[0]?.ok,
      false,
    );
    const pm = await db.query<{ rls: boolean; anon: boolean; auth: boolean; write: boolean }>(
      `select relrowsecurity as rls,
              has_table_privilege('anon', 'public.party_members', 'select') as anon,
              has_table_privilege('authenticated', 'public.party_members', 'select') as auth,
              has_table_privilege('authenticated', 'public.party_members', 'insert, update, delete') as write
         from pg_class where oid = 'public.party_members'::regclass`,
    );
    assert.deepEqual(pm.rows[0], { rls: true, anon: false, auth: true, write: false });
    await rpc.party([ann, ben]);
    const mine = await asUser(db, ann, () => db.query<{ user_id: string }>(`select user_id from public.party_members`));
    assert.deepEqual(
      mine.rows.map((r) => r.user_id),
      [ann],
    );
    await assert.rejects(
      asAnon(db, () => db.query(`select * from public.party_members`)),
      permissionDenied,
    );
    await assert.rejects(
      asUser(db, ann, () =>
        db.query(`insert into public.party_members (party_id, user_id) select party_id, $1 from public.party_members`, [
          NOBODY,
        ]),
      ),
      permissionDenied,
    );
    for (const fn of [
      'broadcast_party_member()',
      'broadcast_party_leader()',
      'broadcast_party_ended()',
      'broadcast_party_launch()',
      'broadcast_invite()',
      'send_realtime(jsonb, text, text)',
      'party_json(uuid)',
      'remove_party_member(uuid, uuid)',
      'party_topic(uuid)',
      'blocked_in_party(uuid, uuid)',
      'invite_stands(public.invites)',
      'purge_invites()',
      'purge_party_launches()',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [
          role,
          `private.${fn}`,
        ]);
        assert.equal(r.rows[0]?.ok, false, `${role} ${fn}`);
      }
    }
  });

  test('RPCs: clients need a linked account; server_* are service_role only; definers pin search_path', async () => {
    const client = [
      'public.create_party()',
      'public.my_party()',
      'public.invite_to_party(uuid)',
      'public.send_room_invite(uuid, text, text, text)',
      'public.my_invites()',
      'public.respond_invite(uuid, boolean)',
      'public.cancel_invite(uuid)',
      'public.leave_party()',
      'public.kick_from_party(uuid)',
      'public.transfer_party_lead(uuid)',
    ];
    const server = [
      'public.server_party_launch_begin(uuid, text)',
      'public.server_party_launch_commit(uuid, uuid, text, text, text)',
      'public.server_party_member(uuid, uuid)',
    ];
    for (const fn of [...client, ...server]) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc, has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon: false, auth: client.includes(fn), svc: true, pub: false }, fn);
    }
    const loose = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p where p.prosecdef and p.proname in (
          'create_party', 'my_party', 'invite_to_party', 'send_room_invite', 'my_invites', 'respond_invite', 'cancel_invite',
          'leave_party', 'kick_from_party', 'transfer_party_lead', 'server_party_launch_begin', 'server_party_launch_commit',
          'server_party_member', 'delete_my_account')
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    assert.deepEqual(loose.rows, []);
    const calls: [string, unknown[]][] = [
      [`select public.create_party()`, []],
      [`select public.my_party()`, []],
      [`select public.invite_to_party($1)`, [ben]],
      [`select public.send_room_invite($1, 'sumo', 'r1')`, [ben]],
      [`select * from public.my_invites()`, []],
      [`select public.respond_invite($1, true)`, [NOBODY]],
      [`select public.cancel_invite($1)`, [NOBODY]],
      [`select public.leave_party()`, []],
      [`select public.kick_from_party($1)`, [ben]],
      [`select public.transfer_party_lead($1)`, [ben]],
    ];
    for (const [sql, params] of calls) {
      await assert.rejects(
        asAnon(db, () => db.query(sql, params)),
        permissionDenied,
        sql,
      );
      await assert.rejects(
        asAnonymousUser(db, ghost, () => db.query(sql, params)),
        anonymousForbidden,
        sql,
      );
      await assert.rejects(
        asRole(db, 'authenticated', () => db.query(sql, params)),
        unauthenticated,
        sql,
      );
    }
    for (const sql of [
      `select public.server_party_launch_begin('${NOBODY}', 'sumo')`,
      `select public.server_party_launch_commit('${NOBODY}', '${NOBODY}', 'sumo', 'r1', null)`,
      `select public.server_party_member('${NOBODY}', '${NOBODY}')`,
    ]) {
      await assert.rejects(
        asUser(db, ann, () => db.query(sql)),
        permissionDenied,
        sql,
      );
      await assert.rejects(
        asAnon(db, () => db.query(sql)),
        permissionDenied,
        sql,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// create_party, my_party, one party per user
// ---------------------------------------------------------------------------------------------------------------

describe('create_party and my_party', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await db.query(
      `update public.profiles set display_name = 'Ann A', avatar_url = 'defaults/avatar-02.webp' where id = $1`,
      [ann],
    );
    await befriend(db, ann, ben);
    await befriend(db, ann, cat);
    await insertServerGame(db, 'sumo');
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('create_party: the caller leads a party of one with its party conversation; my_party returns it', async () => {
    assert.equal(await rpc.myParty(ann), null);
    const p = await rpc.createParty(ann);
    assert.deepEqual(Object.keys(p).sort(), [
      'channel_key',
      'conversation_id',
      'created_at',
      'id',
      'launch',
      'leader_id',
      'members',
    ]);
    assert.equal(p.leader_id, ann);
    assert.equal(p.launch, null);
    assert.equal(p.members.length, 1);
    assert.deepEqual(Object.keys(p.members[0]!).sort(), [
      'avatar_url',
      'display_name',
      'game_id',
      'joined_at',
      'status',
      'user_id',
      'username',
    ]);
    assert.deepEqual(
      { ...p.members[0], joined_at: undefined },
      {
        user_id: ann,
        username: 'ann',
        display_name: 'Ann A',
        avatar_url: 'defaults/avatar-02.webp',
        status: null,
        game_id: null,
        joined_at: undefined,
      },
    );
    assert.deepEqual(await rpc.myParty(ann), p);
    const c = await db.query<{ kind: string; party_id: string }>(
      `select kind, party_id from public.conversations where id = $1`,
      [p.conversation_id],
    );
    assert.deepEqual(c.rows, [{ kind: 'party', party_id: p.id }]);
    assert.deepEqual(
      (
        await db.query<{ user_id: string }>(
          `select user_id from public.conversation_members where conversation_id = $1`,
          [p.conversation_id],
        )
      ).rows,
      [{ user_id: ann }],
    );
    assert.equal(await rpc.myParty(ben), null);
  });

  test('one party per user: create_party refuses while in one; the unique index backs it', async () => {
    const p = await rpc.createParty(ann);
    await assert.rejects(rpc.createParty(ann), alreadyInParty);
    await rpc.respond(ben, await rpc.invite(ann, ben), true);
    await assert.rejects(rpc.createParty(ben), alreadyInParty);
    const other = await rpc.createParty(cat);
    await assert.rejects(
      db.query(`insert into public.party_members (party_id, user_id) values ($1, $2)`, [other.id, ben]),
      /party_members_one_party_idx/,
    );
    assert.equal(await count(db, `select 1 from public.parties`), 2);
    assert.deepEqual(await rpc.members(p.id), [ann, ben]);
  });

  test('members are ordered by joined_at with their live presence (90 s; in_game needs the live room)', async () => {
    await rpc.party([ann, ben, cat]);
    await heartbeat(db, ben, 'online');
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8, playerIds: [cat] });
    await heartbeat(db, cat, 'in_game', 'sumo', 'r1');
    let m = (await rpc.myParty(ben))!.members;
    assert.deepEqual(
      m.map((x) => [x.user_id, x.status, x.game_id]),
      [
        [ann, null, null],
        [ben, 'online', null],
        [cat, 'in_game', 'sumo'],
      ],
    );
    assert.ok(m[0]!.joined_at <= m[1]!.joined_at && m[1]!.joined_at <= m[2]!.joined_at);
    // A stale room makes the seat unconfirmed ('online'); a stale heartbeat makes the member offline (null).
    await age(db, 'game_rooms', 61);
    await age(db, 'presence', 91, `user_id = '${ben}'`);
    m = (await rpc.myParty(ann))!.members;
    assert.deepEqual(
      m.map((x) => [x.user_id, x.status, x.game_id]),
      [
        [ann, null, null],
        [ben, null, null],
        [cat, 'online', null],
      ],
    );
  });

  test('launch: the active launch while unexpired and its room is live, else null', async () => {
    const p = await rpc.party([ann, ben]);
    assert.equal((await rpc.myParty(ben))!.launch, null);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 0, maxClients: 8, private: true, code: 'ABCD' });
    const launch = await rpc.serverCommit(p.id, ann, 'sumo', 'r1', 'ABCD');
    const l = (await rpc.myParty(ben))!.launch!;
    assert.deepEqual(Object.keys(l).sort(), [
      'code',
      'created_at',
      'expires_at',
      'game_id',
      'game_title',
      'id',
      'leader_id',
      'room_id',
    ]);
    assert.deepEqual(
      { ...l, created_at: undefined, expires_at: undefined },
      {
        id: launch,
        game_id: 'sumo',
        game_title: 'sumo',
        room_id: 'r1',
        code: 'ABCD',
        leader_id: ann,
        created_at: undefined,
        expires_at: undefined,
      },
    );
    assert.ok(Math.abs(Date.parse(l.expires_at) - Date.parse(l.created_at) - 600_000) < 1000);
    // The room died.
    await age(db, 'game_rooms', 61);
    assert.equal((await rpc.myParty(ben))!.launch, null);
    await age(db, 'game_rooms', 10);
    assert.notEqual((await rpc.myParty(ben))!.launch, null);
    // The launch expired.
    await db.query(`update public.party_launches set expires_at = now() - interval '1 second' where id = $1`, [launch]);
    assert.equal((await rpc.myParty(ann))!.launch, null);
    // A newer launch replaces it; deleting a launch row clears active_launch_id.
    const launch2 = await rpc.serverCommit(p.id, ann, 'sumo', 'r1', null);
    assert.equal((await rpc.myParty(ann))!.launch!.id, launch2);
    assert.equal((await rpc.myParty(ann))!.launch!.code, null);
    await db.query(`delete from public.party_launches where id = $1`, [launch2]);
    assert.equal((await rpc.myParty(ann))!.launch, null);
    assert.equal(
      (await db.query<{ a: string | null }>(`select active_launch_id as a from public.parties where id = $1`, [p.id]))
        .rows[0]?.a,
      null,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------------------------------

describe('invite_to_party and send_room_invite', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dan: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    dan = await user(db, 'dan'); // never ann's friend
    await befriend(db, ann, ben);
    await befriend(db, cat, ann);
    await befriend(db, ben, cat);
    await insertServerGame(db, 'sumo');
    await insertServerGame(db, 'wip', 8, 'draft');
    await insertGame(db, 'stack'); // solo, no server
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('invite_to_party: in a party, a friend with no block, not yet a member; returns the invite id', async () => {
    await assert.rejects(rpc.invite(ann, ben), sqlstate('22023', /^INVALID: not in a party$/));
    const p = await rpc.createParty(ann);
    await assert.rejects(rpc.invite(ann, dan), noSuchFriend);
    await assert.rejects(rpc.invite(ann, ann), noSuchFriend);
    await assert.rejects(rpc.invite(ann, NOBODY), noSuchFriend);
    await block(db, cat, ann); // they blocked the caller: the same answer as a stranger
    await assert.rejects(rpc.invite(ann, cat), noSuchFriend);
    await asUser(db, cat, () => db.query(`select public.unblock_user($1)`, [ann]));
    await befriend(db, cat, ann);
    const id = await rpc.invite(ann, ben);
    const row = await db.query<Record<string, unknown>>(`select * from public.invites where id = $1`, [id]);
    const r = row.rows[0]!;
    assert.equal(r.kind, 'party');
    assert.equal(r.from_id, ann);
    assert.equal(r.to_id, ben);
    assert.equal(r.party_id, p.id);
    assert.equal(r.status, 'pending');
    assert.equal(r.game_id, null);
    assert.ok(Math.abs((r.expires_at as Date).getTime() - (r.created_at as Date).getTime() - 600_000) < 1000);
    // Pending again: the same invite, no new row, no token.
    assert.equal(await rpc.invite(ann, ben), id);
    assert.equal(await count(db, `select 1 from public.invites`), 1);
    await rpc.respond(ben, id, true);
    await assert.rejects(rpc.invite(ann, ben), sqlstate('22023', /^INVALID: already in the party$/));
    // Any member may invite, not only the leader.
    await rpc.invite(ben, cat);
    await assert.rejects(rpc.invite(cat, dan), sqlstate('22023', /^INVALID: not in a party$/)); // cat has not accepted yet
  });

  test('a pending invite that expired is marked expired and replaced; one from an earlier party is cancelled', async () => {
    await rpc.createParty(ann);
    const first = await rpc.invite(ann, ben);
    await db.query(`update public.invites set expires_at = now() - interval '1 second' where id = $1`, [first]);
    const second = await rpc.invite(ann, ben);
    assert.notEqual(second, first);
    assert.equal((await rpc.invite_state(first))?.status, 'expired');
    assert.equal((await rpc.invite_state(second))?.status, 'pending');
    // ann moves to cat's party (hers lives on with a third member): the invite to ben still names the old party, so
    // inviting again replaces it.
    const eve = await user(db, 'eve');
    await befriend(db, ann, eve);
    await rpc.respond(eve, await rpc.invite(ann, eve), true);
    await rpc.createParty(cat);
    await rpc.respond(ann, await rpc.invite(cat, ann), true);
    const third = await rpc.invite(ann, ben);
    assert.notEqual(third, second);
    assert.equal((await rpc.invite_state(second))?.status, 'cancelled');
    assert.equal(
      (await db.query<{ party_id: string }>(`select party_id from public.invites where id = $1`, [third])).rows[0]
        ?.party_id,
      (await rpc.myParty(cat))!.id,
    );
    await db.query(`delete from auth.users where id = $1`, [eve]);
  });

  test('party is full at 8: no more invites, and a pending invite can no longer be accepted', async () => {
    const extra: string[] = [];
    for (let i = 0; i < 7; i++) {
      const u = await user(db, `extra${i}`);
      await befriend(db, ann, u);
      extra.push(u);
    }
    const p = await rpc.createParty(ann);
    const toBen = await rpc.invite(ann, ben);
    for (const u of extra.slice(0, 6)) await rpc.respond(u, await rpc.invite(ann, u), true);
    const seventh = await rpc.invite(ann, extra[6]!);
    assert.equal((await rpc.members(p.id)).length, 7);
    await rpc.respond(extra[6]!, seventh, true); // the eighth member
    assert.equal((await rpc.members(p.id)).length, 8);
    await assert.rejects(rpc.invite(ann, cat), partyFull);
    await assert.rejects(rpc.respond(ben, toBen, true), partyFull);
    assert.equal((await rpc.invite_state(toBen))?.status, 'pending'); // still there, for when a seat frees up
    await rpc.leave(extra[0]!);
    assert.deepEqual(await rpc.respond(ben, toBen, true).then((r) => r.kind), 'party');
    for (const u of extra) await db.query(`delete from auth.users where id = $1`, [u]);
  });

  test('RATE_LIMITED past 20 new invites in a burst (party and room invites share the bucket)', async () => {
    await rpc.createParty(ann);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8 });
    for (let i = 0; i < 20; i++) {
      // Reusing a pending invite takes no token, so withdraw each one first.
      const id = i % 2 ? await rpc.invite(ann, ben) : await rpc.roomInvite(ann, ben, 'sumo', 'r1');
      await rpc.cancel(ann, id);
    }
    await assert.rejects(rpc.invite(ann, ben), rateLimited);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'r1'), rateLimited);
    await rpc.invite(cat, ann).catch(() => undefined); // cat is not in a party; just not ann's bucket
    assert.equal(await count(db, `select 1 from public.invites where status = 'pending'`), 0);
  });

  test('send_room_invite: a friend, a published game with a server, a live room of that game, a short code', async () => {
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8 });
    await upsertRoom(db, { roomId: 'r2', gameId: 'stack', clients: 1, maxClients: 8 });
    await assert.rejects(rpc.roomInvite(ann, dan, 'sumo', 'r1'), noSuchFriend);
    await assert.rejects(rpc.roomInvite(ann, ann, 'sumo', 'r1'), noSuchFriend);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', ''), invalid);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', null), invalid);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'x'.repeat(129)), invalid);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'r1', 'x'.repeat(17)), invalid);
    await assert.rejects(rpc.roomInvite(ann, ben, 'wip', 'r1'), sqlstate('P0002', /^NOT_FOUND: game wip$/)); // draft
    await assert.rejects(rpc.roomInvite(ann, ben, 'stack', 'r2'), sqlstate('P0002', /^NOT_FOUND: game stack$/)); // no server
    await assert.rejects(rpc.roomInvite(ann, ben, 'nope', 'r1'), sqlstate('P0002', /^NOT_FOUND: game nope$/));
    await assert.rejects(rpc.roomInvite(ann, ben, null, 'r1'), sqlstate('P0002', /^NOT_FOUND: game null$/));
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'r9'), roomEnded);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'r2'), roomEnded); // another game's room
    await age(db, 'game_rooms', 61);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'r1'), roomEnded);
    await age(db, 'game_rooms', 10);
    const id = await rpc.roomInvite(ann, ben, 'sumo', 'r1', ' ');
    const r = (await db.query<Record<string, unknown>>(`select * from public.invites where id = $1`, [id])).rows[0]!;
    assert.deepEqual(
      [r.kind, r.from_id, r.to_id, r.party_id, r.game_id, r.room_id, r.code, r.status],
      ['room', ann, ben, null, 'sumo', 'r1', null, 'pending'],
    );
    // Same room: the same invite. Another room: the first is cancelled, a new one is sent.
    assert.equal(await rpc.roomInvite(ann, ben, 'sumo', 'r1', 'ABCD'), id);
    await upsertRoom(db, { roomId: 'r3', gameId: 'sumo', clients: 1, maxClients: 8, private: true, code: 'ZZZZ' });
    const next = await rpc.roomInvite(ann, ben, 'sumo', 'r3', 'ZZZZ');
    assert.notEqual(next, id);
    assert.equal((await rpc.invite_state(id))?.status, 'cancelled');
    assert.equal(
      (await db.query<{ code: string }>(`select code from public.invites where id = $1`, [next])).rows[0]?.code,
      'ZZZZ',
    );
    // A block either way after the fact: the same NOT_FOUND.
    await block(db, ann, ben);
    await assert.rejects(rpc.roomInvite(ann, ben, 'sumo', 'r3'), noSuchFriend);
  });
});

describe('my_invites, respond_invite and cancel_invite', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dan: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    dan = await user(db, 'dan');
    await db.query(
      `update public.profiles set display_name = 'Ann A', avatar_url = 'defaults/avatar-02.webp' where id = $1`,
      [ann],
    );
    for (const [a, b] of [
      [ann, ben],
      [ann, cat],
      [ann, dan],
      [ben, cat],
      [ben, dan],
      [cat, dan],
    ])
      await befriend(db, a!, b!);
    await insertServerGame(db, 'sumo');
    await db.query(`update public.games set title = 'Sumo' where id = 'sumo'`);
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('my_invites: pending, unexpired invites to the caller, newest first, with sender, party size and game title', async () => {
    const p = await rpc.party([ann, ben]);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8 });
    const fromAnn = await rpc.invite(ann, cat);
    await db.query(`update public.invites set created_at = created_at - interval '1 minute' where id = $1`, [fromAnn]);
    const room = await rpc.roomInvite(ben, cat, 'sumo', 'r1', 'ABCD');
    assert.deepEqual(await rpc.myInvites(ann), []);
    const rows = await rpc.myInvites(cat);
    assert.deepEqual(
      rows.map((r) => ({ ...r, created_at: undefined, expires_at: undefined })),
      [
        {
          id: room,
          kind: 'room',
          from_id: ben,
          from_username: 'ben',
          from_display_name: null,
          from_avatar_url: rows[0]!.from_avatar_url,
          party_id: null,
          party_size: null,
          game_id: 'sumo',
          game_title: 'Sumo',
          room_id: 'r1',
          created_at: undefined,
          expires_at: undefined,
        },
        {
          id: fromAnn,
          kind: 'party',
          from_id: ann,
          from_username: 'ann',
          from_display_name: 'Ann A',
          from_avatar_url: 'defaults/avatar-02.webp',
          party_id: p.id,
          party_size: 2,
          game_id: null,
          game_title: null,
          room_id: null,
          created_at: undefined,
          expires_at: undefined,
        },
      ],
    );
    assert.equal(rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime(), 600_000);
    // The join code never travels in the list (it comes with the acceptance).
    assert.ok(!('code' in rows[0]!));
    // Expired, answered, cancelled, and blocked senders drop out.
    await db.query(`update public.invites set expires_at = now() where id = $1`, [fromAnn]);
    assert.deepEqual(
      (await rpc.myInvites(cat)).map((r) => r.id),
      [room],
    );
    await block(db, cat, ben);
    assert.deepEqual(await rpc.myInvites(cat), []);
    await asUser(db, cat, () => db.query(`select public.unblock_user($1)`, [ben]));
    await befriend(db, ben, cat);
    assert.deepEqual(
      (await rpc.myInvites(cat)).map((r) => r.id),
      [room],
    );
    await rpc.cancel(ben, room);
    assert.deepEqual(await rpc.myInvites(cat), []);
  });

  test('respond_invite: NOT_FOUND unless pending, unexpired and addressed to the caller; p_accept required', async () => {
    await rpc.createParty(ann);
    const id = await rpc.invite(ann, ben);
    await assert.rejects(rpc.respond(ben, id, null), invalid);
    await assert.rejects(rpc.respond(cat, id, true), notFound); // not for cat
    await assert.rejects(rpc.respond(ann, id, true), notFound); // not for the sender either
    await assert.rejects(rpc.respond(ben, NOBODY, true), notFound);
    await db.query(`update public.invites set expires_at = now() - interval '1 second' where id = $1`, [id]);
    await assert.rejects(rpc.respond(ben, id, true), notFound);
    await assert.rejects(rpc.respond(ben, id, false), notFound);
    await db.query(`update public.invites set expires_at = now() + interval '1 minute' where id = $1`, [id]);
    assert.deepEqual(await rpc.respond(ben, id, false), { kind: 'party' });
    const st = await rpc.invite_state(id);
    assert.equal(st?.status, 'declined');
    assert.notEqual(st?.responded_at, null);
    await assert.rejects(rpc.respond(ben, id, true), notFound); // answered already
    assert.equal(await rpc.myParty(ben), null);
    // Declining a room invite: {kind: 'room'}.
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8 });
    const room = await rpc.roomInvite(ann, ben, 'sumo', 'r1');
    assert.deepEqual(await rpc.respond(ben, room, false), { kind: 'room' });
  });

  test('accepting a party invite joins the party and its chat, cancels the other invites from that party, returns my_party', async () => {
    const p = await rpc.party([ann, ben]);
    const fromAnn = await rpc.invite(ann, cat);
    const fromBen = await rpc.invite(ben, cat);
    const r = await rpc.respond(cat, fromBen, true);
    assert.equal(r.kind, 'party');
    const party = r.party as Party;
    assert.equal(party.id, p.id);
    assert.deepEqual(
      party.members.map((m) => m.user_id),
      [ann, ben, cat],
    );
    assert.deepEqual(await rpc.myParty(cat), party);
    assert.equal(
      await count(db, `select 1 from public.conversation_members where conversation_id = $1 and user_id = $2`, [
        p.conversation_id,
        cat,
      ]),
      1,
    );
    assert.equal((await rpc.invite_state(fromBen))?.status, 'accepted');
    assert.equal((await rpc.invite_state(fromAnn))?.status, 'cancelled');
    // An invite to a party you are already in is simply accepted.
    await db.exec(`delete from public.invites`);
    await db.query(`insert into public.invites (kind, from_id, to_id, party_id) values ('party', $1, $2, $3)`, [
      ann,
      cat,
      p.id,
    ]);
    const again = await rpc.respond(cat, (await rpc.myInvites(cat))[0]!.id, true);
    assert.equal((again.party as Party).members.length, 3);
  });

  test('accepting moves the caller out of their current party (leader handover or the party ending)', async () => {
    const a = await rpc.party([ann, ben]); // ann leads
    const c = await rpc.party([cat, dan]); // cat leads
    // ann (leader) accepts cat's invite: ben leads the old party.
    await rpc.respond(ann, await rpc.invite(cat, ann), true);
    assert.deepEqual(await rpc.members(a.id), [ben]);
    assert.equal(await rpc.leader(a.id), ben);
    assert.deepEqual(await rpc.members(c.id), [cat, dan, ann]);
    assert.equal(
      await count(db, `select 1 from public.conversation_members where conversation_id = $1`, [a.conversation_id]),
      1,
    );
    assert.equal(
      await count(db, `select 1 from public.conversation_members where conversation_id = $1`, [c.conversation_id]),
      3,
    );
    // ben (alone) accepts: the old party is gone with its conversation.
    await rpc.respond(ben, await rpc.invite(ann, ben), true);
    assert.equal(await count(db, `select 1 from public.parties where id = $1`, [a.id]), 0);
    assert.equal(await count(db, `select 1 from public.conversations where id = $1`, [a.conversation_id]), 0);
    assert.deepEqual(await rpc.members(c.id), [cat, dan, ann, ben]);
  });

  test('a party that ended takes its invites along (NOT_FOUND); accepting a room invite returns the join target', async () => {
    await rpc.createParty(ann);
    const id = await rpc.invite(ann, ben);
    await rpc.leave(ann); // the last member: the party is deleted
    assert.equal(await count(db, `select 1 from public.invites where id = $1`, [id]), 0);
    await assert.rejects(rpc.respond(ben, id, true), notFound);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8, private: true, code: 'ABCD' });
    const room = await rpc.roomInvite(ann, ben, 'sumo', 'r1', 'ABCD');
    assert.deepEqual(await rpc.respond(ben, room, true), {
      kind: 'room',
      game_id: 'sumo',
      room_id: 'r1',
      code: 'ABCD',
    });
    assert.equal((await rpc.invite_state(room))?.status, 'accepted');
    assert.equal(await rpc.myParty(ben), null); // a room invite does not touch parties
  });

  test('cancel_invite: the sender withdraws a pending invite; anything else is NOT_FOUND', async () => {
    await rpc.createParty(ann);
    const id = await rpc.invite(ann, ben);
    await assert.rejects(rpc.cancel(ben, id), notFound);
    await assert.rejects(rpc.cancel(cat, id), notFound);
    await assert.rejects(rpc.cancel(ann, NOBODY), notFound);
    await rpc.cancel(ann, id);
    const st = await rpc.invite_state(id);
    assert.equal(st?.status, 'cancelled');
    assert.notEqual(st?.responded_at, null);
    await assert.rejects(rpc.cancel(ann, id), notFound);
    await assert.rejects(rpc.respond(ben, id, true), notFound);
    // Cancelled: a new invite can be sent right away.
    assert.notEqual(await rpc.invite(ann, ben), id);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Leaving, kicking, handing over
// ---------------------------------------------------------------------------------------------------------------

describe('leave_party, kick_from_party, transfer_party_lead', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dan: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    dan = await user(db, 'dan');
    for (const u of [ben, cat, dan]) await befriend(db, ann, u);
    await insertServerGame(db, 'sumo');
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('leave: a member goes (and leaves the chat); the leader hands over to the earliest joined; no party is a no-op', async () => {
    await rpc.leave(ann); // nothing happens
    const p = await rpc.party([ann, ben, cat]);
    await db.query(`update public.party_members set joined_at = joined_at - interval '1 minute' where user_id = $1`, [
      cat,
    ]); // cat "joined" before ben
    await rpc.leave(ben);
    assert.deepEqual(await rpc.members(p.id), [cat, ann]);
    assert.equal(await rpc.myParty(ben), null);
    assert.equal(
      await count(db, `select 1 from public.conversation_members where conversation_id = $1 and user_id = $2`, [
        p.conversation_id,
        ben,
      ]),
      0,
    );
    await rpc.leave(ann);
    assert.equal(await rpc.leader(p.id), cat);
    assert.deepEqual(await rpc.members(p.id), [cat]);
  });

  test('the last member leaving deletes the party with its conversation, messages, invites and launches', async () => {
    const p = await rpc.party([ann, ben]);
    await asUser(db, ann, () => db.query(`select public.send_message($1, 'hi')`, [p.conversation_id]));
    const invite = await rpc.invite(ann, cat);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 0, maxClients: 8 });
    await rpc.serverCommit(p.id, ann, 'sumo', 'r1', null);
    await rpc.leave(ben);
    assert.equal(await count(db, `select 1 from public.parties`), 1);
    await rpc.leave(ann);
    assert.equal(await count(db, `select 1 from public.parties`), 0);
    assert.equal(await count(db, `select 1 from public.conversations`), 0);
    assert.equal(await count(db, `select 1 from public.messages`), 0);
    assert.equal(await count(db, `select 1 from public.party_launches`), 0);
    assert.equal(await count(db, `select 1 from public.invites where id = $1`, [invite]), 0);
    assert.equal(await rpc.myParty(ann), null);
  });

  test('kick: leader only, not yourself, a member; the same removal as leaving', async () => {
    const p = await rpc.party([ann, ben, cat]);
    await assert.rejects(rpc.kick(ben, cat), leaderOnly);
    await assert.rejects(rpc.kick(dan, cat), leaderOnly); // not even in a party
    await assert.rejects(rpc.kick(ann, ann), invalid);
    await assert.rejects(rpc.kick(ann, dan), notFound);
    await assert.rejects(rpc.kick(ann, NOBODY), notFound);
    await rpc.kick(ann, ben);
    assert.deepEqual(await rpc.members(p.id), [ann, cat]);
    assert.equal(await rpc.myParty(ben), null);
    assert.equal(
      await count(db, `select 1 from public.conversation_members where conversation_id = $1`, [p.conversation_id]),
      2,
    );
    await assert.rejects(rpc.kick(ann, ben), notFound);
    // The kicked member may create a party of their own at once.
    await rpc.createParty(ben);
  });

  test('transfer: leader only, to a member; the old leader stays a member; to yourself changes nothing', async () => {
    const p = await rpc.party([ann, ben, cat]);
    await assert.rejects(rpc.transfer(ben, cat), leaderOnly);
    await assert.rejects(rpc.transfer(ann, dan), notFound);
    await rpc.transfer(ann, ann);
    assert.equal(await rpc.leader(p.id), ann);
    await rpc.transfer(ann, ben);
    assert.equal(await rpc.leader(p.id), ben);
    assert.deepEqual(await rpc.members(p.id), [ann, ben, cat]);
    await assert.rejects(rpc.transfer(ann, cat), leaderOnly);
    await rpc.transfer(ben, cat);
    assert.equal((await rpc.myParty(ann))!.leader_id, cat);
  });

  test('delete_my_account leaves the party first: a deleted leader hands over, a deleted member just goes', async () => {
    const p = await rpc.party([ann, ben, cat]);
    await asUser(db, cat, () => db.query(`select public.delete_my_account()`));
    assert.deepEqual(await rpc.members(p.id), [ann, ben]);
    await asUser(db, ann, () => db.query(`select public.delete_my_account()`));
    assert.deepEqual(await rpc.members(p.id), [ben]);
    assert.equal(await rpc.leader(p.id), ben);
    assert.equal(
      await count(db, `select 1 from public.conversation_members where conversation_id = $1`, [p.conversation_id]),
      1,
    );
    await asUser(db, ben, () => db.query(`select public.delete_my_account()`));
    assert.equal(await count(db, `select 1 from public.parties`), 0);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    for (const u of [ben, cat, dan]) await befriend(db, ann, u);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Game server RPCs
// ---------------------------------------------------------------------------------------------------------------

describe('server_party_launch_begin / commit, server_party_member', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await db.query(`update public.profiles set avatar_url = 'defaults/avatar-03.webp' where id = $1`, [ben]);
    await befriend(db, ann, ben);
    await befriend(db, ann, cat);
    await insertServerGame(db, 'sumo', 8);
    await insertServerGame(db, 'duel', 2);
    await insertServerGame(db, 'wip', 8, 'draft');
    await db.query(`update public.games set title = 'Duel' where id = 'duel'`);
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test("begin: the leader's party and members; NOT_FOUND for anyone else; INVALID unless the game fits", async () => {
    await assert.rejects(rpc.serverBegin(ann, 'sumo'), notFound);
    const p = await rpc.party([ann, ben, cat]);
    await assert.rejects(rpc.serverBegin(ben, 'sumo'), notFound); // a member, not the leader
    await assert.rejects(rpc.serverBegin(NOBODY, 'sumo'), notFound);
    await assert.rejects(rpc.serverBegin(ann, 'wip'), sqlstate('22023', /^INVALID: game wip is not published$/));
    await assert.rejects(rpc.serverBegin(ann, 'nope'), invalid);
    await assert.rejects(
      rpc.serverBegin(ann, 'duel'),
      sqlstate('22023', /^INVALID: Duel fits 2 players, the party has 3$/),
    );
    assert.deepEqual(await rpc.serverBegin(ann, 'sumo'), {
      party_id: p.id,
      members: [
        { user_id: ann, username: 'ann', avatar_url: (await rpc.myParty(ann))!.members[0]!.avatar_url },
        { user_id: ben, username: 'ben', avatar_url: 'defaults/avatar-03.webp' },
        { user_id: cat, username: 'cat', avatar_url: (await rpc.myParty(ann))!.members[2]!.avatar_url },
      ],
    });
    await rpc.leave(cat);
    assert.equal((await rpc.serverBegin(ann, 'duel')).members.length, 2);
  });

  test('commit: records the launch for 10 minutes, sets active_launch_id, validates the leader, game and room', async () => {
    const p = await rpc.party([ann, ben]);
    await assert.rejects(rpc.serverCommit(p.id, ben, 'sumo', 'r1', null), notFound);
    await assert.rejects(rpc.serverCommit(NOBODY, ann, 'sumo', 'r1', null), notFound);
    await assert.rejects(rpc.serverCommit(p.id, ann, 'nope', 'r1', null), notFound);
    await assert.rejects(rpc.serverCommit(p.id, ann, 'sumo', '', null), invalid);
    await assert.rejects(rpc.serverCommit(p.id, ann, 'sumo', 'x'.repeat(129), null), invalid);
    await assert.rejects(rpc.serverCommit(p.id, ann, 'sumo', 'r1', 'x'.repeat(33)), invalid);
    const id = await rpc.serverCommit(p.id, ann, 'sumo', 'r1', 'ABCD');
    const l = (await db.query<Record<string, unknown>>(`select * from public.party_launches where id = $1`, [id]))
      .rows[0]!;
    assert.deepEqual([l.party_id, l.leader_id, l.game_id, l.room_id, l.code], [p.id, ann, 'sumo', 'r1', 'ABCD']);
    assert.equal((l.expires_at as Date).getTime() - (l.created_at as Date).getTime(), 600_000);
    assert.equal(
      (await db.query<{ a: string }>(`select active_launch_id as a from public.parties where id = $1`, [p.id])).rows[0]
        ?.a,
      id,
    );
    const second = await rpc.serverCommit(p.id, ann, 'sumo', 'r2', '');
    assert.equal(
      (await db.query<{ a: string }>(`select active_launch_id as a from public.parties where id = $1`, [p.id])).rows[0]
        ?.a,
      second,
    );
    assert.equal(
      (await db.query<{ code: string | null }>(`select code from public.party_launches where id = $1`, [second]))
        .rows[0]?.code,
      null,
    );
    assert.equal(await count(db, `select 1 from public.party_launches`), 2);
  });

  test('member: the seat data for a joined member of an unexpired launch, else null', async () => {
    const p = await rpc.party([ann, ben]);
    const id = await rpc.serverCommit(p.id, ann, 'sumo', 'r1', 'ABCD');
    assert.deepEqual(await rpc.serverMember(ben, id), {
      party_id: p.id,
      game_id: 'sumo',
      room_id: 'r1',
      code: 'ABCD',
      username: 'ben',
      avatar_url: 'defaults/avatar-03.webp',
    });
    assert.equal((await rpc.serverMember(ann, id))!.username, 'ann');
    assert.equal(await rpc.serverMember(cat, id), null); // not a member
    assert.equal(await rpc.serverMember(ben, NOBODY), null);
    assert.equal(await rpc.serverMember(NOBODY, id), null);
    // Joining later still works (late arrivals); leaving loses the seat; expiry ends it for everyone.
    await rpc.respond(cat, await rpc.invite(ann, cat), true);
    assert.equal((await rpc.serverMember(cat, id))!.username, 'cat');
    await rpc.leave(ben);
    assert.equal(await rpc.serverMember(ben, id), null);
    await db.query(`update public.party_launches set expires_at = now() - interval '1 second' where id = $1`, [id]);
    assert.equal(await rpc.serverMember(ann, id), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------------------------------------------

describe('parties: realtime events', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await befriend(db, ann, ben);
    await befriend(db, ann, cat);
    await befriend(db, ben, cat);
    await insertServerGame(db, 'sumo');
  });
  beforeEach(async () => {
    await db.exec(RESET);
    await stubSend(db);
    await db.exec(`truncate pg_temp.sent`);
  });
  after(() => db.close());

  test('membership: member_joined / member_left on the party topic, removed on the user topic, by = the actor', async () => {
    const p = await rpc.createParty(ann);
    assert.deepEqual(await take(db), [
      partyEv(p.channel_key, { type: 'member_joined', party_id: p.id, user_id: ann, by: ann }),
    ]);
    const inv = await rpc.invite(ann, ben);
    assert.deepEqual(await take(db), [
      userEv(ben, 'invite', {
        type: 'party_invite',
        invite_id: inv,
        from: ann,
        party_id: p.id,
        game_id: null,
        room_id: null,
      }),
    ]);
    await rpc.respond(ben, inv, true);
    assert.deepEqual(await take(db), [
      partyEv(p.channel_key, { type: 'member_joined', party_id: p.id, user_id: ben, by: ben }),
      userEv(ben, 'invite', { type: 'invite_closed', invite_id: inv }),
    ]);
    await rpc.respond(cat, await rpc.invite(ben, cat), true);
    await take(db);
    // Leaving: by = the leaver. Kicking: by = the leader. Each on the key before the removal (it rotates after).
    assert.equal(await keyOf(db, p.id), p.channel_key); // joins do not rotate it
    await rpc.leave(cat);
    assert.deepEqual(await take(db), [
      partyEv(p.channel_key, { type: 'member_left', party_id: p.id, user_id: cat, by: cat }),
      userEv(cat, 'party', { type: 'removed', party_id: p.id }),
    ]);
    const k2 = (await keyOf(db, p.id))!;
    assert.notEqual(k2, p.channel_key);
    await rpc.kick(ann, ben);
    assert.deepEqual(await take(db), [
      partyEv(k2, { type: 'member_left', party_id: p.id, user_id: ben, by: ann }),
      userEv(ben, 'party', { type: 'removed', party_id: p.id }),
    ]);
    // The last member leaving: their own member_left / removed, then nothing (nobody is left for party_ended).
    const k3 = (await keyOf(db, p.id))!;
    await rpc.leave(ann);
    assert.deepEqual(await take(db), [
      partyEv(k3, { type: 'member_left', party_id: p.id, user_id: ann, by: ann }),
      userEv(ann, 'party', { type: 'removed', party_id: p.id }),
    ]);
  });

  test('leader_changed on a handover (transfer or the leader leaving), never for an unchanged leader', async () => {
    const p = await rpc.party([ann, ben, cat]);
    await take(db);
    await rpc.transfer(ann, ann);
    await db.query(`update public.parties set created_at = created_at where id = $1`, [p.id]);
    assert.deepEqual(await take(db), []);
    await rpc.transfer(ann, ben);
    assert.deepEqual(await take(db), [
      partyEv(p.channel_key, { type: 'leader_changed', party_id: p.id, leader_id: ben }),
    ]);
    // The leader leaving: member_left on the old key, then the handover on the rotated one.
    await rpc.leave(ben);
    const k2 = (await keyOf(db, p.id))!;
    assert.notEqual(k2, p.channel_key);
    assert.deepEqual(await take(db), [
      partyEv(p.channel_key, { type: 'member_left', party_id: p.id, user_id: ben, by: ben }),
      userEv(ben, 'party', { type: 'removed', party_id: p.id }),
      partyEv(k2, { type: 'leader_changed', party_id: p.id, leader_id: ann }),
    ]);
    // Accepting another party's invite as a leader: the handover event goes to the old party.
    const q = await rpc.createParty(ben);
    await take(db);
    await rpc.respond(ann, await rpc.invite(ben, ann), true);
    const events = await take(db);
    assert.deepEqual(events.slice(1), [
      partyEv(k2, { type: 'member_left', party_id: p.id, user_id: ann, by: ann }),
      userEv(ann, 'party', { type: 'removed', party_id: p.id }),
      partyEv((await keyOf(db, p.id))!, { type: 'leader_changed', party_id: p.id, leader_id: cat }),
      partyEv(q.channel_key, { type: 'member_joined', party_id: q.id, user_id: ann, by: ann }),
      userEv(ann, 'invite', { type: 'invite_closed', invite_id: events[0]!.payload.invite_id }),
    ]);
  });

  test('party_ended goes to every member still in a party that is deleted (Studio, a cascade); no party topic then', async () => {
    const p = await rpc.party([ann, ben, cat]);
    const inv = await rpc.invite(ann, cat).catch(() => null); // cat is a member: INVALID, nothing sent
    assert.equal(inv, null);
    await take(db);
    await db.query(`delete from public.parties where id = $1`, [p.id]);
    assert.deepEqual(await take(db), [
      userEv(ann, 'party', { type: 'party_ended', party_id: p.id }),
      userEv(ben, 'party', { type: 'party_ended', party_id: p.id }),
      userEv(cat, 'party', { type: 'party_ended', party_id: p.id }),
      // The cascade removes the members after the party row: there is no key any more, so only the user topics.
      userEv(ann, 'party', { type: 'removed', party_id: p.id }),
      userEv(ben, 'party', { type: 'removed', party_id: p.id }),
      userEv(cat, 'party', { type: 'removed', party_id: p.id }),
    ]);
  });

  test('launch on the party topic', async () => {
    const p = await rpc.party([ann, ben]);
    await take(db);
    const id = await rpc.serverCommit(p.id, ann, 'sumo', 'r1', 'ABCD');
    assert.deepEqual(await take(db), [
      partyEv(p.channel_key, {
        type: 'launch',
        party_id: p.id,
        launch_id: id,
        game_id: 'sumo',
        room_id: 'r1',
        leader_id: ann,
      }),
    ]);
    // The code never travels on the channel; members fetch their seat through the server.
    const keys = await db.query<{ keys: string[] }>(
      `select array(select jsonb_object_keys(payload) order by 1) as keys from pg_temp.sent`,
    );
    assert.deepEqual(keys.rows, []);
  });

  test('invites: party_invite / room_invite to the recipient; invite_declined to the sender; invite_closed to the recipient', async () => {
    const p = await rpc.party([ann, ben]);
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8 });
    await take(db);
    const party = await rpc.invite(ann, cat);
    const room = await rpc.roomInvite(ben, cat, 'sumo', 'r1', 'ABCD');
    assert.deepEqual(await take(db), [
      userEv(cat, 'invite', {
        type: 'party_invite',
        invite_id: party,
        from: ann,
        party_id: p.id,
        game_id: null,
        room_id: null,
      }),
      userEv(cat, 'invite', {
        type: 'room_invite',
        invite_id: room,
        from: ben,
        party_id: null,
        game_id: 'sumo',
        room_id: 'r1',
      }),
    ]);
    assert.equal(await rpc.invite(ann, cat), party); // reused: nothing sent
    assert.deepEqual(await take(db), []);
    await rpc.respond(cat, room, false);
    assert.deepEqual(await take(db), [userEv(ben, 'invite', { type: 'invite_declined', invite_id: room, to: cat })]);
    await rpc.cancel(ann, party);
    assert.deepEqual(await take(db), [userEv(cat, 'invite', { type: 'invite_closed', invite_id: party })]);
    // Accepting a room invite closes it; a replaced room invite closes the old one and sends the new.
    const room2 = await rpc.roomInvite(ben, cat, 'sumo', 'r1');
    await take(db);
    await rpc.respond(cat, room2, true);
    assert.deepEqual(await take(db), [userEv(cat, 'invite', { type: 'invite_closed', invite_id: room2 })]);
    await upsertRoom(db, { roomId: 'r2', gameId: 'sumo', clients: 1, maxClients: 8 });
    const room3 = await rpc.roomInvite(ben, cat, 'sumo', 'r1');
    await take(db);
    const room4 = await rpc.roomInvite(ben, cat, 'sumo', 'r2');
    assert.deepEqual(await take(db), [
      userEv(cat, 'invite', { type: 'invite_closed', invite_id: room3 }),
      userEv(cat, 'invite', {
        type: 'room_invite',
        invite_id: room4,
        from: ben,
        party_id: null,
        game_id: 'sumo',
        room_id: 'r2',
      }),
    ]);
    // Expiry is silent (the app knows expires_at); the party ending closes its pending invites.
    const party2 = await rpc.invite(ann, cat);
    await take(db);
    await db.query(`update public.invites set expires_at = now() - interval '1 second' where id = $1`, [party2]);
    const party3 = await rpc.invite(ann, cat);
    assert.deepEqual(await take(db), [
      userEv(cat, 'invite', {
        type: 'party_invite',
        invite_id: party3,
        from: ann,
        party_id: p.id,
        game_id: null,
        room_id: null,
      }),
    ]);
    await rpc.leave(ben);
    await take(db);
    const key = (await keyOf(db, p.id))!;
    await rpc.leave(ann);
    assert.deepEqual(await take(db), [
      partyEv(key, { type: 'member_left', party_id: p.id, user_id: ann, by: ann }),
      userEv(ann, 'party', { type: 'removed', party_id: p.id }),
      userEv(cat, 'invite', { type: 'invite_closed', invite_id: party3 }),
    ]);
  });

  test('a failing realtime.send never fails the change; without realtime.send everything works and nothing is sent', async () => {
    await stubSend(db, { fail: true });
    const p = await rpc.party([ann, ben]);
    await rpc.serverCommit(p.id, ann, 'sumo', 'r1', null);
    await rpc.transfer(ann, ben);
    await rpc.cancel(ann, await rpc.invite(ann, cat));
    await rpc.leave(ben);
    await db.exec(`drop function realtime.send(jsonb, text, text, boolean)`);
    await rpc.respond(cat, await rpc.invite(ann, cat), true);
    await rpc.leave(ann);
    await rpc.leave(cat);
    assert.equal(await count(db, `select 1 from public.parties`), 0);
    assert.equal(await count(db, `select 1 from pg_temp.sent`), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Private channel policy
// ---------------------------------------------------------------------------------------------------------------

describe('parties: realtime.messages policy for party:<channel_key> channels', () => {
  const POLICY_BLOCK = (() => {
    const start = MIGRATION.indexOf('do $outer$');
    return MIGRATION.slice(start, MIGRATION.indexOf('end $outer$;', start) + 'end $outer$;'.length);
  })();

  test('without realtime.messages the migration applies with a NOTICE', async () => {
    const db = await createTestDb();
    const notices: string[] = [];
    await db.exec(POLICY_BLOCK, { onNotice: (n) => notices.push(n.message ?? '') });
    assert.deepEqual(notices, ['realtime.messages does not exist: no policy for the private party:<id> channels']);
    await db.close();
  });

  test('SELECT only, to authenticated, on party:<channel_key> of the party the caller is in', async () => {
    const db = await createTestDb();
    const rpc = api(db);
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    const cat = await user(db, 'cat');
    await befriend(db, ann, ben);
    // Stub of Supabase's realtime.messages / realtime.topic() (the topic of the channel being authorized).
    await db.exec(`
      create schema if not exists realtime;
      create table realtime.messages (
        id bigserial primary key, topic text not null, extension text not null default 'broadcast',
        payload jsonb, event text, private boolean default true
      );
      alter table realtime.messages enable row level security;
      create function realtime.topic() returns text language sql stable as
        $$ select nullif(current_setting('realtime.topic', true), '') $$;
      grant usage on schema realtime to anon, authenticated;
      grant select, insert on realtime.messages to anon, authenticated;
      grant usage on sequence realtime.messages_id_seq to anon, authenticated;
      insert into realtime.messages (topic, event) values ('party:x', 'party');
    `);
    const notices: string[] = [];
    await db.exec(POLICY_BLOCK, { onNotice: (n) => notices.push(n.message ?? '') });
    assert.deepEqual(notices, [
      'policy "members receive their party channel" for relation "realtime.messages" does not exist, skipping',
    ]);
    await db.exec(POLICY_BLOCK, { onNotice: (n) => notices.push(n.message ?? '') });
    assert.equal(notices.length, 1); // idempotent
    const policies = await db.query<Record<string, unknown>>(
      `select policyname, cmd, roles::text[] as roles, permissive, qual, with_check
         from pg_policies where schemaname = 'realtime' and tablename = 'messages'`,
    );
    assert.equal(policies.rows.length, 1);
    const p = policies.rows[0]!;
    assert.equal(p.policyname, 'members receive their party channel');
    assert.equal(p.cmd, 'SELECT');
    assert.deepEqual(p.roles, ['authenticated']);
    assert.equal(p.permissive, 'PERMISSIVE');
    assert.equal(p.with_check, null);
    assert.match(String(p.qual), /realtime\.topic\(\)[^)]*\) ~~ 'party:%'::text/);
    assert.match(String(p.qual), /FROM \(party_members pm\s+JOIN parties p ON \(\(p\.id = pm\.party_id\)\)\)/);
    assert.match(String(p.qual), /\('party:'::text \|\| \(p\.channel_key\)::text\)/);

    const party = await rpc.party([ann, ben]);
    const canJoin = async (topic: string, as: (fn: () => Promise<number>) => Promise<number>) => {
      await db.query(`select set_config('realtime.topic', $1, false)`, [topic]);
      return (await as(async () => (await db.query(`select 1 from realtime.messages`)).rows.length)) > 0;
    };
    const k1 = `party:${party.channel_key}`;
    assert.equal(await canJoin(k1, (fn) => asUser(db, ann, fn)), true);
    assert.equal(await canJoin(k1, (fn) => asUser(db, ben, fn)), true);
    assert.equal(await canJoin(k1, (fn) => asUser(db, cat, fn)), false);
    assert.equal(await canJoin(`party:${party.id}`, (fn) => asUser(db, ann, fn)), false); // the id is not the topic
    assert.equal(await canJoin(`party:${NOBODY}`, (fn) => asUser(db, ann, fn)), false);
    assert.equal(await canJoin(k1, (fn) => asAnon(db, fn)), false);
    assert.equal(await canJoin(`user:${ann}`, (fn) => asUser(db, ann, fn)), false); // that policy is 20261031000200's
    assert.equal(await canJoin('', (fn) => asUser(db, ann, fn)), false);
    // Membership changes take effect at once, and a removal rotates the key: the old topic admits nobody.
    await rpc.leave(ben);
    const k2 = `party:${(await keyOf(db, party.id))!}`;
    assert.notEqual(k2, k1);
    assert.equal(await canJoin(k1, (fn) => asUser(db, ben, fn)), false);
    assert.equal(await canJoin(k1, (fn) => asUser(db, ann, fn)), false);
    assert.equal(await canJoin(k2, (fn) => asUser(db, ben, fn)), false);
    assert.equal(await canJoin(k2, (fn) => asUser(db, ann, fn)), true);
    await rpc.respond(ben, await rpc.invite(ann, ben), true);
    assert.equal(await canJoin(k2, (fn) => asUser(db, ben, fn)), true);
    // No INSERT policy: members cannot broadcast on the party channel themselves.
    await db.query(`select set_config('realtime.topic', $1, false)`, [k2]);
    await assert.rejects(
      asUser(db, ann, () => db.query(`insert into realtime.messages (topic, event) values ($1, 'party')`, [k2])),
      /row-level security/,
    );
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------

describe('parties: retention', () => {
  test('purge_invites and purge_party_launches delete rows older than a day; active_launch_id is cleared', async () => {
    const db = await createTestDb();
    const rpc = api(db);
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    const cat = await user(db, 'cat');
    await befriend(db, ann, ben);
    await befriend(db, ann, cat);
    await insertServerGame(db, 'sumo');
    const p = await rpc.party([ann, ben]);
    const oldInvite = await rpc.invite(ann, cat);
    await rpc.cancel(ann, oldInvite);
    const newInvite = await rpc.invite(ann, cat);
    const oldLaunch = await rpc.serverCommit(p.id, ann, 'sumo', 'r1', null);
    const newLaunch = await rpc.serverCommit(p.id, ann, 'sumo', 'r2', null);
    await db.query(`update public.invites set created_at = now() - interval '25 hours' where id = $1`, [oldInvite]);
    await db.query(`update public.party_launches set created_at = now() - interval '25 hours' where id = $1`, [
      oldLaunch,
    ]);
    await db.exec(`select private.purge_invites(); select private.purge_party_launches();`);
    assert.deepEqual((await db.query<{ id: string }>(`select id from public.invites where to_id = $1`, [cat])).rows, [
      { id: newInvite },
    ]);
    assert.deepEqual((await db.query<{ id: string }>(`select id from public.party_launches`)).rows, [
      { id: newLaunch },
    ]);
    await db.query(`update public.party_launches set created_at = now() - interval '25 hours'`);
    await db.exec(`select private.purge_party_launches()`);
    assert.equal(await count(db, `select 1 from public.party_launches`), 0);
    assert.equal(
      (await db.query<{ a: string | null }>(`select active_launch_id as a from public.parties where id = $1`, [p.id]))
        .rows[0]?.a,
      null,
    );
    await db.close();
  });

  test('without pg_cron the schedule block only raises a NOTICE', async () => {
    const db = await createTestDb();
    const block = MIGRATION.slice(MIGRATION.lastIndexOf('do $outer$'));
    const notices: string[] = [];
    await db.exec(block, { onNotice: (n) => notices.push(n.message ?? '') });
    assert.deepEqual(notices, [
      'pg_cron is not available: old invites and party launches will not be purged automatically',
    ]);
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Security review fixes (each test reproduces an exploit against the first version of the migration)
// ---------------------------------------------------------------------------------------------------------------

/** Stub of Supabase's realtime.messages / realtime.topic(), then the migration's channel policy block. */
async function stubRealtimeMessages(db: PGlite): Promise<void> {
  await db.exec(`
    create schema if not exists realtime;
    create table realtime.messages (
      id bigserial primary key, topic text not null, extension text not null default 'broadcast',
      payload jsonb, event text, private boolean default true
    );
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as
      $$ select nullif(current_setting('realtime.topic', true), '') $$;
    grant usage on schema realtime to anon, authenticated;
    grant select, insert on realtime.messages to anon, authenticated;
    insert into realtime.messages (topic, event) values ('any', 'party');
  `);
  const start = MIGRATION.indexOf('do $outer$');
  await db.exec(MIGRATION.slice(start, MIGRATION.indexOf('end $outer$;', start) + 'end $outer$;'.length));
}
/** Whether `uid` may join the private channel `topic` (Realtime's check: messages selectable for that topic). */
async function canJoin(db: PGlite, uid: string, topic: string): Promise<boolean> {
  await db.query(`select set_config('realtime.topic', $1, false)`, [topic]);
  return (await asUser(db, uid, async () => (await db.query(`select 1 from realtime.messages`)).rows.length)) > 0;
}
const keyOf = async (db: PGlite, party: string) =>
  (await db.query<{ k: string }>(`select channel_key::text as k from public.parties where id = $1`, [party])).rows[0]
    ?.k;

describe('security: stale invites, blocks inside a party, the rotating party channel', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dan: string;
  let rpc: ReturnType<typeof api>;
  const refriend = async (a: string, b: string) => {
    await db.query(`delete from public.blocks where (blocker_id, blocked_id) in (($1, $2), ($2, $1))`, [a, b]);
    await db.query(`delete from public.friendships where (user_id, friend_id) in (($1, $2), ($2, $1))`, [a, b]);
    await befriend(db, a, b);
  };
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    dan = await user(db, 'dan');
    await insertServerGame(db, 'sumo');
  });
  beforeEach(async () => {
    await db.exec(RESET + `delete from public.friendships;`);
    for (const [a, b] of [
      [ann, ben],
      [ann, cat],
      [ben, cat],
      [ben, dan],
      [ann, dan],
    ])
      await befriend(db, a!, b!);
    await stubSend(db);
    await db.exec(`truncate pg_temp.sent`);
  });
  after(() => db.close());

  test('1. accepting rechecks the sender: unfriended or blocked either way -> NOT_FOUND, and my_invites hides it', async () => {
    await rpc.createParty(ann);
    const inv = await rpc.invite(ann, ben);
    await asUser(db, ben, () => db.query(`select public.remove_friend($1)`, [ann]));
    assert.deepEqual(await rpc.myInvites(ben), []);
    await assert.rejects(rpc.respond(ben, inv, true), sqlstate('P0002', /^NOT_FOUND: invite$/));
    assert.equal(await rpc.myParty(ben), null);
    // Friends again: the invite (still pending, unexpired) is valid again.
    await refriend(ann, ben);
    assert.deepEqual(
      (await rpc.myInvites(ben)).map((r) => r.id),
      [inv],
    );
    // The recipient blocks the sender, or the sender blocks the recipient (the friendship row put back by hand: the
    // block alone must refuse).
    for (const [blocker, blocked] of [
      [ben, ann],
      [ann, ben],
    ]) {
      await block(db, blocker!, blocked!);
      await befriend(db, ann, ben);
      assert.deepEqual(await rpc.myInvites(ben), [], `${blocker} blocks`);
      await assert.rejects(rpc.respond(ben, inv, true), notFound);
      await refriend(ann, ben);
    }
    // Room invites too.
    await upsertRoom(db, { roomId: 'r1', gameId: 'sumo', clients: 1, maxClients: 8 });
    const room = await rpc.roomInvite(cat, ben, 'sumo', 'r1');
    await asUser(db, cat, () => db.query(`select public.remove_friend($1)`, [ben]));
    assert.deepEqual(
      (await rpc.myInvites(ben)).map((r) => r.id),
      [inv],
    );
    await assert.rejects(rpc.respond(ben, room, true), notFound);
    // Nothing above changed a status.
    assert.equal((await rpc.invite_state(inv))?.status, 'pending');
    assert.equal((await rpc.invite_state(room))?.status, 'pending');
    assert.equal((await rpc.respond(ben, inv, true)).kind, 'party');
  });

  test('1. an invite sent by a member who leaves (or is kicked) is cancelled; one from a non-member is refused', async () => {
    const p = await rpc.party([ann, ben]);
    const fromBen = await rpc.invite(ben, cat);
    const fromAnn = await rpc.invite(ann, dan);
    await take(db);
    await rpc.leave(ben);
    assert.equal((await rpc.invite_state(fromBen))?.status, 'cancelled');
    assert.equal((await rpc.invite_state(fromAnn))?.status, 'pending');
    assert.ok(
      (await take(db)).some(
        (e) => e.topic === `user:${cat}` && e.payload.type === 'invite_closed' && e.payload.invite_id === fromBen,
      ),
    );
    await assert.rejects(rpc.respond(cat, fromBen, true), notFound);
    // A pending row whose sender is no longer in the party (written by hand) is hidden and refused all the same.
    await db.query(`insert into public.invites (kind, from_id, to_id, party_id) values ('party', $1, $2, $3)`, [
      ben,
      cat,
      p.id,
    ]);
    assert.deepEqual(await rpc.myInvites(cat), []);
    const stale = (
      await db.query<{ id: string }>(`select id from public.invites where from_id = $1 and status = 'pending'`, [ben])
    ).rows[0]!.id;
    await assert.rejects(rpc.respond(cat, stale, true), notFound);
    assert.deepEqual(await rpc.members(p.id), [ann]);
    // Kicked: the same.
    await rpc.respond(ben, await rpc.invite(ann, ben), true);
    const again = await rpc.invite(ben, dan);
    await rpc.kick(ann, ben);
    assert.equal((await rpc.invite_state(again))?.status, 'cancelled');
  });

  test('2. a user with a block (either way) with ANY party member cannot be invited by another member, nor accept', async () => {
    for (const [blocker, blocked] of [
      [ann, dan],
      [dan, ann],
    ]) {
      await db.exec(RESET);
      await refriend(ben, dan);
      await block(db, blocker!, blocked!); // between ann and dan only
      // ann and ben are partied; ben (dan's friend) invites dan: the generic "no such friend".
      await rpc.party([ann, ben]);
      await assert.rejects(rpc.invite(ben, dan), noSuchFriend, `${blocker} blocks`);
      await rpc.leave(ann);
      await rpc.leave(ben);
      // ben invites dan first, then ann joins ben's party: dan can no longer accept, and does not see the invite.
      await rpc.createParty(ben);
      const inv = await rpc.invite(ben, dan);
      await rpc.respond(ann, await rpc.invite(ben, ann), true);
      assert.deepEqual(await rpc.myInvites(dan), []);
      await assert.rejects(rpc.respond(dan, inv, true), sqlstate('P0002', /^NOT_FOUND: invite$/));
      assert.equal(await rpc.myParty(dan), null);
      // ann leaves: dan may join again.
      await rpc.leave(ann);
      assert.equal((await rpc.respond(dan, inv, true)).kind, 'party');
      await rpc.leave(dan);
      await rpc.leave(ben);
      await asUser(db, blocker!, () => db.query(`select public.unblock_user($1)`, [blocked]));
    }
  });

  test('3. my_party carries channel_key; party events go to party:<channel_key>; every removal rotates it', async () => {
    const p = await rpc.party([ann, ben, cat]);
    const k1 = (await rpc.myParty(ann))!.channel_key;
    assert.match(k1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(k1, p.id);
    assert.equal(p.channel_key, k1); // create_party returns the my_party shape
    assert.equal((await rpc.myParty(ben))!.channel_key, k1);
    await take(db);
    await rpc.kick(ann, ben);
    // member_left (and removed) on the key ben knew, then the key changes.
    assert.deepEqual(await take(db), [
      partyEv(k1, { type: 'member_left', party_id: p.id, user_id: ben, by: ann }),
      userEv(ben, 'party', { type: 'removed', party_id: p.id }),
    ]);
    const k2 = (await rpc.myParty(ann))!.channel_key;
    assert.notEqual(k2, k1);
    assert.equal(await keyOf(db, p.id), k2);
    // Chat and launches now go to the new key only.
    const m = await asUser(
      db,
      ann,
      async () =>
        (
          await db.query<{ m: { id: string } }>(`select public.send_message($1, 'secret plan') as m`, [
            p.conversation_id,
          ])
        ).rows[0]!.m,
    );
    const launch = await rpc.serverCommit(p.id, ann, 'sumo', 'r-secret', 'CODE');
    assert.deepEqual(await take(db), [
      partyEv(k2, {
        type: 'message',
        conversation_id: p.conversation_id,
        message_id: m.id,
        sender_id: ann,
        body: 'secret plan',
      }),
      partyEv(k2, {
        type: 'launch',
        party_id: p.id,
        launch_id: launch,
        game_id: 'sumo',
        room_id: 'r-secret',
        leader_id: ann,
      }),
    ]);
    // Leaving rotates too; joining does not.
    await rpc.leave(cat);
    const k3 = await keyOf(db, p.id);
    assert.notEqual(k3, k2);
    await rpc.respond(ben, await rpc.invite(ann, ben), true);
    assert.equal(await keyOf(db, p.id), k3);
  });

  test('3. the channel policy admits current members on the current key only (never party:<id>, never an old key)', async () => {
    await stubRealtimeMessages(db);
    const p = await rpc.party([ann, ben, cat]);
    const k1 = (await keyOf(db, p.id))!;
    assert.equal(await canJoin(db, ann, `party:${k1}`), true);
    assert.equal(await canJoin(db, ben, `party:${k1}`), true);
    assert.equal(await canJoin(db, dan, `party:${k1}`), false);
    assert.equal(await canJoin(db, ann, `party:${p.id}`), false);
    await rpc.kick(ann, ben);
    const k2 = (await keyOf(db, p.id))!;
    assert.equal(await canJoin(db, ben, `party:${k1}`), false);
    assert.equal(await canJoin(db, ben, `party:${k2}`), false);
    assert.equal(await canJoin(db, ann, `party:${k1}`), false);
    assert.equal(await canJoin(db, ann, `party:${k2}`), true);
    assert.equal(await canJoin(db, cat, `party:${k2}`), true);
    // Clients read only their own party's key (the policy's lookup), and nothing else of the party row.
    const own = await asUser(db, cat, () =>
      db.query<{ id: string; channel_key: string }>(`select id, channel_key from public.parties`),
    );
    assert.deepEqual(own.rows, [{ id: p.id, channel_key: k2 }]);
    assert.deepEqual((await asUser(db, ben, () => db.query(`select id, channel_key from public.parties`))).rows, []);
    await assert.rejects(
      asUser(db, cat, () => db.query(`select leader_id from public.parties`)),
      permissionDenied,
    );
  });
});
