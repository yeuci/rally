// 20261107000100_messages.sql: direct messages between friends and party chat (docs/social-phase.md §1). Who may open
// a dm and send (membership, friends only, blocks, MUTED, FILTERED, the rate limit), the conversation list with its
// unread counts and mutes, the thread with its pages and deleted messages, delete_message, unread_total, report_user
// with a message, the realtime events (stubbed realtime.send, as social-realtime.test.ts), privileges and retention.
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

const MIGRATION = readFileSync(new URL('../supabase/migrations/20261107000100_messages.sql', import.meta.url), 'utf8');
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
const noConversation = sqlstate('P0002', /^NOT_FOUND: conversation$/);
const invalid = sqlstate('22023', /^INVALID/);
const muted = sqlstate('42501', /^MUTED/);
const filtered = sqlstate('22023', /^FILTERED/);
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

interface SentMessage {
  id: string;
  conversation_id: string;
  body: string;
  created_at: string;
}
interface ConversationRow {
  conversation_id: string;
  kind: string;
  party_id: string | null;
  other_user_id: string | null;
  other_username: string | null;
  other_display_name: string | null;
  other_avatar_url: string | null;
  last_message_id: string | null;
  last_sender_id: string | null;
  last_body: string | null;
  last_at: Date | null;
  unread: number;
  muted: boolean;
}
interface ThreadRow {
  id: string;
  sender_id: string | null;
  body: string;
  created_at: Date;
  deleted: boolean;
}

const api = (db: PGlite) => ({
  openDm: (uid: string, other: string) =>
    asUser(
      db,
      uid,
      async () => (await db.query<{ id: string }>(`select public.open_dm($1) as id`, [other])).rows[0]!.id,
    ),
  send: (uid: string, conversation: string, body: string | null) =>
    asUser(
      db,
      uid,
      async () =>
        (await db.query<{ m: SentMessage }>(`select public.send_message($1, $2) as m`, [conversation, body])).rows[0]!
          .m,
    ),
  conversations: (uid: string, limit?: number) =>
    asUser(
      db,
      uid,
      async () =>
        (
          await db.query<ConversationRow>(
            limit === undefined
              ? `select * from public.my_conversations()`
              : `select * from public.my_conversations($1)`,
            limit === undefined ? [] : [limit],
          )
        ).rows,
    ),
  thread: (uid: string, conversation: string, before: Date | string | null = null, limit: number | null = null) =>
    asUser(
      db,
      uid,
      async () =>
        (
          await db.query<ThreadRow>(`select * from public.conversation_messages($1, $2, $3)`, [
            conversation,
            before,
            limit,
          ])
        ).rows,
    ),
  markRead: (uid: string, conversation: string) =>
    asUser(db, uid, () => db.query(`select public.mark_conversation_read($1)`, [conversation])),
  setMuted: (uid: string, conversation: string, value: boolean | null) =>
    asUser(db, uid, () => db.query(`select public.set_conversation_muted($1, $2)`, [conversation, value])),
  deleteMessage: (uid: string, id: string) => asUser(db, uid, () => db.query(`select public.delete_message($1)`, [id])),
  unread: (uid: string) =>
    asUser(db, uid, async () => (await db.query<{ n: number }>(`select public.unread_total() as n`)).rows[0]!.n),
  /** A party of `members` (the first one leads), through the party RPCs of 20261107000200; returns the party. */
  party: async (members: string[]) => {
    const [leader, ...rest] = members;
    const party = await asUser(
      db,
      leader!,
      async () =>
        (await db.query<{ p: { id: string; conversation_id: string } }>(`select public.create_party() as p`)).rows[0]!
          .p,
    );
    for (const m of rest) {
      const invite = await asUser(
        db,
        leader!,
        async () => (await db.query<{ id: string }>(`select public.invite_to_party($1) as id`, [m])).rows[0]!.id,
      );
      await asUser(db, m, () => db.query(`select public.respond_invite($1, true)`, [invite]));
    }
    return party;
  },
});

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

// ---------------------------------------------------------------------------------------------------------------
// Privileges
// ---------------------------------------------------------------------------------------------------------------

describe('messages: privileges', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    await befriend(db, ann, ben);
  });
  after(() => db.close());

  test('the four tables have RLS and no client access; service_role has all', async () => {
    for (const t of ['conversations', 'conversation_members', 'dm_pairs', 'messages']) {
      const r = await db.query<{ rls: boolean; anon: boolean; auth: boolean; svc: boolean }>(
        `select relrowsecurity as rls,
                has_table_privilege('anon', $1, 'select') as anon,
                has_table_privilege('authenticated', $1, 'select') as auth,
                has_table_privilege('service_role', $1, 'select, insert, update, delete') as svc
           from pg_class where oid = $1::regclass`,
        [`public.${t}`],
      );
      assert.deepEqual(r.rows[0], { rls: true, anon: false, auth: false, svc: true }, t);
      assert.equal(
        (await db.query(`select 1 from pg_policies where schemaname = 'public' and tablename = $1`, [t])).rows.length,
        0,
        `${t} has policies`,
      );
      for (const as of [asAnon, asService] as const) {
        if (as === asAnon)
          await assert.rejects(
            as(db, () => db.query(`select * from public.${t}`)),
            permissionDenied,
          );
        else await as(db, () => db.query(`select * from public.${t}`));
      }
    }
    // Realtime: the tables are not published and the trigger function is private.
    assert.equal(
      (await db.query(`select 1 from pg_publication_tables where tablename in ('messages', 'conversations')`)).rows
        .length,
      0,
    );
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'private.broadcast_message()', 'execute') as ok`,
        [role],
      );
      assert.equal(r.rows[0]?.ok, false, role);
    }
  });

  test('RPCs: authenticated and service_role only; linked accounts only; definer functions pin search_path', async () => {
    const fns = [
      'public.open_dm(uuid)',
      'public.send_message(uuid, text)',
      'public.my_conversations(int)',
      'public.conversation_messages(uuid, timestamptz, int)',
      'public.mark_conversation_read(uuid)',
      'public.set_conversation_muted(uuid, boolean)',
      'public.delete_message(uuid)',
      'public.unread_total()',
      'public.report_user(uuid, text, text, text, text, uuid)',
    ];
    for (const fn of fns) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc, has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon: false, auth: true, svc: true, pub: false }, fn);
    }
    // The old five-argument report_user is gone (one signature, so PostgREST resolves calls without ambiguity).
    assert.equal(await count(db, `select 1 from pg_proc where proname = 'report_user'`), 1);
    const loose = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p where p.prosecdef
          and p.proname in ('open_dm', 'send_message', 'my_conversations', 'conversation_messages', 'mark_conversation_read',
                            'set_conversation_muted', 'delete_message', 'unread_total', 'report_user')
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    assert.deepEqual(loose.rows, []);

    const calls: [string, unknown[]][] = [
      [`select public.open_dm($1)`, [ben]],
      [`select public.send_message($1, 'hi')`, [NOBODY]],
      [`select * from public.my_conversations()`, []],
      [`select * from public.conversation_messages($1)`, [NOBODY]],
      [`select public.mark_conversation_read($1)`, [NOBODY]],
      [`select public.set_conversation_muted($1, true)`, [NOBODY]],
      [`select public.delete_message($1)`, [NOBODY]],
      [`select public.unread_total()`, []],
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
      // Role authenticated without a sub claim (no user): UNAUTHENTICATED.
      await assert.rejects(
        asRole(db, 'authenticated', () => db.query(sql, params)),
        unauthenticated,
        sql,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// open_dm and send_message
// ---------------------------------------------------------------------------------------------------------------

describe('open_dm', () => {
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
  });
  beforeEach(() =>
    db.exec(`delete from public.conversations; delete from public.friendships; delete from public.blocks;`),
  );
  after(() => db.close());

  test('friends only: strangers, pending requests, blocks (either way), yourself and unknown ids are NOT_FOUND', async () => {
    await assert.rejects(rpc.openDm(ann, ben), noSuchFriend);
    await asUser(db, ann, () => db.query(`select public.send_friend_request($1)`, [ben]));
    await assert.rejects(rpc.openDm(ann, ben), noSuchFriend);
    await assert.rejects(rpc.openDm(ben, ann), noSuchFriend);
    await assert.rejects(rpc.openDm(ann, ann), noSuchFriend);
    await assert.rejects(rpc.openDm(ann, NOBODY), noSuchFriend);
    await assert.rejects(rpc.openDm(ann, null as unknown as string), noSuchFriend);
    assert.equal(await count(db, `select 1 from public.conversations`), 0);
    // A block removes the friendship and hides itself behind the same message.
    await db.exec(`delete from public.friendships`);
    await befriend(db, ann, ben);
    await block(db, ben, ann);
    await assert.rejects(rpc.openDm(ann, ben), noSuchFriend);
    await assert.rejects(rpc.openDm(ben, ann), noSuchFriend);
    // Friendship rows written while a block exists (not possible through the RPCs) still count as blocked.
    await befriend(db, ann, ben);
    await assert.rejects(rpc.openDm(ann, ben), noSuchFriend);
  });

  test('creates the conversation, the pair row and both memberships once; the same id from both sides', async () => {
    await befriend(db, ann, ben);
    const id = await rpc.openDm(ann, ben);
    assert.equal(await rpc.openDm(ann, ben), id);
    assert.equal(await rpc.openDm(ben, ann), id);
    const c = await db.query<{ kind: string; party_id: string | null; last_message_at: string | null }>(
      `select kind, party_id, last_message_at from public.conversations where id = $1`,
      [id],
    );
    assert.deepEqual(c.rows, [{ kind: 'dm', party_id: null, last_message_at: null }]);
    const pair = await db.query<{ user_a: string; user_b: string }>(
      `select user_a, user_b from public.dm_pairs where conversation_id = $1`,
      [id],
    );
    assert.deepEqual(pair.rows, [{ user_a: [ann, ben].sort()[0], user_b: [ann, ben].sort()[1] }]);
    const members = await db.query<{ user_id: string; muted: boolean }>(
      `select user_id, muted from public.conversation_members where conversation_id = $1 order by user_id`,
      [id],
    );
    assert.deepEqual(
      members.rows,
      [ann, ben].sort().map((u) => ({ user_id: u, muted: false })),
    );
    // Another friend gets another thread.
    await befriend(db, cat, ann);
    assert.notEqual(await rpc.openDm(cat, ann), id);
    assert.equal(await count(db, `select 1 from public.conversations`), 2);
  });
});

describe('send_message', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dm: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await db.exec(`insert into public.banned_words (word) values ('jerk'), ('kill yourself')`);
  });
  beforeEach(async () => {
    await db.exec(`delete from public.conversations; delete from public.friendships; delete from public.blocks;
                   delete from public.rate_limits; delete from public.user_sanctions; delete from public.parties;`);
    await befriend(db, ann, ben);
    dm = await rpc.openDm(ann, ben);
  });
  after(() => db.close());

  test('stores the trimmed body and returns {id, conversation_id, body, created_at}; bumps the thread and the read cursor', async () => {
    const before = await db.query<{ last_read_at: string }>(
      `select last_read_at from public.conversation_members where conversation_id = $1 and user_id = $2`,
      [dm, ann],
    );
    await db.query(
      `update public.conversation_members set last_read_at = now() - interval '1 hour' where user_id = $1`,
      [ann],
    );
    const m = await rpc.send(ann, dm, '  hello ben \n');
    assert.deepEqual(Object.keys(m).sort(), ['body', 'conversation_id', 'created_at', 'id']);
    assert.equal(m.body, 'hello ben');
    assert.equal(m.conversation_id, dm);
    assert.ok(Math.abs(Date.parse(m.created_at) - Date.now()) < 60_000);
    const row = await db.query<{ sender_id: string; body: string; deleted_at: string | null; created_at: Date }>(
      `select sender_id, body, deleted_at, created_at from public.messages where id = $1`,
      [m.id],
    );
    assert.equal(row.rows[0]?.sender_id, ann);
    assert.equal(row.rows[0]?.body, 'hello ben');
    assert.equal(row.rows[0]?.deleted_at, null);
    const c = await db.query<{ last_message_at: Date }>(
      `select last_message_at from public.conversations where id = $1`,
      [dm],
    );
    assert.equal(c.rows[0]!.last_message_at.getTime(), row.rows[0]!.created_at.getTime());
    const cursor = await db.query<{ last_read_at: Date }>(
      `select last_read_at from public.conversation_members where conversation_id = $1 and user_id = $2`,
      [dm, ann],
    );
    assert.equal(cursor.rows[0]!.last_read_at.getTime(), row.rows[0]!.created_at.getTime());
    assert.ok(before.rows[0]);
  });

  test('INVALID: empty, blank or over 1000 characters after trimming; exactly 1000 is fine', async () => {
    for (const body of [null, '', '   ', '\n\t ', 'x'.repeat(1001), ' ' + 'x'.repeat(1001) + ' ']) {
      await assert.rejects(rpc.send(ann, dm, body), invalid, JSON.stringify(body));
    }
    const ok = await rpc.send(ann, dm, ' ' + 'x'.repeat(1000) + ' ');
    assert.equal(ok.body.length, 1000);
    assert.equal(await count(db, `select 1 from public.messages`), 1);
  });

  test('NOT_FOUND for a thread the caller is not in, or that does not exist', async () => {
    await assert.rejects(rpc.send(cat, dm, 'hi'), noConversation);
    await assert.rejects(rpc.send(ann, NOBODY, 'hi'), noConversation);
    await assert.rejects(rpc.send(ann, null as unknown as string, 'hi'), noConversation);
  });

  test('a dm needs the two to still be friends with no block either way (same NOT_FOUND)', async () => {
    await rpc.send(ann, dm, 'first');
    await asUser(db, ben, () => db.query(`select public.remove_friend($1)`, [ann]));
    await assert.rejects(rpc.send(ann, dm, 'second'), noConversation);
    await assert.rejects(rpc.send(ben, dm, 'second'), noConversation);
    await befriend(db, ann, ben);
    await rpc.send(ann, dm, 'friends again');
    await block(db, ann, ben); // removes the friendship too
    await befriend(db, ann, ben); // put back by hand: the block alone must refuse
    await assert.rejects(rpc.send(ann, dm, 'blocked'), noConversation);
    await assert.rejects(rpc.send(ben, dm, 'blocked'), noConversation);
    await asUser(db, ann, () => db.query(`select public.unblock_user($1)`, [ben]));
    await rpc.send(ben, dm, 'ok');
    assert.equal(await count(db, `select 1 from public.messages`), 3);
  });

  test('party chat needs membership only (no friendship between every pair)', async () => {
    await befriend(db, ann, cat);
    const party = await rpc.party([ann, ben, cat]); // ben and cat are not friends
    await rpc.send(ben, party.conversation_id, 'hi all');
    await rpc.send(cat, party.conversation_id, 'hey');
    await asUser(db, cat, () => db.query(`select public.leave_party()`));
    await assert.rejects(rpc.send(cat, party.conversation_id, 'still here?'), noConversation);
  });

  test('MUTED while a mute sanction is active; expired and revoked mutes do not count; bans are not mutes', async () => {
    await db.query(
      `insert into public.user_sanctions (user_id, kind, reason, expires_at) values ($1, 'mute', 'spam', now() + interval '1 hour')`,
      [ann],
    );
    await assert.rejects(rpc.send(ann, dm, 'hi'), muted);
    await rpc.send(ben, dm, 'ben can talk');
    await db.query(`update public.user_sanctions set revoked_at = now() where user_id = $1`, [ann]);
    await rpc.send(ann, dm, 'revoked');
    await db.query(
      `insert into public.user_sanctions (user_id, kind, reason, expires_at) values ($1, 'mute', 'spam', now() - interval '1 second')`,
      [ann],
    );
    await rpc.send(ann, dm, 'expired');
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'mute', 'forever')`, [ann]);
    await assert.rejects(rpc.send(ann, dm, 'permanent'), muted);
    await db.exec(`delete from public.user_sanctions`);
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'x')`, [ann]);
    await rpc.send(ann, dm, 'banned but not muted'); // bans are enforced by heartbeat and the game server
    assert.equal(await count(db, `select 1 from public.messages`), 4);
  });

  test('FILTERED when the body contains a banned word (whole words, any case); nothing is stored', async () => {
    for (const body of ['you jerk', 'JERK!', 'please kill yourself now']) {
      await assert.rejects(rpc.send(ann, dm, body), filtered, body);
    }
    await rpc.send(ann, dm, 'jerky chicken'); // not a whole word
    assert.equal(await count(db, `select 1 from public.messages`), 1);
  });

  test('RATE_LIMITED past 30 messages in a burst; the bucket refills', async () => {
    for (let i = 0; i < 30; i++) await rpc.send(ann, dm, `m${i}`);
    await assert.rejects(rpc.send(ann, dm, 'one too many'), rateLimited);
    await rpc.send(ben, dm, 'ben has his own bucket');
    // 4 s of refill at 0.5/s = 2 tokens.
    await db.query(
      `update public.rate_limits set refilled_at = refilled_at - interval '4 seconds' where user_id = $1`,
      [ann],
    );
    await rpc.send(ann, dm, 'after a pause');
    await rpc.send(ann, dm, 'and another');
    await assert.rejects(rpc.send(ann, dm, 'third'), rateLimited);
    assert.equal(await count(db, `select 1 from public.messages`), 33);
  });

  test('checks run in the contract order: membership, friendship, mute, filter, rate limit', async () => {
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'mute', 'x')`, [cat]);
    await assert.rejects(rpc.send(cat, dm, 'jerk'), noConversation); // not a member: before the mute
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'mute', 'x')`, [ann]);
    await assert.rejects(rpc.send(ann, dm, 'jerk'), muted); // muted: before the filter
    await db.exec(`delete from public.user_sanctions`);
    for (let i = 0; i < 30; i++) await rpc.send(ann, dm, `m${i}`);
    await assert.rejects(rpc.send(ann, dm, 'jerk'), filtered); // filtered: before the rate limit (no token taken)
    await assert.rejects(rpc.send(ann, dm, 'fine'), rateLimited);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Reads: my_conversations, conversation_messages, unread_total; mark read, mute, delete
// ---------------------------------------------------------------------------------------------------------------

describe('conversations, threads and unread counts', () => {
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
      `update public.profiles set display_name = 'Ben B', avatar_url = 'defaults/avatar-01.webp' where id = $1`,
      [ben],
    );
  });
  beforeEach(async () => {
    await db.exec(`delete from public.parties; delete from public.conversations; delete from public.friendships;
                   delete from public.blocks; delete from public.rate_limits;`);
    await befriend(db, ann, ben);
    await befriend(db, ann, cat);
    await befriend(db, ann, dan);
  });
  after(() => db.close());

  test('my_conversations: the other person, the last message, unread and muted; newest activity first', async () => {
    const withBen = await rpc.openDm(ann, ben);
    const withCat = await rpc.openDm(cat, ann);
    assert.deepEqual(await rpc.conversations(dan), []);
    // Empty threads: ordered by creation, last_* null.
    let rows = await rpc.conversations(ann);
    assert.deepEqual(
      rows.map((r) => r.conversation_id),
      [withCat, withBen],
    );
    assert.deepEqual(rows[1], {
      conversation_id: withBen,
      kind: 'dm',
      party_id: null,
      other_user_id: ben,
      other_username: 'ben',
      other_display_name: 'Ben B',
      other_avatar_url: 'defaults/avatar-01.webp',
      last_message_id: null,
      last_sender_id: null,
      last_body: null,
      last_at: null,
      unread: 0,
      muted: false,
    });
    // A message moves its thread to the top; the sender has nothing unread, the recipient one.
    const m1 = await rpc.send(ben, withBen, 'hi ann');
    rows = await rpc.conversations(ann);
    assert.deepEqual(
      rows.map((r) => [r.conversation_id, r.last_message_id, r.last_sender_id, r.last_body, r.unread]),
      [
        [withBen, m1.id, ben, 'hi ann', 1],
        [withCat, null, null, null, 0],
      ],
    );
    assert.equal(rows[0]!.last_at!.getTime(), Date.parse(m1.created_at));
    assert.deepEqual(
      (await rpc.conversations(ben)).map((r) => [r.conversation_id, r.other_user_id, r.unread]),
      [[withBen, ann, 0]],
    );
    // Reading, then more messages; a muted thread still lists with its count.
    await rpc.markRead(ann, withBen);
    await rpc.send(ben, withBen, 'two');
    await rpc.send(ben, withBen, 'three');
    await rpc.send(cat, withCat, 'cat here');
    await rpc.setMuted(ann, withBen, true);
    rows = await rpc.conversations(ann);
    assert.deepEqual(
      rows.map((r) => [r.conversation_id, r.last_body, r.unread, r.muted]),
      [
        [withCat, 'cat here', 1, false],
        [withBen, 'three', 2, true],
      ],
    );
    assert.equal(await rpc.unread(ann), 1); // the muted thread is not counted
    await rpc.setMuted(ann, withBen, false);
    assert.equal(await rpc.unread(ann), 3);
    // Your own message resets your count (the cursor moves with it) and does not count for you.
    await rpc.send(ann, withBen, 'reply');
    assert.deepEqual(
      (await rpc.conversations(ann)).map((r) => [r.conversation_id, r.last_body, r.unread]),
      [
        [withBen, 'reply', 0],
        [withCat, 'cat here', 1],
      ],
    );
    assert.equal(await rpc.unread(ben), 1);
    // p_limit is clamped to 1..200.
    assert.equal((await rpc.conversations(ann, 1)).length, 1);
    assert.equal((await rpc.conversations(ann, 0)).length, 1);
    assert.equal((await rpc.conversations(ann, 500)).length, 2);
  });

  test('a dm hidden by a block (either way) is dropped from the list and the badge; a gone account too', async () => {
    const withBen = await rpc.openDm(ann, ben);
    const withCat = await rpc.openDm(ann, cat);
    await rpc.send(ben, withBen, 'hi');
    await rpc.send(cat, withCat, 'hi');
    assert.equal(await rpc.unread(ann), 2);
    await block(db, ann, ben);
    assert.deepEqual(
      (await rpc.conversations(ann)).map((r) => r.conversation_id),
      [withCat],
    );
    assert.deepEqual(await rpc.conversations(ben), []);
    assert.equal(await rpc.unread(ann), 1);
    assert.equal(await rpc.unread(ben), 0);
    await asUser(db, ann, () => db.query(`select public.unblock_user($1)`, [ben]));
    assert.equal((await rpc.conversations(ann)).length, 2);
    await block(db, ben, ann);
    assert.deepEqual(
      (await rpc.conversations(ann)).map((r) => r.conversation_id),
      [withCat],
    );
    await db.query(`delete from auth.users where id = $1`, [cat]); // the account is gone: so is the thread, for ann
    assert.deepEqual(await rpc.conversations(ann), []);
    assert.equal(await rpc.unread(ann), 0);
    cat = await user(db, 'cat');
  });

  test('party chat lists with null other_* columns; a blocked member is hidden from the thread and the counts', async () => {
    const party = await rpc.party([ann, ben, cat]);
    const rows = await rpc.conversations(cat);
    assert.deepEqual(
      rows.map((r) => [r.kind, r.party_id, r.conversation_id, r.other_user_id, r.other_username]),
      [['party', party.id, party.conversation_id, null, null]],
    );
    await rpc.send(ben, party.conversation_id, 'ben says hi');
    await rpc.send(ann, party.conversation_id, 'ann says hi');
    assert.equal(await rpc.unread(cat), 2);
    await block(db, cat, ben); // cat blocks a party member: ben's messages vanish for cat only
    assert.deepEqual(
      (await rpc.thread(cat, party.conversation_id)).map((m) => m.body),
      ['ann says hi'],
    );
    assert.deepEqual(
      (await rpc.thread(ann, party.conversation_id)).map((m) => m.body),
      ['ann says hi', 'ben says hi'],
    );
    assert.equal(await rpc.unread(cat), 1);
    assert.deepEqual(
      (await rpc.conversations(cat)).map((r) => [r.last_body, r.unread]),
      [['ann says hi', 1]],
    );
    await rpc.send(ben, party.conversation_id, 'latest');
    assert.deepEqual(
      (await rpc.conversations(cat)).map((r) => [r.last_body, r.unread]),
      [['ann says hi', 1]],
    );
    assert.deepEqual(
      (await rpc.conversations(ann)).map((r) => [r.last_body, r.unread]),
      [['latest', 1]], // ann's own message moved her cursor past ben's first one
    );
    // Party chat is still sendable by the blocked member (membership is the rule there).
    await rpc.send(ben, party.conversation_id, 'can still talk');
  });

  test('conversation_messages: newest first, keyset on p_before, p_limit clamped to 1..100, members only', async () => {
    const dm = await rpc.openDm(ann, ben);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await rpc.send(i % 2 ? ben : ann, dm, `m${i}`);
      ids.push(m.id);
      await db.query(`update public.messages set created_at = now() - make_interval(mins => $2) where id = $1`, [
        m.id,
        10 - i,
      ]);
    }
    let page = await rpc.thread(ann, dm);
    assert.deepEqual(
      page.map((m) => m.body),
      ['m4', 'm3', 'm2', 'm1', 'm0'],
    );
    assert.deepEqual(page[0], {
      id: ids[4]!,
      sender_id: ann,
      body: 'm4',
      created_at: page[0]!.created_at,
      deleted: false,
    });
    page = await rpc.thread(ann, dm, null, 2);
    assert.deepEqual(
      page.map((m) => m.body),
      ['m4', 'm3'],
    );
    page = await rpc.thread(ann, dm, page[1]!.created_at, 2);
    assert.deepEqual(
      page.map((m) => m.body),
      ['m2', 'm1'],
    );
    page = await rpc.thread(ann, dm, page[1]!.created_at, 2);
    assert.deepEqual(
      page.map((m) => m.body),
      ['m0'],
    );
    assert.equal((await rpc.thread(ann, dm, null, 0)).length, 1);
    assert.equal((await rpc.thread(ann, dm, null, -5)).length, 1);
    for (let i = 5; i < 120; i++)
      await db.query(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, $3)`, [
        dm,
        ann,
        `m${i}`,
      ]);
    assert.equal((await rpc.thread(ann, dm, null, 1000)).length, 100);
    assert.equal((await rpc.thread(ben, dm, null, null)).length, 50);
    await assert.rejects(rpc.thread(cat, dm), noConversation);
    await assert.rejects(rpc.thread(ann, NOBODY), noConversation);
  });

  test("delete_message: sender only; the row stays with body '' and deleted = true; not counted as unread", async () => {
    const dm = await rpc.openDm(ann, ben);
    const m = await rpc.send(ann, dm, 'oops');
    const m2 = await rpc.send(ann, dm, 'keep');
    await assert.rejects(rpc.deleteMessage(ben, m.id), notFound);
    await assert.rejects(rpc.deleteMessage(ann, NOBODY), notFound);
    assert.equal(await rpc.unread(ben), 2);
    await rpc.deleteMessage(ann, m.id);
    const row = await db.query<{ body: string; deleted_at: string | null }>(
      `select body, deleted_at from public.messages where id = $1`,
      [m.id],
    );
    assert.equal(row.rows[0]?.body, '');
    assert.notEqual(row.rows[0]?.deleted_at, null);
    assert.deepEqual(
      (await rpc.thread(ben, dm)).map((x) => [x.id, x.body, x.deleted]),
      [
        [m2.id, 'keep', false],
        [m.id, '', true],
      ],
    );
    assert.equal(await rpc.unread(ben), 1);
    // The newest message deleted: the list shows '' for it.
    await rpc.deleteMessage(ann, m2.id);
    assert.deepEqual(
      (await rpc.conversations(ben)).map((r) => [r.last_message_id, r.last_body, r.unread]),
      [[m2.id, '', 0]],
    );
    // Deleting again is a no-op (same deleted_at).
    const at = (row.rows[0]!.deleted_at as unknown as Date).getTime();
    await rpc.deleteMessage(ann, m.id);
    const again = await db.query<{ deleted_at: Date }>(`select deleted_at from public.messages where id = $1`, [m.id]);
    assert.equal(again.rows[0]!.deleted_at.getTime(), at);
  });

  test('mark_conversation_read and set_conversation_muted: members only; muted must be a boolean', async () => {
    const dm = await rpc.openDm(ann, ben);
    await assert.rejects(rpc.markRead(cat, dm), noConversation);
    await assert.rejects(rpc.setMuted(cat, dm, true), noConversation);
    await assert.rejects(rpc.markRead(ann, NOBODY), noConversation);
    await assert.rejects(rpc.setMuted(ann, dm, null), invalid);
    await rpc.send(ben, dm, 'a');
    await rpc.send(ben, dm, 'b');
    assert.equal(await rpc.unread(ann), 2);
    await rpc.markRead(ann, dm);
    assert.equal(await rpc.unread(ann), 0);
    assert.equal((await rpc.conversations(ann))[0]!.unread, 0);
    await rpc.send(ben, dm, 'c');
    assert.equal(await rpc.unread(ann), 1);
    await rpc.setMuted(ann, dm, true);
    assert.equal((await rpc.conversations(ann))[0]!.muted, true);
    assert.equal(await rpc.unread(ann), 0);
    assert.equal(await rpc.unread(ben), 0); // ben's own view is untouched
  });
});

// ---------------------------------------------------------------------------------------------------------------
// report_user with a message
// ---------------------------------------------------------------------------------------------------------------

describe('report_user(p_message_id)', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dm: string;
  let rpc: ReturnType<typeof api>;
  before(async () => {
    db = await createTestDb();
    rpc = api(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await insertGame(db, 'sumo');
    await befriend(db, ann, ben);
    dm = await rpc.openDm(ann, ben);
  });
  beforeEach(() => db.exec(`delete from public.reports; delete from public.rate_limits;`));
  after(() => db.close());

  const report = (uid: string, target: string, messageId: string | null, extra: unknown[] = [null, null, null]) =>
    asUser(db, uid, () =>
      db.query(`select public.report_user($1, 'harassment', $3, $4, $5, $2)`, [target, messageId, ...extra]),
    );
  const snapshots = async () =>
    (
      await db.query<{ message_snapshot: unknown; game_id: string | null }>(
        `select message_snapshot, game_id from public.reports`,
      )
    ).rows;

  test('snapshots {id, body, conversation_id} of a message in a thread the caller is in, sent by the target', async () => {
    const m = await rpc.send(ben, dm, 'rude');
    await report(ann, ben, m.id, ['note', 'sumo', 'r1']);
    assert.deepEqual(await snapshots(), [
      { message_snapshot: { id: m.id, body: 'rude', conversation_id: dm }, game_id: 'sumo' },
    ]);
    // A repeat within the day keeps the first snapshot unless a message is given now.
    await report(ann, ben, null);
    assert.deepEqual((await snapshots())[0]!.message_snapshot, { id: m.id, body: 'rude', conversation_id: dm });
    const m2 = await rpc.send(ben, dm, 'ruder');
    await report(ann, ben, m2.id);
    assert.equal(await count(db, `select 1 from public.reports`), 1);
    assert.deepEqual((await snapshots())[0]!.message_snapshot, { id: m2.id, body: 'ruder', conversation_id: dm });
    // A deleted message is still reportable (the reporter saw it): body '' in the snapshot.
    await db.exec(`delete from public.reports`);
    await rpc.deleteMessage(ben, m2.id);
    await report(ann, ben, m2.id);
    assert.deepEqual((await snapshots())[0]!.message_snapshot, { id: m2.id, body: '', conversation_id: dm });
  });

  test('without a message the column is null and the old five-argument calls still work', async () => {
    await asUser(db, ann, () => db.query(`select public.report_user($1, 'spam', 'note', 'sumo', 'r1')`, [ben]));
    await asUser(db, ann, () => db.query(`select public.report_user($1, 'spam')`, [cat]));
    assert.deepEqual(
      (await db.query(`select target_id, message_snapshot from public.reports order by created_at`)).rows,
      [
        { target_id: ben, message_snapshot: null },
        { target_id: cat, message_snapshot: null },
      ],
    );
  });

  test('NOT_FOUND for a message the caller cannot see; INVALID when the target did not send it; after the rate limit', async () => {
    const m = await rpc.send(ben, dm, 'hello');
    await assert.rejects(report(cat, ben, m.id), notFound); // cat is not in the thread
    await assert.rejects(report(ann, ben, NOBODY), notFound);
    await assert.rejects(report(ann, cat, m.id), invalid); // ben sent it, not cat
    await assert.rejects(report(ben, ann, m.id), invalid); // your own message is not the target's
    assert.equal(await count(db, `select 1 from public.reports`), 0);
    // The token is taken before the message is looked up: probing message ids costs the same as reporting.
    for (let i = 0; i < 10; i++) await report(ann, cat, null);
    await assert.rejects(report(ann, ben, NOBODY), rateLimited);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------------------------------------------

describe('messages: realtime events', () => {
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
  });
  beforeEach(async () => {
    await db.exec(`delete from public.parties; delete from public.conversations; delete from public.rate_limits;`);
    await stubSend(db);
    await db.exec(`truncate pg_temp.sent`);
  });
  after(() => db.close());

  const dmEvent = (
    to: string,
    type: string,
    m: { id: string; conversation_id: string },
    sender: string,
    body: string,
  ): Sent => ({
    topic: `user:${to}`,
    event: 'dm',
    private: true,
    payload: { type, conversation_id: m.conversation_id, message_id: m.id, sender_id: sender, body },
  });

  test("a dm goes to the other member only, event dm, with the body; deleting it sends message_deleted with ''", async () => {
    const dm = await rpc.openDm(ann, ben);
    assert.deepEqual(await take(db), []); // opening a thread sends nothing
    const m = await rpc.send(ann, dm, 'hi ben');
    assert.deepEqual(await take(db), [dmEvent(ben, 'message', m, ann, 'hi ben')]);
    const m2 = await rpc.send(ben, dm, 'hi ann');
    assert.deepEqual(await take(db), [dmEvent(ann, 'message', m2, ben, 'hi ann')]);
    await rpc.deleteMessage(ann, m.id);
    assert.deepEqual(await take(db), [dmEvent(ben, 'message_deleted', m, ann, '')]);
    await rpc.deleteMessage(ann, m.id); // already deleted: nothing
    await rpc.markRead(ben, dm);
    await rpc.setMuted(ben, dm, true);
    await db.query(`update public.messages set created_at = created_at - interval '1 minute'`); // other updates: nothing
    assert.deepEqual(await take(db), []);
  });

  test('party chat goes to party:<id>, event party, for the whole party', async () => {
    const party = await rpc.party([ann, ben, cat]);
    await db.exec(`truncate pg_temp.sent`); // the party events are parties.test.ts's
    const m = await rpc.send(cat, party.conversation_id, 'hello party');
    assert.deepEqual(await take(db), [
      {
        topic: `party:${party.id}`,
        event: 'party',
        private: true,
        payload: {
          type: 'message',
          conversation_id: party.conversation_id,
          message_id: m.id,
          sender_id: cat,
          body: 'hello party',
        },
      },
    ]);
    await rpc.deleteMessage(cat, m.id);
    assert.deepEqual(await take(db), [
      {
        topic: `party:${party.id}`,
        event: 'party',
        private: true,
        payload: {
          type: 'message_deleted',
          conversation_id: party.conversation_id,
          message_id: m.id,
          sender_id: cat,
          body: '',
        },
      },
    ]);
  });

  test('the payload has exactly {type, conversation_id, message_id, sender_id, body, at}', async () => {
    const dm = await rpc.openDm(ann, ben);
    await rpc.send(ann, dm, 'x');
    const r = await db.query<{ keys: string[] }>(
      `select array(select jsonb_object_keys(payload) order by 1) as keys from pg_temp.sent`,
    );
    assert.deepEqual(r.rows[0]?.keys, ['at', 'body', 'conversation_id', 'message_id', 'sender_id', 'type']);
  });

  test('a failing realtime.send never fails the message; without realtime.send nothing is sent and everything works', async () => {
    await stubSend(db, { fail: true });
    const dm = await rpc.openDm(ann, ben);
    const m = await rpc.send(ann, dm, 'still stored');
    await rpc.deleteMessage(ann, m.id);
    assert.equal(await count(db, `select 1 from public.messages where deleted_at is not null`), 1);
    await db.exec(`drop function realtime.send(jsonb, text, text, boolean)`);
    await rpc.send(ben, dm, 'no realtime at all');
    assert.equal(await count(db, `select 1 from public.messages`), 2);
    assert.equal(await count(db, `select 1 from pg_temp.sent`), 0);
  });

  test('a dm whose other member is gone sends nothing', async () => {
    const dan = await user(db, 'dan');
    await befriend(db, ann, dan);
    const dm = await rpc.openDm(ann, dan);
    await db.query(`delete from auth.users where id = $1`, [dan]);
    await db.exec(`truncate pg_temp.sent`);
    // ann is no longer friends with a deleted account, so send_message refuses; a service insert shows the trigger.
    await assert.rejects(rpc.send(ann, dm, 'hello?'), noConversation);
    await db.query(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'x')`, [dm, ann]);
    assert.deepEqual(await take(db), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Retention and re-running the migration
// ---------------------------------------------------------------------------------------------------------------

describe('messages: retention', () => {
  test('private.purge_messages deletes messages older than 90 days, deleted ones included; threads stay', async () => {
    const db = await createTestDb();
    const rpc = api(db);
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    await befriend(db, ann, ben);
    const dm = await rpc.openDm(ann, ben);
    const old = await rpc.send(ann, dm, 'old');
    const gone = await rpc.send(ann, dm, 'deleted long ago');
    await rpc.deleteMessage(ann, gone.id);
    const fresh = await rpc.send(ben, dm, 'fresh');
    await db.query(`update public.messages set created_at = now() - interval '91 days' where id in ($1, $2)`, [
      old.id,
      gone.id,
    ]);
    await db.query(`update public.messages set created_at = now() - interval '89 days' where id = $1`, [fresh.id]);
    await db.exec(`select private.purge_messages()`);
    assert.deepEqual(
      (await db.query<{ id: string }>(`select id from public.messages`)).rows.map((r) => r.id),
      [fresh.id],
    );
    assert.equal(await count(db, `select 1 from public.conversations`), 1);
    // Not callable by clients.
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'private.purge_messages()', 'execute') as ok`,
        [role],
      );
      assert.equal(r.rows[0]?.ok, false, role);
    }
    await db.close();
  });

  test('without pg_cron the schedule block only raises a NOTICE', async () => {
    const db = await createTestDb();
    // Only the final `do` block is re-runnable (the tables exist); run it alone.
    const block = MIGRATION.slice(MIGRATION.lastIndexOf('do $outer$'));
    const notices: string[] = [];
    await db.exec(block, { onNotice: (n) => notices.push(n.message ?? '') });
    assert.deepEqual(notices, ['pg_cron is not available: old messages will not be purged automatically']);
    await db.close();
  });
});
