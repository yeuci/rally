// 20261029000400_m1_review_fixes.sql: profile column grants, anonymous-session fence, username release,
// anonymous-user purge, and the UTC age gate boundary.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { PROFILE_COLUMNS } from '../src/index.ts';
import {
  asAnon,
  asAnonymousUser,
  asRole,
  asUser,
  createTestDb,
  insertGame,
  signUp,
  signUpAnonymously,
} from './harness.ts';

const MIGRATION = new URL('../supabase/migrations/20261029000400_m1_review_fixes.sql', import.meta.url);

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

const anonymousForbidden = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string };
  return err.code === '42501' && /ANONYMOUS_FORBIDDEN/.test(err.message ?? '');
};

describe('profiles: column-level select', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;

  before(async () => {
    db = await createTestDb();
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '1995-06-15' });
  });
  after(() => db.close());

  test('authenticated may select exactly PROFILE_COLUMNS; birth_date and privacy are withheld', async () => {
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles'
          and has_column_privilege('authenticated', 'public.profiles', column_name, 'select')
        order by ordinal_position`,
    );
    assert.deepEqual(r.rows.map((c) => c.column_name), PROFILE_COLUMNS.split(', '));
    assert.equal(PROFILE_COLUMNS, 'id, username, display_name, avatar_url, bio, created_at, updated_at');
    const table = await db.query<{ ok: boolean }>(`select has_table_privilege('authenticated', 'public.profiles', 'select') as ok`);
    assert.equal(table.rows[0]!.ok, false);
  });

  test("another user's birth_date / privacy / select * are refused", async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select birth_date from public.profiles where id = $1`, [bob]), /permission denied/);
      await assert.rejects(db.query(`select privacy from public.profiles where id = $1`, [bob]), /permission denied/);
      await assert.rejects(db.query(`select * from public.profiles`), /permission denied/);
      // Filtering or ordering by a withheld column is refused too (no oracle).
      await assert.rejects(db.query(`select id from public.profiles where birth_date < '2000-01-01'`), /permission denied/);
    });
  });

  test('the allowed columns are readable for any profile', async () => {
    await asUser(db, alice, async () => {
      const r = await db.query<{ id: string; username: string }>(
        `select ${PROFILE_COLUMNS} from public.profiles order by username`,
      );
      assert.deepEqual(r.rows.map((x) => x.username), ['alice', 'bob']);
      assert.ok(Object.keys(r.rows[0]!).includes('bio'));
    });
  });

  test('a user cannot read their own birth_date or privacy either (intended: the app never shows them)', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select birth_date from public.profiles where id = $1`, [alice]), /permission denied/);
      await assert.rejects(db.query(`select privacy from public.profiles where id = $1`, [alice]), /permission denied/);
    });
  });

  test('updates still work; returning must name allowed columns (no returning *)', async () => {
    await asUser(db, alice, async () => {
      const r = await db.query<{ id: string; display_name: string }>(
        `update public.profiles set display_name = 'Alice', privacy = '{"online":false}' where id = $1 returning id, display_name`,
        [alice],
      );
      assert.deepEqual(r.rows, [{ id: alice, display_name: 'Alice' }]);
      await assert.rejects(
        db.query(`update public.profiles set display_name = 'A' where id = $1 returning *`, [alice]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`update public.profiles set birth_date = '1980-01-01' where id = $1`, [alice]),
        /permission denied/,
      );
    });
    const r = await db.query<{ privacy: unknown }>(`select privacy from public.profiles where id = $1`, [alice]);
    assert.deepEqual(r.rows[0]!.privacy, { online: false });
  });

  test('anon still has no access to profiles', async () => {
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select username from public.profiles`), /permission denied/);
    });
  });
});

describe('anonymous sessions are fenced', () => {
  let db: PGlite;
  let alice: string;
  let ghost: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'spike');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2001-02-03' });
    await asUser(db, alice, async () => {
      await db.query(`insert into public.favorites (user_id, game_id) values ($1, 'spike')`, [alice]);
      await db.query(`select public.save_put('spike', 'main', '{}'::jsonb)`);
    });
  });
  after(() => db.close());

  test('reads only its own profile row', async () => {
    await asAnonymousUser(db, ghost, async () => {
      const r = await db.query<{ id: string; username: string }>(`select ${PROFILE_COLUMNS} from public.profiles`);
      assert.deepEqual(r.rows.map((x) => [x.id, x.username]), [[ghost, 'ghost']]);
      assert.equal(await count(db, `select id from public.profiles where id = $1`, [alice]), 0);
      assert.equal(await count(db, `select id from public.profiles where username = 'alice'`), 0);
    });
  });

  test('can update its own profile (username before linking), not anyone else', async () => {
    await asAnonymousUser(db, ghost, async () => {
      const own = await db.query(`update public.profiles set username = 'ghost_2', display_name = 'G' where id = $1`, [ghost]);
      assert.equal(own.affectedRows, 1);
      const other = await db.query(`update public.profiles set display_name = 'pwned' where id = $1`, [alice]);
      assert.equal(other.affectedRows, 0);
      await db.query(`update public.profiles set username = 'ghost' where id = $1`, [ghost]);
    });
  });

  test('cannot insert, update or delete consents and favorites', async () => {
    // Rows that exist for the anonymous user (e.g. written by the service role) stay untouchable.
    await db.query(`insert into public.favorites (user_id, game_id) values ($1, 'spike')`, [ghost]);
    await db.query(`insert into public.game_consents (user_id, game_id) values ($1, 'spike')`, [ghost]);
    await insertGame(db, 'arena');
    await asAnonymousUser(db, ghost, async () => {
      for (const table of ['favorites', 'game_consents']) {
        await assert.rejects(
          db.query(`insert into public.${table} (user_id, game_id) values ($1, 'arena')`, [ghost]),
          /row-level security/,
          table,
        );
        await assert.rejects(
          db.query(
            `insert into public.${table} (user_id, game_id) values ($1, 'spike') on conflict (user_id, game_id) do nothing`,
            [ghost],
          ),
          /row-level security/,
          table,
        );
        const del = await db.query(`delete from public.${table} where user_id = $1`, [ghost]);
        assert.equal(del.affectedRows, 0, table);
        const upd = await db.query(`update public.${table} set game_id = 'arena' where user_id = $1`, [ghost]);
        assert.equal(upd.affectedRows, 0, table);
      }
    });
    assert.equal(await count(db, `select 1 from public.favorites where user_id = $1 and game_id = 'spike'`, [ghost]), 1);
    assert.equal(await count(db, `select 1 from public.game_consents where user_id = $1 and game_id = 'spike'`, [ghost]), 1);
    await db.query(`delete from public.favorites where user_id = $1`, [ghost]);
    await db.query(`delete from public.game_consents where user_id = $1`, [ghost]);
  });

  test("sees none of another user's rows", async () => {
    await asAnonymousUser(db, ghost, async () => {
      for (const table of ['favorites', 'game_consents', 'game_saves', 'game_stats']) {
        assert.equal(await count(db, `select 1 from public.${table} where user_id = $1`, [alice]), 0, table);
      }
    });
  });

  test('save_put and record_play raise ANONYMOUS_FORBIDDEN (insufficient_privilege)', async () => {
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.save_put('spike', 'main', '{}'::jsonb)`), anonymousForbidden);
      await assert.rejects(db.query(`select public.record_play('spike', 10)`), anonymousForbidden);
    });
    assert.equal(await count(db, `select 1 from public.game_saves where user_id = $1`, [ghost]), 0);
    assert.equal(await count(db, `select 1 from public.game_stats where user_id = $1`, [ghost]), 0);
  });

  test('once linked (is_anonymous false) the same user has full rights', async () => {
    await asUser(db, ghost, async () => {
      assert.equal(await count(db, `select id from public.profiles`), 2);
      await db.query(`insert into public.favorites (user_id, game_id) values ($1, 'spike')`, [ghost]);
      await db.query(`insert into public.game_consents (user_id, game_id) values ($1, 'spike')`, [ghost]);
      await db.query(`select public.save_put('spike', 'main', '{}'::jsonb)`);
      await db.query(`select public.record_play('spike', 10)`);
    });
  });

  test('a token without the is_anonymous claim is treated as a regular account', async () => {
    await asRole(
      db,
      'authenticated',
      async () => {
        assert.equal(await count(db, `select id from public.profiles`), 2);
        await db.query(`select public.record_play('spike', 1)`);
      },
      { sub: alice },
    );
  });
});

describe('usernames: availability and release', () => {
  let db: PGlite;
  let alice: string;
  let ghost: string;

  const available = async (name: string): Promise<boolean> =>
    (await db.query<{ ok: boolean }>(`select public.username_available($1) as ok`, [name])).rows[0]!.ok;
  const usernameOf = async (id: string): Promise<string> =>
    (await db.query<{ username: string }>(`select username from public.profiles where id = $1`, [id])).rows[0]!.username;

  before(async () => {
    // Seeded word list: the generated name must pass the real filter.
    db = await createTestDb({ seed: true });
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2001-02-03' });
  });
  after(() => db.close());

  test("username_available ignores the caller's own profile (any case), not others'", async () => {
    await asAnonymousUser(db, ghost, async () => {
      assert.equal(await available('ghost'), true);
      assert.equal(await available('GHOST'), true);
      assert.equal(await available('alice'), false);
    });
    await asUser(db, alice, async () => {
      assert.equal(await available('alice'), true);
      assert.equal(await available('ghost'), false);
    });
    await asAnon(db, async () => {
      assert.equal(await available('ghost'), false);
      assert.equal(await available('alice'), false);
    });
  });

  test('release_username is a no-op for a linked user', async () => {
    await asUser(db, alice, async () => {
      await db.query(`select public.release_username()`);
    });
    assert.equal(await usernameOf(alice), 'alice');
  });

  test('release_username frees the name an anonymous signup reserved', async () => {
    await asAnonymousUser(db, ghost, async () => {
      await db.query(`select public.release_username()`);
      const r = await db.query<{ username: string }>(`select username from public.profiles where id = $1`, [ghost]);
      assert.equal(r.rows[0]!.username, `user_${ghost.replace(/-/g, '').slice(0, 12)}`);
    });
    await asAnon(db, async () => {
      assert.equal(await available('ghost'), true);
    });
    // Someone else can now take it.
    await signUp(db, { username: 'ghost', birth_date: '1999-09-09' });
  });

  test('release_username falls back to a random name if user_<id> is taken', async () => {
    const shade = await signUpAnonymously(db, { username: 'shade', birth_date: '2001-02-03' });
    await signUp(db, { username: `user_${shade.replace(/-/g, '').slice(0, 12)}`, birth_date: '1999-09-09' });
    await asAnonymousUser(db, shade, async () => {
      await db.query(`select public.release_username()`);
    });
    assert.match(await usernameOf(shade), /^user_[0-9a-f]{15}$/);
  });

  test('release_username is not callable signed out', async () => {
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.release_username()`), /permission denied/);
    });
  });
});

describe('purge of abandoned anonymous users', () => {
  test('the migration applies without pg_cron', async () => {
    const db = await createTestDb();
    const r = await db.query<{ cron: boolean; ext: boolean; fn: boolean }>(
      `select exists (select 1 from pg_available_extensions where name = 'pg_cron') as cron,
              exists (select 1 from pg_extension where extname = 'pg_cron') as ext,
              to_regprocedure('public.release_username()') is not null as fn`,
    );
    assert.deepEqual(r.rows[0], { cron: false, ext: false, fn: true });
    // Re-running the migration is harmless too (the DO block skips with a NOTICE).
    const sql = readFileSync(MIGRATION, 'utf8');
    await db.exec(sql.slice(sql.indexOf('do $outer$')));
    await db.close();
  });

  test('the scheduled statement deletes only anonymous users older than a day, cascading', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /'17 3 \* \* \*'/);
    const cmd = /\$cmd\$(.+?)\$cmd\$/s.exec(sql)?.[1];
    assert.ok(cmd, 'purge command not found in migration');

    const db = await createTestDb();
    await insertGame(db, 'spike');
    const stale = await signUpAnonymously(db, { username: 'stale', birth_date: '2000-01-01' }, new Date(Date.now() - 2 * 864e5).toISOString());
    const fresh = await signUpAnonymously(db, { username: 'fresh', birth_date: '2000-01-01' }, new Date(Date.now() - 3600e3).toISOString());
    const old = await signUp(db, { username: 'old_timer', birth_date: '2000-01-01' });
    await db.query(`update auth.users set created_at = now() - interval '30 days' where id = $1`, [old]);
    await db.query(`insert into public.favorites (user_id, game_id) values ($1, 'spike')`, [stale]);

    await db.exec(cmd);
    const users = await db.query<{ id: string }>(`select id from auth.users order by created_at`);
    assert.deepEqual(users.rows.map((u) => u.id).sort(), [fresh, old].sort());
    assert.equal(await count(db, `select 1 from public.profiles where id = $1`, [stale]), 0);
    assert.equal(await count(db, `select 1 from public.favorites where user_id = $1`, [stale]), 0);
    await db.close();
  });
});

test('age gate is evaluated on the server date (UTC): 13 today accepted, 13 tomorrow refused', async () => {
  const db = await createTestDb();
  const r = await db.query<{ tz: string; today13: string; tomorrow13: string }>(
    `select current_setting('TimeZone') as tz,
            (current_date - interval '13 years')::date::text as today13,
            (current_date - interval '13 years' + interval '1 day')::date::text as tomorrow13`,
  );
  const { tz, today13, tomorrow13 } = r.rows[0]!;
  assert.equal(tz, 'UTC');
  await signUp(db, { username: 'turns13today', birth_date: today13 });
  await assert.rejects(signUp(db, { username: 'turns13tmrw', birth_date: tomorrow13 }), /AGE_GATE/);
  await assert.rejects(signUpAnonymously(db, { username: 'anon13tmrw', birth_date: tomorrow13 }), /AGE_GATE/);
  await db.close();
});
