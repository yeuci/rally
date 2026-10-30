// 20261030000400_hardening.sql: fixes from the codebase audit (record_play, score bounds, asc boards, achievements,
// save_put races and caps, retention jobs, leaderboard_entries reads, storage listing and avatar fences, avatar_url,
// release_username, unconfirmed email signups). Concurrency races are reproduced deterministically with a test-only
// BEFORE INSERT trigger that writes the conflicting row first, which is exactly what a concurrent transaction that
// commits between our read and our insert looks like.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const MIGRATION = new URL('../supabase/migrations/20261030000400_hardening.sql', import.meta.url);

interface SubmitResult {
  accepted: boolean;
  best: number | null;
  rank: number | null;
  reason: string | null;
}

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

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
const checkViolation = sqlstate('23514', /profiles_avatar_url_format/);

async function addBoard(
  db: PGlite,
  game: string,
  key: string,
  sort: 'asc' | 'desc',
  opts: { max?: number | null; createdAgoS?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.leaderboards (game_id, key, sort, max_score_per_minute, created_at)
     values ($1, $2, $3, $4, now() - make_interval(secs => $5)) returning id`,
    [game, key, sort, opts.max ?? null, opts.createdAgoS ?? 0],
  );
  return r.rows[0]!.id;
}

/** start_play_session as `uid`, then backdate it: started `ageS` ago, ended `endedAgoS` ago (if given). */
async function startSession(db: PGlite, uid: string, game: string, ageS = 10, endedAgoS?: number): Promise<string> {
  const id = await asUser(
    db,
    uid,
    async () => (await db.query<{ id: string }>(`select public.start_play_session($1) as id`, [game])).rows[0]!.id,
  );
  await db.query(
    `update public.play_sessions
        set started_at = now() - make_interval(secs => $2),
            ended_at = case when $3::float8 is null then null else now() - make_interval(secs => $3::float8) end
      where id = $1`,
    [id, ageS, endedAgoS ?? null],
  );
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

const stats = async (db: PGlite, uid: string, game: string) =>
  (
    await db.query<{ plays: number; playtime_s: number }>(
      `select plays, playtime_s from public.game_stats where user_id = $1 and game_id = $2`,
      [uid, game],
    )
  ).rows[0];

// ---------------------------------------------------------------------------------------------------------------
// 1. record_play
// ---------------------------------------------------------------------------------------------------------------

describe('record_play (fallback when no play session could be started)', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'other');
    await insertGame(db, 'secret', 'draft');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  });
  after(() => db.close());
  beforeEach(async () => {
    await db.query(`delete from public.rate_limits`);
    await db.query(`delete from public.game_stats`);
    await db.query(`delete from public.play_sessions`);
  });
  const record = (game: string, playtime: number) =>
    asUser(db, alice, () => db.query(`select public.record_play($1, $2)`, [game, playtime]));
  const ageLastPlay = (game: string, s: number) =>
    db.query(
      `update public.game_stats set last_played_at = last_played_at - make_interval(secs => $3)
        where user_id = $1 and game_id = $2`,
      [alice, game, s],
    );

  test('published games only: drafts and unknown games are NOT_FOUND (no stats row, games_played unchanged)', async () => {
    await assert.rejects(record('secret', 10), notFound);
    await assert.rejects(record('nope', 10), notFound);
    assert.equal(await count(db, `select 1 from public.game_stats where user_id = $1`, [alice]), 0);
  });

  test('at most one play per minute per game (RATE_LIMITED); other games are independent', async () => {
    await record('stack', 30);
    await assert.rejects(record('stack', 30), rateLimited);
    await record('other', 30);
    assert.deepEqual(await stats(db, alice, 'stack'), { plays: 1, playtime_s: 30 });
    await ageLastPlay('stack', 61);
    await record('stack', 30);
    assert.equal((await stats(db, alice, 'stack'))!.plays, 2);
  });

  test('playtime is capped at 2 h per call and at the wall-clock time since the previous play', async () => {
    await record('stack', 999999);
    assert.deepEqual(await stats(db, alice, 'stack'), { plays: 1, playtime_s: 7200 });
    await ageLastPlay('stack', 120);
    await record('stack', 3600);
    const s = (await stats(db, alice, 'stack'))!;
    assert.ok(s.playtime_s >= 7200 + 120 && s.playtime_s <= 7200 + 122, `got ${s.playtime_s}`);
    await ageLastPlay('stack', 600);
    await record('stack', -50);
    assert.equal((await stats(db, alice, 'stack'))!.plays, 3);
    assert.equal((await stats(db, alice, 'stack'))!.playtime_s, s.playtime_s);
  });

  test('refused (CONFLICT) while the caller has an open play session for the game; fine once it ended', async () => {
    const id = await startSession(db, alice, 'stack', 60);
    await assert.rejects(record('stack', 30), conflict);
    await record('other', 30); // another game has no open session
    await asUser(db, alice, () => db.query(`select public.end_play_session($1, 30)`, [id]));
    await ageLastPlay('stack', 61);
    await record('stack', 30);
    assert.equal((await stats(db, alice, 'stack'))!.plays, 2);
    // A session left open for more than 24 h is abandoned and does not block.
    await startSession(db, alice, 'other', 86400 + 60);
    await ageLastPlay('other', 61);
    await record('other', 30);
  });

  test('token bucket: 12 counted plays per game per hour', async () => {
    for (let i = 1; i <= 12; i++) {
      await record('stack', 1);
      await ageLastPlay('stack', 61);
    }
    await assert.rejects(record('stack', 1), rateLimited);
    assert.equal((await stats(db, alice, 'stack'))!.plays, 12);
    await record('other', 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 14. abandon_play_session
// ---------------------------------------------------------------------------------------------------------------

describe('abandon_play_session (launch that never reached ready)', () => {
  let db: PGlite;
  let alice: string;
  let bob: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await addBoard(db, 'stack', 'free', 'desc');
    await db.query(`insert into public.achievements (game_id, key, title) values ('stack', 'a1', 'A1'), ('stack', 'a2', 'A2')`);
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    bob = await signUp(db, { username: 'bob', birth_date: '2000-01-01' });
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  after(() => db.close());
  const abandon = (uid: string, id: string) =>
    asUser(db, uid, () => db.query(`select public.abandon_play_session($1)`, [id]));

  test('closes the session without counting a play; record_play then works; idempotent', async () => {
    const s = await startSession(db, alice, 'stack', 30);
    await assert.rejects(asUser(db, alice, () => db.query(`select public.record_play('stack', 5)`)), conflict);
    await abandon(alice, s);
    const row = await db.query<{ ended: boolean; playtime_s: number }>(
      `select ended_at is not null as ended, playtime_s from public.play_sessions where id = $1`,
      [s],
    );
    assert.deepEqual(row.rows, [{ ended: true, playtime_s: 0 }]);
    assert.equal(await count(db, `select 1 from public.game_stats where user_id = $1`, [alice]), 0);
    const endedAt = async () =>
      (await db.query<{ t: string }>(`select ended_at::text as t from public.play_sessions where id = $1`, [s])).rows[0]!.t;
    const first = await endedAt();
    await abandon(alice, s); // no-op
    assert.equal(await endedAt(), first);
    await asUser(db, alice, () => db.query(`select public.end_play_session($1, 10)`, [s])); // already ended: no-op
    assert.equal(await count(db, `select 1 from public.game_stats where user_id = $1`, [alice]), 0);
    await asUser(db, alice, () => db.query(`select public.record_play('stack', 5)`));
    assert.deepEqual(await stats(db, alice, 'stack'), { plays: 1, playtime_s: 5 });
  });

  test('a session ended by end_play_session keeps its play and playtime', async () => {
    const s = await startSession(db, bob, 'stack', 60);
    await asUser(db, bob, () => db.query(`select public.end_play_session($1, 40)`, [s]));
    await abandon(bob, s);
    assert.deepEqual(await stats(db, bob, 'stack'), { plays: 1, playtime_s: 40 });
    assert.equal(
      await count(db, `select 1 from public.play_sessions where id = $1 and playtime_s = 40`, [s]),
      1,
    );
  });

  test('scores and unlocks treat an abandoned session like an ended one', async () => {
    await db.query(`delete from public.play_sessions where user_id = $1`, [alice]);
    const s = await startSession(db, alice, 'stack', 600);
    await abandon(alice, s);
    // Just ended: inside the 5-minute grace, with the bound computed on the session's duration.
    assert.equal((await submitAs(db, alice, 'stack', 'free', 1, s)).accepted, true);
    await asUser(db, alice, () => db.query(`select public.unlock_achievement('stack', 'a1')`));
    // More than 5 minutes later: expired, and no unlocks.
    await db.query(`update public.play_sessions set ended_at = now() - interval '6 minutes' where id = $1`, [s]);
    assert.equal((await submitAs(db, alice, 'stack', 'free', 2, s)).reason, 'session_expired');
    await assert.rejects(
      asUser(db, alice, () => db.query(`select public.unlock_achievement('stack', 'a2')`)),
      notFound,
    );
  });

  test("someone else's or an unknown session is NOT_FOUND; anonymous, signed out and no subject are refused", async () => {
    const s = await startSession(db, alice, 'stack', 30);
    await assert.rejects(abandon(bob, s), notFound);
    await assert.rejects(abandon(bob, '00000000-0000-0000-0000-000000000000'), notFound);
    assert.equal(await count(db, `select 1 from public.play_sessions where id = $1 and ended_at is null`, [s]), 1);
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.abandon_play_session($1)`, [s]), /ANONYMOUS_FORBIDDEN/);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.abandon_play_session($1)`, [s]), /permission denied/);
    });
    await asUser(db, '', async () => {
      await assert.rejects(db.query(`select public.abandon_play_session($1)`, [s]), /UNAUTHENTICATED/);
    });
    assert.equal(await count(db, `select 1 from public.play_sessions where id = $1 and ended_at is null`, [s]), 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2, 3, 11. submit_solo_score
// ---------------------------------------------------------------------------------------------------------------

describe('submit_solo_score hardening', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await addBoard(db, 'stack', 'height', 'desc', { max: 100, createdAgoS: 60 });
    await addBoard(db, 'stack', 'time', 'asc', { createdAgoS: 30 });
    await addBoard(db, 'stack', 'free', 'desc');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  });
  after(() => db.close());
  beforeEach(async () => {
    await db.query(`delete from public.rate_limits`);
    await db.query(`delete from public.leaderboard_entries`);
  });

  test('the bound uses the session duration: an ended session stops growing it', async () => {
    // Started 10 min ago, ended 4 min ago: 6 minutes of play -> bound 600 (it was 1000 before the fix).
    const s = await startSession(db, alice, 'stack', 600, 240);
    assert.equal((await submitAs(db, alice, 'stack', 'height', 601, s)).reason, 'bounds');
    assert.equal((await submitAs(db, alice, 'stack', 'height', 600, s)).accepted, true);
  });

  test('submits for a session that ended more than 5 minutes ago are session_expired', async () => {
    const s = await startSession(db, alice, 'stack', 900, 301);
    assert.deepEqual(await submitAs(db, alice, 'stack', 'free', 1, s), {
      accepted: false,
      best: null,
      rank: null,
      reason: 'session_expired',
    });
    const recent = await startSession(db, alice, 'stack', 900, 290);
    assert.equal((await submitAs(db, alice, 'stack', 'free', 1, recent)).accepted, true);
  });

  test('an open session counts at most 2 h towards the bound', async () => {
    const s = await startSession(db, alice, 'stack', 5 * 3600);
    assert.equal((await submitAs(db, alice, 'stack', 'height', 12001, s)).reason, 'bounds');
    assert.equal((await submitAs(db, alice, 'stack', 'height', 12000, s)).accepted, true);
  });

  test('ascending boards need a score > 0 (0 was an instant rank 1); descending boards accept 0', async () => {
    const s = await startSession(db, alice, 'stack', 60);
    await assert.rejects(submitAs(db, alice, 'stack', 'time', 0, s), invalid);
    await assert.rejects(submitAs(db, alice, 'stack', 'time', -0.0, s), invalid);
    assert.equal((await submitAs(db, alice, 'stack', 'time', 0.001, s)).accepted, true);
    assert.equal((await submitAs(db, alice, 'stack', 'free', 0, s)).accepted, true);
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      await assert.rejects(
        asUser(db, alice, () =>
          db.query(`select public.submit_solo_score('stack', 'free', $1::float8, $2)`, [bad, s]),
        ),
        invalid,
      );
    }
  });

  test('a concurrent better first score is never overwritten by a worse one', async () => {
    const s = await startSession(db, alice, 'stack', 60);
    // Simulate another transaction committing 50 between our read (no entry yet) and our upsert: the rate-limit
    // token is taken by a statement in between, so a trigger on rate_limits writes the competing entry there.
    // (A BEFORE INSERT trigger on leaderboard_entries itself would make ON CONFLICT DO UPDATE fail with 21000,
    // "cannot affect row a second time", which a real concurrent commit never causes.)
    await db.exec(`
      create function public.test_race_entry() returns trigger language plpgsql as $$
      begin
        if current_setting('test.race', true) = 'on' then
          perform set_config('test.race', 'off', false); -- session-wide: fire once
          insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score)
            select b.id, 'all', new.user_id, 50 from public.leaderboards b where b.key = 'free';
        end if;
        return new;
      end $$;
      create trigger test_race_entry after insert or update on public.rate_limits
        for each row execute function public.test_race_entry();
    `);
    try {
      await db.query(`select set_config('test.race', 'on', false)`);
      const r = await submitAs(db, alice, 'stack', 'free', 10, s);
      assert.deepEqual(r, { accepted: false, best: 50, rank: 1, reason: 'not_best' });
      const e = await db.query<{ score: number }>(`select score from public.leaderboard_entries where user_id = $1`, [
        alice,
      ]);
      assert.deepEqual(e.rows, [{ score: 50 }]);
      // A better score still replaces it.
      assert.equal((await submitAs(db, alice, 'stack', 'free', 60, s)).accepted, true);
    } finally {
      await db.exec(`drop trigger test_race_entry on public.rate_limits; drop function public.test_race_entry();`);
      await db.query(`select set_config('test.race', 'off', false)`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. unlock_achievement
// ---------------------------------------------------------------------------------------------------------------

describe('unlock_achievement needs a play session and is rate limited', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'other');
    await db.query(
      `insert into public.achievements (game_id, key, title) select 'stack', 'a' || g, 'A' || g from generate_series(1, 70) g`,
    );
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  });
  after(() => db.close());
  beforeEach(async () => {
    await db.query(`delete from public.rate_limits`);
    await db.query(`delete from public.user_achievements`);
    await db.query(`delete from public.play_sessions`);
  });
  const unlock = (key: string) =>
    asUser(
      db,
      alice,
      async () =>
        (
          await db.query<{ r: { unlocked: boolean; alreadyHad: boolean } }>(
            `select public.unlock_achievement('stack', $1) as r`,
            [key],
          )
        ).rows[0]!.r,
    );

  test('without an open or recently ended session of that game: NOT_FOUND, nothing written', async () => {
    await assert.rejects(unlock('a1'), notFound);
    await startSession(db, alice, 'other', 60); // another game's session does not count
    await assert.rejects(unlock('a1'), notFound);
    await startSession(db, alice, 'stack', 900, 301); // ended more than 5 minutes ago
    await assert.rejects(unlock('a1'), notFound);
    await startSession(db, alice, 'stack', 90000); // open but abandoned (> 24 h)
    await assert.rejects(unlock('a1'), notFound);
    assert.equal(await count(db, `select 1 from public.user_achievements`), 0);
  });

  test('an open session, or one that ended less than 5 minutes ago, allows it', async () => {
    await startSession(db, alice, 'stack', 60);
    assert.deepEqual(await unlock('a1'), { unlocked: true, alreadyHad: false });
    await db.query(`delete from public.play_sessions`);
    await startSession(db, alice, 'stack', 600, 120);
    assert.deepEqual(await unlock('a2'), { unlocked: true, alreadyHad: false });
    // Already unlocked: answered without a session and without spending a token.
    await db.query(`delete from public.play_sessions`);
    assert.deepEqual(await unlock('a1'), { unlocked: true, alreadyHad: true });
  });

  test('60 new unlocks per user per hour (token bucket), then RATE_LIMITED', async () => {
    await startSession(db, alice, 'stack', 60);
    for (let i = 1; i <= 60; i++) assert.equal((await unlock(`a${i}`)).alreadyHad, false, `a${i}`);
    await assert.rejects(unlock('a61'), rateLimited);
    assert.equal(await count(db, `select 1 from public.user_achievements`), 60);
    assert.deepEqual(await unlock('a5'), { unlocked: true, alreadyHad: true }); // re-unlocks still answer
    await db.query(`update public.rate_limits set refilled_at = refilled_at - interval '2 minutes'`);
    assert.equal((await unlock('a61')).alreadyHad, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. save_put
// ---------------------------------------------------------------------------------------------------------------

describe('save_put: first-write race, slot cap, rate limit', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'other');
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  });
  after(() => db.close());
  beforeEach(async () => {
    await db.query(`delete from public.rate_limits`);
    await db.query(`delete from public.game_saves`);
  });
  const put = (game: string, slot: string, ifVersion: number | null = null) =>
    asUser(
      db,
      alice,
      async () =>
        (
          await db.query<{ v: number }>(`select public.save_put($1, $2, '{"x":1}'::jsonb, $3) as v`, [
            game,
            slot,
            ifVersion,
          ])
        ).rows[0]!.v,
    );

  test('a concurrent first write to the same slot surfaces as CONFLICT, not unique_violation', async () => {
    await db.exec(`
      create function public.test_race_save() returns trigger language plpgsql as $$
      begin
        if current_setting('test.race', true) = 'on' then
          perform set_config('test.race', 'off', false); -- session-wide: fire once
          insert into public.game_saves (user_id, game_id, slot, data, version)
            values (new.user_id, new.game_id, new.slot, '{"other":true}', 1);
        end if;
        return new;
      end $$;
      create trigger test_race_save before insert on public.game_saves
        for each row execute function public.test_race_save();
    `);
    try {
      for (const ifVersion of [0, null]) {
        await db.query(`delete from public.game_saves`);
        await db.query(`select set_config('test.race', 'on', false)`);
        await assert.rejects(put('stack', 'main', ifVersion), conflict, `ifVersion ${ifVersion}`);
        // The simulated competitor ran inside our transaction, so the raise rolled it back too (a real one commits).
        assert.equal(await count(db, `select 1 from public.game_saves`), 0);
      }
    } finally {
      await db.exec(`drop trigger test_race_save on public.game_saves; drop function public.test_race_save();`);
      await db.query(`select set_config('test.race', 'off', false)`);
    }
  });

  test('at most 8 slots per user per game: a 9th new slot is INVALID; existing slots stay writable', async () => {
    for (let i = 1; i <= 8; i++) assert.equal(await put('stack', `s${i}`), 1);
    await db.query(`delete from public.rate_limits`);
    await assert.rejects(put('stack', 's9'), invalid);
    assert.equal(await put('stack', 's3'), 2);
    assert.equal(await put('other', 's9'), 1);
    assert.equal(await count(db, `select 1 from public.game_saves where game_id = 'stack'`), 8);
  });

  test('10 writes per user per minute (mirrors the host), then RATE_LIMITED; refills', async () => {
    for (let i = 1; i <= 10; i++) assert.equal(await put('stack', 'main'), i);
    await assert.rejects(put('stack', 'main'), rateLimited);
    await assert.rejects(put('other', 'main'), rateLimited);
    await db.query(`update public.rate_limits set refilled_at = refilled_at - interval '6 seconds'`);
    assert.equal(await put('stack', 'main'), 11);
  });

  test('a CONFLICT does not spend a token (the raise rolls the take back)', async () => {
    assert.equal(await put('stack', 'main'), 1);
    for (let i = 0; i < 15; i++) await assert.rejects(put('stack', 'main', 7), conflict);
    assert.equal(await put('stack', 'main', 1), 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6, 13. Retention jobs
// ---------------------------------------------------------------------------------------------------------------

describe('retention: play sessions, rate-limit buckets, unconfirmed email signups', () => {
  test('the migration applies without pg_cron and schedules both jobs where pg_cron exists', async () => {
    const db = await createTestDb();
    const sql = readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /'purge-stale-play-sessions', '47 3 \* \* \*', 'select private\.purge_stale_rows\(\)'/);
    assert.match(sql, /'purge-unconfirmed-users', '27 4 \* \* \*', 'select private\.purge_unconfirmed_users\(\)'/);
    // Re-running the scheduling block is harmless (skips with a NOTICE here).
    await db.exec(sql.slice(sql.indexOf('do $outer$')));
    await db.close();
  });

  test('purge_stale_rows: sessions ended > 90 days ago and sessions never ended after 24 h; stats intact', async () => {
    const db = await createTestDb();
    await insertGame(db, 'stack');
    const alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    const ended = await startSession(db, alice, 'stack', 600, 300);
    const ids = {
      old: await startSession(db, alice, 'stack', 91 * 86400, 91 * 86400 - 60),
      recentEnded: await startSession(db, alice, 'stack', 89 * 86400, 89 * 86400 - 60),
      abandoned: await startSession(db, alice, 'stack', 86400 + 60),
      open: await startSession(db, alice, 'stack', 3600),
      ended,
    };
    await db.query(
      `insert into public.game_stats (user_id, game_id, plays, playtime_s) values ($1, 'stack', 7, 700)
       on conflict (user_id, game_id) do update set plays = 7, playtime_s = 700`,
      [alice],
    );
    await db.query(
      `insert into public.rate_limits (user_id, action, tokens, refilled_at) values
         ($1, 'old', 0, now() - interval '25 hours'), ($1, 'fresh', 0, now())`,
      [alice],
    );
    await db.exec(`select private.purge_stale_rows()`);
    const left = (await db.query<{ id: string }>(`select id from public.play_sessions`)).rows.map((r) => r.id).sort();
    assert.deepEqual(left, [ids.recentEnded, ids.open, ids.ended].sort());
    assert.deepEqual(await stats(db, alice, 'stack'), { plays: 7, playtime_s: 700 });
    assert.deepEqual((await db.query(`select action from public.rate_limits`)).rows, [{ action: 'fresh' }]);
    await db.close();
  });

  test('purge_unconfirmed_users: email signups unconfirmed for 7 days are deleted (profile cascades, name freed)', async () => {
    const db = await createTestDb();
    const mk = async (username: string, ageDays: number, opts: { confirmed?: boolean; provider?: string } = {}) => {
      const id = await signUp(db, { username, birth_date: '2000-01-01' });
      await db.query(
        `update auth.users set created_at = now() - make_interval(days => $2),
                email_confirmed_at = case when $3 then now() end where id = $1`,
        [id, ageDays, opts.confirmed ?? false],
      );
      await db.query(`insert into auth.identities (user_id, provider) values ($1, 'email')`, [id]);
      if (opts.provider) await db.query(`insert into auth.identities (user_id, provider) values ($1, $2)`, [id, opts.provider]);
      return id;
    };
    const stale = await mk('stale_signup', 8);
    const fresh = await mk('fresh_signup', 6);
    const confirmed = await mk('confirmed', 30, { confirmed: true });
    const google = await mk('google_user', 30, { provider: 'google' });
    const phone = await mk('phone_user', 30);
    await db.query(`update auth.users set phone_confirmed_at = now() where id = $1`, [phone]);
    const anon = await signUpAnonymously(db, { username: 'anon_user', birth_date: '2000-01-01' });
    await db.query(`update auth.users set created_at = now() - interval '30 days' where id = $1`, [anon]);

    await db.exec(`select private.purge_unconfirmed_users()`);
    const users = (await db.query<{ id: string }>(`select id from auth.users`)).rows.map((r) => r.id).sort();
    assert.deepEqual(users, [fresh, confirmed, google, phone, anon].sort());
    assert.equal(await count(db, `select 1 from public.profiles where id = $1`, [stale]), 0);
    assert.equal(await count(db, `select 1 from auth.identities where user_id = $1`, [stale]), 0);
    await asAnon(db, async () => {
      const r = await db.query<{ ok: boolean }>(`select public.username_available('stale_signup') as ok`);
      assert.equal(r.rows[0]!.ok, true);
    });
    await db.close();
  });

  test('the purge helpers are not reachable by clients', async () => {
    const db = await createTestDb();
    const alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    for (const fn of ['private.purge_stale_rows()', 'private.purge_unconfirmed_users()']) {
      await asUser(db, alice, async () => {
        await assert.rejects(db.query(`select ${fn}`), /permission denied/);
      });
      await asAnon(db, async () => {
        await assert.rejects(db.query(`select ${fn}`), /permission denied/);
      });
    }
    const acl = await db.query<{ proname: string; public_exec: boolean }>(
      `select proname, has_function_privilege('public', oid, 'execute') as public_exec
         from pg_proc where pronamespace = 'private'::regnamespace and proname in
           ('purge_stale_rows', 'purge_unconfirmed_users', 'avatar_url_ok') order by 1`,
    );
    assert.deepEqual(acl.rows.map((r) => r.public_exec), [false, false, false]);
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7, 8, 10. Direct reads and storage
// ---------------------------------------------------------------------------------------------------------------

describe('leaderboard_entries: RPC-only reads', () => {
  test('no client role selects the table directly; leaderboard_top / my_leaderboard_rank still work', async () => {
    const db = await createTestDb();
    await insertGame(db, 'stack');
    await addBoard(db, 'stack', 'free', 'desc');
    const alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    const ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    const s = await startSession(db, alice, 'stack', 60);
    assert.equal((await submitAs(db, alice, 'stack', 'free', 5, s)).accepted, true);

    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select * from public.leaderboard_entries`), /permission denied/);
      const top = await db.query(`select username, score from public.leaderboard_top('stack', 'free')`);
      assert.deepEqual(top.rows, [{ username: 'alice', score: 5 }]);
    });
    await asUser(db, alice, async () => {
      await assert.rejects(db.query(`select * from public.leaderboard_entries`), /permission denied/);
      const me = await db.query(`select public.my_leaderboard_rank('stack', 'free') as r`);
      assert.deepEqual(me.rows, [{ r: { score: 5, rank: 1 } }]);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.leaderboard_entries`), /permission denied/);
    });
    await asService(db, async () => {
      assert.equal(await count(db, `select 1 from public.leaderboard_entries`), 1);
    });
    await db.close();
  });
});

describe('storage', () => {
  test('games bucket: clients cannot list objects (drafts included); the service role can', async () => {
    const db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'secret', 'draft');
    const alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    await asService(db, async () => {
      await db.query(
        `insert into storage.objects (bucket_id, name) values ('games', 'stack/1.0.0/index.html'), ('games', 'secret/0.1.0/index.html')`,
      );
      assert.equal(await count(db, `select 1 from storage.objects where bucket_id = 'games'`), 2);
    });
    await asAnon(db, async () => {
      assert.equal(await count(db, `select 1 from storage.objects where bucket_id = 'games'`), 0);
    });
    await asUser(db, alice, async () => {
      assert.equal(await count(db, `select 1 from storage.objects where bucket_id = 'games'`), 0);
    });
    await db.close();
  });

  test('avatars: anonymous sessions cannot upload or replace; linked accounts can', async () => {
    const db = await createTestDb();
    const alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
    const ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    const put = (uid: string) =>
      db.query(`insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${uid}/avatar.webp`]);
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(put(ghost), /row-level security/);
    });
    await db.query(`insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${ghost}/old.webp`]);
    await asAnonymousUser(db, ghost, async () => {
      const upd = await db.query(`update storage.objects set metadata = '{}' where bucket_id = 'avatars'`);
      assert.equal(upd.affectedRows, 0);
    });
    await asUser(db, alice, async () => {
      await put(alice);
      const upd = await db.query(`update storage.objects set metadata = '{}' where bucket_id = 'avatars'`);
      assert.equal(upd.affectedRows, 1);
    });
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 9. avatar_url
// ---------------------------------------------------------------------------------------------------------------

describe('profiles.avatar_url format', () => {
  let db: PGlite;
  let alice: string;
  before(async () => {
    db = await createTestDb();
    alice = await signUp(db, { username: 'alice', birth_date: '2000-01-01' });
  });
  after(() => db.close());

  const VALID = [
    null,
    'defaults/avatar-01.webp',
    'b5f6c1d2-0000-4000-8000-000000000000/avatar.v2.webp',
    'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c',
    'https://abc.supabase.co/storage/v1/object/public/avatars/u/a.webp?t=1',
    `https://x.io/${'a'.repeat(512 - 'https://x.io/'.length)}`,
  ];
  const INVALID = [
    '',
    'javascript:alert(1)',
    'http://tracker.example/pixel.png',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    '//evil.example/a.png',
    '/defaults/avatar-01.webp',
    '../secret.png',
    'defaults/../x.webp',
    'a//b.webp',
    'defaults/avatar 01.webp',
    'https://evil.example/a b.png',
    'https://',
    'HTTPS://x.io/a.png',
    `https://x.io/${'a'.repeat(512 - 'https://x.io/'.length + 1)}`,
  ];

  test('owners may set a bucket-relative path or an https URL of at most 512 characters', async () => {
    for (const v of VALID) {
      await asUser(db, alice, () => db.query(`update public.profiles set avatar_url = $2 where id = $1`, [alice, v]));
    }
    for (const v of INVALID) {
      await assert.rejects(
        asUser(db, alice, () => db.query(`update public.profiles set avatar_url = $2 where id = $1`, [alice, v])),
        checkViolation,
        JSON.stringify(v),
      );
    }
  });

  test('private.avatar_url_ok agrees with the check constraint', async () => {
    for (const [values, ok] of [
      [VALID, true],
      [INVALID, false],
    ] as const) {
      for (const v of values) {
        const r = await db.query<{ ok: boolean }>(`select private.avatar_url_ok($1) as ok`, [v]);
        assert.equal(r.rows[0]!.ok, ok, JSON.stringify(v));
      }
    }
  });

  test('signup metadata: a valid avatar_url is kept, an invalid one falls back to a default avatar', async () => {
    const meta = (avatar_url: string, username: string) =>
      ({ username, birth_date: '2000-01-01', avatar_url }) as { username: string; birth_date: string };
    const ok = await signUp(db, meta('https://lh3.googleusercontent.com/a/x', 'oauth_ok'));
    const bad = await signUp(db, meta('javascript:alert(1)', 'oauth_bad'));
    const huge = await signUp(db, meta(`https://x.io/${'a'.repeat(600)}`, 'oauth_huge'));
    const r = await db.query<{ id: string; avatar_url: string }>(
      `select id, avatar_url from public.profiles where id in ($1, $2, $3)`,
      [ok, bad, huge],
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.avatar_url]));
    assert.equal(by[ok], 'https://lh3.googleusercontent.com/a/x');
    assert.match(by[bad]!, /^defaults\/avatar-\d\d\.webp$/);
    assert.match(by[huge]!, /^defaults\/avatar-\d\d\.webp$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 12. release_username
// ---------------------------------------------------------------------------------------------------------------

describe('release_username trusts auth.users, not the token', () => {
  test('a just-linked account with a stale is_anonymous token keeps its name; a real anonymous user frees it', async () => {
    const db = await createTestDb();
    const linked = await signUpAnonymously(db, { username: 'linked_now', birth_date: '2000-01-01' });
    const anon = await signUpAnonymously(db, { username: 'still_anon', birth_date: '2000-01-01' });
    await db.query(`update auth.users set is_anonymous = false where id = $1`, [linked]); // linkIdentity
    await asAnonymousUser(db, linked, () => db.query(`select public.release_username()`));
    await asAnonymousUser(db, anon, () => db.query(`select public.release_username()`));
    const names = await db.query<{ id: string; username: string }>(`select id, username::text from public.profiles`);
    const by = Object.fromEntries(names.rows.map((r) => [r.id, r.username]));
    assert.equal(by[linked], 'linked_now');
    assert.match(by[anon]!, /^user_[0-9a-f]{12}$/);
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// search_profiles: LIKE metacharacters (already escaped by 20261030000300; pinned with data that contains them)
// ---------------------------------------------------------------------------------------------------------------

describe('search_profiles escapes LIKE metacharacters', () => {
  test('%, _ and \\ in the query match only themselves', async () => {
    const db = await createTestDb();
    const me = await signUp(db, { username: 'searcher', birth_date: '2000-01-01' });
    const people: [string, string][] = [
      ['percent', '100% real'],
      ['percentx', '100x real'],
      ['backslash', 'back\\slash'],
      ['backslashx', 'backxslash'],
      ['underscore', 'under_score'],
      ['underscorex', 'underxscore'],
    ];
    for (const [username, display] of people) {
      const id = await signUp(db, { username, birth_date: '2000-01-01' });
      await db.query(`update public.profiles set display_name = $2 where id = $1`, [id, display]);
    }
    const search = (q: string) =>
      asUser(db, me, async () =>
        (await db.query<{ username: string }>(`select username from public.search_profiles($1)`, [q])).rows.map(
          (r) => r.username,
        ),
      );
    assert.deepEqual(await search('0% r'), ['percent']);
    assert.deepEqual(await search('%'), ['percent']);
    assert.deepEqual(await search('k\\s'), ['backslash']);
    assert.deepEqual(await search('\\'), ['backslash']);
    assert.deepEqual(await search('r_s'), ['underscore']);
    assert.deepEqual(await search('_'), ['underscore']);
    await db.close();
  });
});
