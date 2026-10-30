// 20261030000100_m2_leaderboards.sql: leaderboards, entries, achievements, play sessions, their RLS and RPCs.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import {
  asAnon,
  asAnonymousUser,
  asService,
  asUser,
  createTestDb,
  insertGame,
  signUp,
  signUpAnonymously,
} from './harness.ts';

interface SubmitResult {
  accepted: boolean;
  best: number | null;
  rank: number | null;
  reason: string | null;
}
interface TopRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  score: number;
  is_me: boolean;
}

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

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
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);

/** Catalog rows the way publish-game writes them (service role). `created_at` orders boards: oldest = primary. */
async function addBoard(
  db: PGlite,
  game: string,
  key: string,
  sort: 'asc' | 'desc',
  opts: { period?: string; max?: number | null; createdAgoS?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.leaderboards (game_id, key, sort, period, max_score_per_minute, created_at)
     values ($1, $2, $3, $4, $5, now() - make_interval(secs => $6)) returning id`,
    [game, key, sort, opts.period ?? 'alltime', opts.max ?? null, opts.createdAgoS ?? 0],
  );
  return r.rows[0]!.id;
}

async function addAchievement(db: PGlite, game: string, key: string, hidden = false): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.achievements (game_id, key, title, hidden) values ($1, $2, $3, $4) returning id`,
    [game, key, key.toUpperCase(), hidden],
  );
  return r.rows[0]!.id;
}

/** start_play_session as `uid`, then backdate the start by `ageS` seconds (superuser, like waiting). */
async function startSession(db: PGlite, uid: string, game: string, ageS = 10): Promise<string> {
  const id = await asUser(
    db,
    uid,
    async () => (await db.query<{ id: string }>(`select public.start_play_session($1) as id`, [game])).rows[0]!.id,
  );
  await db.query(`update public.play_sessions set started_at = now() - make_interval(secs => $2) where id = $1`, [
    id,
    ageS,
  ]);
  return id;
}

const submitAs = (db: PGlite, uid: string, game: string, board: string, score: number, session: string) =>
  asUser(
    db,
    uid,
    async () =>
      (
        await db.query<{ r: SubmitResult }>(`select public.submit_solo_score($1, $2, $3, $4) as r`, [
          game,
          board,
          score,
          session,
        ])
      ).rows[0]!.r,
  );

const topRows = async (db: PGlite, game: string, board: string, scope = 'global', limit: number | null = 25) =>
  (await db.query<TopRow>(`select * from public.leaderboard_top($1, $2, $3, $4)`, [game, board, scope, limit])).rows;

describe('period_key', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  const key = async (period: string, at: string): Promise<string> =>
    (await db.query<{ k: string }>(`select public.period_key($1, $2::timestamptz) as k`, [period, at])).rows[0]!.k;

  test("alltime is 'all'; weekly is the ISO week; daily is the UTC date", async () => {
    assert.equal(await key('alltime', '2026-10-30T12:00:00Z'), 'all');
    assert.equal(await key('weekly', '2026-10-30T12:00:00Z'), '2026-W44');
    // ISO weeks start on Monday and belong to the ISO year of their Thursday.
    assert.equal(await key('weekly', '2026-11-01T23:59:59Z'), '2026-W44'); // Sunday
    assert.equal(await key('weekly', '2026-11-02T00:00:00Z'), '2026-W45'); // Monday
    assert.equal(await key('weekly', '2021-01-03T12:00:00Z'), '2020-W53');
    assert.equal(await key('weekly', '2024-12-30T00:00:00Z'), '2025-W01');
    assert.equal(await key('daily', '2026-10-30T12:00:00Z'), '2026-10-30');
    // UTC, whatever the input offset or session time zone.
    assert.equal(await key('daily', '2026-10-30T23:30:00-05:00'), '2026-10-31');
    await db.exec(`set timezone = 'America/Los_Angeles'`);
    try {
      assert.equal(await key('daily', '2026-10-31T01:00:00Z'), '2026-10-31');
      assert.equal(await key('weekly', '2026-11-02T01:00:00Z'), '2026-W45');
    } finally {
      await db.exec(`set timezone = 'UTC'`);
    }
  });

  test('defaults to now(); unknown period raises INVALID; callable signed out', async () => {
    const r = await db.query<{ a: string; b: string }>(
      `select public.period_key('daily') as a, to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as b`,
    );
    assert.equal(r.rows[0]!.a, r.rows[0]!.b);
    await assert.rejects(db.query(`select public.period_key('monthly')`), invalid);
    await asAnon(db, async () => {
      assert.equal((await db.query<{ k: string }>(`select public.period_key('alltime') as k`)).rows[0]!.k, 'all');
    });
  });
});

describe('catalog tables: public reads, constraints', () => {
  let db: PGlite;
  let alice: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'secret', 'draft');
    await insertGame(db, 'retired', 'hidden');
    await addBoard(db, 'stack', 'height', 'desc');
    await addBoard(db, 'secret', 'height', 'desc');
    await addBoard(db, 'retired', 'height', 'desc');
    await addAchievement(db, 'stack', 'first_drop');
    await addAchievement(db, 'secret', 'first_drop');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  });
  after(() => db.close());

  test('anon and authenticated see boards and achievements of published games only', async () => {
    for (const run of [
      (fn: () => Promise<void>) => asAnon(db, fn),
      (fn: () => Promise<void>) => asUser(db, alice, fn),
    ]) {
      await run(async () => {
        const boards = await db.query<{ game_id: string }>(`select game_id from public.leaderboards`);
        assert.deepEqual(
          boards.rows.map((r) => r.game_id),
          ['stack'],
        );
        const ach = await db.query<{ game_id: string }>(`select game_id from public.achievements`);
        assert.deepEqual(
          ach.rows.map((r) => r.game_id),
          ['stack'],
        );
      });
    }
  });

  test('clients cannot write catalog tables; the service role can', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(
        db.query(`insert into public.leaderboards (game_id, key, sort) values ('stack', 'x', 'asc')`),
        /permission denied/,
      );
      await assert.rejects(db.query(`update public.achievements set title = 'pwned'`), /permission denied/);
      await assert.rejects(db.query(`delete from public.leaderboards`), /permission denied/);
    });
    await asService(db, async () => {
      await db.query(`insert into public.leaderboards (game_id, key, sort) values ('stack', 'svc', 'asc')`);
      await db.query(`delete from public.leaderboards where key = 'svc'`);
    });
  });

  test('board key format, sort, period and bound are checked; (game_id, key) is unique', async () => {
    const bad = async (key: string, sort = 'desc', period = 'alltime', max: number | null = null) =>
      assert.rejects(
        db.query(
          `insert into public.leaderboards (game_id, key, sort, period, max_score_per_minute) values ('stack', $1, $2, $3, $4)`,
          [key, sort, period, max],
        ),
        /violates check constraint/,
      );
    await bad('Height');
    await bad('1st');
    await bad('a'.repeat(33));
    await bad('has space');
    await bad('ok', 'up');
    await bad('ok', 'desc', 'monthly');
    await bad('ok', 'desc', 'alltime', 0);
    await assert.rejects(addBoard(db, 'stack', 'height', 'asc'), /duplicate key/);
    const id = await addBoard(db, 'stack', 'best_time-2', 'asc', { period: 'daily', max: 12.5 });
    const r = await db.query<{ period: string; max_score_per_minute: number }>(
      `select period, max_score_per_minute from public.leaderboards where id = $1`,
      [id],
    );
    assert.deepEqual(r.rows[0], { period: 'daily', max_score_per_minute: 12.5 });
    const defaults = await db.query<{ period: string }>(
      `select period from public.leaderboards where key = 'height' limit 1`,
    );
    assert.equal(defaults.rows[0]!.period, 'alltime');
  });

  test('achievement defaults: description empty, icon null, not hidden', async () => {
    const r = await db.query(
      `select description, icon, hidden from public.achievements where game_id = 'stack' and key = 'first_drop'`,
    );
    assert.deepEqual(r.rows[0], { description: '', icon: null, hidden: false });
  });

  test('deleting a game cascades to its boards and achievements', async () => {
    await insertGame(db, 'doomed');
    await addBoard(db, 'doomed', 'score', 'desc');
    await addAchievement(db, 'doomed', 'a');
    await db.query(`delete from public.games where id = 'doomed'`);
    assert.equal(await count(db, `select 1 from public.leaderboards where game_id = 'doomed'`), 0);
    assert.equal(await count(db, `select 1 from public.achievements where game_id = 'doomed'`), 0);
  });
});

describe('play sessions', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let ghost: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'secret', 'draft');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  after(() => db.close());

  test('start_play_session records the caller, game and version', async () => {
    const id = await asUser(
      db,
      alice,
      async () =>
        (await db.query<{ id: string }>(`select public.start_play_session('stack', '1.0.0') as id`)).rows[0]!.id,
    );
    const r = await db.query(
      `select user_id, game_id, version, ended_at, playtime_s from public.play_sessions where id = $1`,
      [id],
    );
    assert.deepEqual(r.rows[0], { user_id: alice, game_id: 'stack', version: '1.0.0', ended_at: null, playtime_s: 0 });
    const noVersion = await asUser(
      db,
      alice,
      async () => (await db.query<{ id: string }>(`select public.start_play_session('stack') as id`)).rows[0]!.id,
    );
    assert.equal(
      (await db.query<{ v: null }>(`select version as v from public.play_sessions where id = $1`, [noVersion])).rows[0]!
        .v,
      null,
    );
  });

  test('the game must exist and be published', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select public.start_play_session('secret')`), notFound);
      await assert.rejects(db.query(`select public.start_play_session('nope')`), notFound);
    });
  });

  test('at most 60 sessions started per user per rolling hour', async () => {
    // bob: 58 sessions in the last hour (plus older ones that do not count).
    await db.query(
      `insert into public.play_sessions (user_id, game_id, started_at)
       select $1, 'stack', now() - make_interval(mins => g) from generate_series(1, 58) g`,
      [bob],
    );
    await db.query(
      `insert into public.play_sessions (user_id, game_id, started_at)
       select $1, 'stack', now() - interval '61 minutes' - make_interval(mins => g) from generate_series(1, 20) g`,
      [bob],
    );
    await asUser(db, bob, async () => {
      await db.query(`select public.start_play_session('stack')`); // 59
      await db.query(`select public.start_play_session('stack')`); // 60
      await assert.rejects(db.query(`select public.start_play_session('stack')`), rateLimited);
    });
    // Other users are unaffected.
    await asUser(db, alice, async () => {
      await db.query(`select public.start_play_session('stack')`);
    });
  });

  test('end_play_session closes the session once and records the play (plays, playtime, last_played_at)', async () => {
    const before = await db.query<{ plays: number; playtime_s: number }>(
      `select plays, playtime_s from public.game_stats where user_id = $1 and game_id = 'stack'`,
      [alice],
    );
    assert.equal(before.rows.length, 0);
    const id = await startSession(db, alice, 'stack', 300);
    await asUser(db, alice, async () => {
      await db.query(`select public.end_play_session($1, 120)`, [id]);
      // Idempotent: a second end changes nothing.
      await db.query(`select public.end_play_session($1, 120)`, [id]);
    });
    const s = await db.query<{ ended_at: Date | null; playtime_s: number }>(
      `select ended_at, playtime_s from public.play_sessions where id = $1`,
      [id],
    );
    assert.ok(s.rows[0]!.ended_at);
    assert.equal(s.rows[0]!.playtime_s, 120);
    const st = await db.query<{ plays: number; playtime_s: number; last_played_at: Date | null }>(
      `select plays, playtime_s, last_played_at from public.game_stats where user_id = $1 and game_id = 'stack'`,
      [alice],
    );
    assert.equal(st.rows[0]!.plays, 1);
    assert.equal(st.rows[0]!.playtime_s, 120);
    assert.ok(st.rows[0]!.last_played_at);
  });

  test('playtime is clamped to [0, seconds since start]', async () => {
    const short = await startSession(db, alice, 'stack', 30);
    const negative = await startSession(db, alice, 'stack', 30);
    await asUser(db, alice, async () => {
      await db.query(`select public.end_play_session($1, 99999)`, [short]);
      await db.query(`select public.end_play_session($1, -5)`, [negative]);
    });
    const r = await db.query<{ id: string; playtime_s: number }>(
      `select id, playtime_s from public.play_sessions where id in ($1, $2)`,
      [short, negative],
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.playtime_s]));
    assert.ok(by[short]! >= 30 && by[short]! <= 32, `clamped to elapsed, got ${by[short]}`);
    assert.equal(by[negative], 0);
  });

  test("end_play_session refuses someone else's or an unknown session", async () => {
    const id = await startSession(db, alice, 'stack');
    await asUser(db, bob, async () => {
      await assert.rejects(db.query(`select public.end_play_session($1, 10)`, [id]), notFound);
      await assert.rejects(db.query(`select public.end_play_session(gen_random_uuid(), 10)`), notFound);
    });
    assert.equal(await count(db, `select 1 from public.play_sessions where id = $1 and ended_at is null`, [id]), 1);
  });

  test('record_play still works (M1 fallback)', async () => {
    await asUser(db, bob, async () => {
      await db.query(`select public.record_play('stack', 10)`);
    });
    assert.equal(await count(db, `select 1 from public.game_stats where user_id = $1 and plays = 1`, [bob]), 1);
  });

  test('sessions are owner-read only; no direct writes', async () => {
    await asUser(db, bob, async () => {
      assert.equal(await count(db, `select 1 from public.play_sessions where user_id = $1`, [alice]), 0);
      assert.ok((await count(db, `select 1 from public.play_sessions`)) > 0);
      await assert.rejects(
        db.query(`insert into public.play_sessions (user_id, game_id) values ($1, 'stack')`, [bob]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`update public.play_sessions set started_at = now() - interval '1 day'`),
        /permission denied/,
      );
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select 1 from public.play_sessions`), /permission denied/);
    });
  });

  test('anonymous sessions, signed-out clients and missing subjects are refused', async () => {
    const id = await startSession(db, alice, 'stack');
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.start_play_session('stack')`), anonymousForbidden);
      await assert.rejects(db.query(`select public.end_play_session($1, 1)`, [id]), anonymousForbidden);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.start_play_session('stack')`), /permission denied/);
      await assert.rejects(db.query(`select public.end_play_session($1, 1)`, [id]), /permission denied/);
    });
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.start_play_session('stack')`), unauthenticated);
      await assert.rejects(db.query(`select public.end_play_session($1, 1)`, [id]), unauthenticated);
    });
    assert.equal(await count(db, `select 1 from public.play_sessions where user_id = $1`, [ghost]), 0);
  });
});

describe('submit_solo_score', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let carol: string;
  let ghost: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'arena');
    await db.query(`update public.games set modes = '{quick,private}' where id = 'arena'`);
    await insertGame(db, 'secret', 'draft');
    await insertGame(db, 'other');
    // height: primary (oldest) board, desc, bounded at 100/min. time: asc. weekly/daily: period boards.
    await addBoard(db, 'stack', 'height', 'desc', { max: 100, createdAgoS: 60 });
    await addBoard(db, 'stack', 'time', 'asc', { createdAgoS: 30 });
    await addBoard(db, 'stack', 'weekly', 'desc', { period: 'weekly', createdAgoS: 20 });
    await addBoard(db, 'stack', 'daily', 'desc', { period: 'daily', createdAgoS: 10 });
    await addBoard(db, 'arena', 'kills', 'desc');
    await addBoard(db, 'secret', 'score', 'desc');
    await addBoard(db, 'other', 'score', 'desc');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
    carol = await signUp(db, { username: 'carol', birth_date: '2000-01-01' });
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  after(() => db.close());
  // Most tests submit more than the per-minute budget in total; only the rate-limit test exercises it.
  beforeEach(() => db.query(`delete from public.rate_limits`).then(() => undefined));

  test('first score is accepted with best and rank; source is client; result shape is exact', async () => {
    const s = await startSession(db, alice, 'stack', 30);
    const r = await submitAs(db, alice, 'stack', 'height', 42, s);
    assert.deepEqual(r, { accepted: true, best: 42, rank: 1, reason: null });
    const e = await db.query(
      `select e.period_key, e.score, e.source from public.leaderboard_entries e
         join public.leaderboards b on b.id = e.leaderboard_id where b.key = 'height' and e.user_id = $1`,
      [alice],
    );
    assert.deepEqual(e.rows, [{ period_key: 'all', score: 42, source: 'client' }]);
  });

  test('desc board keeps the higher score; ties and lower scores are not_best', async () => {
    const s = await startSession(db, bob, 'stack', 30);
    assert.deepEqual(await submitAs(db, bob, 'stack', 'height', 50, s), {
      accepted: true,
      best: 50,
      rank: 1,
      reason: null,
    });
    assert.deepEqual(await submitAs(db, bob, 'stack', 'height', 40, s), {
      accepted: false,
      best: 50,
      rank: 1,
      reason: 'not_best',
    });
    assert.deepEqual(await submitAs(db, bob, 'stack', 'height', 50, s), {
      accepted: false,
      best: 50,
      rank: 1,
      reason: 'not_best',
    });
    assert.deepEqual(await submitAs(db, bob, 'stack', 'height', 60.5, s), {
      accepted: true,
      best: 60.5,
      rank: 1,
      reason: null,
    });
    // alice (42) is now second.
    const s2 = await startSession(db, alice, 'stack', 30);
    assert.deepEqual(await submitAs(db, alice, 'stack', 'height', 10, s2), {
      accepted: false,
      best: 42,
      rank: 2,
      reason: 'not_best',
    });
  });

  test('asc board keeps the lower score; rank counts strictly better scores', async () => {
    const sa = await startSession(db, alice, 'stack', 30);
    const sb = await startSession(db, bob, 'stack', 30);
    const sc = await startSession(db, carol, 'stack', 30);
    assert.equal((await submitAs(db, alice, 'stack', 'time', 30, sa)).accepted, true);
    assert.deepEqual(await submitAs(db, alice, 'stack', 'time', 20, sa), {
      accepted: true,
      best: 20,
      rank: 1,
      reason: null,
    });
    assert.deepEqual(await submitAs(db, alice, 'stack', 'time', 25, sa), {
      accepted: false,
      best: 20,
      rank: 1,
      reason: 'not_best',
    });
    assert.deepEqual(await submitAs(db, bob, 'stack', 'time', 20, sb), {
      accepted: true,
      best: 20,
      rank: 1,
      reason: null,
    });
    assert.deepEqual(await submitAs(db, carol, 'stack', 'time', 21, sc), {
      accepted: true,
      best: 21,
      rank: 3,
      reason: null,
    });
    assert.deepEqual(await submitAs(db, carol, 'stack', 'time', 0, sc), {
      accepted: true,
      best: 0,
      rank: 1,
      reason: null,
    });
  });

  test('bounds: score <= max_score_per_minute * ceil(minutes since start), at least one minute', async () => {
    const cases: [ageS: number, ok: number, tooHigh: number][] = [
      [5, 100, 100.001], // under a minute counts as one
      [59, 100, 101],
      [61, 200, 201], // ceil(61/60) = 2
      [119, 200, 200.5],
      [179, 300, 301],
      [3600 * 5 - 1, 30000, 30001], // 299.98 min -> 300
    ];
    for (const [ageS, ok, tooHigh] of cases) {
      await db.query(`delete from public.leaderboard_entries where user_id = $1`, [carol]);
      const s = await startSession(db, carol, 'stack', ageS);
      const high = await submitAs(db, carol, 'stack', 'height', tooHigh, s);
      assert.deepEqual(high, { accepted: false, best: null, rank: null, reason: 'bounds' }, `${ageS}s: ${tooHigh}`);
      const fine = await submitAs(db, carol, 'stack', 'height', ok, s);
      assert.equal(fine.accepted, true, `${ageS}s: ${ok}`);
      // Once there is an entry, a rejected submit still reports it.
      const again = await submitAs(db, carol, 'stack', 'height', tooHigh, s);
      assert.deepEqual([again.reason, again.best], ['bounds', ok]);
    }
    // Unbounded boards take any finite score.
    const s = await startSession(db, carol, 'stack', 5);
    assert.equal((await submitAs(db, carol, 'stack', 'weekly', 1e12, s)).accepted, true);
  });

  test('session timing: at least 3 s old, less than 24 h old', async () => {
    const fresh = await startSession(db, carol, 'stack', 0);
    assert.deepEqual(await submitAs(db, carol, 'stack', 'daily', 1, fresh), {
      accepted: false,
      best: null,
      rank: null,
      reason: 'session_too_new',
    });
    const almost = await startSession(db, carol, 'stack', 2);
    assert.equal((await submitAs(db, carol, 'stack', 'daily', 1, almost)).reason, 'session_too_new');
    const ok = await startSession(db, carol, 'stack', 3);
    assert.equal((await submitAs(db, carol, 'stack', 'daily', 1, ok)).accepted, true);
    const stale = await startSession(db, carol, 'stack', 86400);
    assert.equal((await submitAs(db, carol, 'stack', 'daily', 2, stale)).reason, 'session_expired');
    const lastMinute = await startSession(db, carol, 'stack', 86400 - 60);
    assert.equal((await submitAs(db, carol, 'stack', 'daily', 2, lastMinute)).accepted, true);
  });

  test('an ended session can still carry a score (the host may close it before the last submit lands)', async () => {
    const s = await startSession(db, bob, 'stack', 30);
    await asUser(db, bob, () => db.query(`select public.end_play_session($1, 10)`, [s]));
    assert.equal((await submitAs(db, bob, 'stack', 'daily', 5, s)).accepted, true);
  });

  test('period boards write under the current period key; older periods do not count', async () => {
    const weekly = (await db.query<{ id: string }>(`select id from public.leaderboards where key = 'weekly'`)).rows[0]!
      .id;
    // A huge score from last week does not block this week's entry.
    await db.query(
      `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score)
       values ($1, public.period_key('weekly', now() - interval '7 days'), $2, 1e9)`,
      [weekly, alice],
    );
    const s = await startSession(db, alice, 'stack', 30);
    const r = await submitAs(db, alice, 'stack', 'weekly', 10, s);
    assert.equal(r.accepted, true);
    const keys = await db.query<{ period_key: string; current: string }>(
      `select period_key, public.period_key('weekly') as current from public.leaderboard_entries
        where leaderboard_id = $1 and user_id = $2 order by score`,
      [weekly, alice],
    );
    assert.equal(keys.rows[0]!.period_key, keys.rows[0]!.current);
    assert.match(keys.rows[0]!.period_key, /^\d{4}-W\d{2}$/);
    assert.notEqual(keys.rows[1]!.period_key, keys.rows[0]!.period_key);

    const daily = await db.query<{ period_key: string }>(
      `select e.period_key from public.leaderboard_entries e join public.leaderboards b on b.id = e.leaderboard_id
        where b.key = 'daily' limit 1`,
    );
    assert.match(daily.rows[0]!.period_key, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('game_stats.best_score follows the primary (oldest) board only, per its sort', async () => {
    const dave = await signUp(db, { username: 'dave', birth_date: '2000-01-01' });
    const best = async () =>
      (
        await db.query<{ best_score: number | null }>(
          `select best_score from public.game_stats where user_id = $1 and game_id = 'stack'`,
          [dave],
        )
      ).rows[0]?.best_score;
    const s = await startSession(db, dave, 'stack', 120);
    await submitAs(db, dave, 'stack', 'time', 5, s); // secondary board: no stats row
    assert.equal(await best(), undefined);
    await submitAs(db, dave, 'stack', 'height', 70, s);
    assert.equal(await best(), 70);
    await submitAs(db, dave, 'stack', 'height', 65, s); // not_best: unchanged
    assert.equal(await best(), 70);
    await submitAs(db, dave, 'stack', 'height', 150, s);
    assert.equal(await best(), 150);
    await submitAs(db, dave, 'stack', 'weekly', 9999, s); // secondary board
    assert.equal(await best(), 150);
    // Stats row created by the score keeps plays at 0 until the session ends.
    const st = await db.query(`select plays from public.game_stats where user_id = $1 and game_id = 'stack'`, [dave]);
    assert.deepEqual(st.rows, [{ plays: 0 }]);

    // asc primary board: lower is better.
    await insertGame(db, 'race');
    await addBoard(db, 'race', 'lap', 'asc', { createdAgoS: 5 });
    await addBoard(db, 'race', 'total', 'asc');
    const r = await startSession(db, dave, 'race', 30);
    await submitAs(db, dave, 'race', 'lap', 50, r);
    await submitAs(db, dave, 'race', 'lap', 40, r);
    await submitAs(db, dave, 'race', 'total', 1, r);
    const race = await db.query(`select best_score from public.game_stats where user_id = $1 and game_id = 'race'`, [
      dave,
    ]);
    assert.deepEqual(race.rows, [{ best_score: 40 }]);
  });

  test('rate limit: 30 submits per user per minute, then rate_limited until the bucket refills', async () => {
    const erin = await signUp(db, { username: 'erin', birth_date: '2000-01-01' });
    const s = await startSession(db, erin, 'stack', 30);
    for (let i = 1; i <= 30; i++) {
      const r = await submitAs(db, erin, 'stack', 'height', i, s);
      assert.equal(r.accepted, true, `submit ${i}`);
    }
    const limited = await submitAs(db, erin, 'stack', 'height', 99, s);
    assert.deepEqual(limited, { accepted: false, best: 30, rank: limited.rank, reason: 'rate_limited' });
    // Rejected submits (any reason) count too, and other users are unaffected.
    assert.equal((await submitAs(db, erin, 'stack', 'height', 1, s)).reason, 'rate_limited');
    const sa = await startSession(db, alice, 'stack', 30);
    assert.notEqual((await submitAs(db, alice, 'stack', 'height', 1, sa)).reason, 'rate_limited');
    // 4 s later two tokens are back (0.5 per second).
    await db.query(
      `update public.rate_limits set refilled_at = refilled_at - interval '4 seconds' where user_id = $1`,
      [erin],
    );
    assert.equal((await submitAs(db, erin, 'stack', 'height', 31, s)).accepted, true);
    assert.equal((await submitAs(db, erin, 'stack', 'height', 32, s)).accepted, true);
    assert.equal((await submitAs(db, erin, 'stack', 'height', 33, s)).reason, 'rate_limited');
    // A full minute refills the bucket, capped at 30.
    await db.query(
      `update public.rate_limits set refilled_at = refilled_at - interval '10 minutes' where user_id = $1`,
      [erin],
    );
    for (let i = 0; i < 30; i++) await submitAs(db, erin, 'stack', 'height', 1, s);
    assert.equal((await submitAs(db, erin, 'stack', 'height', 1, s)).reason, 'rate_limited');
  });

  test('invalid input raises: score, board, game, mode, session', async () => {
    const s = await startSession(db, alice, 'stack', 30);
    const so = await startSession(db, alice, 'other', 30);
    const sb = await startSession(db, bob, 'stack', 30);
    const submit = (game: string, board: string, score: number | string, session: string) =>
      asUser(db, alice, () =>
        db.query(`select public.submit_solo_score($1, $2, $3::double precision, $4)`, [game, board, score, session]),
      );
    await assert.rejects(submit('stack', 'height', -1, s), invalid);
    await assert.rejects(submit('stack', 'height', 'NaN', s), invalid);
    await assert.rejects(submit('stack', 'height', 'Infinity', s), invalid);
    await assert.rejects(submit('stack', 'height', '-Infinity', s), invalid);
    await assert.rejects(submit('stack', 'nope', 1, s), notFound);
    await assert.rejects(submit('secret', 'score', 1, s), notFound);
    await assert.rejects(submit('nope', 'score', 1, s), notFound);
    await assert.rejects(submit('arena', 'kills', 1, s), invalid); // not a solo game
    await assert.rejects(submit('stack', 'height', 1, sb), notFound); // someone else's session
    await assert.rejects(submit('stack', 'height', 1, '00000000-0000-0000-0000-000000000000'), notFound);
    await assert.rejects(submit('stack', 'height', 1, so), invalid); // session of another game
    // Raising rolls back: no token was spent on any of the above.
    assert.equal(await count(db, `select 1 from public.rate_limits where user_id = $1`, [alice]), 0);
  });

  test('anonymous sessions, signed-out clients and missing subjects are refused', async () => {
    const s = await startSession(db, alice, 'stack', 30);
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(
        db.query(`select public.submit_solo_score('stack', 'height', 1, $1)`, [s]),
        anonymousForbidden,
      );
    });
    await asAnon(db, async () => {
      await assert.rejects(
        db.query(`select public.submit_solo_score('stack', 'height', 1, $1)`, [s]),
        /permission denied/,
      );
    });
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.submit_solo_score('stack', 'height', 1, $1)`, [s]), unauthenticated);
    });
  });

  test('entries are readable by signed-in users, not writable; anon has no table access', async () => {
    await asUser(db, carol, async () => {
      assert.ok((await count(db, `select 1 from public.leaderboard_entries where user_id = $1`, [alice])) > 0);
      await assert.rejects(db.query(`update public.leaderboard_entries set score = 1e9`), /permission denied/);
      await assert.rejects(db.query(`delete from public.leaderboard_entries`), /permission denied/);
      const board = (await db.query<{ id: string }>(`select id from public.leaderboards where key = 'height'`)).rows[0]!
        .id;
      await assert.rejects(
        db.query(
          `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score) values ($1, 'all', $2, 1e9)`,
          [board, carol],
        ),
        /permission denied/,
      );
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select 1 from public.leaderboard_entries`), /permission denied/);
    });
  });
});

describe('leaderboard_top and my_leaderboard_rank', () => {
  let db: PGlite;
  const users: Record<string, string> = {};

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'secret', 'draft');
    const height = await addBoard(db, 'stack', 'height', 'desc');
    const time = await addBoard(db, 'stack', 'time', 'asc');
    const weekly = await addBoard(db, 'stack', 'weekly', 'desc', { period: 'weekly' });
    const hidden = await addBoard(db, 'secret', 'score', 'desc');
    for (const name of ['ann', 'ben', 'cat', 'dan', 'eve']) {
      users[name] = await signUp(db, { username: name, birth_date: '2000-01-01' });
    }
    // Entries as the RPCs would write them; updated_at breaks ties (earlier first).
    const entry = (board: string, user: string, score: number, agoS: number, pk = 'all') =>
      db.query(
        `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score, updated_at)
         values ($1, $2, $3, $4, now() - make_interval(secs => $5))`,
        [board, pk, users[user], score, agoS],
      );
    await entry(height, 'ann', 10, 50);
    await entry(height, 'ben', 30, 40);
    await entry(height, 'cat', 30, 60); // ties with ben, got there first
    await entry(height, 'dan', 5, 10);
    await entry(time, 'ann', 12.5, 10);
    await entry(time, 'ben', 9.75, 10);
    await entry(time, 'cat', 20, 10);
    await entry(time, 'dan', 9.75, 20);
    await db.query(
      `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score)
       values ($1, public.period_key('weekly'), $2, 7), ($1, public.period_key('weekly', now() - interval '8 days'), $3, 100)`,
      [weekly, users.ann, users.ben],
    );
    await entry(hidden, 'ann', 1, 0);
  });
  after(() => db.close());

  test('desc board: best first, ties share a rank and list the earlier score first', async () => {
    const rows = await asUser(db, users.ann!, () => topRows(db, 'stack', 'height'));
    assert.deepEqual(
      rows.map((r) => [r.rank, r.username, r.score, r.is_me]),
      [
        [1, 'cat', 30, false],
        [1, 'ben', 30, false],
        [3, 'ann', 10, true],
        [4, 'dan', 5, false],
      ],
    );
    assert.equal(rows[0]!.user_id, users.cat);
    assert.match(rows[0]!.avatar_url ?? '', /^defaults\/avatar-\d{2}\.webp$/);
  });

  test('asc board: lowest first', async () => {
    const rows = await asUser(db, users.eve!, () => topRows(db, 'stack', 'time'));
    assert.deepEqual(
      rows.map((r) => [r.rank, r.username, r.score]),
      [
        [1, 'dan', 9.75],
        [1, 'ben', 9.75],
        [3, 'ann', 12.5],
        [4, 'cat', 20],
      ],
    );
    assert.ok(rows.every((r) => r.is_me === false));
  });

  test('limit is clamped to 1..100 (null means 25); rank is computed before the limit', async () => {
    await asUser(db, users.ann!, async () => {
      assert.equal((await topRows(db, 'stack', 'height', 'global', 2)).length, 2);
      assert.equal((await topRows(db, 'stack', 'height', 'global', 0)).length, 1);
      assert.equal((await topRows(db, 'stack', 'height', 'global', -5)).length, 1);
      assert.equal((await topRows(db, 'stack', 'height', 'global', 100000)).length, 4);
      assert.equal((await topRows(db, 'stack', 'height', 'global', null)).length, 4);
      const defaults = await db.query(`select * from public.leaderboard_top('stack', 'height')`);
      assert.equal(defaults.rows.length, 4);
      const three = await topRows(db, 'stack', 'height', 'global', 3);
      assert.deepEqual(
        three.map((r) => r.rank),
        [1, 1, 3],
      );
    });
  });

  test('current period only', async () => {
    const rows = await asUser(db, users.ann!, () => topRows(db, 'stack', 'weekly'));
    assert.deepEqual(
      rows.map((r) => [r.username, r.score]),
      [['ann', 7]],
    );
  });

  test('signed out (anon key): global works with is_me false; friends is empty', async () => {
    await asAnon(db, async () => {
      const rows = await topRows(db, 'stack', 'height');
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => r.is_me === false));
      assert.deepEqual(await topRows(db, 'stack', 'height', 'friends'), []);
    });
  });

  test("friends scope is the caller's own row until friendships exist (M4)", async () => {
    await asUser(db, users.dan!, async () => {
      const rows = await topRows(db, 'stack', 'height', 'friends');
      assert.deepEqual(
        rows.map((r) => [r.rank, r.username, r.score, r.is_me]),
        [[1, 'dan', 5, true]],
      );
    });
    await asUser(db, users.eve!, async () => {
      assert.deepEqual(await topRows(db, 'stack', 'height', 'friends'), []);
    });
  });

  test('unknown board, unpublished game or bad scope raise', async () => {
    await asAnon(db, async () => {
      await assert.rejects(topRows(db, 'stack', 'nope'), notFound);
      await assert.rejects(topRows(db, 'secret', 'score'), notFound);
      await assert.rejects(topRows(db, 'stack', 'height', 'world'), invalid);
    });
  });

  test('my_leaderboard_rank: {score, rank} for the current period, null without an entry', async () => {
    const rank = (uid: string, board: string) =>
      asUser(
        db,
        uid,
        async () =>
          (await db.query<{ r: unknown }>(`select public.my_leaderboard_rank('stack', $1) as r`, [board])).rows[0]!.r,
      );
    assert.deepEqual(await rank(users.ben!, 'height'), { score: 30, rank: 1 });
    assert.deepEqual(await rank(users.ann!, 'height'), { score: 10, rank: 3 });
    assert.deepEqual(await rank(users.ann!, 'time'), { score: 12.5, rank: 3 });
    assert.deepEqual(await rank(users.ben!, 'time'), { score: 9.75, rank: 1 });
    assert.equal(await rank(users.eve!, 'height'), null);
    assert.equal(await rank(users.ben!, 'weekly'), null, 'last week does not count');
    await asUser(db, users.ann!, async () => {
      await assert.rejects(db.query(`select public.my_leaderboard_rank('stack', 'nope')`), notFound);
      await assert.rejects(db.query(`select public.my_leaderboard_rank('secret', 'score')`), notFound);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.my_leaderboard_rank('stack', 'height')`), /permission denied/);
    });
    const ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.my_leaderboard_rank('stack', 'height')`), anonymousForbidden);
    });
  });
});

describe('achievements and public profile stats', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let ghost: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'secret', 'draft');
    await insertGame(db, 'other');
    await addAchievement(db, 'stack', 'first_drop');
    await addAchievement(db, 'stack', 'tower_50', true);
    await addAchievement(db, 'secret', 'first_drop');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  after(() => db.close());

  const unlock = (uid: string, game: string, key: string) =>
    asUser(
      db,
      uid,
      async () =>
        (await db.query<{ r: unknown }>(`select public.unlock_achievement($1, $2) as r`, [game, key])).rows[0]!.r,
    );

  test('unlock_achievement is idempotent: {unlocked, alreadyHad}', async () => {
    assert.deepEqual(await unlock(alice, 'stack', 'first_drop'), { unlocked: true, alreadyHad: false });
    assert.deepEqual(await unlock(alice, 'stack', 'first_drop'), { unlocked: true, alreadyHad: true });
    assert.deepEqual(await unlock(alice, 'stack', 'tower_50'), { unlocked: true, alreadyHad: false });
    assert.deepEqual(await unlock(bob, 'stack', 'first_drop'), { unlocked: true, alreadyHad: false });
    assert.equal(await count(db, `select 1 from public.user_achievements where user_id = $1`, [alice]), 2);
  });

  test('unknown achievement, or one of an unpublished game, is NOT_FOUND', async () => {
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select public.unlock_achievement('stack', 'nope')`), notFound);
      await assert.rejects(db.query(`select public.unlock_achievement('secret', 'first_drop')`), notFound);
      await assert.rejects(db.query(`select public.unlock_achievement('other', 'first_drop')`), notFound);
    });
  });

  test('anonymous sessions, signed-out clients and missing subjects are refused', async () => {
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.unlock_achievement('stack', 'first_drop')`), anonymousForbidden);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.unlock_achievement('stack', 'first_drop')`), /permission denied/);
    });
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.unlock_achievement('stack', 'first_drop')`), unauthenticated);
    });
    assert.equal(await count(db, `select 1 from public.user_achievements where user_id = $1`, [ghost]), 0);
  });

  test("signed-in users read anyone's unlocked achievements (public profiles); no direct writes", async () => {
    await asUser(db, bob, async () => {
      const r = await db.query<{ key: string }>(
        `select a.key from public.user_achievements ua join public.achievements a on a.id = ua.achievement_id
          where ua.user_id = $1 order by a.key`,
        [alice],
      );
      assert.deepEqual(
        r.rows.map((x) => x.key),
        ['first_drop', 'tower_50'],
      );
      const ach = (await db.query<{ id: string }>(`select id from public.achievements where key = 'tower_50'`)).rows[0]!
        .id;
      await assert.rejects(
        db.query(`insert into public.user_achievements (user_id, achievement_id) values ($1, $2)`, [bob, ach]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`delete from public.user_achievements where user_id = $1`, [bob]),
        /permission denied/,
      );
    });
  });

  test('anonymous sessions see only their own achievements; anon has no table access', async () => {
    await asAnonymousUser(db, ghost, async () => {
      assert.equal(await count(db, `select 1 from public.user_achievements`), 0);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select 1 from public.user_achievements`), /permission denied/);
    });
  });

  test("other users' game_stats stay private", async () => {
    await asUser(db, alice, () => db.query(`select public.record_play('stack', 5)`));
    await asUser(db, bob, async () => {
      assert.equal(await count(db, `select 1 from public.game_stats where user_id = $1`, [alice]), 0);
    });
  });

  test('public_profile_stats: achievements and distinct games played, computed server-side', async () => {
    await asUser(db, alice, () => db.query(`select public.record_play('other', 5)`));
    await asUser(db, alice, () => db.query(`select public.record_play('stack', 5)`));
    const stats = (uid: string, target: string) =>
      asUser(
        db,
        uid,
        async () =>
          (await db.query<{ r: unknown }>(`select public.public_profile_stats($1) as r`, [target])).rows[0]!.r,
      );
    assert.deepEqual(await stats(bob, alice), { achievements: 2, games_played: 2 });
    assert.deepEqual(await stats(alice, bob), { achievements: 1, games_played: 0 });
    assert.deepEqual(await stats(alice, '00000000-0000-0000-0000-000000000000'), { achievements: 0, games_played: 0 });
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.public_profile_stats($1)`, [alice]), anonymousForbidden);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.public_profile_stats($1)`, [alice]), /permission denied/);
    });
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.public_profile_stats($1)`, [alice]), unauthenticated);
    });
  });

  test('deleting a user cascades their unlocks and entries', async () => {
    const tmp = await signUp(db, { username: 'tmp_user', birth_date: '2000-01-01' });
    await unlock(tmp, 'stack', 'first_drop');
    await db.query(`delete from auth.users where id = $1`, [tmp]);
    assert.equal(await count(db, `select 1 from public.user_achievements where user_id = $1`, [tmp]), 0);
  });
});

test('function privileges: only leaderboard_top and period_key are callable signed out', async () => {
  const db = await createTestDb();
  const fns = [
    ['public.period_key(text, timestamptz)', true, true],
    ['public.leaderboard_top(text, text, text, int)', true, true],
    ['public.start_play_session(text, text)', false, true],
    ['public.end_play_session(uuid, int)', false, true],
    ['public.submit_solo_score(text, text, double precision, uuid)', false, true],
    ['public.unlock_achievement(text, text)', false, true],
    ['public.my_leaderboard_rank(text, text)', false, true],
    ['public.public_profile_stats(uuid)', false, true],
    ['public.take_rate_limit_token(uuid, text, int, double precision)', false, false],
  ] as const;
  for (const [fn, anon, authenticated] of fns) {
    const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as auth,
              has_function_privilege('service_role', $1, 'execute') as svc`,
      [fn],
    );
    assert.deepEqual(r.rows[0], { anon, auth: authenticated, svc: true }, fn);
  }
  const tables = await db.query<{ t: string; anon: boolean; auth: boolean }>(
    `select t, has_table_privilege('anon', t, 'select') as anon, has_table_privilege('authenticated', t, 'select') as auth
       from unnest(array['public.leaderboards', 'public.achievements', 'public.leaderboard_entries',
                         'public.user_achievements', 'public.play_sessions', 'public.rate_limits']) t`,
  );
  assert.deepEqual(Object.fromEntries(tables.rows.map((r) => [r.t, [r.anon, r.auth]])), {
    'public.leaderboards': [true, true],
    'public.achievements': [true, true],
    'public.leaderboard_entries': [false, true],
    'public.user_achievements': [false, true],
    'public.play_sessions': [false, true],
    'public.rate_limits': [false, false],
  });
  for (const t of [
    'leaderboards',
    'achievements',
    'leaderboard_entries',
    'user_achievements',
    'play_sessions',
    'rate_limits',
  ]) {
    for (const priv of ['insert', 'update', 'delete']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_table_privilege('authenticated', $1, $2) or has_table_privilege('anon', $1, $2) as ok`,
        [`public.${t}`, priv],
      );
      assert.equal(r.rows[0]!.ok, false, `${t} ${priv}`);
    }
  }
  await db.close();
});
