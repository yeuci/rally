// Profiles: visibility, owner updates, immutable columns, username rules and the word filter.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { asAnon, asService, asUser, createTestDb, signUp } from './harness.ts';

describe('profiles', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;

  before(async () => {
    db = await createTestDb();
    await db.exec(`insert into public.banned_words (word) values ('admin'), ('jerk'), ('kill yourself')`);
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'Bob_99', birth_date: '1995-06-15' });
  });
  after(() => db.close());

  test('authenticated users can read every profile', async () => {
    await asUser(db, alice, async () => {
      const r = await db.query<{ username: string }>(`select username from public.profiles order by username`);
      assert.deepEqual(r.rows.map((x) => x.username), ['alice', 'Bob_99']);
    });
  });

  test('anon cannot read profiles', async () => {
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.profiles`), /permission denied/);
    });
  });

  test('a user can update their own profile; updated_at moves', async () => {
    const before = await db.query<{ updated_at: Date }>(`select updated_at from public.profiles where id = $1`, [alice]);
    await asUser(db, alice, async () => {
      const r = await db.query(
        `update public.profiles set display_name = 'Alice A.', bio = 'hi', avatar_url = 'https://x/a.png', privacy = '{"online":false}' where id = $1`,
        [alice],
      );
      assert.equal(r.affectedRows, 1);
    });
    const after = await db.query<{ display_name: string; updated_at: Date }>(
      `select display_name, updated_at from public.profiles where id = $1`,
      [alice],
    );
    assert.equal(after.rows[0]!.display_name, 'Alice A.');
    assert.ok(after.rows[0]!.updated_at >= before.rows[0]!.updated_at);
  });

  test("a user cannot update someone else's profile", async () => {
    await asUser(db, alice, async () => {
      const r = await db.query(`update public.profiles set display_name = 'pwned' where id = $1`, [bob]);
      assert.equal(r.affectedRows, 0);
    });
    const r = await db.query<{ display_name: string | null }>(`select display_name from public.profiles where id = $1`, [bob]);
    assert.equal(r.rows[0]!.display_name, null);
  });

  test('a user cannot change id or birth_date (with modern and legacy JWT GUCs)', async () => {
    for (const legacyClaims of [false, true]) {
      await asUser(
        db,
        alice,
        async () => {
          await assert.rejects(
            db.query(`update public.profiles set birth_date = '1980-01-01' where id = $1`, [alice]),
            /permission denied/,
          );
          await assert.rejects(
            db.query(`update public.profiles set id = gen_random_uuid() where id = $1`, [alice]),
            /permission denied/,
          );
        },
        { legacyClaims },
      );
    }
    const r = await db.query<{ birth_date: Date }>(`select birth_date from public.profiles where id = $1`, [alice]);
    assert.equal(r.rows[0]!.birth_date.getUTCFullYear(), 2000);
  });

  test('users cannot insert or delete profiles directly', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(
        db.query(`insert into public.profiles (id, username, birth_date) values ($1, 'dup', '2000-01-01')`, [alice]),
        /permission denied/,
      );
      await assert.rejects(db.query(`delete from public.profiles where id = $1`, [alice]), /permission denied/);
    });
  });

  test('the service role can correct a birth date (support path)', async () => {
    await asService(db, async () => {
      const r = await db.query(`update public.profiles set birth_date = '1995-06-16' where id = $1`, [bob]);
      assert.equal(r.affectedRows, 1);
    });
  });

  test('username format is enforced on signup and on update', async () => {
    for (const bad of ['ab', 'has space', 'way_too_long_username_123', 'dash-name', 'émile']) {
      await assert.rejects(signUp(db, { username: bad, birth_date: '2000-01-01' }), /profiles_username_format/, bad);
    }
    await asUser(db, alice, async () => {
      await assert.rejects(
        db.query(`update public.profiles set username = 'no!' where id = $1`, [alice]),
        /profiles_username_format/,
      );
    });
  });

  test('usernames are unique case-insensitively', async () => {
    await assert.rejects(signUp(db, { username: 'BOB_99', birth_date: '2000-01-01' }), /duplicate key|unique/);
  });

  test('banned words are rejected in usernames and display names', async () => {
    await assert.rejects(signUp(db, { username: 'ADMIN', birth_date: '2000-01-01' }), /USERNAME_FILTERED/);
    await assert.rejects(signUp(db, { username: 'the_admin', birth_date: '2000-01-01' }), /USERNAME_FILTERED/);
    // Whole-word match: a banned word inside a longer word is allowed.
    await signUp(db, { username: 'badminton', birth_date: '2000-01-01' });
    await asUser(db, alice, async () => {
      await assert.rejects(
        db.query(`update public.profiles set username = 'jerk_face' where id = $1`, [alice]),
        /USERNAME_FILTERED/,
      );
      await assert.rejects(
        db.query(`update public.profiles set display_name = 'Pls Kill Yourself' where id = $1`, [alice]),
        /DISPLAY_NAME_FILTERED/,
      );
      const ok = await db.query(`update public.profiles set username = 'alice_2' where id = $1`, [alice]);
      assert.equal(ok.affectedRows, 1);
    });
  });

  test('age gate: under 13 refused, 13 today accepted, absurd dates refused', async () => {
    const d = new Date();
    const iso = (y: number) => `${d.getUTCFullYear() - y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    await signUp(db, { username: 'just13', birth_date: iso(13) });
    await assert.rejects(signUp(db, { username: 'almost13', birth_date: iso(12) }), /AGE_GATE/);
    await assert.rejects(signUp(db, { username: 'ancient', birth_date: '1850-01-01' }), /AGE_GATE/);
  });

  test('signup without a username gets a generated one', async () => {
    const id = await signUp(db, { birth_date: '2001-01-01' });
    const r = await db.query<{ username: string }>(`select username from public.profiles where id = $1`, [id]);
    assert.match(r.rows[0]!.username, /^user_[0-9a-f]{8}$/);
  });

  // Apple/Google ID tokens carry no birth_date, so a direct provider signup is aborted here. The app signs
  // up with a provider by creating an anonymous user with { username, birth_date } first and then linking
  // the identity (README: "Anonymous sign-ins + manual linking"); this pins the direct-signup behaviour.
  test('signup without birth_date metadata is refused', async () => {
    await assert.rejects(signUp(db, { username: 'oauth_user' }), /birth_date|not-null|null value/);
  });
});
