// Row-level security and privileges, evaluated the way PostgREST does it (set role + JWT claims).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { asAnon, asService, asUser, createTestDb, insertGame, signUp } from './harness.ts';

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

describe('per-user tables are owner-only', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'spike');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
    for (const uid of [alice, bob]) {
      await asUser(db, uid, async () => {
        await db.query(`select public.save_put('spike', 'main', '{"hp":3}'::jsonb)`);
        await db.query(`select public.record_play('spike', 30)`);
        await db.query(`insert into public.game_consents (user_id, game_id) values ($1, 'spike')`, [uid]);
        await db.query(`insert into public.favorites (user_id, game_id) values ($1, 'spike')`, [uid]);
      });
    }
  });
  after(() => db.close());

  for (const table of ['game_saves', 'game_stats', 'game_consents', 'favorites']) {
    test(`${table}: a user sees only their own rows`, async () => {
      await asUser(db, alice, async () => {
        assert.equal(await count(db, `select * from public.${table}`), 1);
        assert.equal(await count(db, `select * from public.${table} where user_id = $1`, [bob]), 0);
      });
    });
    test(`${table}: anon has no access`, async () => {
      await asAnon(db, async () => {
        await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
      });
    });
  }

  test('service role sees every row (bypassrls)', async () => {
    await asService(db, async () => {
      assert.equal(await count(db, `select * from public.game_saves`), 2);
    });
  });

  test('consents/favorites: cannot write rows for another user', async () => {
    await insertGame(db, 'arena');
    await asUser(db, alice, async () => {
      await assert.rejects(
        db.query(`insert into public.favorites (user_id, game_id) values ($1, 'arena')`, [bob]),
        /row-level security/,
      );
      await assert.rejects(
        db.query(`insert into public.game_consents (user_id, game_id) values ($1, 'arena')`, [bob]),
        /row-level security/,
      );
      // Deleting someone else's row silently matches nothing.
      const del = await db.query(`delete from public.favorites where user_id = $1`, [bob]);
      assert.equal(del.affectedRows, 0);
      // Own rows: insert, re-grant (upsert), delete.
      await db.query(`insert into public.game_consents (user_id, game_id) values ($1, 'arena')`, [alice]);
      await db.query(
        `insert into public.game_consents (user_id, game_id) values ($1, 'arena')
         on conflict (user_id, game_id) do update set granted_at = now()`,
        [alice],
      );
      const own = await db.query(`delete from public.game_consents where user_id = $1 and game_id = 'arena'`, [alice]);
      assert.equal(own.affectedRows, 1);
    });
    assert.equal(await count(db, `select * from public.favorites where user_id = $1`, [bob]), 1);
  });

  test('saves and stats cannot be written directly, only through the RPCs', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(
        db.query(`insert into public.game_saves (user_id, game_id, slot, data) values ($1, 'spike', 'x', '{}')`, [alice]),
        /permission denied/,
      );
      await assert.rejects(db.query(`update public.game_saves set version = 99`), /permission denied/);
      await assert.rejects(db.query(`update public.game_stats set plays = 1000`), /permission denied/);
    });
  });

  test('banned_words is not readable by clients', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select * from public.banned_words`), /permission denied/);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.banned_words`), /permission denied/);
    });
  });
});

describe('catalog visibility', () => {
  let db: PGlite;
  let user: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'live', 'published');
    await insertGame(db, 'wip', 'draft');
    await insertGame(db, 'pulled', 'hidden');
    for (const g of ['live', 'wip', 'pulled']) {
      await db.query(
        `insert into public.game_versions (game_id, version, entry_url, manifest, sha256)
         values ($1, '1.0.0', 'https://cdn.example/' || $1 || '/1.0.0/index.html', '{}', 'abc')`,
        [g],
      );
    }
    user = await signUp(db, { username: 'carol', birth_date: '1990-02-03' });
  });
  after(() => db.close());

  for (const who of ['anon', 'authenticated'] as const) {
    test(`${who} reads only published games and their versions`, async () => {
      const run = async () => {
        const games = await db.query<{ id: string }>(`select id from public.games order by id`);
        assert.deepEqual(games.rows.map((r) => r.id), ['live']);
        const versions = await db.query<{ game_id: string }>(`select game_id from public.game_versions`);
        assert.deepEqual(versions.rows.map((r) => r.game_id), ['live']);
      };
      if (who === 'anon') await asAnon(db, run);
      else await asUser(db, user, run);
    });

    test(`${who} cannot write the catalog`, async () => {
      const run = async () => {
        await assert.rejects(
          db.query(`insert into public.games (id, title, engine) values ('evil', 'Evil', 'custom')`),
          /permission denied/,
        );
        await assert.rejects(db.query(`update public.games set status = 'published'`), /permission denied/);
        await assert.rejects(db.query(`delete from public.game_versions`), /permission denied/);
      };
      if (who === 'anon') await asAnon(db, run);
      else await asUser(db, user, run);
    });
  }

  test('service role sees drafts and hidden games', async () => {
    await asService(db, async () => {
      assert.equal(await count(db, `select * from public.games`), 3);
      assert.equal(await count(db, `select * from public.game_versions`), 3);
    });
  });
});
