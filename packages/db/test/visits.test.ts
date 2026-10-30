// 20261031000100_visits.sql: games.visits, game_visits_daily, private.bump_visits, the solo launch counters
// (start_play_session, record_play) and server_record_visits for multiplayer joins.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { asAnon, asService, asUser, createTestDb, insertGame, signUp } from './harness.ts';
import { MAX_SERVER_VISITS_PER_CALL } from '../src/index.ts';

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const notFound = sqlstate('P0002', /^NOT_FOUND/);
const invalid = sqlstate('22023', /^INVALID/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const conflict = sqlstate('40001', /^CONFLICT/);
const permissionDenied = /permission denied/;

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const visits = async (db: PGlite, game: string): Promise<number> =>
  (await db.query<{ v: number }>(`select visits::int as v from public.games where id = $1`, [game])).rows[0]!.v;

/** game_visits_daily rows of `game` as {day: 'YYYY-MM-DD', visits}, oldest first. */
const daily = async (db: PGlite, game: string) =>
  (
    await db.query<{ day: string; visits: number }>(
      `select day::text as day, visits from public.game_visits_daily where game_id = $1 order by day`,
      [game],
    )
  ).rows;

const utcToday = async (db: PGlite): Promise<string> =>
  (await db.query<{ d: string }>(`select ((now() at time zone 'utc')::date)::text as d`)).rows[0]!.d;

const startSession = (db: PGlite, uid: string, game: string) =>
  asUser(db, uid, async () => (await db.query<{ id: string }>(`select public.start_play_session($1) as id`, [game])).rows[0]!.id);

const recordPlay = (db: PGlite, uid: string, game: string) =>
  asUser(db, uid, () => db.query(`select public.record_play($1, 30)`, [game]));

const serverRecord = (db: PGlite, game: string | null, n: number | null) =>
  asService(db, () => db.query(`select public.server_record_visits($1, $2)`, [game, n]));

/** A multiplayer game (no 'solo' mode), like Sumo. */
async function insertMultiplayerGame(db: PGlite, id: string): Promise<void> {
  await insertGame(db, id);
  await db.query(`update public.games set modes = '{quick,browser,private}', max_players = 8 where id = $1`, [id]);
}

// ---------------------------------------------------------------------------------------------------------------
// Solo launches
// ---------------------------------------------------------------------------------------------------------------

describe('solo launches', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    alice = await user(db, 'alice');
    await insertGame(db, 'runner');
    await insertGame(db, 'puzzle');
    await insertGame(db, 'draft', 'draft');
    await insertMultiplayerGame(db, 'sumo');
  });
  after(() => db.close());

  test('new games start at 0 visits and no daily rows', async () => {
    assert.equal(await visits(db, 'runner'), 0);
    assert.deepEqual(await daily(db, 'runner'), []);
  });

  test('start_play_session counts one visit; abandon_play_session and end_play_session do not', async () => {
    const today = await utcToday(db);
    const s1 = await startSession(db, alice, 'runner');
    assert.equal(await visits(db, 'runner'), 1);
    assert.deepEqual(await daily(db, 'runner'), [{ day: today, visits: 1 }]);

    await asUser(db, alice, () => db.query(`select public.abandon_play_session($1)`, [s1]));
    assert.equal(await visits(db, 'runner'), 1);

    const s2 = await startSession(db, alice, 'runner');
    assert.equal(await visits(db, 'runner'), 2);
    await asUser(db, alice, () => db.query(`select public.end_play_session($1, 60)`, [s2]));
    assert.equal(await visits(db, 'runner'), 2);
    assert.deepEqual(await daily(db, 'runner'), [{ day: today, visits: 2 }]);
    assert.equal(await visits(db, 'puzzle'), 0, 'other games untouched');
  });

  test('record_play counts one visit; refused calls count nothing', async () => {
    const today = await utcToday(db);
    await recordPlay(db, alice, 'puzzle');
    assert.equal(await visits(db, 'puzzle'), 1);
    assert.deepEqual(await daily(db, 'puzzle'), [{ day: today, visits: 1 }]);

    // One play per minute per game: the second call raises and its bump rolls back.
    await assert.rejects(recordPlay(db, alice, 'puzzle'), rateLimited);
    assert.equal(await visits(db, 'puzzle'), 1);

    // An open session makes record_play refuse (CONFLICT); only the session's start counted.
    const s = await startSession(db, alice, 'puzzle');
    assert.equal(await visits(db, 'puzzle'), 2);
    await assert.rejects(recordPlay(db, alice, 'puzzle'), conflict);
    assert.equal(await visits(db, 'puzzle'), 2);
    await asUser(db, alice, () => db.query(`select public.abandon_play_session($1)`, [s]));
    assert.deepEqual(await daily(db, 'puzzle'), [{ day: today, visits: 2 }]);
  });

  test('refused launches count nothing: drafts, unknown games, multiplayer games', async () => {
    await assert.rejects(startSession(db, alice, 'draft'), notFound);
    await assert.rejects(recordPlay(db, alice, 'draft'), notFound);
    await assert.rejects(startSession(db, alice, 'sumo'), invalid);
    await assert.rejects(recordPlay(db, alice, 'sumo'), invalid);
    await assert.rejects(startSession(db, alice, 'nope'), notFound);
    assert.equal(await visits(db, 'draft'), 0);
    assert.equal(await visits(db, 'sumo'), 0);
    assert.deepEqual(await daily(db, 'sumo'), []);
  });

  test('a bump leaves games.updated_at alone; metadata edits still set it', async () => {
    await db.query(`update public.games set updated_at = '2020-01-01T00:00:00Z' where id = 'runner'`);
    const at = async () =>
      (await db.query<{ t: string }>(`select updated_at::text as t from public.games where id = 'runner'`)).rows[0]!.t;
    const frozen = await at();
    const s = await startSession(db, alice, 'runner');
    await asUser(db, alice, () => db.query(`select public.abandon_play_session($1)`, [s]));
    await serverRecord(db, 'runner', 5);
    assert.equal(await at(), frozen);
    await db.query(`update public.games set title = 'Runner!' where id = 'runner'`);
    assert.notEqual(await at(), frozen);
    await db.query(`update public.games set updated_at = '2020-01-01T00:00:00Z' where id = 'runner'`);
    await db.query(`update public.games set title = 'Runner' where id = 'runner'`);
    assert.notEqual(await at(), frozen, 'an update without a visits change sets updated_at as before');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// private.bump_visits and the UTC day
// ---------------------------------------------------------------------------------------------------------------

describe('private.bump_visits', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'runner');
  });
  after(() => db.close());

  test('ignores p_count <= 0 (and null); no-op for an unknown game', async () => {
    await db.query(`select private.bump_visits('runner', 0)`);
    await db.query(`select private.bump_visits('runner', -5)`);
    await db.query(`select private.bump_visits('runner', null)`);
    assert.equal(await visits(db, 'runner'), 0);
    assert.deepEqual(await daily(db, 'runner'), []);
    await db.query(`select private.bump_visits('nope', 3)`);
    assert.equal((await db.query(`select 1 from public.game_visits_daily where game_id = 'nope'`)).rows.length, 0);
  });

  test('keys the daily row by the UTC day whatever the session time zone; days accumulate separately', async () => {
    const today = await utcToday(db);
    const yesterday = (
      await db.query<{ d: string }>(`select (((now() at time zone 'utc')::date) - 1)::text as d`)
    ).rows[0]!.d;
    await db.query(`insert into public.game_visits_daily (game_id, day, visits) values ('runner', $1, 7)`, [yesterday]);
    // UTC+14 and UTC-11: at any instant at least one of them is on another calendar day than UTC.
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      await db.exec(`set timezone = '${tz}'`);
      try {
        await db.query(`select private.bump_visits('runner', 2)`);
      } finally {
        await db.exec(`reset timezone`);
      }
    }
    assert.deepEqual(await daily(db, 'runner'), [
      { day: yesterday, visits: 7 },
      { day: today, visits: 4 },
    ]);
    assert.equal(await visits(db, 'runner'), 4, 'games.visits counts bumps only, not seeded daily rows');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// server_record_visits
// ---------------------------------------------------------------------------------------------------------------

describe('server_record_visits', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    alice = await user(db, 'alice');
    await insertMultiplayerGame(db, 'sumo');
    await insertGame(db, 'hidden', 'hidden');
  });
  after(() => db.close());

  test('adds p_count (1..1000) to games.visits and the UTC day', async () => {
    assert.equal(MAX_SERVER_VISITS_PER_CALL, 1000);
    await serverRecord(db, 'sumo', 1);
    await serverRecord(db, 'sumo', 1000);
    assert.equal(await visits(db, 'sumo'), 1001);
    assert.deepEqual(await daily(db, 'sumo'), [{ day: await utcToday(db), visits: 1001 }]);
    // Any catalog row counts, published or not.
    await serverRecord(db, 'hidden', 3);
    assert.equal(await visits(db, 'hidden'), 3);
  });

  test('INVALID for count <= 0, > 1000 or null; NOT_FOUND for an unknown game; nothing written', async () => {
    for (const n of [0, -1, 1001, null]) await assert.rejects(serverRecord(db, 'sumo', n), invalid, String(n));
    await assert.rejects(serverRecord(db, 'nope', 1), notFound);
    await assert.rejects(serverRecord(db, null, 1), notFound);
    assert.equal(await visits(db, 'sumo'), 1001);
  });

  test('service role only', async () => {
    const r = await db.query<{ pub: boolean; anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('public', $1, 'execute') as pub,
              has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as auth,
              has_function_privilege('service_role', $1, 'execute') as svc`,
      ['public.server_record_visits(text, int)'],
    );
    assert.deepEqual(r.rows[0], { pub: false, anon: false, auth: false, svc: true });
    await asUser(db, alice, () =>
      assert.rejects(db.query(`select public.server_record_visits('sumo', 1)`), permissionDenied),
    );
    await asAnon(db, () => assert.rejects(db.query(`select public.server_record_visits('sumo', 1)`), permissionDenied));
    for (const run of [(fn: () => Promise<void>) => asUser(db, alice, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(() => assert.rejects(db.query(`select private.bump_visits('sumo', 1)`), permissionDenied));
    }
    assert.equal(await visits(db, 'sumo'), 1001);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Client access
// ---------------------------------------------------------------------------------------------------------------

describe('client access', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    alice = await user(db, 'alice');
    await insertGame(db, 'runner');
    await insertGame(db, 'draft', 'draft');
    await db.query(`select private.bump_visits('runner', 12)`);
    await db.query(`select private.bump_visits('draft', 4)`);
  });
  after(() => db.close());

  test('games.visits is readable with the rest of the row, by anon and authenticated', async () => {
    for (const run of [(fn: () => Promise<void>) => asUser(db, alice, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(async () => {
        const r = await db.query<{ id: string; visits: number }>(`select id, visits::int as visits from public.games`);
        assert.deepEqual(r.rows, [{ id: 'runner', visits: 12 }]);
      });
    }
  });

  test('clients cannot write games.visits (no column or table grant)', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ upd: boolean; ins: boolean; sel: boolean }>(
        `select has_column_privilege($1, 'public.games', 'visits', 'update') as upd,
                has_column_privilege($1, 'public.games', 'visits', 'insert') as ins,
                has_column_privilege($1, 'public.games', 'visits', 'select') as sel`,
        [role],
      );
      assert.deepEqual(r.rows[0], { upd: false, ins: false, sel: true }, role);
    }
    await asUser(db, alice, () =>
      assert.rejects(db.query(`update public.games set visits = 999999 where id = 'runner'`), permissionDenied),
    );
    await asAnon(db, () =>
      assert.rejects(db.query(`update public.games set visits = 999999 where id = 'runner'`), permissionDenied),
    );
    assert.equal(await visits(db, 'runner'), 12);
  });

  test('game_visits_daily: RLS on, select for published games only, no client writes', async () => {
    const rls = await db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = 'public.game_visits_daily'::regclass`,
    );
    assert.equal(rls.rows[0]!.on, true);
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['insert', 'update', 'delete', 'truncate']) {
        const r = await db.query<{ ok: boolean }>(`select has_table_privilege($1, 'public.game_visits_daily', $2) as ok`, [
          role,
          priv,
        ]);
        assert.equal(r.rows[0]!.ok, false, `${role} ${priv}`);
      }
    }
    for (const run of [(fn: () => Promise<void>) => asUser(db, alice, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(async () => {
        const r = await db.query<{ game_id: string; visits: number }>(
          `select game_id, visits from public.game_visits_daily order by game_id`,
        );
        assert.deepEqual(r.rows, [{ game_id: 'runner', visits: 12 }]);
        await assert.rejects(
          db.query(`insert into public.game_visits_daily (game_id, day, visits) values ('runner', '2020-01-01', 1)`),
          permissionDenied,
        );
        await assert.rejects(db.query(`update public.game_visits_daily set visits = 999`), permissionDenied);
        await assert.rejects(db.query(`delete from public.game_visits_daily`), permissionDenied);
      });
    }
    const svc = await asService(db, async () => (await db.query(`select 1 from public.game_visits_daily`)).rows.length);
    assert.equal(svc, 2);
  });

  test('deleting a game cascades its daily rows', async () => {
    await db.query(`delete from public.games where id = 'draft'`);
    assert.deepEqual(await daily(db, 'draft'), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------------

describe('purge_stale_rows: game_visits_daily', () => {
  test('drops rows of UTC days more than 90 days ago; keeps the rest and games.visits', async () => {
    const db = await createTestDb();
    await insertGame(db, 'runner');
    await db.query(`select private.bump_visits('runner', 5)`);
    await db.query(
      `insert into public.game_visits_daily (game_id, day, visits)
       select 'runner', (now() at time zone 'utc')::date - d, d from unnest(array[1, 89, 90, 91, 400]) as d`,
    );
    await db.exec(`select private.purge_stale_rows()`);
    const ages = await db.query<{ age: number }>(
      `select ((now() at time zone 'utc')::date - day) as age from public.game_visits_daily order by day desc`,
    );
    assert.deepEqual(
      ages.rows.map((r) => r.age),
      [0, 1, 89, 90],
    );
    assert.equal(await visits(db, 'runner'), 5);
    await db.close();
  });
});
