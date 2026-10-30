// 20261031000200_social_realtime.sql: friendship changes are broadcast (Realtime Broadcast-from-database) to the
// recipient's private `user:<uid>` channel only. PGlite has no Realtime, so the tests stub `realtime.send` (it
// records every call into a temp table) and `realtime.messages` / `realtime.topic()` for the channel policy.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { asAnon, asService, asUser, createTestDb, signUp } from './harness.ts';

const MIGRATION = readFileSync(
  new URL('../supabase/migrations/20261031000200_social_realtime.sql', import.meta.url),
  'utf8',
);

interface Sent {
  topic: string;
  event: string;
  private: boolean;
  type: string;
  from: string;
  to: string;
}

/** Runs the whole migration again, returning the NOTICE messages it raised. */
async function rerun(db: PGlite): Promise<string[]> {
  const notices: string[] = [];
  await db.exec(MIGRATION, { onNotice: (n) => notices.push(n.message ?? '') });
  return notices;
}

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

/** Calls recorded since the last call to `take`, in order (and clears them). */
async function take(db: PGlite): Promise<Sent[]> {
  const r = await db.query<{ payload: { type: string; from: string; to: string; at: string } } & Sent>(
    `select payload, event, topic, private from pg_temp.sent order by n`,
  );
  await db.exec(`truncate pg_temp.sent`);
  return r.rows.map((row) => {
    assert.deepEqual(Object.keys(row.payload).sort(), ['at', 'from', 'to', 'type']); // no usernames, nothing else
    assert.match(row.payload.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(row.payload.at) - Date.now()) < 60_000);
    return {
      topic: row.topic,
      event: row.event,
      private: row.private,
      type: row.payload.type,
      from: row.payload.from,
      to: row.payload.to,
    };
  });
}

/** The single event a flow must produce: event 'social', private, on the recipient's topic. */
const ev = (type: string, from: string, to: string): Sent => ({
  topic: `user:${to}`,
  event: 'social',
  private: true,
  type,
  from,
  to,
});

async function setup(opts: { stub?: boolean } = { stub: true }) {
  const db = await createTestDb();
  const user = (username: string) => signUp(db, { username, birth_date: '2000-01-01' });
  const [ann, ben, cat] = [await user('ann'), await user('ben'), await user('cat')];
  if (opts.stub) await stubSend(db);
  const call = (uid: string, sql: string, params: unknown[]) => asUser(db, uid, () => db.query(sql, params));
  const api = {
    send: (from: string, to: string) => call(from, `select public.send_friend_request($1)`, [to]),
    respond: (uid: string, from: string, accept: boolean) =>
      call(uid, `select public.respond_friend_request($1, $2)`, [from, accept]),
    remove: (uid: string, other: string) => call(uid, `select public.remove_friend($1)`, [other]),
    block: (uid: string, other: string) => call(uid, `select public.block_user($1)`, [other]),
    unblock: (uid: string, other: string) => call(uid, `select public.unblock_user($1)`, [other]),
    /** ann and ben become friends; the events are consumed. */
    befriend: async () => {
      await api.send(ann, ben);
      await api.respond(ben, ann, true);
      if (opts.stub) await take(db);
    },
  };
  return { db, ann, ben, cat, ...api };
}

describe('social realtime: friendship events on private user:<uid> channels', () => {
  test('a request goes to the recipient only', async () => {
    const { db, ann, ben, send } = await setup();
    await send(ann, ben);
    assert.deepEqual(await take(db), [ev('friend_request', ann, ben)]);
    // Asking again while pending changes nothing and sends nothing.
    await send(ann, ben);
    assert.deepEqual(await take(db), []);
    await db.close();
  });

  test('accept: the original requester is told, by the recipient', async () => {
    const { db, ann, ben, send, respond } = await setup();
    await send(ann, ben);
    await take(db);
    await respond(ben, ann, true);
    assert.deepEqual(await take(db), [ev('friend_accepted', ben, ann)]);
    // Already friends: a new request is a no-op.
    await send(ben, ann);
    assert.deepEqual(await take(db), []);
    await db.close();
  });

  test('mutual auto-accept: requesting someone who asked you accepts theirs (one accepted event)', async () => {
    const { db, ann, ben, send } = await setup();
    await send(ann, ben);
    await send(ben, ann);
    assert.deepEqual(await take(db), [ev('friend_request', ann, ben), ev('friend_accepted', ben, ann)]);
    await db.close();
  });

  test('decline: the requester is told, by the recipient', async () => {
    const { db, ann, ben, send, respond } = await setup();
    await send(ann, ben);
    await take(db);
    await respond(ben, ann, false);
    assert.deepEqual(await take(db), [ev('friend_declined', ben, ann)]);
    await db.close();
  });

  test('cancel: the recipient is told, by the requester', async () => {
    const { db, ann, ben, send, remove } = await setup();
    await send(ann, ben);
    await take(db);
    await remove(ann, ben);
    assert.deepEqual(await take(db), [ev('friend_request_cancelled', ann, ben)]);
    // Nothing left to remove: nothing sent.
    await remove(ann, ben);
    assert.deepEqual(await take(db), []);
    await db.close();
  });

  test('remove: the other side is told, whichever side removes', async () => {
    const { db, ann, ben, remove, befriend } = await setup();
    await befriend();
    await remove(ben, ann);
    assert.deepEqual(await take(db), [ev('friend_removed', ben, ann)]);
    await befriend();
    await remove(ann, ben);
    assert.deepEqual(await take(db), [ev('friend_removed', ann, ben)]);
    await db.close();
  });

  test('block: same events as decline / cancel / remove (a block is not revealed); requests after it send nothing', async () => {
    const { db, ann, ben, send, block, unblock, befriend } = await setup();
    // Ben blocks Ann, who had asked him: looks like a decline.
    await send(ann, ben);
    await take(db);
    await block(ben, ann);
    assert.deepEqual(await take(db), [ev('friend_declined', ben, ann)]);
    // Ann (blocked) asks again: no row, no event.
    await send(ann, ben);
    assert.deepEqual(await take(db), []);
    await unblock(ben, ann);
    assert.deepEqual(await take(db), []);
    // Ann blocks Ben, whom she had asked: looks like a cancel.
    await send(ann, ben);
    await take(db);
    await block(ann, ben);
    assert.deepEqual(await take(db), [ev('friend_request_cancelled', ann, ben)]);
    await unblock(ann, ben);
    // Ben blocks Ann, a friend: looks like a removal. Blocking again sends nothing.
    await befriend();
    await block(ben, ann);
    assert.deepEqual(await take(db), [ev('friend_removed', ben, ann)]);
    await block(ben, ann);
    assert.deepEqual(await take(db), []);
    await db.close();
  });

  test("a third user's topic never receives anything", async () => {
    const { db, ann, ben, cat, send, respond, remove, block, unblock } = await setup();
    const all: Sent[] = [];
    const flow = async (fn: () => Promise<unknown>) => {
      await fn();
      all.push(...(await take(db)));
    };
    await flow(() => send(ann, ben));
    await flow(() => respond(ben, ann, true));
    await flow(() => remove(ann, ben));
    await flow(() => send(ben, ann));
    await flow(() => respond(ann, ben, false));
    await flow(() => send(ben, ann));
    await flow(() => remove(ben, ann));
    await flow(() => send(ann, ben));
    await flow(() => block(ben, ann));
    await flow(() => unblock(ben, ann));
    // Cat acting on others does not touch their row either.
    await flow(() => remove(cat, ann));
    await flow(() => block(cat, ben));
    assert.equal(all.length, 9);
    for (const e of all) {
      assert.ok([`user:${ann}`, `user:${ben}`].includes(e.topic), e.topic);
      assert.equal(e.topic, `user:${e.to}`);
      assert.notEqual(e.from, e.to);
      assert.ok(![e.from, e.to].includes(cat));
    }
    await db.close();
  });

  test('nothing is sent when nothing relevant changed, or for deletes by the service role / without a user', async () => {
    const { db, ann, ben, cat, send, befriend } = await setup();
    await befriend();
    // Updates that keep the status.
    await db.query(`update public.friendships set created_at = created_at - interval '1 day'`);
    await db.query(`update public.friendships set accepted_at = now()`);
    // A row inserted already accepted (service tooling).
    await db.query(
      `insert into public.friendships (user_id, friend_id, status, accepted_at) values ($1, $2, 'accepted', now())`,
      [cat, ann],
    );
    assert.deepEqual(await take(db), []);
    // Deletes whose actor is not one of the two users: the service role, and no JWT at all (cascades, purges).
    await asService(db, () => db.query(`delete from public.friendships where user_id = $1`, [cat]));
    await db.query(`delete from public.friendships where user_id = $1`, [ann]);
    assert.deepEqual(await take(db), []);
    await send(cat, ben);
    await db.query(`delete from auth.users where id = $1`, [cat]); // account deletion cascades
    assert.deepEqual(await take(db), [ev('friend_request', cat, ben)]);
    await db.close();
  });

  test('without realtime.send (PGlite, local stacks) every flow works and sends nothing', async () => {
    const { db, ann, ben, send, respond, remove, block } = await setup({ stub: false });
    await send(ann, ben);
    await respond(ben, ann, true);
    await remove(ben, ann);
    await send(ann, ben);
    await block(ben, ann);
    // The schema alone is not enough either.
    await db.exec(`create schema realtime`);
    await block(ann, ben);
    assert.equal((await db.query(`select 1 from public.friendships`)).rows.length, 0);
    await db.close();
  });

  test('a failing realtime.send never fails the friendship change', async () => {
    const { db, ann, ben, send, respond } = await setup({ stub: false });
    await stubSend(db, { fail: true });
    await send(ann, ben);
    await respond(ben, ann, true);
    assert.deepEqual((await db.query(`select status::text from public.friendships`)).rows, [{ status: 'accepted' }]);
    await db.close();
  });

  test('the trigger function is not callable by clients; friendships is not published', async () => {
    const { db } = await setup();
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'private.broadcast_friendship_change()', 'execute') as ok`,
        [role],
      );
      assert.equal(r.rows[0]?.ok, false, role);
    }
    const r = await db.query<{ relreplident: string }>(
      `select relreplident from pg_class where oid = 'public.friendships'::regclass`,
    );
    assert.equal(r.rows[0]?.relreplident, 'd');
    assert.equal(
      (await db.query(`select 1 from pg_publication_tables where tablename = 'friendships'`)).rows.length,
      0,
    );
    await db.close();
  });
});

describe('social realtime: realtime.messages policy for user:<uid> channels', () => {
  test('without realtime.messages the migration applies with a NOTICE', async () => {
    const db = await createTestDb();
    assert.deepEqual(await rerun(db), [
      'realtime.messages does not exist: no policy for the private user:<uid> channels',
    ]);
    await db.close();
  });

  test('SELECT only, to authenticated, on topic user:<own uid>', async () => {
    const db = await createTestDb();
    const ann = await signUp(db, { username: 'ann', birth_date: '2000-01-01' });
    const ben = await signUp(db, { username: 'ben', birth_date: '2000-01-01' });
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
      insert into realtime.messages (topic, event) values ('user:${ann}', 'social'), ('user:${ben}', 'social');
    `);
    assert.deepEqual(await rerun(db), [
      'policy "users receive their own user channel" for relation "realtime.messages" does not exist, skipping',
    ]);
    assert.deepEqual(await rerun(db), []); // idempotent

    const policies = await db.query(
      `select policyname, cmd, roles::text[] as roles, permissive, qual, with_check
         from pg_policies where schemaname = 'realtime' and tablename = 'messages'`,
    );
    assert.equal(policies.rows.length, 1);
    const p = policies.rows[0] as Record<string, unknown>;
    assert.equal(p.policyname, 'users receive their own user channel');
    assert.equal(p.cmd, 'SELECT');
    assert.deepEqual(p.roles, ['authenticated']);
    assert.equal(p.permissive, 'PERMISSIVE');
    assert.equal(p.with_check, null);
    assert.match(
      String(p.qual).replace(/\s+/g, ' '),
      /^\(\( SELECT realtime\.topic\(\) AS topic\) = \('user:'::text \|\| \(\( SELECT auth\.uid\(\) AS uid\)\)::text\)\)$/,
    );

    // How Realtime authorizes joining a private channel: with realtime.topic() = the channel's topic and the user's
    // JWT, it may join when messages are selectable (the policy compares the channel topic, not the row's).
    const canJoin = async (topic: string, as: (fn: () => Promise<number>) => Promise<number>) => {
      await db.query(`select set_config('realtime.topic', $1, false)`, [topic]);
      return (await as(async () => (await db.query(`select 1 from realtime.messages`)).rows.length)) > 0;
    };
    assert.equal(await canJoin(`user:${ann}`, (fn) => asUser(db, ann, fn)), true);
    assert.equal(await canJoin(`user:${ben}`, (fn) => asUser(db, ann, fn)), false);
    assert.equal(await canJoin(`user:${ann}`, (fn) => asUser(db, ben, fn)), false);
    assert.equal(await canJoin(`user:${ann}`, (fn) => asAnon(db, fn)), false);
    assert.equal(await canJoin('', (fn) => asUser(db, ann, fn)), false);
    // No INSERT policy: clients cannot broadcast (or track presence) on a user channel, not even their own.
    await db.query(`select set_config('realtime.topic', $1, false)`, [`user:${ann}`]);
    await assert.rejects(
      asUser(db, ann, () =>
        db.query(`insert into realtime.messages (topic, event) values ($1, 'social')`, [`user:${ann}`]),
      ),
      /row-level security/,
    );
    await db.close();
  });
});
