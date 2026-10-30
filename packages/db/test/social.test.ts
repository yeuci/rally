// 20261030000300_m4_social.sql: friendships, blocks, people search, profile privacy, and the M2 functions that
// now use friendships (leaderboard_top friends scope, public_profile_stats).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import {
  asAnon,
  asAnonymousUser,
  asUser,
  createTestDb,
  insertGame,
  signUp,
  signUpAnonymously,
} from './harness.ts';

const NOBODY = '00000000-0000-0000-0000-000000000000';

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const anonymousForbidden = sqlstate('42501', /^ANONYMOUS_FORBIDDEN/);
const unauthenticated = sqlstate('42501', /^UNAUTHENTICATED/);
const blocked = sqlstate('42501', /^BLOCKED: cannot send a friend request to this user$/);
const notFound = sqlstate('P0002', /^NOT_FOUND/);
const invalid = sqlstate('22023', /^INVALID/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const permissionDenied = /permission denied/;

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

interface PersonRow {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}
interface SearchRow extends PersonRow {
  friendship: string;
}
interface FriendRow extends PersonRow {
  since: string;
}
interface RequestRow extends PersonRow {
  direction: string;
  created_at: string;
}
interface GameRow {
  game_id: string;
  title: string;
  icon_url: string | null;
  cover_url: string | null;
  plays: number;
  best_score: number | null;
  last_played_at: string | null;
}

/** Shorthands bound to one database. Each call runs as a signed-in, linked user. */
function api(db: PGlite) {
  const scalar = async <T>(uid: string, sql: string, params: unknown[]): Promise<T> =>
    asUser(db, uid, async () => (await db.query<{ v: T }>(sql, params)).rows[0]!.v);
  const rows = async <T>(uid: string, sql: string, params: unknown[] = []): Promise<T[]> =>
    asUser(db, uid, async () => (await db.query<T>(sql, params)).rows);
  return {
    send: (from: string, to: string) => scalar<string>(from, `select public.send_friend_request($1) as v`, [to]),
    respond: (uid: string, from: string, accept: boolean) =>
      scalar<string>(uid, `select public.respond_friend_request($1, $2) as v`, [from, accept]),
    remove: (uid: string, other: string) => scalar<null>(uid, `select public.remove_friend($1) as v`, [other]),
    block: (uid: string, other: string) => scalar<null>(uid, `select public.block_user($1) as v`, [other]),
    unblock: (uid: string, other: string) => scalar<null>(uid, `select public.unblock_user($1) as v`, [other]),
    rel: (uid: string, other: string) => scalar<string>(uid, `select public.friendship_with($1) as v`, [other]),
    search: (uid: string, q: string, limit: number | null = 20) =>
      rows<SearchRow>(uid, `select * from public.search_profiles($1, $2)`, [q, limit]),
    friends: (uid: string, limit: number | null = 200) =>
      rows<FriendRow>(uid, `select * from public.my_friends($1)`, [limit]),
    requests: (uid: string) => rows<RequestRow>(uid, `select * from public.my_friend_requests()`),
    publicFriends: (uid: string, owner: string, limit: number | null = 50) =>
      rows<FriendRow>(uid, `select * from public.public_friends($1, $2)`, [owner, limit]),
    publicGames: (uid: string, owner: string, limit: number | null = 20) =>
      rows<GameRow>(uid, `select * from public.public_profile_games($1, $2)`, [owner, limit]),
    stats: (uid: string, owner: string) =>
      scalar<Record<string, number | null>>(uid, `select public.public_profile_stats($1) as v`, [owner]),
    /** Owner updates their privacy through the column grant (no RETURNING: privacy is not client-readable). */
    setPrivacy: (uid: string, privacy: object) =>
      asUser(db, uid, () => db.query(`update public.profiles set privacy = $2::jsonb where id = $1`, [uid, JSON.stringify(privacy)])),
  };
}

/** Raw friendships rows (superuser view), ordered for stable comparisons. */
const pairRows = async (db: PGlite, a: string, b: string) =>
  (
    await db.query<{ user_id: string; friend_id: string; status: string; accepted: boolean }>(
      `select user_id, friend_id, status::text, accepted_at is not null as accepted from public.friendships
        where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1)`,
      [a, b],
    )
  ).rows;

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const resetSocial = (db: PGlite) =>
  db.exec(`delete from public.friendships; delete from public.blocks; delete from public.rate_limits;`);

describe('friend requests', () => {
  let db: PGlite;
  let a: ReturnType<typeof api>;
  let ann: string;
  let ben: string;
  let cat: string;
  let ghost: string;

  before(async () => {
    db = await createTestDb();
    a = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() => resetSocial(db));
  after(() => db.close());

  test('send -> outgoing / incoming on each side; one pending row from the requester', async () => {
    assert.equal(await a.send(ann, ben), 'outgoing');
    assert.deepEqual(await pairRows(db, ann, ben), [{ user_id: ann, friend_id: ben, status: 'pending', accepted: false }]);
    assert.equal(await a.rel(ann, ben), 'outgoing');
    assert.equal(await a.rel(ben, ann), 'incoming');
    assert.equal(await a.rel(ann, ann), 'self');
    assert.equal(await a.rel(ann, cat), 'none');
    // Sending again is idempotent.
    assert.equal(await a.send(ann, ben), 'outgoing');
    assert.equal((await pairRows(db, ann, ben)).length, 1);

    const annReqs = await a.requests(ann);
    assert.deepEqual(
      annReqs.map((r) => [r.user_id, r.username, r.direction]),
      [[ben, 'ben', 'outgoing']],
    );
    const benReqs = await a.requests(ben);
    assert.deepEqual(
      benReqs.map((r) => [r.user_id, r.username, r.direction]),
      [[ann, 'ann', 'incoming']],
    );
    assert.ok(benReqs[0]!.created_at);
    assert.deepEqual(await a.friends(ann), []);
  });

  test('accept -> friends both ways; my_friends lists each other with since = accepted_at', async () => {
    await a.send(ann, ben);
    assert.equal(await a.respond(ben, ann, true), 'friends');
    assert.deepEqual(await pairRows(db, ann, ben), [{ user_id: ann, friend_id: ben, status: 'accepted', accepted: true }]);
    assert.equal(await a.rel(ann, ben), 'friends');
    assert.equal(await a.rel(ben, ann), 'friends');
    const annFriends = await a.friends(ann);
    assert.deepEqual(
      annFriends.map((r) => [r.user_id, r.username]),
      [[ben, 'ben']],
    );
    const accepted = await db.query<{ t: string }>(`select accepted_at as t from public.friendships`);
    assert.equal(new Date(annFriends[0]!.since).getTime(), new Date(accepted.rows[0]!.t).getTime());
    assert.deepEqual(
      (await a.friends(ben)).map((r) => r.user_id),
      [ann],
    );
    assert.deepEqual(await a.requests(ann), []);
    assert.deepEqual(await a.requests(ben), []);
    // Either side sending again is a no-op that reports the state.
    assert.equal(await a.send(ann, ben), 'friends');
    assert.equal(await a.send(ben, ann), 'friends');
    assert.equal((await pairRows(db, ann, ben)).length, 1);
    // Answering again: there is no pending request any more.
    await assert.rejects(a.respond(ben, ann, true), notFound);
  });

  test('decline deletes the request; the requester may ask again', async () => {
    await a.send(ann, ben);
    assert.equal(await a.respond(ben, ann, false), 'none');
    assert.deepEqual(await pairRows(db, ann, ben), []);
    assert.equal(await a.rel(ann, ben), 'none');
    assert.equal(await a.rel(ben, ann), 'none');
    assert.equal(await a.send(ann, ben), 'outgoing');
  });

  test('mutual request: the second sender accepts the pending incoming one (single row, original direction)', async () => {
    assert.equal(await a.send(ann, ben), 'outgoing');
    assert.equal(await a.send(ben, ann), 'friends');
    assert.deepEqual(await pairRows(db, ann, ben), [{ user_id: ann, friend_id: ben, status: 'accepted', accepted: true }]);
  });

  test('one row per pair is enforced by the database too', async () => {
    await a.send(ann, ben);
    await assert.rejects(
      db.query(`insert into public.friendships (user_id, friend_id) values ($1, $2)`, [ben, ann]),
      /duplicate key value violates unique constraint "friendships_pair_idx"/,
    );
    await assert.rejects(
      db.query(`insert into public.friendships (user_id, friend_id) values ($1, $1)`, [ann]),
      /friendships_not_self/,
    );
    await assert.rejects(
      db.query(`insert into public.friendships (user_id, friend_id, status) values ($1, $2, 'accepted')`, [ann, cat]),
      /friendships_accepted_at/,
    );
  });

  test('respond: only a pending request FROM p_user_id TO the caller; else NOT_FOUND', async () => {
    await a.send(ann, ben);
    await assert.rejects(a.respond(ann, ben, true), notFound); // ann is the requester
    await assert.rejects(a.respond(cat, ann, true), notFound); // not addressed to cat
    await assert.rejects(a.respond(ben, cat, true), notFound); // no request from cat
    await assert.rejects(a.respond(ben, NOBODY, true), notFound);
    await assert.rejects(a.respond(ben, ann, null as unknown as boolean), invalid);
    assert.equal((await pairRows(db, ann, ben))[0]!.status, 'pending');
  });

  test('remove_friend: accepted (either side) or own outgoing request; incoming untouched; no error otherwise', async () => {
    await a.send(ann, ben);
    await a.respond(ben, ann, true);
    await a.remove(ben, ann); // the recipient may end it too
    assert.deepEqual(await pairRows(db, ann, ben), []);

    await a.send(ann, ben);
    await a.remove(ann, ben); // cancel own request
    assert.deepEqual(await pairRows(db, ann, ben), []);

    await a.send(ann, ben);
    await a.remove(ben, ann); // incoming: decline it with respond_friend_request instead
    assert.equal((await pairRows(db, ann, ben))[0]!.status, 'pending');

    await a.remove(ann, cat); // nothing there
    await a.remove(ann, ann);
    await assert.rejects(a.remove(ann, NOBODY), notFound);
  });

  test('send: self is INVALID, unknown or anonymous users are NOT_FOUND', async () => {
    await assert.rejects(a.send(ann, ann), invalid);
    await assert.rejects(a.send(ann, NOBODY), notFound);
    await assert.rejects(a.send(ann, ghost), notFound);
    await assert.rejects(a.rel(ann, NOBODY), notFound);
    assert.equal(await count(db, `select 1 from public.friendships`), 0);
  });

  test('anonymous sessions cannot write; signed-out clients cannot call the writes at all', async () => {
    await asAnonymousUser(db, ghost, async () => {
      for (const sql of [
        `select public.send_friend_request($1)`,
        `select public.respond_friend_request($1, true)`,
        `select public.remove_friend($1)`,
        `select public.block_user($1)`,
        `select public.unblock_user($1)`,
      ]) {
        await assert.rejects(db.query(sql, [ann]), anonymousForbidden, sql);
      }
      await assert.rejects(db.query(`select * from public.search_profiles('ann')`), anonymousForbidden);
      // Reads: an anonymous session is a stranger with no relationships.
      assert.equal((await db.query<{ v: string }>(`select public.friendship_with($1) as v`, [ann])).rows[0]!.v, 'none');
      assert.equal((await db.query(`select * from public.my_friends()`)).rows.length, 0);
      assert.equal((await db.query(`select * from public.my_friend_requests()`)).rows.length, 0);
    });
    await asAnon(db, async () => {
      for (const sql of [
        `select public.send_friend_request($1)`,
        `select public.respond_friend_request($1, true)`,
        `select public.remove_friend($1)`,
        `select public.block_user($1)`,
        `select public.unblock_user($1)`,
        `select * from public.my_friends()`,
        `select * from public.my_friend_requests()`,
        `select * from public.search_profiles($1::text)`,
      ]) {
        await assert.rejects(db.query(sql, sql.includes('$1') ? [ann] : []), permissionDenied, sql);
      }
      assert.equal((await db.query<{ v: string }>(`select public.friendship_with($1) as v`, [ann])).rows[0]!.v, 'none');
    });
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.send_friend_request($1)`, [ann]), unauthenticated);
      await assert.rejects(db.query(`select * from public.my_friends()`), unauthenticated);
      await assert.rejects(db.query(`select * from public.my_friend_requests()`), unauthenticated);
      assert.equal((await db.query<{ v: string }>(`select public.friendship_with($1) as v`, [ann])).rows[0]!.v, 'none');
    });
  });

  test('rate limit: 30 send_friend_request calls per user per hour', async () => {
    for (let i = 0; i < 30; i++) assert.equal(await a.send(ann, ben), 'outgoing');
    await assert.rejects(a.send(ann, cat), rateLimited);
    assert.equal(await count(db, `select 1 from public.friendships where friend_id = $1`, [cat]), 0);
    // Other users have their own bucket.
    assert.equal(await a.send(cat, ben), 'outgoing');
    // The bucket refills at 30 per hour (one token per 2 minutes): 3 minutes buy one more request, not two.
    await db.query(
      `update public.rate_limits set refilled_at = refilled_at - interval '3 minutes'
        where user_id = $1 and action = 'send_friend_request'`,
      [ann],
    );
    assert.equal(await a.send(ann, cat), 'outgoing');
    await assert.rejects(a.send(ann, cat), rateLimited);
  });

  test('my_friends / my_friend_requests: newest first; my_friends limit', async () => {
    await a.send(ann, ben);
    await a.send(cat, ann);
    await db.query(`update public.friendships set created_at = now() - interval '1 hour' where user_id = $1`, [ann]);
    assert.deepEqual(
      (await a.requests(ann)).map((r) => [r.username, r.direction]),
      [
        ['cat', 'incoming'],
        ['ben', 'outgoing'],
      ],
    );
    await a.respond(ben, ann, true);
    await a.respond(ann, cat, true);
    await db.query(`update public.friendships set accepted_at = now() - interval '1 day' where friend_id = $1`, [ann]);
    assert.deepEqual(
      (await a.friends(ann)).map((r) => r.username),
      ['ben', 'cat'],
    );
    assert.deepEqual(
      (await a.friends(ann, 1)).map((r) => r.username),
      ['ben'],
    );
    assert.equal((await a.friends(ann, 0)).length, 1);
    assert.equal((await a.friends(ann, null)).length, 2);
  });

  test('deleting a user removes their friendships and blocks', async () => {
    const tmp = await user(db, 'tmp_user');
    await a.send(tmp, ann);
    await a.block(tmp, ben);
    await db.query(`delete from auth.users where id = $1`, [tmp]);
    assert.equal(await count(db, `select 1 from public.friendships where user_id = $1`, [tmp]), 0);
    assert.equal(await count(db, `select 1 from public.blocks where blocker_id = $1`, [tmp]), 0);
  });
});

describe('blocks', () => {
  let db: PGlite;
  let a: ReturnType<typeof api>;
  let ann: string;
  let ben: string;

  before(async () => {
    db = await createTestDb();
    a = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
  });
  beforeEach(() => resetSocial(db));
  after(() => db.close());

  test('blocking removes a friendship or request in either direction', async () => {
    await a.send(ann, ben);
    await a.respond(ben, ann, true);
    await a.block(ben, ann);
    assert.deepEqual(await pairRows(db, ann, ben), []);

    await a.unblock(ben, ann);
    await a.send(ann, ben);
    await a.block(ann, ben);
    assert.deepEqual(await pairRows(db, ann, ben), []);
  });

  test("the blocker gets BLOCKED; the blocked side's request looks sent but is dropped (never revealed)", async () => {
    await a.block(ann, ben);
    await assert.rejects(a.send(ann, ben), blocked);
    assert.equal(await a.send(ben, ann), 'outgoing');
    assert.deepEqual(await pairRows(db, ann, ben), []);
    assert.equal(await a.rel(ben, ann), 'none');
  });

  test("friendship_with: the blocker sees 'blocked', the blocked user sees 'none'; unblock restores 'none'", async () => {
    await a.block(ann, ben);
    assert.equal(await a.rel(ann, ben), 'blocked');
    assert.equal(await a.rel(ben, ann), 'none');
    await a.block(ann, ben); // idempotent
    assert.equal(await count(db, `select 1 from public.blocks`), 1);
    await a.unblock(ann, ben);
    await a.unblock(ann, ben); // idempotent
    assert.equal(await a.rel(ann, ben), 'none');
    assert.equal(await a.send(ann, ben), 'outgoing');
  });

  test('both sides blocking each other: each sees blocked; unblocking one side still refuses requests', async () => {
    await a.block(ann, ben);
    await a.block(ben, ann);
    assert.equal(await a.rel(ann, ben), 'blocked');
    assert.equal(await a.rel(ben, ann), 'blocked');
    await a.unblock(ann, ben);
    assert.equal(await a.rel(ann, ben), 'none');
    // ben still blocks ann: ann's request is silently dropped.
    assert.equal(await a.send(ann, ben), 'outgoing');
    assert.deepEqual(await pairRows(db, ann, ben), []);
  });

  test('self is INVALID; unknown users are NOT_FOUND', async () => {
    await assert.rejects(a.block(ann, ann), invalid);
    await assert.rejects(a.unblock(ann, ann), invalid);
    await assert.rejects(a.block(ann, NOBODY), notFound);
    await assert.rejects(a.unblock(ann, NOBODY), notFound);
  });
});

describe('search_profiles', () => {
  let db: PGlite;
  let a: ReturnType<typeof api>;
  const u: Record<string, string> = {};

  before(async () => {
    db = await createTestDb();
    a = api(db);
    for (const [name, display] of [
      ['samwise', 'The Caller'],
      ['sam', null],
      ['samantha', 'Sammy'],
      ['bob_sam', 'Sam Bobson'],
      ['sa_m', null],
      ['xavier', 'not here'],
      ['zed', 'aSAMb'],
    ] as const) {
      u[name] = await user(db, name);
      if (display) await db.query(`update public.profiles set display_name = $2 where id = $1`, [u[name], display]);
    }
    await signUpAnonymously(db, { username: 'sam_anon', birth_date: '2000-01-01' });
    for (let i = 0; i < 55; i++) await user(db, `zz${String(i).padStart(2, '0')}`);
  });
  beforeEach(() => resetSocial(db));
  after(() => db.close());

  test('username prefix matches first, then display-name matches, each by username; caller and anonymous excluded', async () => {
    const rows = await a.search(u.samwise!, 'sam');
    assert.deepEqual(
      rows.map((r) => r.username),
      ['sam', 'samantha', 'bob_sam', 'zed'],
    );
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['avatar_url', 'display_name', 'friendship', 'user_id', 'username']);
    assert.equal(rows[1]!.display_name, 'Sammy');
    assert.ok(rows.every((r) => r.friendship === 'none'));
    // Case-insensitive, trimmed.
    assert.deepEqual(
      (await a.search(u.samwise!, '  SAM  ')).map((r) => r.username),
      ['sam', 'samantha', 'bob_sam', 'zed'],
    );
    // Display names match anywhere; usernames only by prefix.
    assert.deepEqual(
      (await a.search(u.samwise!, 'bobson')).map((r) => r.username),
      ['bob_sam'],
    );
    assert.deepEqual(await a.search(u.samwise!, 'avier'), []);
  });

  test('LIKE wildcards in the query are literal', async () => {
    assert.deepEqual(
      (await a.search(u.samwise!, 'sa_')).map((r) => r.username),
      ['sa_m'],
    );
    assert.deepEqual(await a.search(u.samwise!, '%'), []);
    assert.deepEqual(await a.search(u.samwise!, '\\'), []);
  });

  test('friendship column is friendship_with for each row', async () => {
    await a.send(u.samwise!, u.sam!);
    await a.send(u.samantha!, u.samwise!);
    await a.send(u.bob_sam!, u.samwise!);
    await a.respond(u.samwise!, u.bob_sam!, true);
    assert.deepEqual(
      (await a.search(u.samwise!, 'sam')).map((r) => [r.username, r.friendship]),
      [
        ['sam', 'outgoing'],
        ['samantha', 'incoming'],
        ['bob_sam', 'friends'],
        ['zed', 'none'],
      ],
    );
  });

  test('a block hides each side from the other, whoever blocked', async () => {
    await a.block(u.samwise!, u.samantha!);
    await a.block(u.sam!, u.samwise!);
    assert.deepEqual(
      (await a.search(u.samwise!, 'sam')).map((r) => r.username),
      ['bob_sam', 'zed'],
    );
    assert.ok(!(await a.search(u.samantha!, 'samw')).some((r) => r.user_id === u.samwise));
    assert.ok(!(await a.search(u.sam!, 'samw')).some((r) => r.user_id === u.samwise));
    // Third parties are unaffected.
    assert.deepEqual(
      (await a.search(u.zed!, 'samw')).map((r) => r.username),
      ['samwise'],
    );
  });

  test('query must be 1..32 characters after trimming; limit is clamped to 1..50 (null = 20)', async () => {
    await assert.rejects(a.search(u.samwise!, ''), invalid);
    await assert.rejects(a.search(u.samwise!, '   '), invalid);
    await assert.rejects(a.search(u.samwise!, null as unknown as string), invalid);
    await assert.rejects(a.search(u.samwise!, 'x'.repeat(33)), invalid);
    assert.deepEqual(await a.search(u.samwise!, 'x'.repeat(32)), []);
    assert.deepEqual(await a.search(u.samwise!, ` ${'x'.repeat(32)} `), []);

    assert.equal((await a.search(u.samwise!, 'zz', 1)).length, 1);
    assert.equal((await a.search(u.samwise!, 'zz', 0)).length, 1);
    assert.equal((await a.search(u.samwise!, 'zz', -5)).length, 1);
    assert.equal((await a.search(u.samwise!, 'zz', null)).length, 20);
    const many = await a.search(u.samwise!, 'zz', 1000);
    assert.equal(many.length, 50);
    assert.deepEqual(
      many.slice(0, 3).map((r) => r.username),
      ['zz00', 'zz01', 'zz02'],
    );
  });

  test('prefix search on usernames has an index', async () => {
    const r = await db.query<{ def: string }>(
      `select indexdef as def from pg_indexes where schemaname = 'public' and indexname = 'profiles_username_prefix_idx'`,
    );
    assert.match(r.rows[0]!.def, /lower\(\(username\)::text\) text_pattern_ops/);
  });
});

describe('profile privacy: public_friends, public_profile_games, public_profile_stats', () => {
  let db: PGlite;
  let a: ReturnType<typeof api>;
  let olive: string; // the owner
  let fred: string; // olive's friend
  let fay: string; // olive's friend
  let stan: string; // stranger
  let bea: string; // blocked by olive
  let boris: string; // blocked olive
  let ghost: string; // anonymous session

  const anonFriends = (owner: string) =>
    asAnon(db, async () => (await db.query<FriendRow>(`select * from public.public_friends($1)`, [owner])).rows);
  const anonGames = (owner: string) =>
    asAnon(db, async () => (await db.query<GameRow>(`select * from public.public_profile_games($1)`, [owner])).rows);
  const ghostFriends = (owner: string) =>
    asAnonymousUser(
      db,
      ghost,
      async () => (await db.query<FriendRow>(`select * from public.public_friends($1)`, [owner])).rows,
    );

  before(async () => {
    db = await createTestDb();
    a = api(db);
    olive = await user(db, 'olive');
    fred = await user(db, 'fred');
    fay = await user(db, 'fay');
    stan = await user(db, 'stan');
    bea = await user(db, 'bea');
    boris = await user(db, 'boris');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    await a.send(fred, olive);
    await a.respond(olive, fred, true);
    await a.send(olive, fay);
    await a.respond(fay, olive, true);
    await db.query(`update public.friendships set accepted_at = now() - interval '1 day' where user_id = $1`, [fred]);
    await a.block(olive, bea);
    await a.block(boris, olive);

    await insertGame(db, 'stack');
    await insertGame(db, 'arena');
    await insertGame(db, 'secret', 'draft');
    await db.query(`update public.games set icon_url = 'https://cdn/stack.png', cover_url = 'https://cdn/stack-cover.png' where id = 'stack'`);
    await db.query(
      `insert into public.game_stats (user_id, game_id, plays, best_score, last_played_at) values
         ($1, 'stack', 3, 42.5, now() - interval '1 hour'),
         ($1, 'arena', 1, null, now()),
         ($1, 'secret', 9, 1, now())`,
      [olive],
    );
    await db.query(`insert into public.achievements (game_id, key, title) values ('stack', 'first', 'First')`);
    await db.query(
      `insert into public.user_achievements (user_id, achievement_id)
         select $1, id from public.achievements where key = 'first'`,
      [olive],
    );
  });
  after(() => db.close());

  test('privacy keys are checked: games/friends must be public, friends or private; other keys are free', async () => {
    await assert.rejects(a.setPrivacy(olive, { games: 'everyone' }), invalid);
    await assert.rejects(a.setPrivacy(olive, { friends: 1 }), invalid);
    await assert.rejects(a.setPrivacy(olive, { friends: null }), invalid);
    await assert.rejects(a.setPrivacy(olive, ['games']), invalid);
    await assert.rejects(a.setPrivacy(olive, { games: 'public', note: 'x'.repeat(3000) }), invalid);
    await a.setPrivacy(olive, { games: 'friends', friends: 'private', online: false });
    const r = await db.query<{ p: unknown }>(`select privacy as p from public.profiles where id = $1`, [olive]);
    assert.deepEqual(r.rows[0]!.p, { games: 'friends', friends: 'private', online: false });
    await a.setPrivacy(olive, {});
  });

  // presence (default 'friends') since 20261031000000_m3_phase2.sql.
  test('my_privacy: the caller\'s own settings with defaults; anonymous sessions too; signed out refused', async () => {
    const mine = (uid: string) =>
      asUser(db, uid, async () => (await db.query<{ v: unknown }>(`select public.my_privacy() as v`)).rows[0]!.v);
    assert.deepEqual(await mine(stan), { games: 'public', friends: 'public', presence: 'friends' });
    await a.setPrivacy(stan, { games: 'private' });
    assert.deepEqual(await mine(stan), { games: 'private', friends: 'public', presence: 'friends' });
    await a.setPrivacy(stan, { games: 'friends', friends: 'private', presence: 'private', online: false });
    assert.deepEqual(await mine(stan), { games: 'friends', friends: 'private', presence: 'private', online: false });
    assert.deepEqual(await mine(fred), { games: 'public', friends: 'public', presence: 'friends' }); // own row only
    await a.setPrivacy(stan, {});
    assert.deepEqual(
      await asAnonymousUser(db, ghost, async () => (await db.query<{ v: unknown }>(`select public.my_privacy() as v`)).rows[0]!.v),
      { games: 'public', friends: 'public', presence: 'friends' },
    );
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.my_privacy()`), unauthenticated);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.my_privacy()`), permissionDenied);
    });
  });

  test('default (no keys) is public: everyone but blocked users sees friends and games', async () => {
    await a.setPrivacy(olive, {});
    for (const viewer of [olive, fred, stan]) {
      assert.deepEqual(
        (await a.publicFriends(viewer, olive)).map((r) => r.username),
        ['fay', 'fred'],
        viewer,
      );
      assert.deepEqual(
        (await a.publicGames(viewer, olive)).map((r) => r.game_id),
        ['arena', 'stack'],
      );
    }
    assert.deepEqual(
      (await anonFriends(olive)).map((r) => r.username),
      ['fay', 'fred'],
    );
    assert.deepEqual(
      (await anonGames(olive)).map((r) => r.game_id),
      ['arena', 'stack'],
    );
    assert.equal((await ghostFriends(olive)).length, 2);
    // A block in either direction hides everything.
    for (const viewer of [bea, boris]) {
      assert.deepEqual(await a.publicFriends(viewer, olive), [], viewer);
      assert.deepEqual(await a.publicGames(viewer, olive), [], viewer);
    }
  });

  test("'friends': the owner and accepted friends only", async () => {
    await a.setPrivacy(olive, { games: 'friends', friends: 'friends' });
    for (const viewer of [olive, fred]) {
      assert.equal((await a.publicFriends(viewer, olive)).length, 2);
      assert.equal((await a.publicGames(viewer, olive)).length, 2);
    }
    for (const viewer of [stan, bea, boris]) {
      assert.deepEqual(await a.publicFriends(viewer, olive), []);
      assert.deepEqual(await a.publicGames(viewer, olive), []);
    }
    assert.deepEqual(await anonFriends(olive), []);
    assert.deepEqual(await anonGames(olive), []);
    assert.deepEqual(await ghostFriends(olive), []);
    // A pending request is not friendship.
    await a.send(stan, olive);
    assert.deepEqual(await a.publicFriends(stan, olive), []);
    await a.remove(stan, olive);
    await a.setPrivacy(olive, {});
  });

  test("'private': the owner only; the two keys are independent", async () => {
    await a.setPrivacy(olive, { games: 'private', friends: 'public' });
    assert.equal((await a.publicGames(olive, olive)).length, 2);
    assert.deepEqual(await a.publicGames(fred, olive), []);
    assert.deepEqual(await anonGames(olive), []);
    assert.equal((await a.publicFriends(stan, olive)).length, 2);

    await a.setPrivacy(olive, { friends: 'private' });
    assert.equal((await a.publicFriends(olive, olive)).length, 2);
    assert.deepEqual(await a.publicFriends(fred, olive), []);
    assert.deepEqual(await anonFriends(olive), []);
    assert.equal((await a.publicGames(stan, olive)).length, 2);
    await a.setPrivacy(olive, {});
  });

  test('public_friends leaves out friends who have a block with the viewer; limit', async () => {
    await a.block(stan, fay);
    assert.deepEqual(
      (await a.publicFriends(stan, olive)).map((r) => r.username),
      ['fred'],
    );
    await a.unblock(stan, fay);
    const rows = await a.publicFriends(stan, olive, 1);
    assert.deepEqual(
      rows.map((r) => [r.username, Object.keys(r).sort()]),
      [['fay', ['avatar_url', 'display_name', 'since', 'user_id', 'username']]],
    );
    assert.equal((await a.publicFriends(stan, olive, 0)).length, 1);
  });

  test('public_profile_games: published games only, most recent first, with art and stats', async () => {
    const rows = await a.publicGames(stan, olive);
    assert.deepEqual(
      rows.map((r) => ({ ...r, last_played_at: r.last_played_at !== null })),
      [
        { game_id: 'arena', title: 'arena', icon_url: null, cover_url: null, plays: 1, best_score: null, last_played_at: true },
        {
          game_id: 'stack',
          title: 'stack',
          icon_url: 'https://cdn/stack.png',
          cover_url: 'https://cdn/stack-cover.png',
          plays: 3,
          best_score: 42.5,
          last_played_at: true,
        },
      ],
    );
    assert.equal((await a.publicGames(stan, olive, 1)).length, 1);
    assert.deepEqual(await a.publicGames(stan, fred), []);
  });

  test('unknown users are NOT_FOUND, signed in or not', async () => {
    await assert.rejects(a.publicFriends(stan, NOBODY), notFound);
    await assert.rejects(a.publicGames(stan, NOBODY), notFound);
    await assert.rejects(anonFriends(NOBODY), notFound);
    await assert.rejects(anonGames(NOBODY), notFound);
  });

  test('public_profile_stats: friends count; games_played follows privacy.games (null when hidden)', async () => {
    assert.deepEqual(await a.stats(stan, olive), { achievements: 1, games_played: 3, friends: 2 });
    assert.deepEqual(await a.stats(stan, fred), { achievements: 0, games_played: 0, friends: 1 });
    assert.deepEqual(await a.stats(bea, olive), { achievements: 1, games_played: null, friends: 2 });
    await a.setPrivacy(olive, { games: 'friends' });
    assert.deepEqual(await a.stats(stan, olive), { achievements: 1, games_played: null, friends: 2 });
    assert.deepEqual(await a.stats(fred, olive), { achievements: 1, games_played: 3, friends: 2 });
    assert.deepEqual(await a.stats(olive, olive), { achievements: 1, games_played: 3, friends: 2 });
    await a.setPrivacy(olive, { games: 'private' });
    assert.deepEqual(await a.stats(fred, olive), { achievements: 1, games_played: null, friends: 2 });
    await a.setPrivacy(olive, {});
    // A pending request does not count.
    await a.send(stan, olive);
    assert.equal((await a.stats(stan, olive)).friends, 2);
    await a.remove(stan, olive);
  });
});

describe('leaderboard_top friends scope', () => {
  let db: PGlite;
  let a: ReturnType<typeof api>;
  const u: Record<string, string> = {};

  interface TopRow {
    rank: number;
    username: string;
    score: number;
    is_me: boolean;
  }
  const top = (uid: string) =>
    asUser(
      db,
      uid,
      async () =>
        (await db.query<TopRow>(`select * from public.leaderboard_top('stack', 'height', 'friends', 25)`)).rows,
    );

  before(async () => {
    db = await createTestDb();
    a = api(db);
    await insertGame(db, 'stack');
    const board = (
      await db.query<{ id: string }>(
        `insert into public.leaderboards (game_id, key, sort) values ('stack', 'height', 'desc') returning id`,
      )
    ).rows[0]!.id;
    for (const [name, score, agoS] of [
      ['ann', 10, 50],
      ['ben', 30, 40],
      ['cat', 99, 10],
      ['dan', 30, 60],
      ['eve', 50, 10],
    ] as const) {
      u[name] = await user(db, name);
      await db.query(
        `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score, updated_at)
         values ($1, 'all', $2, $3, now() - make_interval(secs => $4))`,
        [board, u[name], score, agoS],
      );
    }
    // ann <-> ben (ann asked), dan <-> ann (dan asked), cat only has a pending request, eve blocked ann.
    await a.send(u.ann!, u.ben!);
    await a.respond(u.ben!, u.ann!, true);
    await a.send(u.dan!, u.ann!);
    await a.respond(u.ann!, u.dan!, true);
    await a.send(u.cat!, u.ann!);
    await a.block(u.eve!, u.ann!);
  });
  after(() => db.close());

  test('the caller and accepted friends (either direction), ranked among themselves with shared ranks', async () => {
    assert.deepEqual(
      (await top(u.ann!)).map((r) => [r.rank, r.username, r.score, r.is_me]),
      [
        [1, 'dan', 30, false],
        [1, 'ben', 30, false],
        [3, 'ann', 10, true],
      ],
    );
    assert.deepEqual(
      (await top(u.ben!)).map((r) => [r.rank, r.username, r.is_me]),
      [
        [1, 'ben', true],
        [2, 'ann', false],
      ],
    );
    // Pending requests and blocks do not count.
    assert.deepEqual(
      (await top(u.cat!)).map((r) => r.username),
      ['cat'],
    );
    assert.deepEqual(
      (await top(u.eve!)).map((r) => r.username),
      ['eve'],
    );
  });

  test('removing a friend removes them from the board', async () => {
    await a.remove(u.ann!, u.ben!);
    assert.deepEqual(
      (await top(u.ann!)).map((r) => r.username),
      ['dan', 'ann'],
    );
    await a.send(u.ann!, u.ben!);
    await a.respond(u.ben!, u.ann!, true);
  });
});

describe('RLS and privileges', () => {
  let db: PGlite;
  let a: ReturnType<typeof api>;
  let ann: string;
  let ben: string;
  let cat: string;

  before(async () => {
    db = await createTestDb();
    a = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await a.send(ann, ben);
    await a.block(cat, ann);
  });
  after(() => db.close());

  test('users read their own friendships (either side) and the blocks they made, nothing else', async () => {
    await asUser(db, ann, async () => {
      assert.equal(await count(db, `select 1 from public.friendships`), 1);
      assert.equal(await count(db, `select 1 from public.blocks`), 0); // ann is blocked, must not see it
    });
    await asUser(db, ben, async () => {
      assert.equal(await count(db, `select 1 from public.friendships`), 1);
    });
    await asUser(db, cat, async () => {
      assert.equal(await count(db, `select 1 from public.friendships`), 0);
      const r = await db.query<{ blocked_id: string }>(`select blocked_id from public.blocks`);
      assert.deepEqual(
        r.rows.map((b) => b.blocked_id),
        [ann],
      );
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select 1 from public.friendships`), permissionDenied);
      await assert.rejects(db.query(`select 1 from public.blocks`), permissionDenied);
    });
  });

  test('clients cannot insert, update or delete friendships or blocks directly', async () => {
    await asUser(db, ben, async () => {
      await assert.rejects(
        db.query(`insert into public.friendships (user_id, friend_id) values ($1, $2)`, [ben, cat]),
        permissionDenied,
      );
      await assert.rejects(
        db.query(`update public.friendships set status = 'accepted', accepted_at = now() where friend_id = $1`, [ben]),
        permissionDenied,
      );
      await assert.rejects(db.query(`delete from public.friendships where friend_id = $1`, [ben]), permissionDenied);
      await assert.rejects(
        db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [ben, cat]),
        permissionDenied,
      );
    });
    await asUser(db, cat, async () => {
      await assert.rejects(db.query(`delete from public.blocks where blocker_id = $1`, [cat]), permissionDenied);
      await assert.rejects(db.query(`update public.blocks set created_at = now()`), permissionDenied);
    });
    assert.deepEqual(await pairRows(db, ann, ben), [{ user_id: ann, friend_id: ben, status: 'pending', accepted: false }]);
    assert.equal(await count(db, `select 1 from public.blocks`), 1);
    for (const t of ['friendships', 'blocks']) {
      for (const priv of ['insert', 'update', 'delete']) {
        const r = await db.query<{ ok: boolean }>(
          `select has_table_privilege('authenticated', $1, $2) or has_table_privilege('anon', $1, $2) as ok`,
          [`public.${t}`, priv],
        );
        assert.equal(r.rows[0]!.ok, false, `${t} ${priv}`);
      }
    }
  });

  test('function privileges: friendship_with, public_friends, public_profile_games are callable signed out', async () => {
    const fns = [
      ['public.friendship_with(uuid)', true],
      ['public.public_friends(uuid, int)', true],
      ['public.public_profile_games(uuid, int)', true],
      ['public.search_profiles(text, int)', false],
      ['public.send_friend_request(uuid)', false],
      ['public.respond_friend_request(uuid, boolean)', false],
      ['public.remove_friend(uuid)', false],
      ['public.block_user(uuid)', false],
      ['public.unblock_user(uuid)', false],
      ['public.my_friends(int)', false],
      ['public.my_friend_requests()', false],
      ['public.my_privacy()', false],
      ['public.public_profile_stats(uuid)', false],
      ['public.leaderboard_top(text, text, text, int)', true],
    ] as const;
    for (const [fn, anon] of fns) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon, auth: true, svc: true }, fn);
    }
    const trigger = await db.query<{ ok: boolean }>(
      `select has_function_privilege('authenticated', 'public.profiles_validate_privacy()', 'execute')
           or has_function_privilege('anon', 'public.profiles_validate_privacy()', 'execute') as ok`,
    );
    assert.equal(trigger.rows[0]!.ok, false);
  });

  test('internal helpers in schema private are not reachable by clients', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(`select has_schema_privilege($1, 'private', 'usage') as ok`, [role]);
      assert.equal(r.rows[0]!.ok, false, role);
    }
    await asUser(db, ann, async () => {
      await assert.rejects(db.query(`select private.is_blocked($1, $2)`, [ann, cat]), permissionDenied);
    });
  });
});
