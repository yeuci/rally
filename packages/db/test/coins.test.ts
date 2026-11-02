// 20261031000400_coins.sql: the coin economy (rules, wallets, the append-only ledger), every earn path (multiplayer
// matches, achievements, solo runs, the daily bonus), the shop (buy_item, equip_item, public_cosmetics), owns_game,
// the Realtime award broadcast and retention. PGlite has one connection, so concurrent purchases are reproduced the
// way hardening.test.ts reproduces races: a test-only trigger on rate_limits (buy_item takes its token before it locks
// the wallet) commits the competing purchase first, which is what a concurrent transaction committing in between
// looks like.
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

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const invalid = sqlstate('22023', /^INVALID/);
const notFound = sqlstate('P0002', /^NOT_FOUND/);
const insufficient = sqlstate('P0001', /^INSUFFICIENT_FUNDS/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const anonymousForbidden = sqlstate('42501', /^ANONYMOUS_FORBIDDEN/);
const permissionDenied = (e: unknown) => /permission denied/.test((e as Error).message);

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

/** Balance as stored (superuser read); 0 without a wallet row. */
const balance = async (db: PGlite, uid: string): Promise<number> =>
  Number(
    (await db.query<{ b: number }>(`select coalesce((select balance from public.wallets where user_id = $1), 0) as b`, [uid]))
      .rows[0]!.b,
  );

interface LedgerRow {
  amount: number;
  reason: string;
  ref: string;
  game_id: string | null;
  note: string | null;
  balance_after: number;
}
const ledger = async (db: PGlite, uid: string): Promise<LedgerRow[]> =>
  (
    await db.query<LedgerRow>(
      `select amount, reason, ref, game_id, note, balance_after from public.coin_ledger where user_id = $1 order by id`,
      [uid],
    )
  ).rows;
const reasons = async (db: PGlite, uid: string) => (await ledger(db, uid)).map((r) => `${r.reason}:${r.amount}`);

/** Every wallet equals the sum of its ledger, and no balance is negative. */
async function assertLedgerInvariant(db: PGlite) {
  const r = await db.query<{ user_id: string; balance: number; total: number }>(
    `select w.user_id, w.balance, coalesce((select sum(amount) from public.coin_ledger l where l.user_id = w.user_id), 0)::int as total
       from public.wallets w`,
  );
  for (const row of r.rows) {
    assert.equal(row.balance, row.total, `wallet of ${row.user_id} = sum of its ledger`);
    assert.ok(row.balance >= 0, 'never negative');
  }
}

/** Gives coins the way an earn path does (superuser; private.apply_coins is the only writer). */
const grant = (db: PGlite, uid: string, amount: number, ref = `grant-${Math.random()}`) =>
  db.query(`select private.apply_coins($1, $2, 'adjustment', $3)`, [uid, amount, ref]);

const setRule = (db: PGlite, key: string, value: number) =>
  db.query(`update public.coin_rules set value = $2 where key = $1`, [key, value]);

/** Moves a user's ledger rows (and so their daily caps / bonus) to yesterday. */
const ageLedger = (db: PGlite, uid: string, interval = '1 day') =>
  db.exec(`
    alter table public.coin_ledger disable trigger coin_ledger_append_only;
    update public.coin_ledger set created_at = created_at - interval '${interval}',
      ref = case when reason = 'daily' then to_char((created_at - interval '${interval}') at time zone 'utc', 'YYYY-MM-DD') else ref end
     where user_id = '${uid}';
    alter table public.coin_ledger enable trigger coin_ledger_append_only;
  `);

// --- multiplayer ---------------------------------------------------------------------------------------------------

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
  const ended = new Date();
  return {
    matchId: `coins${++seq}:1`,
    gameId: 'sumo',
    roomId: `coins${seq}`,
    private: false,
    winnerUserId: null,
    startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
    endedAt: ended.toISOString(),
    durationSec: duration,
    rounds: 3,
    leaderboardDeltas: {},
    players: players.map((p, i) => ({ username: `p${i}`, placement: i + 1, score: 0, achievements: [], ...p })),
    ...over,
  };
}
const p = (userId: string, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ userId, guest: false, ...extra });
const guest = (n: number, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ userId: `guest:${n}`, guest: true, ...extra });
const record = (db: PGlite, m: unknown) =>
  asService(db, async () => (await db.query<{ r: unknown }>(`select public.server_record_match($1::jsonb) as r`, [JSON.stringify(m)])).rows[0]!.r);

// --- solo ----------------------------------------------------------------------------------------------------------

/** A play session of `game` for `uid`, started `ageS` seconds ago. */
async function session(db: PGlite, uid: string, game = 'stack', ageS = 60): Promise<string> {
  const id = await asUser(db, uid, async () => (await db.query<{ id: string }>(`select public.start_play_session($1) as id`, [game])).rows[0]!.id);
  await db.query(`update public.play_sessions set started_at = now() - make_interval(secs => $2) where id = $1`, [id, ageS]);
  return id;
}
const submit = (db: PGlite, uid: string, score: number, sessionId: string, board = 'height') =>
  asUser(db, uid, async () =>
    (await db.query<{ r: { accepted: boolean; reason: string | null } }>(
      `select public.submit_solo_score('stack', $1, $2::float8, $3) as r`,
      [board, score, sessionId],
    )).rows[0]!.r,
  );
const unlock = (db: PGlite, uid: string, key: string, game = 'stack') =>
  asUser(db, uid, async () =>
    (await db.query<{ r: { unlocked: boolean; alreadyHad: boolean } }>(`select public.unlock_achievement($1, $2) as r`, [game, key]))
      .rows[0]!.r,
  );

// --- shop ----------------------------------------------------------------------------------------------------------

type BuyResult = { status: 'purchased' | 'owned'; item_id: string; balance: number };
const buy = (db: PGlite, uid: string, item: string) =>
  asUser(db, uid, async () => (await db.query<{ r: BuyResult }>(`select public.buy_item($1) as r`, [item])).rows[0]!.r);
const equip = (db: PGlite, uid: string, kind: string, item: string | null) =>
  asUser(db, uid, async () =>
    (await db.query<{ r: Record<string, string> }>(`select public.equip_item($1, $2) as r`, [kind, item])).rows[0]!.r,
  );
type CosmeticRow = { user_id: string; kind: string; item_id: string; name: string; data: Record<string, unknown> };
const cosmetics = (rows: CosmeticRow[]) => rows.map((r) => `${r.user_id === rows[0]?.user_id ? '' : '*'}${r.kind}=${r.item_id}`);
const publicCosmetics = async (db: PGlite, ids: string[]) =>
  (await db.query<CosmeticRow>(`select * from public.public_cosmetics($1::uuid[])`, [ids])).rows;

async function setupGames(db: PGlite) {
  await insertGame(db, 'sumo');
  await insertGame(db, 'stack');
  await db.exec(`
    update public.games set title = 'Sumo', modes = '{quick,browser,private}', max_players = 8 where id = 'sumo';
    update public.games set title = 'Stack' where id = 'stack';
    insert into public.leaderboards (game_id, key, sort, period, max_score_per_minute) values
      ('stack', 'height', 'desc', 'alltime', 100), ('stack', 'daily', 'desc', 'daily', null);
    insert into public.achievements (game_id, key, title, coins) values
      ('sumo', 'first_win', 'First win', null), ('sumo', 'yokozuna', 'Yokozuna', 100),
      ('stack', 'tower', 'Tower', null), ('stack', 'skyline', 'Skyline', 40);
    -- Level-up coins (20261101000100_progress.sql) are pinned by progress.test.ts; here they would add 'level' rows.
    update public.progress_rules set value = 0 where key = 'level_coins_max';
    -- The play streak (20261102000400_streaks.sql) is pinned by streaks.test.ts; here it would add 'streak' rows.
    update public.progress_rules set value = 0 where key ~ '^streak_';
  `);
}

/** Stub of Supabase's realtime.send that records its calls (as in social-realtime.test.ts). */
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
/** The `coins` events sent since the last call (the `progress` events of XP and challenges: progress.test.ts). */
async function takeSent(db: PGlite) {
  const r = await db.query<{ payload: Record<string, unknown>; event: string; topic: string; private: boolean }>(
    `select payload, event, topic, private from pg_temp.sent where event = 'coins' order by n`,
  );
  await db.exec(`truncate pg_temp.sent`);
  return r.rows;
}

// =====================================================================================================================

describe('coins: rules, tables and privileges', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    await grant(db, ann, 300, 'seed');
    await grant(db, ben, 300, 'seed');
    await buy(db, ann, 'name-mint');
    await equip(db, ann, 'name_color', 'name-mint');
  });
  after(() => db.close());

  test('coin_rules: the documented starting values, one place to tune them', async () => {
    const r = await db.query<{ key: string; value: number }>(`select key, value from public.coin_rules order by key`);
    assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.key, x.value])), {
      achievement: 25,
      daily: 50,
      match: 10,
      match_daily_cap: 500,
      match_min_duration_s: 20,
      podium: 10,
      podium_min_players: 4,
      solo: 5,
      solo_daily_cap: 50,
      win: 25,
    });
    // Readable by everyone (the shop explains how to earn), writable by nobody but the service role.
    for (const run of [(fn: () => Promise<void>) => asUser(db, ann, fn), (fn: () => Promise<void>) => asAnon(db, fn)]) {
      await run(async () => {
        assert.equal(await count(db, `select 1 from public.coin_rules`), 10);
        await assert.rejects(db.query(`update public.coin_rules set value = 1000 where key = 'win'`), permissionDenied);
        await assert.rejects(db.query(`insert into public.coin_rules (key, value) values ('free', 1)`), permissionDenied);
      });
    }
  });

  test('RLS: users read only their own wallet, ledger, items and equipped items', async () => {
    await asUser(db, ben, async () => {
      const w = await db.query<{ user_id: string }>(`select user_id from public.wallets`);
      assert.deepEqual(w.rows, [{ user_id: ben }]);
      const l = await db.query<{ user_id: string }>(`select distinct user_id from public.coin_ledger`);
      assert.deepEqual(l.rows, [{ user_id: ben }]);
      assert.equal(await count(db, `select 1 from public.user_items`), 0);
      assert.equal(await count(db, `select 1 from public.equipped_items`), 0);
      // Explicitly asking for someone else's rows returns nothing.
      assert.equal(await count(db, `select 1 from public.coin_ledger where user_id = $1`, [ann]), 0);
      assert.equal(await count(db, `select 1 from public.wallets where user_id = $1`, [ann]), 0);
      assert.equal(await count(db, `select 1 from public.user_items where user_id = $1`, [ann]), 0);
    });
    await asUser(db, ann, async () => {
      assert.equal(await count(db, `select 1 from public.user_items`), 1);
      assert.equal(await count(db, `select 1 from public.equipped_items`), 1);
    });
    await asAnon(db, async () => {
      for (const t of ['wallets', 'coin_ledger', 'user_items', 'equipped_items', 'shop_items']) {
        await assert.rejects(db.query(`select * from public.${t}`), permissionDenied, t);
      }
    });
  });

  test('clients cannot write wallets, the ledger, items or equipped items directly', async () => {
    await asUser(db, ben, async () => {
      const writes = [
        [`update public.wallets set balance = 99999`],
        [`insert into public.wallets (user_id, balance) values ($1, 5)`, [ben]],
        [`delete from public.wallets`],
        [`insert into public.coin_ledger (user_id, amount, reason, ref, balance_after) values ($1, 500, 'win', 'x', 500)`, [ben]],
        [`update public.coin_ledger set amount = 1000`],
        [`delete from public.coin_ledger`],
        [`insert into public.user_items (user_id, item_id) values ($1, 'frame-gilded')`, [ben]],
        [`insert into public.equipped_items (user_id, kind, item_id) values ($1, 'name_color', 'name-mint')`, [ben]],
        [`update public.shop_items set price = 0`],
        [`insert into public.shop_items (id, kind, name, price) values ('free', 'badge', 'Free', 0)`],
      ] as const;
      for (const [sql, params] of writes) await assert.rejects(db.query(sql, params ? [...params] : []), permissionDenied, sql);
      // The internal writers are unreachable.
      await assert.rejects(db.query(`select private.apply_coins($1, 1000, 'adjustment', 'x')`, [ben]), permissionDenied);
      await assert.rejects(db.query(`select private.award_coins($1, 1000, 'win', 'x')`, [ben]), permissionDenied);
      await assert.rejects(db.query(`select private.award_daily_bonus($1)`, [ben]), permissionDenied);
    });
    assert.equal(await balance(db, ben), 300);
  });

  test('the ledger is append-only and a wallet can never go negative, even for the service role', async () => {
    await asService(db, async () => {
      await assert.rejects(db.query(`update public.coin_ledger set amount = 1 where user_id = $1`, [ann]), /IMMUTABLE/);
    });
    await assert.rejects(db.query(`update public.wallets set balance = -1 where user_id = $1`, [ann]), /wallets_balance_nonnegative/);
    await assert.rejects(
      db.query(`insert into public.coin_ledger (user_id, amount, reason, ref, balance_after) values ($1, 10, 'purchase', 'x', 10)`, [ann]),
      /coin_ledger_sign/,
    );
    await assert.rejects(
      db.query(`insert into public.coin_ledger (user_id, amount, reason, ref, balance_after) values ($1, 10, 'gift', 'x', 10)`, [ann]),
      /coin_ledger_reason/,
    );
    await assert.rejects(db.query(`select private.apply_coins($1, -100000, 'adjustment', 'take')`, [ann]), insufficient);
    await assertLedgerInvariant(db);
  });

  test('who may call what', async () => {
    const expect: Record<string, [anon: boolean, auth: boolean]> = {
      'public.my_wallet()': [false, true],
      'public.buy_item(text)': [false, true],
      'public.equip_item(text, text)': [false, true],
      'public.public_cosmetics(uuid[])': [true, true],
      'public.owns_game(uuid, text)': [true, true],
    };
    for (const [fn, [anon, auth]] of Object.entries(expect)) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc, has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon, auth, svc: true, pub: false }, fn);
    }
    const acl = await db.query<{ proname: string; public_exec: boolean }>(
      `select proname, has_function_privilege('public', oid, 'execute') as public_exec from pg_proc
        where pronamespace = 'private'::regnamespace
          and proname in ('coin_rule', 'apply_coins', 'award_coins', 'award_daily_bonus', 'lock_wallet', 'lock_wallets',
                          'broadcast_coin_award', 'shop_items_validate', 'coin_ledger_append_only', 'purge_stale_rows')`,
    );
    assert.equal(acl.rows.length, 10);
    assert.ok(acl.rows.every((r) => !r.public_exec), JSON.stringify(acl.rows));
  });

  test('my_wallet: balance, lifetime, today toward the caps; zeros without a wallet; signed out refused', async () => {
    const cat = await user(db, 'wallet_cat');
    const mine = await asUser(db, cat, async () => (await db.query<{ r: unknown }>(`select public.my_wallet() as r`)).rows[0]!.r);
    assert.deepEqual(mine, {
      balance: 0,
      lifetime_earned: 0,
      daily_claimed: false,
      solo_today: 0,
      solo_cap: 50,
      match_today: 0,
      match_cap: 500,
    });
    const anns = await asUser(db, ann, async () => (await db.query<{ r: { balance: number; lifetime_earned: number } }>(`select public.my_wallet() as r`)).rows[0]!.r);
    assert.equal(anns.balance, 200);
    assert.equal(anns.lifetime_earned, 300); // purchases do not lower lifetime earnings
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.my_wallet()`), permissionDenied);
    });
  });
});

// =====================================================================================================================

describe('earning: multiplayer matches (server_record_match)', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let dan: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    dan = await user(db, 'dan');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() =>
    db.exec(`
      alter table public.coin_ledger disable trigger coin_ledger_append_only;
      delete from public.coin_ledger; delete from public.wallets; delete from public.match_results;
      delete from public.user_achievements; delete from public.user_sanctions; delete from public.game_stats;
      update public.coin_rules set value = 500 where key = 'match_daily_cap';
      alter table public.coin_ledger enable trigger coin_ledger_append_only;
    `),
  );
  after(() => db.close());

  test('a counted match pays participation to everyone, the win to the winner and the daily bonus once', async () => {
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual(await reasons(db, ann), ['match:10', 'win:25', 'daily:50']);
    assert.deepEqual(await reasons(db, ben), ['match:10', 'daily:50']);
    const first = (await ledger(db, ann))[0]!;
    assert.equal(first.game_id, 'sumo');
    assert.equal(first.note, 'Sumo');
    assert.match(first.ref, /^coins\d+:1$/);
    assert.deepEqual((await ledger(db, ann)).map((r) => r.balance_after), [10, 35, 85]);
    // The second match of the day: no second daily bonus.
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    assert.deepEqual(await reasons(db, ann), ['match:10', 'win:25', 'daily:50', 'match:10']);
    assert.deepEqual(await reasons(db, ben), ['match:10', 'daily:50', 'match:10', 'win:25']);
    assert.equal(await balance(db, ann), 95);
    assert.equal(await balance(db, ben), 95);
    const daily = (await ledger(db, ann)).find((r) => r.reason === 'daily')!;
    assert.equal(daily.ref, new Date().toISOString().slice(0, 10));
    await assertLedgerInvariant(db);
  });

  test('podium: 2nd and 3rd of a competitive match with 4+ players; never in co-op runs or small matches', async () => {
    // 4 players (one a guest), ann won: ben 2nd, cat 3rd, dan 4th.
    await record(db, match([p(ann, { placement: 1 }), p(ben, { placement: 2 }), p(cat, { placement: 3 }), guest(1, { placement: 4 })], { winnerUserId: ann }));
    assert.deepEqual(await reasons(db, ben), ['match:10', 'podium:10', 'daily:50']);
    assert.deepEqual(await reasons(db, cat), ['match:10', 'podium:10', 'daily:50']);
    await record(db, match([p(ann, { placement: 1 }), p(ben, { placement: 2 }), p(cat, { placement: 3 }), p(dan, { placement: 4 })], { winnerUserId: ann }));
    assert.deepEqual(await reasons(db, dan), ['match:10', 'daily:50']);
    // Ties share a placement: both 2nd places pay.
    await record(db, match([p(ann, { placement: 1 }), p(ben, { placement: 2 }), p(cat, { placement: 2 }), p(dan, { placement: 4 })], { winnerUserId: ann }));
    assert.deepEqual((await reasons(db, cat)).slice(-2), ['match:10', 'podium:10']);
    // A guest winner still makes it competitive.
    await record(db, match([guest(1, { placement: 1 }), p(ben, { placement: 2 }), p(cat, { placement: 3 }), p(dan, { placement: 4 })], { winnerUserId: 'guest:1' }));
    assert.deepEqual((await reasons(db, ben)).slice(-2), ['match:10', 'podium:10']);
    // Three players: no podium.
    const before3 = (await ledger(db, ben)).length;
    await record(db, match([p(ann, { placement: 1 }), p(ben, { placement: 2 }), p(cat, { placement: 3 })], { winnerUserId: ann }));
    assert.deepEqual((await reasons(db, ben)).slice(before3), ['match:10']);
    // Co-op (Overrun: no winner; placements rank scores inside the team): participation only.
    const beforeCoop = (await ledger(db, ben)).length;
    await record(db, match([p(ann, { placement: 1 }), p(ben, { placement: 2 }), p(cat, { placement: 3 }), p(dan, { placement: 4 })], { winnerUserId: null }));
    assert.deepEqual((await reasons(db, ben)).slice(beforeCoop), ['match:10']);
    assert.deepEqual((await reasons(db, ann)).slice(-1), ['match:10']);
    // A placement that is not a number pays no podium.
    const beforeBad = (await ledger(db, cat)).length;
    await record(db, match([p(ann), p(ben), { userId: cat, guest: false, placement: '2' as unknown as number }, p(dan)], { winnerUserId: ann }));
    assert.deepEqual((await reasons(db, cat)).slice(beforeBad), ['match:10']);
    await assertLedgerInvariant(db);
  });

  test('idempotent: a replayed match pays nothing, even after match_results was purged', async () => {
    const m = match([p(ann, { achievements: ['first_win'] }), p(ben)], { winnerUserId: ann });
    await record(db, m);
    const paid = await reasons(db, ann);
    assert.deepEqual(paid, ['match:10', 'win:25', 'daily:50', 'achievement:25']);
    assert.deepEqual(await record(db, m), { duplicate: true });
    assert.deepEqual(await reasons(db, ann), paid);
    // match_results is purged after 180 days; the ledger still refuses to pay the same matchId twice.
    await db.query(`delete from public.match_results where match_id = $1`, [m.matchId]);
    const again = (await record(db, m)) as { duplicate: boolean };
    assert.equal(again.duplicate, false);
    assert.deepEqual(await reasons(db, ann), paid);
    assert.equal(await balance(db, ann), 110);
  });

  test('anti-boost: short matches and private matches with fewer than 2 eligible players pay nothing', async () => {
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, durationSec: 19.9 }));
    await record(db, match([p(ann), guest(1)], { winnerUserId: ann, private: true }));
    await record(db, match([p(ann), p(ghost)], { winnerUserId: ann, private: true }));
    assert.deepEqual(await reasons(db, ann), []);
    assert.deepEqual(await reasons(db, ben), []);
    assert.equal(await count(db, `select 1 from public.wallets`), 0, 'nobody to pay: no wallet rows either');
    // The match still counted for stats.
    const s = await db.query<{ plays: number }>(`select plays from public.game_stats where user_id = $1`, [ann]);
    assert.equal(s.rows[0]!.plays, 3);
    // Private with 2 eligible players, and public with a guest, both pay.
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann, private: true }));
    assert.deepEqual(await reasons(db, ben), ['match:10', 'daily:50']);
    await record(db, match([p(cat), guest(2)], { winnerUserId: cat }));
    assert.deepEqual(await reasons(db, cat), ['match:10', 'win:25', 'daily:50']);
    // The threshold is a rule.
    await setRule(db, 'match_min_duration_s', 120);
    await record(db, match([p(dan), p(ben)], { winnerUserId: dan, durationSec: 95 }));
    assert.deepEqual(await reasons(db, dan), []);
    await setRule(db, 'match_min_duration_s', 20);
  });

  test('guests, anonymous, banned and unknown players never earn', async () => {
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'cheating')`, [cat]);
    await record(db, match([
      { userId: ben, guest: true },
      p(ghost, { achievements: ['first_win'] }),
      p(cat, { achievements: ['first_win'] }),
      p('session:abc'),
      guest(7),
      p(ann),
    ], { winnerUserId: ghost }));
    assert.deepEqual(await reasons(db, ann), ['match:10', 'daily:50']);
    for (const u of [ben, ghost, cat]) {
      assert.deepEqual(await ledger(db, u), [], u);
      assert.equal(await count(db, `select 1 from public.wallets where user_id = $1`, [u]), 0);
    }
  });

  test('match coins are capped per UTC day (match + win + podium); the cap resets the next day', async () => {
    await setRule(db, 'match_daily_cap', 50);
    for (let i = 0; i < 2; i++) await record(db, match([p(ann), p(ben)], { winnerUserId: ann })); // 35 + 35 = 70 > 50
    assert.deepEqual(await reasons(db, ann), ['match:10', 'win:25', 'daily:50', 'match:10', 'win:5']);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual((await reasons(db, ann)).length, 5, 'nothing once capped');
    // The daily bonus is not part of the cap.
    assert.equal(await balance(db, ann), 50 + 50);
    // Tomorrow (the rows of today become yesterday's): match coins and the daily bonus again.
    await ageLedger(db, ann);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    assert.deepEqual((await reasons(db, ann)).slice(5), ['match:10', 'win:25', 'daily:50']);
    await assertLedgerInvariant(db);
  });

  test('achievements unlocked in a match pay their one-time bonus (rule or per-achievement override), once', async () => {
    await record(db, match([p(ann, { achievements: ['first_win', 'yokozuna', 'nope'] }), p(ben)], { winnerUserId: ann, durationSec: 5 }));
    // A short match pays no match coins, but the unlocks still pay.
    const rows = await ledger(db, ann);
    assert.deepEqual(rows.map((r) => [r.reason, r.amount, r.ref, r.note]), [
      ['achievement', 25, 'sumo:first_win', 'First win'],
      ['achievement', 100, 'sumo:yokozuna', 'Yokozuna'],
    ]);
    await record(db, match([p(ann, { achievements: ['first_win', 'yokozuna'] }), p(ben)], { winnerUserId: ann, durationSec: 5 }));
    assert.equal((await ledger(db, ann)).length, 2);
    // The rule is the default for achievements without an override.
    await setRule(db, 'achievement', 30);
    await record(db, match([p(ben, { achievements: ['first_win'] }), p(ann)], { durationSec: 5 }));
    assert.deepEqual(await reasons(db, ben), ['achievement:30']);
    await setRule(db, 'achievement', 25);
  });

  test('wallets are locked in user id order and the match is all or nothing', async () => {
    // A failing award (here: the ledger refuses inserts) rolls the whole match back, so a retry pays exactly once.
    await db.exec(`
      create function public.test_fail_ledger() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger test_fail before insert on public.coin_ledger for each row execute function public.test_fail_ledger();
    `);
    const m = match([p(ann), p(ben)], { winnerUserId: ann });
    try {
      await assert.rejects(record(db, m), /boom/);
    } finally {
      await db.exec(`drop trigger test_fail on public.coin_ledger; drop function public.test_fail_ledger();`);
    }
    assert.equal(await count(db, `select 1 from public.match_results`), 0);
    assert.equal(await count(db, `select 1 from public.game_stats`), 0);
    await record(db, m);
    assert.deepEqual(await reasons(db, ann), ['match:10', 'win:25', 'daily:50']);
  });
});

// =====================================================================================================================

describe('earning: solo runs, achievements and the daily bonus', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() =>
    db.exec(`
      alter table public.coin_ledger disable trigger coin_ledger_append_only;
      delete from public.coin_ledger; delete from public.wallets; delete from public.match_results;
      delete from public.user_achievements; delete from public.play_sessions; delete from public.rate_limits;
      delete from public.leaderboard_entries; delete from public.game_stats;
      alter table public.coin_ledger enable trigger coin_ledger_append_only;
    `),
  );
  after(() => db.close());

  test('a valid solo run pays once per session; the first one of the day adds the daily bonus', async () => {
    const s1 = await session(db, ann);
    assert.equal((await submit(db, ann, 50, s1)).accepted, true);
    assert.deepEqual(await reasons(db, ann), ['solo:5', 'daily:50']);
    const row = (await ledger(db, ann))[0]!;
    assert.deepEqual([row.ref, row.game_id, row.note], [s1, 'stack', 'Stack']);
    // The same run on another board, or a worse score in the same session: nothing more.
    assert.equal((await submit(db, ann, 50, s1, 'daily')).accepted, true);
    assert.equal((await submit(db, ann, 10, s1)).reason, 'not_best');
    assert.deepEqual(await reasons(db, ann), ['solo:5', 'daily:50']);
    // A new run that does not beat the best is still a valid run: it pays (no second daily bonus).
    const s2 = await session(db, ann);
    assert.equal((await submit(db, ann, 20, s2)).reason, 'not_best');
    assert.deepEqual(await reasons(db, ann), ['solo:5', 'daily:50', 'solo:5']);
    assert.equal(await balance(db, ann), 60);
  });

  test('refused runs pay nothing: too new, beyond the bounds, expired, rate limited', async () => {
    const fresh = await session(db, ann, 'stack', 0);
    assert.equal((await submit(db, ann, 10, fresh)).reason, 'session_too_new');
    const s = await session(db, ann, 'stack', 30);
    assert.equal((await submit(db, ann, 101, s)).reason, 'bounds');
    const old = await session(db, ann, 'stack', 600);
    await db.query(`update public.play_sessions set ended_at = now() - interval '6 minutes' where id = $1`, [old]);
    assert.equal((await submit(db, ann, 10, old)).reason, 'session_expired');
    await db.query(
      `insert into public.rate_limits (user_id, action, tokens) values ($1, 'submit_solo_score', 0)
       on conflict (user_id, action) do update set tokens = 0, refilled_at = now()`,
      [ann],
    );
    const s2 = await session(db, ann);
    assert.equal((await submit(db, ann, 10, s2)).reason, 'rate_limited');
    assert.deepEqual(await ledger(db, ann), []);
    assert.equal(await count(db, `select 1 from public.wallets where user_id = $1`, [ann]), 0);
  });

  test('solo coins are capped per UTC day; the cap resets the next day', async () => {
    for (let i = 0; i < 12; i++) await submit(db, ann, 10 + i, await session(db, ann));
    const solo = (await ledger(db, ann)).filter((r) => r.reason === 'solo');
    assert.equal(solo.length, 10);
    assert.equal(solo.reduce((n, r) => n + r.amount, 0), 50);
    assert.equal(await balance(db, ann), 100);
    // A cap that is not a multiple of the award: the last award is cut.
    await setRule(db, 'solo_daily_cap', 52);
    await submit(db, ann, 99, await session(db, ann));
    assert.deepEqual((await reasons(db, ann)).at(-1), 'solo:2');
    await setRule(db, 'solo_daily_cap', 50);
    // Tomorrow: solo coins and the daily bonus again.
    await ageLedger(db, ann);
    await submit(db, ann, 5, await session(db, ann));
    assert.deepEqual((await reasons(db, ann)).slice(-2), ['solo:5', 'daily:50']);
    const w = await asUser(db, ann, async () => (await db.query<{ r: { solo_today: number; daily_claimed: boolean } }>(`select public.my_wallet() as r`)).rows[0]!.r);
    assert.equal(w.solo_today, 5);
    assert.equal(w.daily_claimed, true);
  });

  test('the daily bonus is paid once per UTC day across solo runs and matches', async () => {
    await submit(db, ann, 10, await session(db, ann));
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    assert.deepEqual(await reasons(db, ann), ['solo:5', 'daily:50', 'match:10']);
    assert.deepEqual(await reasons(db, ben), ['match:10', 'win:25', 'daily:50']);
    await submit(db, ben, 10, await session(db, ben));
    assert.deepEqual((await reasons(db, ben)).slice(-1), ['solo:5']);
    // A solo run that pays nothing (cap reached) does not claim the bonus either.
    await ageLedger(db, ann);
    await setRule(db, 'solo_daily_cap', 0);
    await submit(db, ann, 99, await session(db, ann));
    assert.equal((await ledger(db, ann)).filter((r) => r.reason === 'daily').length, 1);
    await setRule(db, 'solo_daily_cap', 50);
  });

  test('unlock_achievement pays the one-time bonus on the first unlock only (override or rule)', async () => {
    await session(db, ann);
    assert.deepEqual(await unlock(db, ann, 'tower'), { unlocked: true, alreadyHad: false });
    assert.deepEqual(await unlock(db, ann, 'tower'), { unlocked: true, alreadyHad: true });
    assert.deepEqual(await unlock(db, ann, 'skyline'), { unlocked: true, alreadyHad: false });
    assert.deepEqual((await ledger(db, ann)).map((r) => [r.reason, r.amount, r.ref, r.note]), [
      ['achievement', 25, 'stack:tower', 'Tower'],
      ['achievement', 40, 'stack:skyline', 'Skyline'],
    ]);
    // Without a play session the unlock (and so the bonus) is refused, as before.
    await assert.rejects(unlock(db, ben, 'tower'), notFound);
    assert.deepEqual(await ledger(db, ben), []);
  });

  test('anonymous sessions never earn: the solo RPCs refuse them', async () => {
    await asAnonymousUser(db, ghost, async () => {
      await assert.rejects(db.query(`select public.start_play_session('stack')`), anonymousForbidden);
      await assert.rejects(db.query(`select public.unlock_achievement('stack', 'tower')`), anonymousForbidden);
      await assert.rejects(db.query(`select public.buy_item('name-mint')`), anonymousForbidden);
      const w = await db.query<{ r: { balance: number } }>(`select public.my_wallet() as r`);
      assert.equal(w.rows[0]!.r.balance, 0);
    });
    assert.deepEqual(await ledger(db, ghost), []);
  });
});

// =====================================================================================================================

describe('shop: catalog, buy_item, equip_item', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
  });
  beforeEach(() =>
    db.exec(`
      alter table public.coin_ledger disable trigger coin_ledger_append_only;
      delete from public.equipped_items; delete from public.user_items; delete from public.coin_ledger;
      delete from public.wallets; delete from public.rate_limits;
      delete from public.shop_items where id like 'test-%';
      update public.shop_items set available = true;
      alter table public.coin_ledger enable trigger coin_ledger_append_only;
    `),
  );
  after(() => db.close());

  test('seeded catalog: 41 data-drawn cosmetics in four kinds on a price ladder, no game unlocks', async () => {
    const items = await asUser(db, ann, async () =>
      (await db.query<{ id: string; kind: string; price: number; data: Record<string, unknown> }>(
        `select id, kind, price, data from public.shop_items order by kind, sort`,
      )).rows,
    );
    // 15 from 20261031000400_coins.sql, 26 from 20261102000300_more_content.sql (pinned in more-content.test.ts).
    assert.equal(items.length, 41);
    const kinds = new Map<string, number>();
    for (const i of items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
    assert.deepEqual(Object.fromEntries(kinds), { avatar_frame: 11, badge: 9, name_color: 11, profile_banner: 10 });
    assert.ok(!items.some((i) => i.kind === 'game_unlock'));
    const prices = [...new Set(items.map((i) => i.price))].sort((a, b) => a - b);
    assert.deepEqual(prices, [100, 150, 250, 300, 400, 500, 600, 800, 900, 1000, 1200, 1500, 1800, 2000, 5000, 6000, 8000, 12000, 15000, 25000]);
    // Reachable after a day's bonus and a few matches.
    assert.equal(items.filter((i) => i.price <= 100).length, 3);
    // The v1 items are unchanged.
    const v1 = new Map(items.map((i) => [i.id, i.price]));
    for (const [id, price] of [['name-mint', 100], ['name-gold', 600], ['frame-gilded', 2000], ['banner-sunset', 1000], ['badge-crown', 2000]] as const) {
      assert.equal(v1.get(id), price, id);
    }
  });

  test('item data is checked per kind', async () => {
    const insert = (kind: string, data: unknown) =>
      db.query(`insert into public.shop_items (id, kind, name, price, data) values ('test-x', $1, 'X', 1, $2::jsonb)`, [kind, JSON.stringify(data)]);
    const bad: [string, unknown][] = [
      ['name_color', {}],
      ['name_color', { color: 'red' }],
      ['name_color', { color: '#12345' }],
      ['name_color', { color: '#123456', light: 'blue' }],
      ['badge', { color: '#123456' }],
      ['badge', { icon: 'Crown!', color: '#123456' }],
      ['avatar_frame', { colors: [] }],
      ['avatar_frame', { colors: ['#111111', '#222222', '#333333', '#444444', '#555555'] }],
      ['avatar_frame', { colors: ['#111111', 7] }],
      ['profile_banner', { colors: ['#111111'] }],
      ['game_unlock', { game_id: 'nope' }],
      ['game_unlock', {}],
    ];
    for (const [kind, data] of bad) await assert.rejects(insert(kind, data), invalid, `${kind} ${JSON.stringify(data)}`);
    await assert.rejects(insert('skin', {}), /shop_items_kind/);
    for (const [kind, data] of [
      ['name_color', { color: '#ABCDEF' }],
      ['badge', { icon: 'trophy', color: '#ABCDEF', light: '#123456' }],
      ['avatar_frame', { colors: ['#111111'] }],
      ['profile_banner', { colors: ['#111111', '#222222', '#333333'] }],
      ['game_unlock', { game_id: 'sumo' }],
    ] as const) {
      await insert(kind, data);
      await db.query(`delete from public.shop_items where id = 'test-x'`);
    }
  });

  test('not enough coins: INSUFFICIENT_FUNDS and nothing written', async () => {
    await grant(db, ann, 99);
    await assert.rejects(buy(db, ann, 'name-mint'), insufficient);
    assert.equal(await balance(db, ann), 99);
    assert.equal(await count(db, `select 1 from public.user_items`), 0);
    assert.deepEqual(await reasons(db, ann), ['adjustment:99']);
    // No wallet at all: same answer.
    await assert.rejects(buy(db, ben, 'name-mint'), insufficient);
  });

  test('buy: charges the price once, records the purchase, and buying again answers owned for free', async () => {
    await grant(db, ann, 400);
    assert.deepEqual(await buy(db, ann, 'frame-ember'), { status: 'purchased', item_id: 'frame-ember', balance: 150 });
    assert.deepEqual(await buy(db, ann, 'frame-ember'), { status: 'owned', item_id: 'frame-ember', balance: 150 });
    assert.deepEqual(await buy(db, ann, 'name-mint'), { status: 'purchased', item_id: 'name-mint', balance: 50 });
    const rows = await ledger(db, ann);
    assert.deepEqual(rows.slice(1).map((r) => [r.reason, r.amount, r.ref, r.note, r.balance_after]), [
      ['purchase', -250, 'frame-ember', 'Ember', 150],
      ['purchase', -100, 'name-mint', 'Mint', 50],
    ]);
    const owned = await asUser(db, ann, async () => (await db.query<{ item_id: string; price_paid: number }>(`select item_id, price_paid from public.user_items order by 1`)).rows);
    assert.deepEqual(owned, [{ item_id: 'frame-ember', price_paid: 250 }, { item_id: 'name-mint', price_paid: 100 }]);
    // lifetime earnings ignore purchases.
    assert.equal(Number((await db.query<{ l: number }>(`select lifetime_earned as l from public.wallets where user_id = $1`, [ann])).rows[0]!.l), 400);
    await assertLedgerInvariant(db);
  });

  test('unknown and retired items are NOT_FOUND; owners still see retired items, others do not', async () => {
    await grant(db, ann, 1000);
    await assert.rejects(buy(db, ann, 'nope'), notFound);
    await buy(db, ann, 'badge-star');
    await db.query(`update public.shop_items set available = false where id in ('badge-star', 'badge-flame')`);
    await assert.rejects(buy(db, ann, 'badge-flame'), notFound);
    assert.equal((await buy(db, ann, 'badge-star')).status, 'owned');
    // (The v1 badges: later batches add more.)
    const seen = (uid: string) =>
      asUser(db, uid, async () => (await db.query<{ id: string }>(
        `select id from public.shop_items where kind = 'badge' and id in ('badge-star', 'badge-flame', 'badge-crown') order by sort`,
      )).rows.map((r) => r.id));
    assert.deepEqual(await seen(ann), ['badge-star', 'badge-crown']);
    assert.deepEqual(await seen(ben), ['badge-crown']);
    // A retired item the caller owns can still be equipped.
    assert.deepEqual(await equip(db, ann, 'badge', 'badge-star'), { badge: 'badge-star' });
  });

  test('purchases are rate limited (20 per minute)', async () => {
    await grant(db, ann, 10);
    await db.query(`insert into public.rate_limits (user_id, action, tokens) values ($1, 'buy_item', 0)`, [ann]);
    await assert.rejects(buy(db, ann, 'name-mint'), rateLimited);
  });

  test('concurrent purchases: the balance is checked under the wallet lock and never goes negative', async () => {
    await grant(db, ann, 300);
    // Another purchase (frame-ocean, 250) commits between our call and our wallet lock.
    await db.exec(`
      create function public.test_race_buy() returns trigger language plpgsql as $$
      begin
        if current_setting('test.race', true) <> '' and new.action = 'buy_item' then
          perform private.apply_coins(new.user_id, -250, 'purchase', current_setting('test.race'));
          insert into public.user_items (user_id, item_id, price_paid) values (new.user_id, current_setting('test.race'), 250);
          perform set_config('test.race', '', false);
        end if;
        return new;
      end $$;
      create trigger test_race_buy after insert or update on public.rate_limits
        for each row execute function public.test_race_buy();
    `);
    try {
      // A different item: our purchase sees the balance after the other one (50) and is refused, not overdrawn
      // (a stale read would have failed on the wallets_balance_nonnegative check instead).
      await db.query(`select set_config('test.race', 'frame-ocean', false)`);
      await assert.rejects(buy(db, ann, 'frame-ember'), insufficient);
      // (The refusal rolled back our transaction, the simulated one included.)
      assert.equal(await balance(db, ann), 300);
      // The same item bought concurrently: we answer 'owned' and charge nothing more.
      await db.query(`select set_config('test.race', 'frame-ember', false)`);
      assert.deepEqual(await buy(db, ann, 'frame-ember'), { status: 'owned', item_id: 'frame-ember', balance: 50 });
      assert.deepEqual((await ledger(db, ann)).filter((r) => r.reason === 'purchase').map((r) => r.amount), [-250]);
    } finally {
      await db.exec(`drop trigger test_race_buy on public.rate_limits; drop function public.test_race_buy();`);
      await db.query(`select set_config('test.race', '', false)`);
    }
    // Draining the wallet item by item stops exactly at what it can afford.
    await grant(db, ann, 500);
    const results: string[] = [];
    for (const item of ['name-sky', 'name-rose', 'name-violet', 'badge-star']) {
      try {
        results.push(`${item}:${(await buy(db, ann, item)).balance}`);
      } catch (e) {
        assert.ok(insufficient(e));
        results.push(`${item}:refused`);
      }
    }
    assert.deepEqual(results, ['name-sky:450', 'name-rose:200', 'name-violet:refused', 'badge-star:50']);
    await assertLedgerInvariant(db);
  });

  test('equip: own items only, in their own slot; null empties the slot; the result is the equipped map', async () => {
    await grant(db, ann, 1000);
    await buy(db, ann, 'name-mint');
    await buy(db, ann, 'name-sky');
    await buy(db, ann, 'frame-ember');
    assert.deepEqual(await equip(db, ann, 'name_color', 'name-mint'), { name_color: 'name-mint' });
    assert.deepEqual(await equip(db, ann, 'avatar_frame', 'frame-ember'), { name_color: 'name-mint', avatar_frame: 'frame-ember' });
    // Another item of the kind replaces it.
    assert.deepEqual(await equip(db, ann, 'name_color', 'name-sky'), { name_color: 'name-sky', avatar_frame: 'frame-ember' });
    // Not owned.
    await assert.rejects(equip(db, ann, 'badge', 'badge-crown'), notFound);
    await assert.rejects(equip(db, ben, 'name_color', 'name-mint'), notFound);
    // Wrong slot, unknown slot, and game unlocks are never equippable.
    await assert.rejects(equip(db, ann, 'badge', 'name-mint'), invalid);
    await assert.rejects(equip(db, ann, 'hat', 'name-mint'), invalid);
    await assert.rejects(equip(db, ann, 'game_unlock', null), invalid);
    // Unequip.
    assert.deepEqual(await equip(db, ann, 'name_color', null), { avatar_frame: 'frame-ember' });
    assert.deepEqual(await equip(db, ann, 'name_color', null), { avatar_frame: 'frame-ember' });
    // The schema itself refuses an unowned item or a kind mismatch.
    await assert.rejects(
      db.query(`insert into public.equipped_items (user_id, kind, item_id) values ($1, 'badge', 'badge-crown')`, [ann]),
      /equipped_items_owned/,
    );
    await assert.rejects(
      db.query(`insert into public.equipped_items (user_id, kind, item_id) values ($1, 'badge', 'name-mint')`, [ann]),
      /equipped_items_kind_fkey/,
    );
    await db.query(`insert into public.rate_limits (user_id, action, tokens) values ($1, 'equip_item', 0)
                    on conflict (user_id, action) do update set tokens = 0, refilled_at = now()`, [ann]);
    await assert.rejects(equip(db, ann, 'name_color', 'name-mint'), rateLimited);
  });
});

// =====================================================================================================================

describe('public_cosmetics: equipped items are public, blocks hide them', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  before(async () => {
    db = await createTestDb();
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    await grant(db, ann, 5000);
    for (const item of ['name-gold', 'frame-aurora', 'banner-dusk', 'badge-crown', 'name-mint']) await buy(db, ann, item);
    await equip(db, ann, 'name_color', 'name-gold');
    await equip(db, ann, 'avatar_frame', 'frame-aurora');
    await equip(db, ann, 'profile_banner', 'banner-dusk');
    await equip(db, ann, 'badge', 'badge-crown');
  });
  after(() => db.close());

  test('other players, strangers and the owner see the equipped items with their data', async () => {
    const expected = ['avatar_frame=frame-aurora', 'badge=badge-crown', 'name_color=name-gold', 'profile_banner=banner-dusk'];
    for (const run of [
      (fn: () => Promise<CosmeticRow[]>) => asUser(db, ben, fn),
      (fn: () => Promise<CosmeticRow[]>) => asAnon(db, fn),
      (fn: () => Promise<CosmeticRow[]>) => asUser(db, ann, fn),
    ]) {
      const rows = await run(() => publicCosmetics(db, [ann, ben, cat]));
      assert.deepEqual(cosmetics(rows), expected);
      assert.ok(rows.every((r) => r.user_id === ann));
      const gold = rows.find((r) => r.kind === 'name_color')!;
      assert.deepEqual([gold.name, gold.data], ['Gold', { color: '#FACC15', light: '#A16207' }]);
    }
    // Owned but not equipped (name-mint) never shows; neither do balances or inventories.
    const rows = await asUser(db, ben, () => publicCosmetics(db, [ann]));
    assert.ok(!rows.some((r) => r.item_id === 'name-mint'));
    await asUser(db, ben, async () => {
      assert.equal(await count(db, `select 1 from public.user_items where user_id = $1`, [ann]), 0);
      assert.equal(await count(db, `select 1 from public.equipped_items where user_id = $1`, [ann]), 0);
    });
  });

  test('a block either way hides them (both directions), and lifting it shows them again', async () => {
    await asUser(db, ben, () => db.query(`select public.block_user($1)`, [ann]));
    assert.deepEqual(await asUser(db, ben, () => publicCosmetics(db, [ann])), []);
    assert.equal((await asUser(db, cat, () => publicCosmetics(db, [ann]))).length, 4);
    await asUser(db, ben, () => db.query(`select public.unblock_user($1)`, [ann]));
    assert.equal((await asUser(db, ben, () => publicCosmetics(db, [ann]))).length, 4);
    // The owner blocking the viewer hides them from that viewer too.
    await asUser(db, ann, () => db.query(`select public.block_user($1)`, [cat]));
    assert.deepEqual(await asUser(db, cat, () => publicCosmetics(db, [ann])), []);
    assert.equal((await asUser(db, ann, () => publicCosmetics(db, [ann]))).length, 4);
    await asUser(db, ann, () => db.query(`select public.unblock_user($1)`, [cat]));
  });

  test('batch limits: empty and unknown ids give no rows; more than 200 ids is INVALID', async () => {
    assert.deepEqual(await asUser(db, ben, () => publicCosmetics(db, [])), []);
    assert.deepEqual(await asUser(db, ben, () => publicCosmetics(db, ['00000000-0000-0000-0000-000000000000'])), []);
    const many = Array.from({ length: 201 }, () => crypto.randomUUID());
    await assert.rejects(asUser(db, ben, () => publicCosmetics(db, many)), invalid);
    assert.equal((await asUser(db, ben, () => publicCosmetics(db, [...many.slice(0, 199), ann]))).length, 4);
  });
});

// =====================================================================================================================

describe('owns_game: ready for coin-only games, nothing gated yet', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await setupGames(db);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
  });
  after(() => db.close());

  const owns = (uid: string | null, game: string) =>
    asService(db, async () => (await db.query<{ ok: boolean }>(`select public.owns_game($1, $2) as ok`, [uid, game])).rows[0]!.ok);

  test('a free game (no game_unlock item) is owned by everyone, signed out included', async () => {
    assert.equal(await owns(ann, 'stack'), true);
    assert.equal(await owns(null, 'stack'), true);
    assert.equal(await owns(ann, 'not-a-game'), true);
    assert.equal(await asAnon(db, async () => (await db.query<{ ok: boolean }>(`select public.owns_game(null, 'stack') as ok`)).rows[0]!.ok), true);
  });

  test('a locked game is not owned until the unlock is bought; buy_item works for it like any item', async () => {
    await db.query(
      `insert into public.shop_items (id, kind, name, price, data) values ('unlock-sumo', 'game_unlock', 'Sumo', 300, '{"game_id": "sumo"}')`,
    );
    assert.equal(await owns(ann, 'sumo'), false);
    assert.equal(await owns(null, 'sumo'), false);
    assert.equal(await owns(ann, 'stack'), true);
    await assert.rejects(buy(db, ann, 'unlock-sumo'), insufficient);
    await grant(db, ann, 300);
    assert.deepEqual(await buy(db, ann, 'unlock-sumo'), { status: 'purchased', item_id: 'unlock-sumo', balance: 0 });
    assert.equal(await owns(ann, 'sumo'), true);
    assert.equal(await owns(ben, 'sumo'), false);
    const row = (await ledger(db, ann)).at(-1)!;
    assert.deepEqual([row.reason, row.amount, row.game_id, row.note], ['purchase', -300, 'sumo', 'Sumo']);
    // Not equippable.
    await assert.rejects(equip(db, ann, 'game_unlock', 'unlock-sumo'), invalid);
    // Only one unlock item on sale per game.
    await assert.rejects(
      db.query(`insert into public.shop_items (id, kind, name, price, data) values ('unlock-sumo-2', 'game_unlock', 'Sumo', 100, '{"game_id": "sumo"}')`),
      /shop_items_game_unlock_idx/,
    );
    // Replacing the item (retire + new price) keeps buyers in; retiring it alone frees the game for everyone.
    await db.query(`update public.shop_items set available = false where id = 'unlock-sumo'`);
    assert.equal(await owns(ben, 'sumo'), true);
    await db.query(
      `insert into public.shop_items (id, kind, name, price, data) values ('unlock-sumo-2', 'game_unlock', 'Sumo', 500, '{"game_id": "sumo"}')`,
    );
    assert.equal(await owns(ann, 'sumo'), true);
    assert.equal(await owns(ben, 'sumo'), false);
  });

  test('clients may ask only about themselves', async () => {
    await asUser(db, ben, async () => {
      assert.equal((await db.query<{ ok: boolean }>(`select public.owns_game($1, 'stack') as ok`, [ben])).rows[0]!.ok, true);
      await assert.rejects(db.query(`select public.owns_game($1, 'sumo')`, [ann]), /FORBIDDEN/);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.owns_game($1, 'sumo')`, [ann]), /FORBIDDEN/);
    });
  });
});

// =====================================================================================================================

describe('Realtime: awards are broadcast to the earner\'s private user channel', () => {
  test('each award sends one coins event to user:<uid>; purchases send nothing; a failing send never fails the award', async () => {
    const db = await createTestDb();
    await setupGames(db);
    const ann = await user(db, 'ann');
    const ben = await user(db, 'ben');
    await stubSend(db);
    await record(db, match([p(ann), p(ben)], { winnerUserId: ann }));
    const sent = await takeSent(db);
    // Players are paid in user id order (the wallet lock order), each one's awards in the order they were made.
    const awards: Record<string, [string, number, number][]> = {
      [ann]: [['match', 10, 10], ['win', 25, 35], ['daily', 50, 85]],
      [ben]: [['match', 10, 10], ['daily', 50, 60]],
    };
    assert.deepEqual(
      sent.map((s) => [s.topic, s.event, s.private, s.payload.reason, s.payload.amount, s.payload.balance]),
      [ann, ben].sort().flatMap((u) => awards[u]!.map(([reason, amount, bal]) => [`user:${u}`, 'coins', true, reason, amount, bal])),
    );
    const one = sent[0]!.payload;
    assert.deepEqual(Object.keys(one).sort(), ['amount', 'at', 'balance', 'game_id', 'id', 'note', 'reason', 'type']);
    assert.equal(one.type, 'coins');
    assert.match(String(one.at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // A purchase is not announced.
    await buy(db, ann, 'name-mint').catch(() => undefined); // 85 < 100: refused, nothing sent
    await grant(db, ann, 100, 'top-up');
    await takeSent(db);
    await buy(db, ann, 'name-mint');
    assert.deepEqual(await takeSent(db), []);
    // Realtime down: the award still lands (a WARNING only).
    await stubSend(db, { fail: true });
    await record(db, match([p(ann), p(ben)], { winnerUserId: ben }));
    assert.equal((await ledger(db, ben)).filter((r) => r.reason === 'win').length, 1);
    await db.close();
  });
});

// =====================================================================================================================

describe('retention: purge_stale_rows and the ledger', () => {
  test('earn rows older than 365 days are purged; purchases, recent rows and wallets stay', async () => {
    const db = await createTestDb();
    const ann = await user(db, 'ann');
    await grant(db, ann, 500, 'old');
    await grant(db, ann, 10, 'new');
    await buy(db, ann, 'name-mint');
    await db.exec(`
      alter table public.coin_ledger disable trigger coin_ledger_append_only;
      update public.coin_ledger set created_at = now() - interval '366 days' where ref in ('old', 'name-mint');
      update public.coin_ledger set created_at = now() - interval '364 days' where ref = 'new';
      alter table public.coin_ledger enable trigger coin_ledger_append_only;
    `);
    await db.exec(`select private.purge_stale_rows()`);
    assert.deepEqual((await ledger(db, ann)).map((r) => r.ref), ['new', 'name-mint']);
    assert.equal(await balance(db, ann), 410);
    await db.close();
  });
});
