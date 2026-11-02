// 20261101000100_progress.sql: XP and levels (rules, the append-only ledger, the stored total, the level curve, the
// level-up coins), every XP path (multiplayer matches, achievements, solo runs, claimed challenges), daily challenges
// (the seeded pick, progress inside server_record_match / submit_solo_score, claiming), my_progress / public_progress,
// the Realtime events, privileges and retention. The level curve is compared with packages/db/src/progress.ts, the
// app's copy of the formula.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  levelForXp,
  progressForXp,
  xpForLevel,
  xpToNextLevel,
  type ChallengeKind,
  type ClaimChallengeResult,
  type DailyChallengeRow,
  type LevelProgress,
  type MyProgress,
  type ProgressEvent,
} from '../src/index.ts';
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
const notFound = sqlstate('P0002', /^NOT_FOUND/);
const alreadyClaimed = sqlstate('P0001', /^ALREADY_CLAIMED/);
const notComplete = sqlstate('P0001', /^NOT_COMPLETE/);
const expired = sqlstate('P0001', /^EXPIRED/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const anonymousForbidden = sqlstate('42501', /^ANONYMOUS_FORBIDDEN/);
const unauthenticated = sqlstate('42501', /^UNAUTHENTICATED/);
const permissionDenied = (e: unknown) => /permission denied/.test((e as Error).message);

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// --- XP and coins as stored ----------------------------------------------------------------------------------------

interface XpRow {
  amount: number;
  reason: string;
  ref: string;
  game_id: string | null;
  note: string | null;
  xp_after: number;
  level_after: number;
}
const xpRows = async (db: PGlite, uid: string): Promise<XpRow[]> =>
  (
    await db.query<XpRow>(
      `select amount, reason, ref, game_id, note, xp_after, level_after from public.xp_ledger where user_id = $1 order by id`,
      [uid],
    )
  ).rows;
const xpReasons = async (db: PGlite, uid: string) => (await xpRows(db, uid)).map((r) => `${r.reason}:${r.amount}`);
const coinRows = async (db: PGlite, uid: string) =>
  (
    await db.query<{ amount: number; reason: string; ref: string; note: string | null }>(
      `select amount, reason, ref, note from public.coin_ledger where user_id = $1 order by id`,
      [uid],
    )
  ).rows;
const coinReasons = async (db: PGlite, uid: string, only?: string[]) =>
  (await coinRows(db, uid)).filter((r) => !only || only.includes(r.reason)).map((r) => `${r.reason}:${r.amount}`);
const stored = async (db: PGlite, uid: string) =>
  (
    await db.query<{ xp: number; level: number }>(
      `select coalesce((select xp from public.player_progress where user_id = $1), 0) as xp,
              coalesce((select level from public.player_progress where user_id = $1), 1) as level`,
      [uid],
    )
  ).rows[0]!;

/** Every progress row equals the sum of its ledger and the level the shared curve gives for it. */
async function assertProgressInvariant(db: PGlite) {
  const r = await db.query<{ user_id: string; xp: number; level: number; total: number }>(
    `select p.user_id, p.xp, p.level, coalesce((select sum(amount) from public.xp_ledger l where l.user_id = p.user_id), 0)::int as total
       from public.player_progress p`,
  );
  for (const row of r.rows) {
    assert.equal(row.xp, row.total, `progress of ${row.user_id} = sum of its ledger`);
    assert.equal(row.level, levelForXp(row.xp), `level of ${row.user_id} follows the curve`);
  }
}

/** XP the way a support grant does it (superuser; private.apply_xp is the only writer). */
const grantXp = (db: PGlite, uid: string, amount: number, ref = `grant-${Math.random()}`) =>
  db.query(`select private.apply_xp($1, $2, 'adjustment', $3)`, [uid, amount, ref]);

const setRule = (db: PGlite, key: string, value: number) =>
  db.query(`update public.progress_rules set value = $2 where key = $1`, [key, value]);

// --- multiplayer (as coins.test.ts) ---------------------------------------------------------------------------------

interface MatchPlayer {
  userId: string;
  guest: boolean;
  placement?: number;
  achievements?: string[];
}
interface Match {
  matchId: string;
  gameId: string;
  roomId: string;
  private: boolean;
  winnerUserId: string | null;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  rounds: number;
  leaderboardDeltas: Record<string, Record<string, number>>;
  players: MatchPlayer[];
}
let seq = 0;
function match(players: MatchPlayer[], over: Partial<Match> = {}): Match {
  const duration = over.durationSec ?? 95;
  const ended = over.endedAt ? new Date(over.endedAt) : new Date();
  return {
    matchId: `xp${++seq}:1`,
    gameId: 'sumo',
    roomId: `xp${seq}`,
    private: false,
    winnerUserId: null,
    startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
    endedAt: ended.toISOString(),
    durationSec: duration,
    rounds: 3,
    leaderboardDeltas: {},
    players: players.map((pl, i) => ({ username: `p${i}`, placement: i + 1, score: 0, achievements: [], ...pl })),
    ...over,
  };
}
const p = (userId: string, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ userId, guest: false, ...extra });
const guest = (n: number): MatchPlayer => ({ userId: `guest:${n}`, guest: true });
const record = (db: PGlite, m: unknown) =>
  asService(
    db,
    async () =>
      (await db.query<{ r: unknown }>(`select public.server_record_match($1::jsonb) as r`, [JSON.stringify(m)]))
        .rows[0]!.r,
  );

// --- solo ----------------------------------------------------------------------------------------------------------

async function session(db: PGlite, uid: string, game = 'stack', ageS = 120): Promise<string> {
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
const submit = (db: PGlite, uid: string, score: number, sessionId: string, board = 'height') =>
  asUser(
    db,
    uid,
    async () =>
      (
        await db.query<{ r: { accepted: boolean; reason: string | null } }>(
          `select public.submit_solo_score('stack', $1, $2::float8, $3) as r`,
          [board, score, sessionId],
        )
      ).rows[0]!.r,
  );
const unlock = (db: PGlite, uid: string, key: string) =>
  asUser(db, uid, () => db.query(`select public.unlock_achievement('stack', $1)`, [key]));

// --- RPCs ----------------------------------------------------------------------------------------------------------

const myProgress = (db: PGlite, uid: string) =>
  asUser(db, uid, async () => (await db.query<{ r: MyProgress }>(`select public.my_progress() as r`)).rows[0]!.r);
const publicProgress = (db: PGlite, uid: string) =>
  db.query<{ r: LevelProgress | null }>(`select public.public_progress($1) as r`, [uid]).then((x) => x.rows[0]!.r);
const myChallenges = (db: PGlite, uid: string) =>
  asUser(db, uid, async () => (await db.query<DailyChallengeRow>(`select * from public.my_daily_challenges()`)).rows);
const claim = (db: PGlite, uid: string, id: string) =>
  asUser(
    db,
    uid,
    async () =>
      (await db.query<{ r: ClaimChallengeResult }>(`select public.claim_daily_challenge($1) as r`, [id])).rows[0]!.r,
  );

interface ChallengeState {
  id: string;
  template_key: string;
  slot: number;
  tier: number;
  kind: string;
  title: string;
  progress: number;
  target: number;
  refs: string[];
  completed: boolean;
  claimed: boolean;
}
/** A user's challenges of a day as stored (superuser), by slot. */
const stateOf = async (db: PGlite, uid: string, day = today()): Promise<ChallengeState[]> =>
  (
    await db.query<ChallengeState>(
      `select id, template_key, slot, tier, kind, title, progress, target, refs, completed_at is not null as completed,
              claimed_at is not null as claimed
         from public.daily_challenges where user_id = $1 and day = $2::date order by slot`,
      [uid, day],
    )
  ).rows;
const progressOf = async (db: PGlite, uid: string, day = today()) =>
  Object.fromEntries((await stateOf(db, uid, day)).map((c) => [c.template_key, `${c.progress}/${c.target}`]));

/** Gives a user a chosen set of challenges for a day (instead of the seeded pick), the way the pick stores them. */
const assign = (db: PGlite, uid: string, keys: string[], day = today()) =>
  db.query(
    `insert into public.daily_challenges (user_id, day, slot, template_key, kind, game_id, board_key, target, title, tier, coins, xp)
     select $1, $3::date, k.slot, t.key, t.kind, t.game_id, t.board_key, t.target,
            replace(replace(t.title, '{game}', coalesce(g.title, '')), '{target}', t.target::text), t.tier, t.coins, t.xp
       from unnest($2::text[]) with ordinality as k(key, slot)
       join public.challenge_templates t on t.key = k.key
       left join public.games g on g.id = t.game_id`,
    [uid, keys, day],
  );
const generate = (db: PGlite, uid: string, day = today()) =>
  db.query(`select private.ensure_daily_challenges($1, $2::date)`, [uid, day]);

// --- games and Realtime --------------------------------------------------------------------------------------------

async function setupGames(db: PGlite) {
  for (const id of ['sumo', 'stack', 'gunrun', 'overrun']) await insertGame(db, id);
  await insertGame(db, 'secret', 'draft');
  await db.exec(`
    update public.games set title = 'Sumo', modes = '{quick,browser,private}', max_players = 8 where id = 'sumo';
    update public.games set title = 'Gun Run', modes = '{quick,browser,private}', max_players = 8 where id = 'gunrun';
    update public.games set title = 'Overrun', modes = '{quick,browser,private}', max_players = 4 where id = 'overrun';
    update public.games set title = 'Stack' where id = 'stack';
    update public.games set title = 'Secret', modes = '{quick}' where id = 'secret';
    insert into public.leaderboards (game_id, key, sort, period, max_score_per_minute) values
      ('stack', 'height', 'desc', 'alltime', 120), ('stack', 'daily', 'desc', 'daily', null);
    insert into public.achievements (game_id, key, title) values
      ('sumo', 'first_win', 'First win'), ('stack', 'tower', 'Tower');
    -- A template for an unpublished game: never picked.
    insert into public.challenge_templates (key, kind, game_id, target, title, tier, coins, xp)
      values ('secret_1', 'play_game', 'secret', 1, 'Play {game}', 1, 20, 30);
    -- The play streak (20261102000400_streaks.sql) is pinned by streaks.test.ts; here it would add 'streak' rows to
    -- both ledgers.
    update public.progress_rules set value = 0 where key ~ '^streak_';
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

const RESET = `
  delete from public.xp_ledger; delete from public.player_progress; delete from public.daily_challenges;
  delete from public.coin_ledger; delete from public.wallets; delete from public.match_results;
  delete from public.user_achievements; delete from public.user_sanctions; delete from public.game_stats;
  delete from public.play_sessions; delete from public.rate_limits; delete from public.leaderboard_entries;
  delete from public.friendships; delete from public.blocks;
  update public.progress_rules set value = case key
    when 'match' then 20 when 'win' then 10 when 'match_daily_cap' then 600 when 'achievement' then 25
    when 'solo' then 10 when 'solo_daily_cap' then 100 when 'level_coins' then 50 when 'level_coins_step' then 10
    when 'level_coins_max' then 250 end
   where key !~ '^streak_';
`;

const befriend = (db: PGlite, a: string, b: string) =>
  db.query(
    `insert into public.friendships (user_id, friend_id, status, accepted_at) values ($1, $2, 'accepted', now())`,
    [a, b],
  );
const setPrivacy = (db: PGlite, uid: string, privacy: object) =>
  asUser(db, uid, () =>
    db.query(`update public.profiles set privacy = $2::jsonb where id = $1`, [uid, JSON.stringify(privacy)]),
  );

// =====================================================================================================================

describe('the level curve: SQL and the app share one formula', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  test('documented values: 100 + 25 per level, capped at 500 from level 17', async () => {
    assert.deepEqual(
      [1, 2, 3, 4, 10, 16, 17, 18, 50].map((l) => xpToNextLevel(l)),
      [100, 125, 150, 175, 325, 475, 500, 500, 500],
    );
    assert.deepEqual(
      [1, 2, 3, 4, 5, 10, 17, 18, 20].map((l) => xpForLevel(l)),
      [0, 100, 225, 375, 550, 1800, 4600, 5100, 6100],
    );
    assert.deepEqual(
      [0, 99, 100, 224, 225, 1799, 1800, 4599, 4600, 5099, 5100].map((x) => levelForXp(x)),
      [1, 1, 2, 2, 3, 9, 10, 16, 17, 17, 18],
    );
    assert.deepEqual(progressForXp(260), { level: 3, xp_into_level: 35, xp_for_next: 150, total_xp: 260 });
    // Junk reads as nothing earned yet.
    assert.deepEqual(progressForXp(-5), { level: 1, xp_into_level: 0, xp_for_next: 100, total_xp: 0 });
    assert.deepEqual(progressForXp(Number.NaN), progressForXp(0));
  });

  test('private.xp_to_next_level / xp_for_level / level_for_xp equal the TS formula everywhere', async () => {
    const levels = await db.query<{ l: number; next: number; at: string }>(
      `select l, private.xp_to_next_level(l) as next, private.xp_for_level(l)::text as at from generate_series(0, 400) l`,
    );
    for (const r of levels.rows) {
      assert.equal(r.next, xpToNextLevel(r.l), `xp_to_next_level(${r.l})`);
      assert.equal(Number(r.at), xpForLevel(r.l), `xp_for_level(${r.l})`);
    }
    const totals = await db.query<{ x: number; l: number; p: LevelProgress }>(
      `select x, private.level_for_xp(x) as l, private.progress_of(x) as p
         from (select generate_series(0, 12000, 7) as x union all select unnest(array[-1, 99, 100, 4599, 4600, 1999999999])) q`,
    );
    for (const r of totals.rows) {
      assert.equal(r.l, levelForXp(r.x), `level_for_xp(${r.x})`);
      assert.deepEqual(r.p, progressForXp(r.x), `progress_of(${r.x})`);
    }
    // Every level boundary, both sides.
    for (let l = 2; l <= 60; l++) {
      const at = xpForLevel(l);
      const r = await db.query<{ below: number; on: number }>(
        `select private.level_for_xp($1 - 1) as below, private.level_for_xp($1) as on`,
        [at],
      );
      assert.deepEqual(r.rows[0], { below: l - 1, on: l }, `boundary of level ${l}`);
    }
  });

  test('level-up coins: 50 at level 2, +10 a level, at most 250; tunable', async () => {
    const r = await db.query<{ l: number; c: number }>(
      `select l, private.level_coins(l) as c from generate_series(1, 30) l order by l`,
    );
    assert.deepEqual(
      r.rows.map((x) => x.c),
      [0, ...Array.from({ length: 29 }, (_, i) => Math.min(50 + 10 * i, 250))],
    );
    await setRule(db, 'level_coins_max', 0);
    assert.equal((await db.query<{ c: number }>(`select private.level_coins(5) as c`)).rows[0]!.c, 0);
  });
});

// =====================================================================================================================

describe('progress: rules, tables and privileges', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    await grantXp(db, ann, 150, 'seed');
    await grantXp(db, ben, 40, 'seed');
    await generate(db, ann);
    await generate(db, ben);
  });
  after(() => db.close());

  test('progress_rules: the documented starting values, readable by everyone, writable by nobody', async () => {
    // The streak's rules (streak_*) are pinned by streaks.test.ts (setupGames turns them off here).
    const r = await db.query<{ key: string; value: number }>(
      `select key, value from public.progress_rules where key !~ '^streak_' order by key`,
    );
    assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.key, x.value])), {
      achievement: 25,
      level_coins: 50,
      level_coins_max: 250,
      level_coins_step: 10,
      match: 20,
      match_daily_cap: 600,
      solo: 10,
      solo_daily_cap: 100,
      win: 10,
    });
    for (const run of [(fn: () => Promise<void>) => asUser(db, ann, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(async () => {
        assert.equal(await count(db, `select 1 from public.progress_rules where key !~ '^streak_'`), 9);
        assert.equal(await count(db, `select 1 from public.challenge_templates`), 28);
        await assert.rejects(
          db.query(`update public.progress_rules set value = 1000 where key = 'win'`),
          permissionDenied,
        );
        await assert.rejects(db.query(`update public.challenge_templates set coins = 1000`), permissionDenied);
        await assert.rejects(
          db.query(
            `insert into public.challenge_templates (key, kind, target, title, tier) values ('x', 'win_matches', 1, 'x', 1)`,
          ),
          permissionDenied,
        );
      });
    }
  });

  test('the seeded templates: 27 in three tiers, rewards growing with the tier, short targets', async () => {
    const r = await db.query<{
      key: string;
      kind: ChallengeKind;
      tier: number;
      target: number;
      coins: number;
      xp: number;
    }>(
      `select key, kind, tier, target, coins, xp from public.challenge_templates where key <> 'secret_1' order by tier, key`,
    );
    // 15 from 20261101000100_progress.sql, 12 from 20261102000300_more_content.sql (pinned in more-content.test.ts).
    assert.equal(r.rows.length, 27);
    const byTier = (t: number) => r.rows.filter((x) => x.tier === t);
    assert.deepEqual(
      [1, 2, 3].map((t) => byTier(t).length),
      [9, 10, 8],
    );
    for (const [t, coins, xp] of [
      [1, 20, 30],
      [2, 35, 50],
      [3, 50, 70],
    ] as const) {
      assert.ok(
        byTier(t).every((x) => x.coins === coins && x.xp === xp),
        `tier ${t} pays ${coins} coins / ${xp} XP`,
      );
    }
    // Never grindy: at most 5 of anything.
    assert.ok(r.rows.filter((x) => x.kind !== 'score').every((x) => x.target <= 5));
    // Templates are checked.
    for (const bad of [
      `('t1', 'play_game', null, null, 1, 'x', 1)`, // a game template without a game
      `('t2', 'score', 'stack', null, 10, 'x', 1)`, // a score without a board
      `('t3', 'win_matches', null, null, 50, 'x', 1)`, // grindy
      `('t4', 'win_matches', null, null, 1, 'x', 4)`, // no such tier
      `('t5', 'hug', null, null, 1, 'x', 1)`,
    ]) {
      await assert.rejects(
        db.query(
          `insert into public.challenge_templates (key, kind, game_id, board_key, target, title, tier) values ${bad}`,
        ),
        /challenge_templates_/,
        bad,
      );
    }
  });

  test('RLS: users read only their own progress, XP history and challenges', async () => {
    await asUser(db, ben, async () => {
      assert.deepEqual((await db.query(`select user_id from public.player_progress`)).rows, [{ user_id: ben }]);
      assert.deepEqual((await db.query(`select distinct user_id from public.xp_ledger`)).rows, [{ user_id: ben }]);
      assert.deepEqual((await db.query(`select distinct user_id from public.daily_challenges`)).rows, [
        { user_id: ben },
      ]);
      for (const t of ['player_progress', 'xp_ledger', 'daily_challenges']) {
        assert.equal(await count(db, `select 1 from public.${t} where user_id = $1`, [ann]), 0, t);
      }
    });
    await asAnon(db, async () => {
      for (const t of ['player_progress', 'xp_ledger', 'daily_challenges']) {
        await assert.rejects(db.query(`select * from public.${t}`), permissionDenied, t);
      }
    });
  });

  test('clients cannot write progress, the XP ledger or challenges, nor call the internal writers', async () => {
    const [annChallenge] = await stateOf(db, ann);
    await asUser(db, ben, async () => {
      const writes = [
        [`update public.player_progress set xp = 99999`],
        [`insert into public.player_progress (user_id, xp, level) values ($1, 5000, 18)`, [ben]],
        [
          `insert into public.xp_ledger (user_id, amount, reason, ref, xp_after, level_after) values ($1, 500, 'win', 'x', 500, 4)`,
          [ben],
        ],
        [`delete from public.xp_ledger`],
        [`update public.daily_challenges set progress = target, completed_at = now()`],
        [
          `insert into public.daily_challenges (user_id, day, slot, template_key, kind, target, title, tier, coins, xp)
          values ($1, current_date, 1, 'x', 'win_matches', 1, 'x', 1, 1000, 1000)`,
          [ben],
        ],
        [`delete from public.daily_challenges`],
      ] as const;
      for (const [sql, params] of writes)
        await assert.rejects(db.query(sql, params ? [...params] : []), permissionDenied, sql);
      for (const sql of [
        `select private.apply_xp($1, 1000, 'adjustment', 'x')`,
        `select private.award_xp($1, 1000, 'win', 'x')`,
        `select private.ensure_daily_challenges($1, current_date)`,
        `select private.challenge_event($1, current_date, 'match', 'match:x', 'sumo')`,
      ]) {
        await assert.rejects(db.query(sql, [ben]), permissionDenied, sql);
      }
      // Someone else's challenge cannot be claimed either (it does not exist for ben).
      await assert.rejects(db.query(`select public.claim_daily_challenge($1)`, [annChallenge!.id]), notFound);
    });
    assert.deepEqual(await stored(db, ben), { xp: 40, level: 1 });
  });

  test('the XP ledger is append-only, even for the service role; amounts are positive', async () => {
    await asService(db, async () => {
      await assert.rejects(db.query(`update public.xp_ledger set amount = 1 where user_id = $1`, [ann]), /IMMUTABLE/);
    });
    // A non-positive amount is a no-op (XP never goes down), not an error.
    const none = await db.query<{ n: number }>(`select private.apply_xp($1, -10, 'adjustment', 'take') as n`, [ann]);
    assert.equal(none.rows[0]!.n, 0);
    assert.deepEqual(await stored(db, ann), { xp: 150, level: 2 });
    await assert.rejects(
      db.query(
        `insert into public.xp_ledger (user_id, amount, reason, ref, xp_after, level_after) values ($1, 0, 'win', 'z', 150, 2)`,
        [ann],
      ),
      /xp_ledger_amount/,
    );
    await assert.rejects(
      db.query(
        `insert into public.xp_ledger (user_id, amount, reason, ref, xp_after, level_after) values ($1, 5, 'gift', 'z', 155, 2)`,
        [ann],
      ),
      /xp_ledger_reason/,
    );
    await assertProgressInvariant(db);
  });

  test('who may call what', async () => {
    const expect: Record<string, [anon: boolean, auth: boolean]> = {
      'public.my_progress()': [false, true],
      'public.my_daily_challenges()': [false, true],
      'public.claim_daily_challenge(uuid)': [false, true],
      'public.public_progress(uuid)': [true, true],
      'public.submit_solo_score(text, text, double precision, uuid)': [false, true],
      'public.unlock_achievement(text, text)': [false, true],
      'public.server_record_match(jsonb)': [false, false],
    };
    for (const [fn, [anon, auth]] of Object.entries(expect)) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc, has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon, auth, svc: true, pub: false }, fn);
    }
    const internal = [
      'progress_rule',
      'xp_to_next_level',
      'xp_for_level',
      'level_for_xp',
      'progress_of',
      'level_coins',
      'broadcast_progress',
      'iso_now',
      'lock_progress',
      'apply_xp',
      'award_xp',
      'xp_ledger_append_only',
      'broadcast_xp_award',
      'broadcast_challenge_change',
      'utc_today',
      'ensure_daily_challenges',
      'challenge_event',
      'purge_progress_rows',
    ];
    const acl = await db.query<{ proname: string; public_exec: boolean; svc_exec: boolean }>(
      `select proname, has_function_privilege('public', oid, 'execute') as public_exec,
              has_function_privilege('service_role', oid, 'execute') as svc_exec
         from pg_proc where pronamespace = 'private'::regnamespace and proname = any ($1)`,
      [internal],
    );
    assert.equal(acl.rows.length, internal.length);
    assert.ok(
      acl.rows.every((r) => !r.public_exec && !r.svc_exec),
      JSON.stringify(acl.rows),
    );
    // Security definer functions pin their search_path.
    const loose = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p where p.prosecdef and p.proname = any ($1)
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
      [['my_progress', 'public_progress', 'my_daily_challenges', 'claim_daily_challenge', ...internal]],
    );
    assert.deepEqual(loose.rows, []);
  });

  test('the coin ledger accepts the new reasons, nothing else', async () => {
    await db.query(`select private.apply_coins($1, 5, 'challenge', 'c-test')`, [ann]);
    await db.query(`select private.apply_coins($1, 5, 'level', '99')`, [ann]);
    await assert.rejects(db.query(`select private.apply_coins($1, 5, 'gift', 'g')`, [ann]), /coin_ledger_reason/);
  });
});

// =====================================================================================================================

describe('earning XP: matches, achievements, solo runs', () => {
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

  test('a counted match pays match XP to everyone and the win bonus to the winner, with the game as note', async () => {
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await xpReasons(db, ann), ['match:20', 'win:10']);
    assert.deepEqual(await xpReasons(db, ben), ['match:20']);
    const [first] = await xpRows(db, ann);
    assert.equal(first!.game_id, 'sumo');
    assert.equal(first!.note, 'Sumo');
    assert.match(first!.ref, /^xp\d+:1$/);
    assert.deepEqual(
      (await xpRows(db, ann)).map((r) => [r.xp_after, r.level_after]),
      [
        [20, 1],
        [30, 1],
      ],
    );
    assert.deepEqual(await stored(db, ann), { xp: 30, level: 1 });
    await assertProgressInvariant(db);
  });

  test('idempotent: a replayed match pays no XP, even after match_results was purged', async () => {
    const m = match([p(ann, { achievements: ['first_win'] }), p(ben)], { winnerUserId: ann });
    await record(db, m);
    const paid = await xpReasons(db, ann);
    assert.deepEqual(paid, ['match:20', 'win:10', 'achievement:25']);
    assert.deepEqual(await record(db, m), { duplicate: true });
    await db.query(`delete from public.match_results where match_id = $1`, [m.matchId]);
    await record(db, m);
    assert.deepEqual(await xpReasons(db, ann), paid);
    assert.deepEqual(await stored(db, ann), { xp: 55, level: 1 });
  });

  test('anti-boost: short and private-alone matches pay no XP (they still count for stats)', async () => {
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, durationSec: 19 }));
    await record(db, match([p(ann), guest(1)], { winnerUserId: ann, private: true }));
    assert.deepEqual(await xpReasons(db, ann), []);
    assert.equal(await count(db, `select 1 from public.player_progress`), 0);
    await record(db, match([p(cat), guest(2)], { winnerUserId: cat }));
    assert.deepEqual(await xpReasons(db, cat), ['match:20', 'win:10']);
  });

  test('guests, anonymous, banned and unknown players never earn XP', async () => {
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'cheating')`, [cat]);
    await record(
      db,
      match([{ userId: ben, guest: true }, p(ghost), p(cat), p('session:abc'), guest(7), p(ann)], {
        winnerUserId: ghost,
      }),
    );
    assert.deepEqual(await xpReasons(db, ann), ['match:20']);
    for (const u of [ben, ghost, cat]) {
      assert.deepEqual(await xpRows(db, u), [], u);
      assert.equal(await count(db, `select 1 from public.player_progress where user_id = $1`, [u]), 0);
      assert.equal(await count(db, `select 1 from public.daily_challenges where user_id = $1`, [u]), 0);
    }
    await asAnonymousUser(db, ghost, async () => {
      assert.deepEqual((await db.query(`select * from public.my_daily_challenges()`)).rows, []);
      const r = await db.query<{ r: MyProgress }>(`select public.my_progress() as r`);
      assert.deepEqual(r.rows[0]!.r, {
        level: 1,
        xp_into_level: 0,
        xp_for_next: 100,
        total_xp: 0,
        next_level_coins: 50,
      });
      await assert.rejects(db.query(`select public.claim_daily_challenge(gen_random_uuid())`), anonymousForbidden);
    });
    assert.equal(await count(db, `select 1 from public.daily_challenges where user_id = $1`, [ghost]), 0);
  });

  test('match XP is capped per UTC day (match + win); tunable; resets the next day', async () => {
    await setRule(db, 'match_daily_cap', 70);
    for (let i = 0; i < 3; i++) await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await xpReasons(db, ann), ['match:20', 'win:10', 'match:20', 'win:10', 'match:10']);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.equal((await xpRows(db, ann)).length, 5, 'nothing once capped');
    // Tomorrow (today's rows become yesterday's).
    await db.exec(`alter table public.xp_ledger disable trigger xp_ledger_append_only`);
    await db.query(`update public.xp_ledger set created_at = created_at - interval '1 day' where user_id = $1`, [ann]);
    await db.exec(`alter table public.xp_ledger enable trigger xp_ledger_append_only`);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual((await xpReasons(db, ann)).slice(5), ['match:20', 'win:10']);
    await assertProgressInvariant(db);
  });

  test('achievements pay XP once, from matches and from unlock_achievement', async () => {
    await record(db, match([p(ann, { achievements: ['first_win', 'nope'] }), p(ben)], { durationSec: 5 }));
    assert.deepEqual(await xpRows(db, ann).then((r) => r.map((x) => [x.reason, x.amount, x.ref, x.note])), [
      ['achievement', 25, 'sumo:first_win', 'First win'],
    ]);
    await session(db, ann);
    await unlock(db, ann, 'tower');
    await unlock(db, ann, 'tower');
    assert.deepEqual(await xpReasons(db, ann), ['achievement:25', 'achievement:25']);
    assert.deepEqual((await xpRows(db, ann))[1]!.ref, 'stack:tower');
  });

  test('a valid solo run pays XP once per session, refused runs pay nothing, and solo XP is capped', async () => {
    const s1 = await session(db, ann);
    await submit(db, ann, 10, s1);
    await submit(db, ann, 10, s1, 'daily');
    await submit(db, ann, 5, s1); // not_best, same session
    assert.deepEqual(await xpReasons(db, ann), ['solo:10']);
    assert.deepEqual([(await xpRows(db, ann))[0]!.ref, (await xpRows(db, ann))[0]!.note], [s1, 'Stack']);
    // Not best but valid, new session: pays.
    assert.equal((await submit(db, ann, 3, await session(db, ann))).reason, 'not_best');
    // Refused runs: too new, beyond the bounds.
    assert.equal((await submit(db, ann, 3, await session(db, ann, 'stack', 0))).reason, 'session_too_new');
    assert.equal((await submit(db, ann, 1000, await session(db, ann, 'stack', 30))).reason, 'bounds');
    assert.deepEqual(await xpReasons(db, ann), ['solo:10', 'solo:10']);
    // The cap: 100 a day, the last award cut.
    await setRule(db, 'solo_daily_cap', 45);
    for (let i = 0; i < 4; i++) await submit(db, ann, 20 + i, await session(db, ann));
    assert.deepEqual(await xpReasons(db, ann), ['solo:10', 'solo:10', 'solo:10', 'solo:10', 'solo:5']);
  });

  test('a failing XP write rolls the whole match back, so a retry pays exactly once', async () => {
    await db.exec(`
      create function public.test_fail_xp() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger test_fail before insert on public.xp_ledger for each row execute function public.test_fail_xp();
    `);
    const m = match([p(ann), p(ben)], { winnerUserId: ann });
    try {
      await assert.rejects(record(db, m), /boom/);
    } finally {
      await db.exec(`drop trigger test_fail on public.xp_ledger; drop function public.test_fail_xp();`);
    }
    assert.equal(await count(db, `select 1 from public.match_results`), 0);
    assert.equal(await count(db, `select 1 from public.coin_ledger`), 0);
    assert.equal(await count(db, `select 1 from public.daily_challenges`), 0);
    await record(db, m);
    assert.deepEqual(await xpReasons(db, ann), ['match:20', 'win:10']);
  });
});

// =====================================================================================================================

describe('levels: level-up coins once per level, my_progress, public_progress', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('reaching a level pays its coins once (coin_ledger reason level, ref = the level); several levels at once each pay', async () => {
    await grantXp(db, ann, 95);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben })); // 115 XP: level 2
    assert.deepEqual(await stored(db, ann), { xp: 115, level: 2 });
    assert.deepEqual(
      (await coinRows(db, ann)).filter((r) => r.reason === 'level'),
      [{ amount: 50, reason: 'level', ref: '2', note: 'Level 2' }],
    );
    // A jump over many levels (a big grant): every level in between pays its own coins, once.
    await grantXp(db, ann, 4600 - 115); // level 17
    const levels = (await coinRows(db, ann)).filter((r) => r.reason === 'level');
    assert.deepEqual(
      levels.map((r) => r.ref),
      Array.from({ length: 16 }, (_, i) => String(i + 2)),
    );
    assert.deepEqual(
      levels.map((r) => r.amount),
      Array.from({ length: 16 }, (_, i) => Math.min(50 + 10 * i, 250)),
    );
    // Replaying the match, or paying a level again directly, adds nothing.
    const before = await coinReasons(db, ann);
    await db.query(`select private.award_coins($1, 999, 'level', '5')`, [ann]);
    assert.deepEqual(await coinReasons(db, ann), before);
    // XP rows carry the level after them.
    assert.deepEqual(
      (await xpRows(db, ann)).map((r) => r.level_after),
      [1, 2, 17],
    );
    await assertProgressInvariant(db);
  });

  test('level coins go through the wallet: balance, lifetime earnings, and the cap rule', async () => {
    await grantXp(db, ben, 225); // level 3: 50 + 60
    const w = await db.query<{ balance: number; lifetime_earned: number }>(
      `select balance, lifetime_earned from public.wallets where user_id = $1`,
      [ben],
    );
    assert.deepEqual(w.rows[0], { balance: 110, lifetime_earned: 110 });
    await setRule(db, 'level_coins_max', 55);
    await grantXp(db, ben, 150); // level 4: capped at 55
    assert.deepEqual(await coinReasons(db, ben, ['level']), ['level:50', 'level:60', 'level:55']);
    // Rules at 0: a level-up pays nothing (no row), the level still counts.
    await setRule(db, 'level_coins_max', 0);
    await grantXp(db, ben, 175);
    assert.deepEqual(await stored(db, ben), { xp: 550, level: 5 });
    assert.equal((await coinReasons(db, ben, ['level'])).length, 3);
  });

  test("my_progress: level, xp into it, its size, the total and the next level's coins; signed out refused", async () => {
    assert.deepEqual(await myProgress(db, ann), {
      level: 1,
      xp_into_level: 0,
      xp_for_next: 100,
      total_xp: 0,
      next_level_coins: 50,
    });
    await grantXp(db, ann, 260);
    assert.deepEqual(await myProgress(db, ann), {
      level: 3,
      xp_into_level: 35,
      xp_for_next: 150,
      total_xp: 260,
      next_level_coins: 70,
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.my_progress()`), permissionDenied);
    });
    // A request with the authenticated role but no user (no sub claim).
    await assert.rejects(
      asRole(db, 'authenticated', () => db.query(`select public.my_progress()`)),
      unauthenticated,
    );
  });

  test('public_progress follows privacy.games and blocks; strangers and signed out see public levels only', async () => {
    await grantXp(db, ann, 260);
    await befriend(db, ann, ben);
    const view = {
      ann: () => asUser(db, ann, () => publicProgress(db, ann)),
      ben: () => asUser(db, ben, () => publicProgress(db, ann)),
      cat: () => asUser(db, cat, () => publicProgress(db, ann)),
      anon: () => asAnon(db, () => publicProgress(db, ann)),
    };
    const level3 = { level: 3, xp_into_level: 35, xp_for_next: 150, total_xp: 260 };
    for (const v of Object.values(view)) assert.deepEqual(await v(), level3);
    await setPrivacy(db, ann, { games: 'friends' });
    assert.deepEqual(
      [await view.ann(), await view.ben(), await view.cat(), await view.anon()],
      [level3, level3, null, null],
    );
    await setPrivacy(db, ann, { games: 'private' });
    assert.deepEqual(
      [await view.ann(), await view.ben(), await view.cat(), await view.anon()],
      [level3, null, null, null],
    );
    await setPrivacy(db, ann, {});
    await asUser(db, cat, () => db.query(`select public.block_user($1)`, [ann]));
    assert.equal(await view.cat(), null);
    assert.deepEqual(await view.ben(), level3);
    // Unknown users and players without XP.
    assert.equal(await asUser(db, ben, () => publicProgress(db, '00000000-0000-0000-0000-000000000000')), null);
    assert.deepEqual(await asUser(db, ann, () => publicProgress(db, ben)), progressForXp(0));
  });
});

// =====================================================================================================================

interface PoolTemplate {
  key: string;
  kind: string;
  tier: number;
  game_id: string | null;
}
/** The games setupGames publishes: templates naming any other game are never picked in these tests. */
const PUBLISHED_GAMES = new Set(['sumo', 'stack', 'gunrun', 'overrun']);
const published = (t: PoolTemplate) => t.game_id === null || PUBLISHED_GAMES.has(t.game_id);

/** The pick, re-implemented from the migration's rules: one template per tier in md5(user/day/key) order. */
function modelPick(uid: string, day: string, pool: { key: string; kind: string; tier: number }[]): string[] {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const ordered = [...pool].sort((a, b) => {
    const ha = md5(`${uid}/${day}/${a.key}`);
    const hb = md5(`${uid}/${day}/${b.key}`);
    return ha < hb ? -1 : ha > hb ? 1 : a.key < b.key ? -1 : 1;
  });
  const keys: string[] = [];
  const kinds: string[] = [];
  const take = (t: { key: string; kind: string }) => {
    keys.push(t.key);
    kinds.push(t.kind);
  };
  for (const tier of [1, 2, 3]) {
    const pick =
      ordered.find((t) => t.tier === tier && !kinds.includes(t.kind)) ??
      ordered.find((t) => !keys.includes(t.key) && !kinds.includes(t.kind)) ??
      ordered.find((t) => !keys.includes(t.key));
    if (pick) take(pick);
  }
  return keys;
}

describe('daily challenges: the seeded pick', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let pool: PoolTemplate[];
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    pool = (
      await db.query<PoolTemplate>(
        `select key, kind, tier, game_id from public.challenge_templates where active order by key`,
      )
    ).rows;
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  const eligible = (opts: { friend: boolean }) =>
    pool.filter((t) => t.key !== 'secret_1' && published(t) && (opts.friend || t.kind !== 'friend_match'));
  const friendKeys = () => pool.filter((t) => t.kind === 'friend_match').map((t) => t.key);

  test('three per day, one per tier, distinct kinds, titles filled in; stable once picked', async () => {
    const rows = await myChallenges(db, ann);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.slot),
      [1, 2, 3],
    );
    const state = await stateOf(db, ann);
    assert.deepEqual(
      state.map((c) => c.tier),
      [1, 2, 3],
    );
    assert.equal(new Set(state.map((c) => c.kind)).size, 3);
    for (const c of state) assert.doesNotMatch(c.title, /\{|\}/, c.title);
    const dayOf = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
    assert.deepEqual(
      rows.map((r) => dayOf(r.day)),
      [today(), today(), today()],
    );
    // resets at the end of the UTC day; claimable until the end of the next.
    const end = Date.parse(`${today()}T00:00:00Z`) + 86_400_000;
    assert.equal(new Date(rows[0]!.resets_at).getTime(), end);
    assert.equal(new Date(rows[0]!.expires_at).getTime(), end + 86_400_000);
    // Calling again returns the same rows (no new pick), even after the pool changes.
    await db.query(`update public.challenge_templates set active = false where key = $1`, [state[0]!.template_key]);
    assert.deepEqual(
      (await myChallenges(db, ann)).map((r) => r.id),
      rows.map((r) => r.id),
    );
    await db.query(`update public.challenge_templates set active = true`);
  });

  test('deterministic: the pick is the md5(user, date, key) order, the same every time it is made', async () => {
    const want = modelPick(ann, today(), eligible({ friend: false }));
    await generate(db, ann);
    assert.deepEqual(
      (await stateOf(db, ann)).map((c) => c.template_key),
      want,
    );
    // Made again from scratch: the same set.
    await db.query(`delete from public.daily_challenges`);
    await myChallenges(db, ann);
    assert.deepEqual(
      (await stateOf(db, ann)).map((c) => c.template_key),
      want,
    );
    // 60 past days and a second user: SQL and the model agree everywhere.
    for (let n = 1; n <= 60; n++) {
      const day = daysAgo(n);
      await generate(db, ann, day);
      assert.deepEqual(
        (await stateOf(db, ann, day)).map((c) => c.template_key),
        modelPick(ann, day, eligible({ friend: false })),
        day,
      );
    }
    await generate(db, ben);
    assert.deepEqual(
      (await stateOf(db, ben)).map((c) => c.template_key),
      modelPick(ben, today(), eligible({ friend: false })),
    );
  });

  test('varied and fair: different per user and per day, every eligible template comes up, each tier every day', async () => {
    for (let n = 0; n < 365; n++) await generate(db, ann, daysAgo(n));
    const sets = await db.query<{ day: string; keys: string[]; tiers: number[]; coins: number; xp: number }>(
      `select day::text, array_agg(template_key order by slot) as keys, array_agg(tier order by slot) as tiers,
              sum(coins)::int as coins, sum(xp)::int as xp
         from public.daily_challenges where user_id = $1 group by day`,
      [ann],
    );
    assert.equal(sets.rows.length, 365);
    assert.ok(
      sets.rows.every((s) => s.tiers.join() === '1,2,3' && s.coins === 105 && s.xp === 150),
      'every day: one of each tier, same rewards',
    );
    const distinct = new Set(sets.rows.map((s) => s.keys.join()));
    assert.ok(distinct.size >= 40, `varied: ${distinct.size} different sets in a year`);
    const seen = new Set(sets.rows.flatMap((s) => s.keys));
    assert.deepEqual(
      [...seen].sort(),
      eligible({ friend: false })
        .map((t) => t.key)
        .sort(),
    );
    // Same day, another user: (almost surely) another set; certainly computed independently.
    await generate(db, ben);
    assert.deepEqual(
      (await stateOf(db, ben)).map((c) => c.template_key),
      modelPick(ben, today(), eligible({ friend: false })),
    );
  });

  test('eligibility: unpublished games never, the friend challenge only with a friend, variety needs enough games', async () => {
    for (let n = 0; n < 60; n++) await generate(db, ann, daysAgo(n));
    const keys = async (uid: string) =>
      new Set(
        (
          await db.query<{ k: string }>(
            `select distinct template_key as k from public.daily_challenges where user_id = $1`,
            [uid],
          )
        ).rows.map((r) => r.k),
      );
    const annKeys = await keys(ann);
    assert.ok(!annKeys.has('secret_1'), 'never a draft game');
    assert.ok(!friendKeys().some((k) => annKeys.has(k)), 'no friend, no friend challenge');
    // With a friend it comes up (the same days now include it where the model says so).
    await befriend(db, ann, ben);
    await db.query(`delete from public.daily_challenges`);
    for (let n = 0; n < 60; n++) {
      const day = daysAgo(n);
      await generate(db, ann, day);
      assert.deepEqual(
        (await stateOf(db, ann, day)).map((c) => c.template_key),
        modelPick(ann, day, eligible({ friend: true })),
      );
    }
    const withFriend = await keys(ann);
    assert.ok(
      friendKeys().some((k) => withFriend.has(k)),
      'a friend challenge comes up',
    );
    // Only Stack published (solo only, one game): Stack challenges and any-solo-game runs only, still three, one per
    // tier where possible.
    await db.query(`update public.games set status = 'hidden' where id <> 'stack'`);
    await db.query(`delete from public.daily_challenges`);
    await generate(db, ann);
    const stackOnly = pool.filter((t) => t.game_id === 'stack' || t.kind === 'solo_runs');
    const picked = (await stateOf(db, ann)).map((c) => c.template_key);
    assert.deepEqual(picked, modelPick(ann, today(), stackOnly));
    assert.equal(picked.length, 3);
    assert.ok(picked.every((k) => stackOnly.some((t) => t.key === k)));
    // Nothing published: no challenges (the app shows its empty state).
    await db.query(`update public.games set status = 'hidden'`);
    await db.query(`delete from public.daily_challenges`);
    assert.deepEqual(await myChallenges(db, ann), []);
    await db.query(`update public.games set status = 'published' where id <> 'secret'`);
  });

  test('a coin-locked game (owns_game false) is never named', async () => {
    await db.query(
      `insert into public.shop_items (id, kind, name, price, data) values ('unlock-gunrun', 'game_unlock', 'Gun Run', 300, '{"game_id": "gunrun"}')`,
    );
    try {
      for (let n = 0; n < 60; n++) await generate(db, ann, daysAgo(n));
      const r = await db.query<{ k: string }>(
        `select distinct template_key as k from public.daily_challenges where game_id = 'gunrun'`,
      );
      assert.deepEqual(r.rows, []);
    } finally {
      await db.query(`delete from public.shop_items where id = 'unlock-gunrun'`);
    }
  });
});

// =====================================================================================================================

describe('daily challenges: progress from matches and solo runs', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    await db.exec(`insert into public.challenge_templates (key, kind, target, title, tier, coins, xp)
                   values ('test_solo_2', 'solo_runs', 2, 'Finish 2 solo runs', 1, 20, 30)`);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('counted matches count once each (idempotent per match), wins count for the winner only', async () => {
    await assign(db, ann, ['play_3', 'win_1', 'sumo_2']);
    await assign(db, ben, ['play_3', 'win_1', 'sumo_2']);
    const m = match([p(ann), p(ben)], { winnerUserId: ben });
    await record(db, m);
    assert.deepEqual(await progressOf(db, ann), { play_3: '1/3', win_1: '0/1', sumo_2: '1/2' });
    assert.deepEqual(await progressOf(db, ben), { play_3: '1/3', win_1: '1/1', sumo_2: '1/2' });
    // Replays, even after match_results was purged, count nothing more.
    await record(db, m);
    await db.query(`delete from public.match_results where match_id = $1`, [m.matchId]);
    await record(db, m);
    assert.deepEqual(await progressOf(db, ann), { play_3: '1/3', win_1: '0/1', sumo_2: '1/2' });
    // Not counted (short / private alone): nothing.
    await record(db, match([p(ann), p(ben)], { durationSec: 10, winnerUserId: ann }));
    await record(db, match([p(ann), guest(1)], { private: true, winnerUserId: ann }));
    assert.deepEqual(await progressOf(db, ann), { play_3: '1/3', win_1: '0/1', sumo_2: '1/2' });
    // Another game counts for play_3, not for sumo_2; completion is stamped and stops counting.
    await record(db, match([p(ann), p(ben)], { gameId: 'gunrun', winnerUserId: ann }));
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await progressOf(db, ann), { play_3: '3/3', win_1: '1/1', sumo_2: '2/2' });
    assert.ok((await stateOf(db, ann)).every((c) => c.completed && !c.claimed));
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await progressOf(db, ann), { play_3: '3/3', win_1: '1/1', sumo_2: '2/2' });
  });

  test('play with a friend: a counted match with an accepted friend', async () => {
    await assign(db, ann, ['friend_1']);
    await assign(db, cat, ['friend_1']);
    await record(db, match([p(ann), p(cat)]));
    assert.deepEqual(await progressOf(db, ann), { friend_1: '0/1' });
    await befriend(db, cat, ann);
    await record(db, match([p(ann), p(cat), guest(3)]));
    assert.deepEqual(await progressOf(db, ann), { friend_1: '1/1' });
    assert.deepEqual(await progressOf(db, cat), { friend_1: '1/1' });
  });

  test('different games: matches and solo runs of distinct games; play_game and solo runs; refused runs never count', async () => {
    await assign(db, ann, ['variety_3', 'stack_2', 'test_solo_2']);
    await record(db, match([p(ann), p(ben)]));
    await record(db, match([p(ann), p(ben)])); // Sumo again: still 1 game
    assert.deepEqual(await progressOf(db, ann), { variety_3: '1/3', stack_2: '0/2', test_solo_2: '0/2' });
    const s = await session(db, ann);
    await submit(db, ann, 8, s);
    await submit(db, ann, 9, s, 'daily'); // the same session: counted once
    assert.deepEqual(await progressOf(db, ann), { variety_3: '2/3', stack_2: '1/2', test_solo_2: '1/2' });
    await submit(db, ann, 1000, await session(db, ann, 'stack', 30)); // bounds: refused
    await submit(db, ann, 3, await session(db, ann, 'stack', 0)); // too new: refused
    assert.deepEqual(await progressOf(db, ann), { variety_3: '2/3', stack_2: '1/2', test_solo_2: '1/2' });
    await submit(db, ann, 2, await session(db, ann)); // valid, not best: counts
    await record(db, match([p(ann), p(ben)], { gameId: 'overrun' }));
    assert.deepEqual(await progressOf(db, ann), { variety_3: '3/3', stack_2: '2/2', test_solo_2: '2/2' });
  });

  test('score challenges: progress is the best valid score today, complete at the target', async () => {
    await assign(db, ann, ['stack_15']);
    await submit(db, ann, 9, await session(db, ann));
    assert.deepEqual(await progressOf(db, ann), { stack_15: '9/15' });
    await submit(db, ann, 4, await session(db, ann)); // lower: unchanged
    await submit(db, ann, 3, await session(db, ann), 'daily'); // another board: not this challenge's
    assert.deepEqual(await progressOf(db, ann), { stack_15: '9/15' });
    await submit(db, ann, 12.7, await session(db, ann));
    assert.deepEqual(await progressOf(db, ann), { stack_15: '12/15' });
    await submit(db, ann, 40, await session(db, ann));
    assert.deepEqual(await progressOf(db, ann), { stack_15: '15/15' });
    assert.ok((await stateOf(db, ann))[0]!.completed);
  });

  test('the 20261102000300 templates move through the same counters as the v1 pool', async () => {
    await assign(db, ann, ['solo_2', 'play_4', 'friend_2']);
    await assign(db, ben, ['stack_10', 'variety_4', 'solo_5']);
    await befriend(db, ann, cat);
    // Solo runs (any game, one per session) and the best Stack tower today.
    await submit(db, ann, 4, await session(db, ann));
    await submit(db, ann, 6, await session(db, ann));
    await submit(db, ben, 11, await session(db, ben));
    assert.deepEqual(await progressOf(db, ann), { solo_2: '2/2', play_4: '0/4', friend_2: '0/2' });
    assert.deepEqual(await progressOf(db, ben), { stack_10: '10/10', variety_4: '1/4', solo_5: '1/5' });
    // Matches: every counted one for play_4, those with an accepted friend for friend_2, distinct games for variety_4.
    await record(db, match([p(ann), p(cat)]));
    await record(db, match([p(ann), p(cat)], { gameId: 'gunrun' }));
    await record(db, match([p(ann), p(ben)], { gameId: 'overrun' }));
    await record(db, match([p(ann), p(ben)], { gameId: 'overrun' }));
    assert.deepEqual(await progressOf(db, ann), { solo_2: '2/2', play_4: '4/4', friend_2: '2/2' });
    assert.deepEqual(await progressOf(db, ben), { stack_10: '10/10', variety_4: '2/4', solo_5: '1/5' });
    await record(db, match([p(ben), p(cat)], { gameId: 'gunrun' }));
    await record(db, match([p(ben), p(cat)]));
    assert.deepEqual(await progressOf(db, ben), { stack_10: '10/10', variety_4: '4/4', solo_5: '1/5' });
    assert.deepEqual(
      (await stateOf(db, ann)).map((c) => c.completed),
      [true, true, true],
    );
  });

  test('a match played before the app was opened today still counts (the pick is made on the spot)', async () => {
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    const state = await stateOf(db, ann);
    assert.equal(state.length, 3);
    assert.deepEqual(
      state.map((c) => c.template_key),
      modelPick(
        ann,
        today(),
        (
          await db.query<PoolTemplate>(
            `select key, kind, tier, game_id from public.challenge_templates
              where active and key <> 'secret_1' and kind <> 'friend_match'`,
          )
        ).rows.filter(published),
      ),
    );
    // The dashboard then shows the same rows, with the match in them.
    assert.deepEqual(
      (await myChallenges(db, ann)).map((r) => r.id),
      state.map((c) => c.id),
    );
  });

  test("a match counts toward the UTC day it ended: yesterday's challenges, never generating past days", async () => {
    const yesterday = daysAgo(1);
    await assign(db, ann, ['play_2'], yesterday);
    await record(db, match([p(ann), p(ben)], { endedAt: `${yesterday}T23:58:00.000Z` }));
    assert.deepEqual(await progressOf(db, ann, yesterday), { play_2: '1/2' });
    assert.equal((await stateOf(db, ann)).length, 0, "today's challenges were not touched");
    assert.equal((await stateOf(db, ben, yesterday)).length, 0, 'no pick is made for a past day');
  });
});

// =====================================================================================================================

describe('daily challenges: claiming', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
  });
  beforeEach(() => db.exec(RESET));
  after(() => db.close());

  test('a completed challenge pays its coins and XP through both ledgers, once; claiming twice fails', async () => {
    await assign(db, ann, ['play_2', 'variety_2', 'win_1']);
    for (let i = 0; i < 2; i++) await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    const [c] = await stateOf(db, ann);
    assert.equal(c!.template_key, 'play_2');
    assert.ok(c!.completed);
    const xpBefore = (await stored(db, ann)).xp;
    const r = await claim(db, ann, c!.id);
    assert.equal(r.id, c!.id);
    assert.equal(r.coins, 20);
    assert.equal(r.xp, 30);
    assert.equal(r.total_xp, xpBefore + 30);
    assert.equal(
      r.balance,
      Number(
        (await db.query<{ b: number }>(`select balance as b from public.wallets where user_id = $1`, [ann])).rows[0]!.b,
      ),
    );
    assert.deepEqual(
      (await coinRows(db, ann)).filter((x) => x.reason === 'challenge'),
      [{ amount: 20, reason: 'challenge', ref: c!.id, note: 'Play 2 matches' }],
    );
    assert.deepEqual(
      (await xpRows(db, ann)).filter((x) => x.reason === 'challenge').map((x) => [x.amount, x.ref]),
      [[30, c!.id]],
    );
    await assert.rejects(claim(db, ann, c!.id), alreadyClaimed);
    assert.equal((await coinRows(db, ann)).filter((x) => x.reason === 'challenge').length, 1);
    const rows = await myChallenges(db, ann);
    assert.ok(rows[0]!.claimed_at && rows[0]!.completed_at);
  });

  test('not complete, not yours, unknown, expired: refused and nothing paid', async () => {
    await assign(db, ann, ['play_3', 'win_1']);
    const [c] = await stateOf(db, ann);
    await assert.rejects(claim(db, ann, c!.id), notComplete);
    // Ben can neither read nor claim ann's challenge (same answer as an unknown id).
    await db.exec(
      `update public.daily_challenges set progress = target, completed_at = now() where user_id = '${ann}'`,
    );
    await assert.rejects(claim(db, ben, c!.id), notFound);
    await assert.rejects(claim(db, ben, '00000000-0000-0000-0000-000000000000'), notFound);
    assert.deepEqual(
      await asUser(db, ben, () =>
        db.query(`select * from public.daily_challenges where id = $1`, [c!.id]).then((r) => r.rows),
      ),
      [],
    );
    // Signed out: no access at all.
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.claim_daily_challenge($1)`, [c!.id]), permissionDenied);
      await assert.rejects(db.query(`select * from public.my_daily_challenges()`), permissionDenied);
    });
    // Older than yesterday: expired.
    await assign(db, ann, ['play_2'], daysAgo(2));
    await db.exec(
      `update public.daily_challenges set progress = target, completed_at = now() where user_id = '${ann}'`,
    );
    const [old] = await stateOf(db, ann, daysAgo(2));
    await assert.rejects(claim(db, ann, old!.id), expired);
    assert.deepEqual(await coinReasons(db, ann, ['challenge']), []);
    assert.deepEqual(await coinReasons(db, ben, ['challenge']), []);
  });

  test("yesterday's completed challenges stay listed and claimable until today's reset", async () => {
    const yesterday = daysAgo(1);
    await assign(db, ann, ['play_2', 'variety_2', 'win_1'], yesterday);
    await db.exec(
      `update public.daily_challenges set progress = target, completed_at = now() where user_id = '${ann}' and slot <> 2`,
    );
    const rows = await myChallenges(db, ann);
    // Yesterday's two completed ones first, then today's three.
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.slice(0, 2).map((r) => r.title),
      ['Play 2 matches', 'Win a match'],
    );
    assert.equal(new Date(rows[0]!.expires_at).getTime(), Date.parse(`${today()}T00:00:00Z`) + 86_400_000);
    await claim(db, ann, rows[0]!.id);
    assert.equal((await myChallenges(db, ann)).length, 4, 'claimed: no longer listed');
  });

  test('claims are rate limited (20 per minute)', async () => {
    await assign(db, ann, ['play_2']);
    const [c] = await stateOf(db, ann);
    await db.query(`insert into public.rate_limits (user_id, action, tokens) values ($1, 'claim_daily_challenge', 0)`, [
      ann,
    ]);
    await assert.rejects(claim(db, ann, c!.id), rateLimited);
  });

  test('a claim that levels up pays the level coins too', async () => {
    await grantXp(db, ann, 80);
    await assign(db, ann, ['play_2']);
    await db.exec(
      `update public.daily_challenges set progress = target, completed_at = now() where user_id = '${ann}'`,
    );
    const [c] = await stateOf(db, ann);
    const r = await claim(db, ann, c!.id);
    assert.deepEqual([r.level, r.total_xp], [2, 110]);
    assert.deepEqual(await coinReasons(db, ann), ['challenge:20', 'level:50']);
    assert.equal(r.balance, 70, 'the balance after the claim and the level-up');
  });
});

// =====================================================================================================================

describe('Realtime: progress events on the private user channel', () => {
  test('xp, level and challenge events go to user:<uid>, event progress; a failing send never fails the award', async () => {
    const db = await createTestDb();
    await setupGames(db);
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    await assign(db, ann, ['play_2', 'variety_2', 'win_1']);
    await grantXp(db, ann, 80);
    await stubSend(db);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    const all = await takeSent(db);
    // The level-up coins are announced as coins too (and the coin toast leaves them to the level-up toast).
    assert.deepEqual(
      all
        .filter((s) => s.event === 'coins' && s.topic === `user:${ann}`)
        .map((s) => `${String(s.payload.reason)}:${String(s.payload.amount)}`),
      ['match:10', 'win:25', 'daily:50', 'level:50'],
    );
    const sent = all.filter((s) => s.event === 'progress');
    assert.ok(sent.every((s) => s.private && s.event === 'progress'));
    const mine = sent.filter((s) => s.topic === `user:${ann}`).map((s) => s.payload as unknown as ProgressEvent);
    assert.deepEqual(
      mine.map((e) =>
        e.type === 'xp'
          ? `xp:${e.reason}:${e.amount}:L${e.level}`
          : e.type === 'level'
            ? `level:${e.from}->${e.level}:+${e.coins}`
            : `challenge:${e.title}:${e.progress}/${e.target}`,
      ),
      [
        'xp:match:20:L2',
        'level:1->2:+50',
        'xp:win:10:L2',
        'challenge:Play 2 matches:1/2',
        'challenge:Play 2 different games:1/2',
        'challenge:Win a match:1/1',
      ],
    );
    const xp = mine[0] as Extract<ProgressEvent, { type: 'xp' }>;
    assert.deepEqual(Object.keys(xp).sort(), [
      'amount',
      'at',
      'game_id',
      'id',
      'level',
      'note',
      'reason',
      'total_xp',
      'type',
      'xp_for_next',
      'xp_into_level',
    ]);
    assert.deepEqual(
      [xp.total_xp, xp.xp_into_level, xp.xp_for_next, xp.game_id, xp.note],
      [100, 0, 125, 'sumo', 'Sumo'],
    );
    const won = mine[5] as Extract<ProgressEvent, { type: 'challenge' }>;
    assert.deepEqual([won.completed, won.claimed, won.coins, won.xp, won.kind], [true, false, 50, 70, 'win_matches']);
    assert.match(won.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // Ben got his own events only (his challenges were picked on the spot).
    assert.ok(sent.filter((s) => s.topic === `user:${ben}`).length >= 1);
    // A claim: the challenge event says claimed; the coins event carries reason challenge.
    const winId = (await stateOf(db, ann)).find((c) => c.template_key === 'win_1')!.id;
    await claim(db, ann, winId);
    const after = await takeSent(db);
    assert.deepEqual(
      after.map(
        (s) =>
          `${s.event}:${String(s.payload.type)}:${String(s.payload.reason ?? (s.payload as { claimed?: boolean }).claimed)}`,
      ),
      ['progress:challenge:true', 'coins:coins:challenge', 'progress:xp:challenge'],
    );
    // Realtime down: the award still lands.
    await stubSend(db, { fail: true });
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    assert.equal((await xpRows(db, ben)).filter((r) => r.reason === 'win').length, 1);
    await db.close();
  });
});

// =====================================================================================================================

describe('retention: purge_progress_rows', () => {
  test('XP rows older than 365 days and challenges older than 30 days go; progress stays', async () => {
    const db = await createTestDb();
    await setupGames(db);
    const ann = await user(db, 'ann');
    await grantXp(db, ann, 300, 'old');
    await grantXp(db, ann, 10, 'new');
    await assign(db, ann, ['play_2'], daysAgo(31));
    await assign(db, ann, ['play_2'], daysAgo(30));
    await db.exec(`
      alter table public.xp_ledger disable trigger xp_ledger_append_only;
      update public.xp_ledger set created_at = now() - interval '366 days' where ref = 'old';
      alter table public.xp_ledger enable trigger xp_ledger_append_only;
    `);
    await db.exec(`select private.purge_progress_rows()`);
    assert.deepEqual(
      (await xpRows(db, ann)).map((r) => r.ref),
      ['new'],
    );
    assert.deepEqual(await stored(db, ann), { xp: 310, level: 3 });
    const days = await db.query<{ d: string }>(
      `select day::text as d from public.daily_challenges where user_id = $1`,
      [ann],
    );
    assert.deepEqual(
      days.rows.map((r) => r.d),
      [daysAgo(30)],
    );
    await db.close();
  });

  test('the purge job is scheduled where pg_cron exists (a NOTICE elsewhere)', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../supabase/migrations/20261101000100_progress.sql', import.meta.url), 'utf8');
    assert.match(sql, /'purge-progress', '7 5 \* \* \*', 'select private\.purge_progress_rows\(\)'/);
  });
});
