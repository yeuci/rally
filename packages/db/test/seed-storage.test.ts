// seed.sql on top of the migrations, and the storage buckets/policies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySeed, asAnon, asService, asUser, createTestDb, signUp } from './harness.ts';

test('seed applies cleanly and is idempotent', async () => {
  const db = await createTestDb({ seed: true });
  const words = async () => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.banned_words`)).rows[0]!.n);
  const before = await words();
  assert.ok(before >= 250, `expected a real word list, got ${before}`);
  await applySeed(db);
  assert.equal(await words(), before);

  const games = await db.query<{ id: string; status: string }>(`select id, status from public.games order by id`);
  assert.deepEqual(
    games.rows.map((g) => `${g.id}:${g.status}`),
    ['arena:draft', 'orbit-golf:draft', 'spike:published', 'tile-rush:draft'],
  );
  await asAnon(db, async () => {
    const visible = await db.query<{ id: string }>(`select id from public.games`);
    assert.deepEqual(visible.rows.map((r) => r.id), ['spike']);
  });

  // The seeded filter is live for signups.
  await assert.rejects(signUp(db, { username: 'fuck_you', birth_date: '2000-01-01' }), /USERNAME_FILTERED/);
  await assert.rejects(signUp(db, { username: 'rally_admin', birth_date: '2000-01-01' }), /USERNAME_FILTERED/);
  await signUp(db, { username: 'classic_gamer', birth_date: '2000-01-01' });
  await db.close();
});

test('every seeded word is matchable by the filter (no regex metacharacters)', async () => {
  const db = await createTestDb({ seed: true });
  const misses = await db.query<{ word: string }>(
    `select word from public.banned_words where not public.contains_banned_word('x ' || word::text || ' y')
        or word::text !~ '^[a-z0-9 ]+$'`,
  );
  assert.deepEqual(misses.rows, []);
  await db.close();
});

test('storage: games bucket served by URL only (no client listing), avatars owner-write under <uid>/', async () => {
  const db = await createTestDb();
  const buckets = await db.query<{ id: string; public: boolean }>(`select id, public from storage.buckets order by id`);
  assert.deepEqual(buckets.rows, [
    { id: 'avatars', public: true },
    // Private: bug-report screenshots (20261101000200_social_discovery.sql, covered by social-discovery.test.ts).
    { id: 'bug-reports', public: false },
    { id: 'games', public: true },
  ]);

  const alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  const bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
  const put = (bucket: string, name: string) =>
    db.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]);

  await asUser(db, alice, async () => {
    await put('avatars', `${alice}/avatar.png`);
    await assert.rejects(put('avatars', `${bob}/avatar.png`), /row-level security/);
    await assert.rejects(put('avatars', `avatar.png`), /row-level security/);
    await assert.rejects(put('games', `spike/0.1.0/index.html`), /row-level security/);
    const upd = await db.query(`update storage.objects set metadata = '{}' where bucket_id = 'avatars'`);
    assert.equal(upd.affectedRows, 1);
  });
  await asUser(db, bob, async () => {
    const mine = await db.query(`select name from storage.objects where bucket_id = 'avatars'`);
    assert.equal(mine.rows.length, 0);
    const del = await db.query(`delete from storage.objects where bucket_id = 'avatars'`);
    assert.equal(del.affectedRows, 0);
  });
  await asAnon(db, async () => {
    await assert.rejects(put('avatars', `${alice}/x.png`), /row-level security/);
  });
  await asService(db, async () => {
    await put('games', `spike/0.1.0/index.html`);
  });
  // Public buckets serve objects by URL without RLS; listing them is not a client right (20261030000400).
  await asAnon(db, async () => {
    const files = await db.query(`select name from storage.objects where bucket_id = 'games'`);
    assert.equal(files.rows.length, 0);
  });
  await db.close();
});
