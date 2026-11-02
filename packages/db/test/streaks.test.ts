// 20261102000400_streaks.sql: the daily play streak (rules, the player_streaks row, the deferred trigger on xp_ledger
// that counts counted matches and valid solo runs, the climbing coin bonus and the XP paid once per day, the reset
// after a missed day and the longest streak, my_streak, the Realtime event, privileges and retention). Account deletion
// (the cascade from profiles) is pinned by moderation.test.ts.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { levelForXp, type MyStreak, type StreakEvent } from '../src/index.ts';
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

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const unauthenticated = sqlstate('42501', /^UNAUTHENTICATED/);
const permissionDenied = (e: unknown) => /permission denied/.test((e as Error).message);

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// --- what is stored ------------------------------------------------------------------------------------------------

interface StreakRow {
  current: number;
  longest: number;
  last_played_on: string | null;
  bonus_paid_on: string | null;
}
/** The user's player_streaks row (superuser view), or null before the first counted game. */
const streakRow = async (db: PGlite, uid: string): Promise<StreakRow | null> =>
  (
    await db.query<StreakRow>(
      `select current, longest, last_played_on::text as last_played_on, bonus_paid_on::text as bonus_paid_on
         from public.player_streaks where user_id = $1`,
      [uid],
    )
  ).rows[0] ?? null;

interface LedgerRow {
  amount: number;
  ref: string;
  note: string | null;
}
const streakCoins = async (db: PGlite, uid: string): Promise<LedgerRow[]> =>
  (
    await db.query<LedgerRow>(
      `select amount, ref, note from public.coin_ledger where user_id = $1 and reason = 'streak' order by id`,
      [uid],
    )
  ).rows;
const streakXp = async (db: PGlite, uid: string): Promise<LedgerRow[]> =>
  (
    await db.query<LedgerRow>(
      `select amount, ref, note from public.xp_ledger where user_id = $1 and reason = 'streak' order by id`,
      [uid],
    )
  ).rows;
const coinReasons = async (db: PGlite, uid: string) =>
  (
    await db.query<{ reason: string; amount: number }>(
      `select reason, amount from public.coin_ledger where user_id = $1 order by id`,
      [uid],
    )
  ).rows.map((r) => `${r.reason}:${r.amount}`);
const xpReasons = async (db: PGlite, uid: string) =>
  (
    await db.query<{ reason: string; amount: number }>(
      `select reason, amount from public.xp_ledger where user_id = $1 order by id`,
      [uid],
    )
  ).rows.map((r) => `${r.reason}:${r.amount}`);
const stored = async (db: PGlite, uid: string) =>
  (
    await db.query<{ xp: number; level: number }>(
      `select coalesce((select xp from public.player_progress where user_id = $1), 0) as xp,
              coalesce((select level from public.player_progress where user_id = $1), 1) as level`,
      [uid],
    )
  ).rows[0]!;

/** Every progress row equals the sum of its ledger (the deferred trigger must never lose the XP it adds to). */
async function assertProgressInvariant(db: PGlite) {
  const r = await db.query<{ user_id: string; xp: number; level: number; total: number }>(
    `select p.user_id, p.xp, p.level,
            coalesce((select sum(amount) from public.xp_ledger l where l.user_id = p.user_id), 0)::int as total
       from public.player_progress p`,
  );
  for (const row of r.rows) {
    assert.equal(row.xp, row.total, `progress of ${row.user_id} = sum of its ledger`);
    assert.equal(row.level, levelForXp(row.xp), `level of ${row.user_id} follows the curve`);
  }
}

const grantXp = (db: PGlite, uid: string, amount: number, ref = `grant-${Math.random()}`) =>
  db.query(`select private.apply_xp($1, $2, 'adjustment', $3)`, [uid, amount, ref]);

const setRule = (db: PGlite, key: string, value: number) =>
  db.query(`update public.progress_rules set value = $2 where key = $1`, [key, value]);

/**
 * `days` days pass for a user: the streak row's dates, and the dated ledger rows (the streak's and the daily bonus's
 * refs, every row's created_at) move back, so the next game is "tomorrow's".
 */
const ageStreak = (db: PGlite, uid: string, days = 1) =>
  db.exec(`
    update public.player_streaks
       set last_played_on = last_played_on - ${days}, bonus_paid_on = bonus_paid_on - ${days}
     where user_id = '${uid}';
    alter table public.coin_ledger disable trigger coin_ledger_append_only;
    alter table public.xp_ledger disable trigger xp_ledger_append_only;
    update public.coin_ledger
       set created_at = created_at - interval '${days} days',
           ref = case when reason in ('daily', 'streak') then to_char(ref::date - ${days}, 'YYYY-MM-DD') else ref end
     where user_id = '${uid}';
    update public.xp_ledger
       set created_at = created_at - interval '${days} days',
           ref = case when reason = 'streak' then to_char(ref::date - ${days}, 'YYYY-MM-DD') else ref end
     where user_id = '${uid}';
    alter table public.coin_ledger enable trigger coin_ledger_append_only;
    alter table public.xp_ledger enable trigger xp_ledger_append_only;
  `);

// --- playing (as progress.test.ts) ---------------------------------------------------------------------------------

interface MatchPlayer {
  userId: string;
  guest: boolean;
}
let seq = 0;
function match(players: MatchPlayer[], over: { winnerUserId?: string | null; durationSec?: number } = {}) {
  const duration = over.durationSec ?? 95;
  const ended = new Date();
  return {
    matchId: `streak${++seq}:1`,
    gameId: 'sumo',
    roomId: `streak${seq}`,
    private: false,
    winnerUserId: over.winnerUserId ?? null,
    startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
    endedAt: ended.toISOString(),
    durationSec: duration,
    rounds: 3,
    leaderboardDeltas: {},
    players: players.map((pl, i) => ({ username: `p${i}`, placement: i + 1, score: 0, achievements: [], ...pl })),
  };
}
const p = (userId: string): MatchPlayer => ({ userId, guest: false });
const guest = (n: number): MatchPlayer => ({ userId: `guest:${n}`, guest: true });
const record = (db: PGlite, m: unknown) =>
  asService(
    db,
    async () =>
      (
        await db.query<{ r: { duplicate: boolean } }>(`select public.server_record_match($1::jsonb) as r`, [
          JSON.stringify(m),
        ])
      ).rows[0]!.r,
  );

async function session(db: PGlite, uid: string, ageS = 120): Promise<string> {
  const id = await asUser(
    db,
    uid,
    async () => (await db.query<{ id: string }>(`select public.start_play_session('stack') as id`)).rows[0]!.id,
  );
  await db.query(`update public.play_sessions set started_at = now() - make_interval(secs => $2) where id = $1`, [
    id,
    ageS,
  ]);
  return id;
}
const submit = (db: PGlite, uid: string, score: number, sessionId: string) =>
  asUser(
    db,
    uid,
    async () =>
      (
        await db.query<{ r: { accepted: boolean; reason: string | null } }>(
          `select public.submit_solo_score('stack', 'height', $1::float8, $2) as r`,
          [score, sessionId],
        )
      ).rows[0]!.r,
  );

const myStreak = (db: PGlite, uid: string) =>
  asUser(db, uid, async () => (await db.query<{ r: MyStreak }>(`select public.my_streak() as r`)).rows[0]!.r);

async function setupGames(db: PGlite) {
  await insertGame(db, 'sumo');
  await insertGame(db, 'stack');
  await db.exec(`
    update public.games set title = 'Sumo', modes = '{quick,browser,private}', max_players = 8 where id = 'sumo';
    update public.games set title = 'Stack' where id = 'stack';
    insert into public.leaderboards (game_id, key, sort, period, max_score_per_minute) values
      ('stack', 'height', 'desc', 'alltime', 120);
  `);
}

async function stubSend(db: PGlite, opts: { fail?: boolean } = {}) {
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
async function takeSent(db: PGlite, event?: string) {
  const r = await db.query<{ payload: Record<string, unknown>; event: string; topic: string; private: boolean }>(
    `select payload, event, topic, private from pg_temp.sent where $1::text is null or event = $1 order by n`,
    [event ?? null],
  );
  await db.exec(`truncate pg_temp.sent`);
  return r.rows;
}

const STREAK_RULES = {
  streak_coins_1: 10,
  streak_coins_2: 15,
  streak_coins_3: 20,
  streak_coins_4: 30,
  streak_coins_5: 40,
  streak_coins_6: 50,
  streak_coins_7: 75,
  streak_xp: 10,
};

const RESET = `
  delete from public.player_streaks; delete from public.xp_ledger; delete from public.player_progress;
  delete from public.daily_challenges; delete from public.coin_ledger; delete from public.wallets;
  delete from public.match_results; delete from public.game_stats; delete from public.play_sessions;
  delete from public.rate_limits; delete from public.leaderboard_entries;
  update public.progress_rules set value = case key
    ${Object.entries(STREAK_RULES)
      .map(([k, v]) => `when '${k}' then ${v}`)
      .join(' ')} end
   where key ~ '^streak_';
`;

// =====================================================================================================================

describe('streak: rules, table and privileges', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
  });
  after(() => db.close());

  test('progress_rules: the documented starting values of the streak, readable by everyone, writable by nobody', async () => {
    const r = await db.query<{ key: string; value: number }>(
      `select key, value from public.progress_rules where key ~ '^streak_' order by key`,
    );
    assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.key, x.value])), STREAK_RULES);
    for (const run of [(fn: () => Promise<void>) => asUser(db, ann, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(async () => {
        assert.equal(await count(db, `select 1 from public.progress_rules where key ~ '^streak_'`), 8);
        await assert.rejects(
          db.query(`update public.progress_rules set value = 1000 where key = 'streak_coins_1'`),
          permissionDenied,
        );
      });
    }
    // private.streak_coins: days 1-7 have their own rule, day 8 and on pay day 7's; nothing below day 1.
    const c = await db.query<{ d: number; c: number }>(
      `select d, private.streak_coins(d) as c from generate_series(0, 9) d order by d`,
    );
    assert.deepEqual(
      c.rows.map((x) => x.c),
      [0, 10, 15, 20, 30, 40, 50, 75, 75, 75],
    );
  });

  test('RLS: users read only their own streak; clients write nothing and cannot call the internal writers', async () => {
    await asUser(db, ben, async () => {
      assert.deepEqual((await db.query(`select user_id from public.player_streaks`)).rows, [{ user_id: ben }]);
      assert.equal(await count(db, `select 1 from public.player_streaks where user_id = $1`, [ann]), 0);
      for (const sql of [
        `update public.player_streaks set current = 99, longest = 99`,
        `insert into public.player_streaks (user_id, current, longest, last_played_on) values ('${ann}', 1, 1, current_date)`,
        `delete from public.player_streaks`,
        `select private.count_streak_day('${ben}', current_date)`,
        `select private.streak_coins(3)`,
      ]) {
        await assert.rejects(db.query(sql), permissionDenied, sql);
      }
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.player_streaks`), permissionDenied);
      await assert.rejects(db.query(`select public.my_streak()`), permissionDenied);
    });
  });

  test('who may call what; the trigger is deferred; the table keeps its invariants', async () => {
    const fn = 'public.my_streak()';
    const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
      `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
              has_function_privilege('service_role', $1, 'execute') as svc, has_function_privilege('public', $1, 'execute') as pub`,
      [fn],
    );
    assert.deepEqual(r.rows[0], { anon: false, auth: true, svc: true, pub: false });
    const internal = ['streak_coins', 'broadcast_streak', 'count_streak_day', 'xp_ledger_count_streak'];
    const acl = await db.query<{ proname: string; public_exec: boolean; svc_exec: boolean }>(
      `select proname, has_function_privilege('public', oid, 'execute') as public_exec,
              has_function_privilege('service_role', oid, 'execute') as svc_exec
         from pg_proc where pronamespace = 'private'::regnamespace and proname = any ($1)`,
      [internal],
    );
    assert.equal(acl.rows.length, internal.length);
    assert.ok(
      acl.rows.every((x) => !x.public_exec && !x.svc_exec),
      JSON.stringify(acl.rows),
    );
    // Security definer functions pin their search_path.
    const loose = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p where p.prosecdef and p.proname = any ($1)
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
      [['my_streak', ...internal]],
    );
    assert.deepEqual(loose.rows, []);
    // The trigger fires at commit (see the migration header for why), for match and solo rows only.
    const trg = await db.query<{ deferrable: boolean; deferred: boolean; when: string }>(
      `select tgdeferrable as deferrable, tginitdeferred as deferred, pg_get_triggerdef(oid) as when
         from pg_trigger where tgname = 'xp_ledger_streak'`,
    );
    assert.equal(trg.rows.length, 1);
    assert.deepEqual([trg.rows[0]!.deferrable, trg.rows[0]!.deferred], [true, true]);
    assert.match(
      trg.rows[0]!.when,
      /AFTER INSERT ON public\.xp_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN/,
    );
    assert.match(trg.rows[0]!.when, /'match'.*'solo'/);
    // Both ledgers take the new reason; the table refuses a longest below the current and a streak without a day.
    await db.query(`select private.apply_coins($1, 5, 'streak', 'test')`, [ann]);
    await db.query(`select private.apply_xp($1, 5, 'streak', 'test')`, [ann]);
    for (const [cols, re] of [
      [`current, longest, last_played_on) values ('${ben}', 3, 1, current_date`, /player_streaks_longest/],
      [`current, longest) values ('${ben}', 1, 1`, /player_streaks_played/],
      [`current, longest, last_played_on) values ('${ben}', -1, 0, current_date`, /player_streaks_current/],
    ] as const) {
      await assert.rejects(
        db.query(
          `insert into public.player_streaks (user_id, ${cols}) on conflict (user_id) do update set current = excluded.current, longest = excluded.longest, last_played_on = excluded.last_played_on`,
        ),
        re,
      );
    }
  });
});

// =====================================================================================================================

describe('counting: the first counted game of a UTC day grows the streak and pays once', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('a counted match starts a streak for each eligible player and pays day 1 (coins and XP, ref = the date)', async () => {
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    for (const u of [ann, ben]) {
      assert.deepEqual(await streakRow(db, u), {
        current: 1,
        longest: 1,
        last_played_on: today(),
        bonus_paid_on: today(),
      });
      assert.deepEqual(await streakCoins(db, u), [{ amount: 10, ref: today(), note: 'Day 1' }]);
      assert.deepEqual(await streakXp(db, u), [{ amount: 10, ref: today(), note: 'Day 1' }]);
    }
    // The bonus lands after the match's own awards, and the stored XP includes it (the trigger ran after apply_xp).
    assert.deepEqual(await coinReasons(db, ann), ['match:10', 'win:25', 'daily:50', 'streak:10']);
    assert.deepEqual(await xpReasons(db, ann), ['match:20', 'win:10', 'streak:10']);
    assert.deepEqual(await stored(db, ann), { xp: 40, level: 1 });
    assert.equal(
      (await db.query<{ b: number }>(`select balance as b from public.wallets where user_id = $1`, [ann])).rows[0]!.b,
      95,
    );
    await assertProgressInvariant(db);
    assert.deepEqual(await myStreak(db, ann), {
      current: 1,
      longest: 1,
      last_played_on: today(),
      today_done: true,
      next_coins: 15,
      next_xp: 10,
    });
  });

  test('a second game the same day pays nothing and changes nothing; a replayed match neither', async () => {
    const m = match([p(ann), p(ben)], { winnerUserId: ann });
    await record(db, m);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    await submit(db, ann, 10, await session(db, ann));
    assert.deepEqual(await record(db, m), { duplicate: true });
    for (const u of [ann, ben]) {
      assert.deepEqual(await streakRow(db, u), {
        current: 1,
        longest: 1,
        last_played_on: today(),
        bonus_paid_on: today(),
      });
      assert.equal((await streakCoins(db, u)).length, 1, 'one coin bonus');
      assert.equal((await streakXp(db, u)).length, 1, 'one XP bonus');
    }
    await assertProgressInvariant(db);
  });

  test('a valid solo run counts; refused runs, short matches, guests and anonymous sessions never do', async () => {
    const s1 = await session(db, ann);
    await submit(db, ann, 10, s1);
    assert.deepEqual(await streakRow(db, ann), {
      current: 1,
      longest: 1,
      last_played_on: today(),
      bonus_paid_on: today(),
    });
    assert.deepEqual(await coinReasons(db, ann), ['solo:5', 'daily:50', 'streak:10']);
    // Not best but valid (a new session): already counted today, nothing more.
    assert.equal((await submit(db, ann, 3, await session(db, ann))).reason, 'not_best');
    assert.equal((await streakCoins(db, ann)).length, 1);
    // Refused: the session is too new (no XP row, so no streak).
    assert.equal((await submit(db, ben, 3, await session(db, ben, 0))).reason, 'session_too_new');
    assert.equal(await streakRow(db, ben), null);
    // A match too short to count, and a private-alone match: stats only, no streak.
    await record(db, match([p(cat), p(ben)], { winnerUserId: cat, durationSec: 19 }));
    assert.equal(await streakRow(db, cat), null);
    assert.equal(await streakRow(db, ben), null);
    // Guests and anonymous players of a counted match are not eligible, so they have no row.
    await record(db, match([p(ghost), guest(1), p(cat)], { winnerUserId: ghost }));
    assert.equal(await streakRow(db, ghost), null);
    assert.deepEqual((await streakRow(db, cat))?.current, 1);
    assert.equal(await count(db, `select 1 from public.player_streaks`), 2);
    await assertProgressInvariant(db);
  });

  test('consecutive days climb the bonus: 10, 15, 20, 30, 40, 50, 75, then 75 every day; longest follows', async () => {
    const expected = [10, 15, 20, 30, 40, 50, 75, 75, 75];
    for (let day = 1; day <= expected.length; day++) {
      if (day > 1) await ageStreak(db, ann);
      await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
      const row = await streakRow(db, ann);
      assert.deepEqual([row!.current, row!.longest, row!.last_played_on], [day, day, today()], `day ${day}`);
      const last = (await streakCoins(db, ann)).at(-1)!;
      assert.deepEqual([last.amount, last.ref, last.note], [expected[day - 1], today(), `Day ${day}`], `day ${day}`);
    }
    assert.deepEqual(
      (await streakCoins(db, ann)).map((r) => r.amount),
      expected,
    );
    assert.deepEqual(
      (await streakXp(db, ann)).map((r) => r.amount),
      expected.map(() => 10),
    );
    // Nine distinct days, every one paid once.
    assert.equal(new Set((await streakCoins(db, ann)).map((r) => r.ref)).size, expected.length);
    assert.deepEqual(await myStreak(db, ann), {
      current: 9,
      longest: 9,
      last_played_on: today(),
      today_done: true,
      next_coins: 75,
      next_xp: 10,
    });
    await assertProgressInvariant(db);
  });

  test("yesterday's game keeps the streak alive; a missed day resets it to 0 and the next game starts at 1; longest stays", async () => {
    for (let day = 1; day <= 3; day++) {
      if (day > 1) await ageStreak(db, ann);
      await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    }
    // The next morning: alive, not played yet, tomorrow is day 4.
    await ageStreak(db, ann);
    assert.deepEqual(await myStreak(db, ann), {
      current: 3,
      longest: 3,
      last_played_on: daysAgo(1),
      today_done: false,
      next_coins: 30,
      next_xp: 10,
    });
    // A day missed: the streak reads 0 (the row is only rewritten by the next game), the longest is kept.
    await ageStreak(db, ann);
    assert.deepEqual(await myStreak(db, ann), {
      current: 0,
      longest: 3,
      last_played_on: daysAgo(2),
      today_done: false,
      next_coins: 10,
      next_xp: 10,
    });
    assert.deepEqual((await streakRow(db, ann))!.current, 3, 'stored until the next game');
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await streakRow(db, ann), {
      current: 1,
      longest: 3,
      last_played_on: today(),
      bonus_paid_on: today(),
    });
    assert.deepEqual((await streakCoins(db, ann)).at(-1), { amount: 10, ref: today(), note: 'Day 1' });
    assert.deepEqual(await myStreak(db, ann), {
      current: 1,
      longest: 3,
      last_played_on: today(),
      today_done: true,
      next_coins: 15,
      next_xp: 10,
    });
    // Ben played every day too (never aged): still day 1 today for him, nothing more.
    assert.deepEqual((await streakRow(db, ben))!.current, 1);
    await assertProgressInvariant(db);
  });

  test('the amounts are rules: tuned values pay at once; 0 pays nothing but the day still counts', async () => {
    await setRule(db, 'streak_coins_1', 100);
    await setRule(db, 'streak_xp', 0);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await streakCoins(db, ann), [{ amount: 100, ref: today(), note: 'Day 1' }]);
    assert.deepEqual(await streakXp(db, ann), []);
    assert.deepEqual((await streakRow(db, ann))!.bonus_paid_on, today());
    await setRule(db, 'streak_coins_1', 0);
    await submit(db, cat, 10, await session(db, cat));
    assert.deepEqual(await streakRow(db, cat), {
      current: 1,
      longest: 1,
      last_played_on: today(),
      bonus_paid_on: null,
    });
    assert.deepEqual(await streakCoins(db, cat), []);
    assert.deepEqual(await myStreak(db, cat), {
      current: 1,
      longest: 1,
      last_played_on: today(),
      today_done: true,
      next_coins: 15,
      next_xp: 0,
    });
    // Day 8 and on follow day 7's rule.
    await setRule(db, 'streak_coins_7', 120);
    assert.equal((await db.query<{ c: number }>(`select private.streak_coins(12) as c`)).rows[0]!.c, 120);
    await assertProgressInvariant(db);
  });

  test('my_streak: zeros without a row and for anonymous sessions; signed out refused', async () => {
    const zeros: MyStreak = {
      current: 0,
      longest: 0,
      last_played_on: null,
      today_done: false,
      next_coins: 10,
      next_xp: 10,
    };
    assert.deepEqual(await myStreak(db, cat), zeros);
    await asAnonymousUser(db, ghost, async () => {
      assert.deepEqual((await db.query<{ r: MyStreak }>(`select public.my_streak() as r`)).rows[0]!.r, zeros);
    });
    await assert.rejects(
      asRole(db, 'authenticated', () => db.query(`select public.my_streak()`)),
      unauthenticated,
    );
  });

  test('the streak XP goes through the level curve: a level-up it causes pays its coins and the stored total is exact', async () => {
    await grantXp(db, ann, 60, 'seed');
    // 60 + 20 (match) + 10 (win) = 90, then the streak's 10 reaches 100: level 2, paid by the deferred trigger.
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await xpReasons(db, ann), ['adjustment:60', 'match:20', 'win:10', 'streak:10']);
    assert.deepEqual(await coinReasons(db, ann), ['match:10', 'win:25', 'daily:50', 'streak:10', 'level:50']);
    assert.deepEqual(await stored(db, ann), { xp: 100, level: 2 });
    const last = (
      await db.query<{ xp_after: number; level_after: number }>(
        `select xp_after, level_after from public.xp_ledger where user_id = $1 order by id desc limit 1`,
        [ann],
      )
    ).rows[0];
    assert.deepEqual(last, { xp_after: 100, level_after: 2 });
    await assertProgressInvariant(db);
  });

  test('a failing streak write rolls the whole match back, so a retry pays exactly once', async () => {
    await db.exec(`
      create function public.test_fail_streak() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger test_fail before insert on public.player_streaks for each row execute function public.test_fail_streak();
    `);
    const m = match([p(ann), p(ben)], { winnerUserId: ann });
    try {
      await assert.rejects(record(db, m), /boom/);
    } finally {
      await db.exec(`drop trigger test_fail on public.player_streaks; drop function public.test_fail_streak();`);
    }
    assert.equal(await count(db, `select 1 from public.match_results`), 0);
    assert.equal(await count(db, `select 1 from public.coin_ledger`), 0);
    assert.equal(await count(db, `select 1 from public.xp_ledger`), 0);
    await record(db, m);
    assert.deepEqual(await coinReasons(db, ann), ['match:10', 'win:25', 'daily:50', 'streak:10']);
    await assertProgressInvariant(db);
  });
});

// =====================================================================================================================

describe('Realtime: the streak event on the private user channel', () => {
  test('one streak event per day the streak grows, after its coins and XP events; a failing send never fails the game', async () => {
    const db = await createTestDb();
    await setupGames(db);
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    await stubSend(db);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    const all = await takeSent(db);
    const events = all.filter((s) => s.event === 'streak');
    assert.ok(events.every((s) => s.private));
    // Players are counted in the order their rows were written (user-id order, the wallet lock order).
    assert.deepEqual(
      events.map((s) => s.topic),
      [ann, ben].sort().map((u) => `user:${u}`),
    );
    const mine = events.find((s) => s.topic === `user:${ann}`)!.payload as unknown as StreakEvent;
    assert.deepEqual(Object.keys(mine).sort(), ['at', 'coins', 'current', 'last_played_on', 'longest', 'type', 'xp']);
    assert.deepEqual(
      [mine.type, mine.current, mine.longest, mine.last_played_on, mine.coins, mine.xp],
      ['streak', 1, 1, today(), 10, 10],
    );
    assert.match(mine.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // Ann's channel: the match's own events first (its coins, then its XP), then at commit the bonus's coins and XP,
    // then the streak itself.
    const annEvents = all
      .filter((s) => s.topic === `user:${ann}` && (s.event !== 'progress' || s.payload.type === 'xp'))
      .map((s) => `${s.event}:${String(s.payload.reason ?? s.payload.type)}`);
    assert.deepEqual(annEvents, [
      'coins:match',
      'coins:win',
      'coins:daily',
      'progress:match',
      'progress:win',
      'coins:streak',
      'progress:streak',
      'streak:streak',
    ]);
    // The second game of the day: no streak event (and no bonus).
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    assert.deepEqual(await takeSent(db, 'streak'), []);
    // Tomorrow, with Realtime down: the day still counts and pays.
    await ageStreak(db, ann);
    await stubSend(db, { fail: true });
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual((await streakRow(db, ann))!.current, 2);
    assert.deepEqual((await streakCoins(db, ann)).at(-1)?.amount, 15);
    await db.close();
  });
});

// =====================================================================================================================

describe('retention: the purges and the streak row', () => {
  test('streak ledger rows older than 365 days go with the other earn rows; player_streaks stays', async () => {
    const db = await createTestDb();
    await setupGames(db);
    const ann = await user(db, 'ann');
    await record(db, match([p(ann)], { winnerUserId: ann }));
    await ageStreak(db, ann, 366);
    await db.exec(`select private.purge_stale_rows(); select private.purge_progress_rows();`);
    assert.deepEqual(await streakCoins(db, ann), []);
    assert.deepEqual(await streakXp(db, ann), []);
    assert.deepEqual(await streakRow(db, ann), {
      current: 1,
      longest: 1,
      last_played_on: daysAgo(366),
      bonus_paid_on: daysAgo(366),
    });
    assert.deepEqual((await myStreak(db, ann)).current, 0);
    assert.deepEqual((await myStreak(db, ann)).longest, 1);
    // The next game starts over at day 1 (a purged date can never pay again: it is in the past).
    await record(db, match([p(ann)], { winnerUserId: ann }));
    assert.deepEqual(await streakRow(db, ann), {
      current: 1,
      longest: 1,
      last_played_on: today(),
      bonus_paid_on: today(),
    });
    assert.deepEqual(await streakCoins(db, ann), [{ amount: 10, ref: today(), note: 'Day 1' }]);
    await db.close();
  });
});
