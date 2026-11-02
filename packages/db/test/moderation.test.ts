// 20261102000100_moderation.sql: reports (report_user: who may report, the reasons and limits, a repeat within a day
// updating the open row, nothing revealed about the target, the rate limit, no client access, the moderator's status
// stamp) and account deletion (delete_my_account: every foreign key to profiles / auth.users classified, the cascade,
// what other players keep, the scrubbed match history, the bug-report screenshot that used to block the delete, a
// second call and the callers who may not).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyMigrations,
  asAnon,
  asAnonymousUser,
  asService,
  asUser,
  createTestDb,
  insertGame,
  signUp,
  signUpAnonymously,
} from './harness.ts';
import { REPORT_LIMITS, REPORT_REASONS } from '../src/index.ts';

const MIGRATION = '20261102000100';
const NOBODY = '00000000-0000-0000-0000-000000000000';

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const anonymousForbidden = sqlstate('42501', /^ANONYMOUS_FORBIDDEN/);
const unauthenticated = sqlstate('42501', /^UNAUTHENTICATED/);
const invalid = sqlstate('22023', /^INVALID/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const permissionDenied = (e: unknown) => /permission denied/.test((e as Error).message);

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

interface ReportArgs {
  reason?: string | null;
  note?: string | null;
  gameId?: string | null;
  roomId?: string | null;
}
/** report_user as `uid` (a linked account); resolves with what the RPC returned. */
const report = (db: PGlite, uid: string, target: string | null, args: ReportArgs = {}) =>
  asUser(db, uid, async () => {
    const res = await db.query<{ v: unknown }>(`select public.report_user($1, $2, $3, $4, $5) as v`, [
      target,
      args.reason === undefined ? 'harassment' : args.reason,
      args.note ?? null,
      args.gameId ?? null,
      args.roomId ?? null,
    ]);
    return res.rows[0]!.v;
  });

interface ReportRow {
  id: string;
  reporter_id: string | null;
  target_id: string;
  reason: string;
  note: string | null;
  game_id: string | null;
  room_id: string | null;
  target_snapshot: Record<string, unknown>;
  status: string;
  reviewed_at: string | null;
  created_at: string;
  last_reported_at: string;
}
/** Every report (superuser view, as a moderator in Studio sees them), oldest first. */
const reports = async (db: PGlite): Promise<ReportRow[]> =>
  (await db.query<ReportRow>(`select * from public.reports order by created_at, id`)).rows;

// ---------------------------------------------------------------------------------------------------------------
// report_user
// ---------------------------------------------------------------------------------------------------------------

describe('report_user', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let ghost: string;

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'sumo');
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
    await db.query(`update public.profiles set display_name = 'Ben B', bio = 'hello' where id = $1`, [ben]);
  });
  beforeEach(() => db.exec(`delete from public.reports; delete from public.blocks; delete from public.rate_limits;`));
  after(() => db.close());

  test('files a report with the reason, the trimmed note, the context and a snapshot of the target', async () => {
    // void (PGlite renders it as ''; PostgREST answers with no body): nothing to tell apart.
    assert.equal(
      await report(db, ann, ben, { reason: 'cheating', note: '  speed hacks  ', gameId: 'sumo', roomId: 'r1' }),
      '',
    );
    const [r, ...rest] = await reports(db);
    assert.equal(rest.length, 0);
    assert.equal(r!.reporter_id, ann);
    assert.equal(r!.target_id, ben);
    assert.equal(r!.reason, 'cheating');
    assert.equal(r!.note, 'speed hacks');
    assert.equal(r!.game_id, 'sumo');
    assert.equal(r!.room_id, 'r1');
    assert.equal(r!.status, 'open');
    assert.equal(r!.reviewed_at, null);
    assert.deepEqual(r!.target_snapshot, {
      username: 'ben',
      display_name: 'Ben B',
      avatar_url: r!.target_snapshot.avatar_url,
      bio: 'hello',
    });
    assert.match(String(r!.target_snapshot.avatar_url), /^defaults\//);
  });

  test('every reason in the fixed set (REPORT_REASONS in @rally/db) is accepted; anything else is INVALID', async () => {
    assert.deepEqual([...REPORT_REASONS], ['harassment', 'hate', 'cheating', 'inappropriate_profile', 'spam', 'other']);
    for (const reason of REPORT_REASONS) {
      await report(db, ann, ben, { reason });
    }
    // Each repeat within the day updated the one open row.
    const rows = await reports(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reason, 'other');
    for (const reason of ['abuse', '', null, 'HARASSMENT']) {
      await assert.rejects(report(db, ann, cat, { reason }), invalid, String(reason));
    }
    assert.equal(await count(db, `select 1 from public.reports where target_id = $1`, [cat]), 0);
  });

  test('note: blank is stored as null, 500 characters fit, 501 are INVALID; long room ids are INVALID', async () => {
    await report(db, ann, ben, { note: ' \n\t \r\n', roomId: ' \n' });
    assert.equal((await reports(db))[0]!.note, null);
    assert.equal((await reports(db))[0]!.room_id, null);
    await report(db, ann, cat, { note: 'x'.repeat(REPORT_LIMITS.note), roomId: 'r'.repeat(REPORT_LIMITS.roomId) });
    assert.equal((await reports(db)).find((r) => r.target_id === cat)!.note!.length, 500);
    await assert.rejects(report(db, cat, ben, { note: 'x'.repeat(REPORT_LIMITS.note + 1) }), invalid);
    await assert.rejects(report(db, cat, ben, { roomId: 'r'.repeat(REPORT_LIMITS.roomId + 1) }), invalid);
    assert.equal(await count(db, `select 1 from public.reports where reporter_id = $1`, [cat]), 0);
  });

  test('yourself (or no one) is INVALID; anonymous sessions and signed-out clients cannot report', async () => {
    await assert.rejects(report(db, ann, ann), invalid);
    await assert.rejects(report(db, ann, null), invalid);
    await assert.rejects(
      asAnonymousUser(db, ghost, () => db.query(`select public.report_user($1, 'spam')`, [ben])),
      anonymousForbidden,
    );
    await assert.rejects(
      asAnon(db, () => db.query(`select public.report_user($1, 'spam')`, [ben])),
      permissionDenied,
    );
    assert.equal(await count(db, `select 1 from public.reports`), 0);
  });

  test('reveals nothing about the target: unknown, blocked and blocking targets answer like any report', async () => {
    const normal = await report(db, ann, ben);
    // Unknown id: same answer, nothing written.
    assert.deepEqual(await report(db, ann, NOBODY), normal);
    assert.equal(await count(db, `select 1 from public.reports where target_id = $1`, [NOBODY]), 0);
    // cat blocked ann, and ann blocked ben: both reports go through (a block never stops a report).
    await db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($2, $3)`, [cat, ann, ben]);
    assert.deepEqual(await report(db, ann, cat), normal);
    assert.deepEqual(await report(db, ann, ben, { reason: 'spam' }), normal);
    assert.deepEqual(
      (await reports(db)).map((r) => [r.target_id, r.reason]),
      [
        [ben, 'spam'],
        [cat, 'harassment'],
      ],
    );
    // An anonymous (unlinked) account is a real profile: recorded like anyone else, same answer.
    assert.deepEqual(await report(db, ann, ghost), normal);
    assert.equal(await count(db, `select 1 from public.reports where target_id = $1`, [ghost]), 1);
  });

  test('an unknown game id is dropped from the context, not refused', async () => {
    await report(db, ann, ben, { gameId: 'no-such-game', roomId: 'r9' });
    const [r] = await reports(db);
    assert.equal(r!.game_id, null);
    assert.equal(r!.room_id, 'r9');
  });

  test('a repeat within a day updates the open row; a later one, or one after review, adds a row', async () => {
    await report(db, ann, ben, { reason: 'harassment', note: 'first', gameId: 'sumo', roomId: 'r1' });
    const [first] = await reports(db);
    // The target renames: the snapshot from the first report is the evidence and stays.
    await db.query(`update public.profiles set display_name = 'Nice Ben' where id = $1`, [ben]);
    await report(db, ann, ben, { reason: 'hate' });
    let rows = await reports(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, first!.id);
    assert.equal(rows[0]!.reason, 'hate');
    assert.equal(rows[0]!.note, 'first', 'no new note keeps the earlier one');
    assert.equal(rows[0]!.game_id, 'sumo');
    assert.equal(rows[0]!.room_id, 'r1');
    assert.equal(rows[0]!.target_snapshot.display_name, 'Ben B');
    assert.deepEqual(rows[0]!.created_at, first!.created_at);
    assert.ok(+new Date(rows[0]!.last_reported_at) > +new Date(first!.last_reported_at));
    await report(db, ann, ben, { note: 'second' });
    assert.equal((await reports(db))[0]!.note, 'second');

    // Another reporter is a separate report.
    await report(db, cat, ben);
    assert.equal(await count(db, `select 1 from public.reports where target_id = $1`, [ben]), 2);

    // More than a day after the first report: a new row.
    await db.query(`update public.reports set created_at = now() - interval '25 hours' where reporter_id = $1`, [ann]);
    await report(db, ann, ben);
    assert.equal(await count(db, `select 1 from public.reports where reporter_id = $1`, [ann]), 2);

    // A report a moderator already reviewed is left as it is: a repeat adds a row.
    await db.query(`update public.reports set status = 'dismissed' where reporter_id = $1`, [cat]);
    await report(db, cat, ben, { reason: 'spam' });
    rows = (await reports(db)).filter((r) => r.reporter_id === cat);
    assert.deepEqual(
      rows.map((r) => [r.status, r.reason]),
      [
        ['dismissed', 'harassment'],
        ['open', 'spam'],
      ],
    );
  });

  test('rate limit: 10 in a burst, unknown targets included, then RATE_LIMITED', async () => {
    const targets = [ben, cat, NOBODY, ghost];
    for (let i = 0; i < 10; i++) await report(db, ann, targets[i % targets.length]!);
    await assert.rejects(report(db, ann, ben), rateLimited);
    await assert.rejects(report(db, ann, NOBODY), rateLimited);
    // Other reporters have their own bucket.
    await report(db, cat, ben);
  });

  test('clients can neither read nor write reports', async () => {
    await report(db, ann, ben);
    for (const [run, label] of [
      [(fn: () => Promise<unknown>) => asUser(db, ann, fn), 'reporter'],
      [(fn: () => Promise<unknown>) => asUser(db, ben, fn), 'target'],
      [(fn: () => Promise<unknown>) => asAnon(db, fn), 'anon'],
    ] as const) {
      await run(async () => {
        await assert.rejects(db.query(`select * from public.reports`), permissionDenied, label);
        await assert.rejects(
          db.query(`insert into public.reports (target_id, reason) values ($1, 'spam')`, [cat]),
          permissionDenied,
          label,
        );
        await assert.rejects(db.query(`update public.reports set status = 'dismissed'`), permissionDenied, label);
        await assert.rejects(db.query(`delete from public.reports`), permissionDenied, label);
      });
    }
    await asService(db, async () => assert.equal(await count(db, `select 1 from public.reports`), 1));
  });

  test('a moderator changing the status stamps reviewed_at (and clears it when reopened)', async () => {
    await report(db, ann, ben);
    await db.query(`update public.reports set moderator_note = 'looking'`);
    assert.equal((await reports(db))[0]!.reviewed_at, null);
    await db.query(`update public.reports set status = 'actioned'`);
    assert.notEqual((await reports(db))[0]!.reviewed_at, null);
    await db.query(`update public.reports set status = 'open'`);
    assert.equal((await reports(db))[0]!.reviewed_at, null);
    await assert.rejects(db.query(`update public.reports set status = 'closed'`), /reports_status/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// delete_my_account
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every foreign key from a public table to profiles or auth.users, and what deleting the user does to it
 * (pg_constraint.confdeltype: c = cascade, n = set null). A new table with such a key fails here until it is classified
 * (and the migration header and docs/moderation.md say why).
 */
const USER_FOREIGN_KEYS: Record<string, 'c' | 'n'> = {
  'blocks.blocked_id': 'c',
  'blocks.blocker_id': 'c',
  'bug_reports.user_id': 'n',
  'coin_ledger.user_id': 'c',
  'daily_challenges.user_id': 'c',
  'equipped_items.user_id': 'c',
  'equipped_items.user_id,item_id': 'c',
  'favorites.user_id': 'c',
  'friendships.friend_id': 'c',
  'friendships.user_id': 'c',
  'game_consents.user_id': 'c',
  'game_saves.user_id': 'c',
  'game_stats.user_id': 'c',
  'game_votes.user_id': 'c',
  'leaderboard_entries.user_id': 'c',
  'play_sessions.user_id': 'c',
  'player_progress.user_id': 'c',
  'player_streaks.user_id': 'c',
  'presence.user_id': 'c',
  'profiles.id': 'c',
  'rate_limits.user_id': 'c',
  'reports.reporter_id': 'n',
  'reports.target_id': 'c',
  'user_achievements.user_id': 'c',
  'user_items.user_id': 'c',
  'user_sanctions.user_id': 'c',
  'wallets.user_id': 'c',
  'xp_ledger.user_id': 'c',
};

/** Rows that name `uid`, per table (superuser view); the user id columns without a foreign key are included. */
async function rowsNaming(db: PGlite, uid: string): Promise<Record<string, number>> {
  const checks: Record<string, string> = {
    profiles: `select 1 from public.profiles where id = $1`,
    auth_users: `select 1 from auth.users where id = $1`,
    auth_identities: `select 1 from auth.identities where user_id = $1`,
    blocks: `select 1 from public.blocks where $1 in (blocker_id, blocked_id)`,
    friendships: `select 1 from public.friendships where $1 in (user_id, friend_id)`,
    coin_ledger: `select 1 from public.coin_ledger where user_id = $1`,
    daily_challenges: `select 1 from public.daily_challenges where user_id = $1`,
    equipped_items: `select 1 from public.equipped_items where user_id = $1`,
    favorites: `select 1 from public.favorites where user_id = $1`,
    game_consents: `select 1 from public.game_consents where user_id = $1`,
    game_saves: `select 1 from public.game_saves where user_id = $1`,
    game_stats: `select 1 from public.game_stats where user_id = $1`,
    game_votes: `select 1 from public.game_votes where user_id = $1`,
    leaderboard_entries: `select 1 from public.leaderboard_entries where user_id = $1`,
    play_sessions: `select 1 from public.play_sessions where user_id = $1`,
    player_progress: `select 1 from public.player_progress where user_id = $1`,
    player_streaks: `select 1 from public.player_streaks where user_id = $1`,
    presence: `select 1 from public.presence where user_id = $1`,
    rate_limits: `select 1 from public.rate_limits where user_id = $1`,
    reports: `select 1 from public.reports where $1 in (reporter_id, target_id)`,
    user_achievements: `select 1 from public.user_achievements where user_id = $1`,
    user_items: `select 1 from public.user_items where user_id = $1`,
    user_sanctions: `select 1 from public.user_sanctions where $1 in (user_id, created_by)`,
    wallets: `select 1 from public.wallets where user_id = $1`,
    xp_ledger: `select 1 from public.xp_ledger where user_id = $1`,
    bug_reports: `select 1 from public.bug_reports where user_id = $1`,
    game_rooms: `select 1 from public.game_rooms where $1 = any (player_ids)`,
    match_results: `select 1 from public.match_results where winner_id = $1 or payload::text like '%' || $1::text || '%'`,
  };
  const out: Record<string, number> = {};
  for (const [name, sql] of Object.entries(checks)) out[name] = await count(db, sql, [uid]);
  return out;
}

let matchSeq = 0;
/** A match recorded the way the game server does (server_record_match, service role); returns its id. */
async function playMatch(db: PGlite, players: string[], winner: string | null): Promise<string> {
  const matchId = `room${++matchSeq}:1`;
  const ended = new Date();
  await asService(db, () =>
    db.query(`select public.server_record_match($1::jsonb)`, [
      JSON.stringify({
        matchId,
        gameId: 'sumo',
        roomId: `room${matchSeq}`,
        private: false,
        winnerUserId: winner,
        startedAt: new Date(ended.getTime() - 95_000).toISOString(),
        endedAt: ended.toISOString(),
        durationSec: 95,
        rounds: 3,
        leaderboardDeltas: winner ? { wins: { [winner]: 1 } } : {},
        players: players.map((u, i) => ({
          userId: u,
          username: `name-of-${u.slice(0, 8)}`,
          guest: false,
          placement: i + 1,
          score: 3 - i,
          achievements: [],
        })),
        details: { kos: Object.fromEntries(players.map((u) => [`name-of-${u.slice(0, 8)}`, 1])) },
      }),
    ]),
  );
  return matchId;
}

describe('delete_my_account', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let dee: string;
  let matchId: string;
  let otherMatch: string;

  /** dee: a long-time player with a row in every per-user table, and rows that name them in other players' data. */
  async function seedDee(): Promise<void> {
    await asUser(db, dee, async () => {
      await db.query(`select public.save_put('stack', 'main', '{"hp": 3}'::jsonb)`);
      await db.query(`insert into public.game_consents (user_id, game_id) values ($1, 'stack')`, [dee]);
      await db.query(`insert into public.favorites (user_id, game_id) values ($1, 'stack')`, [dee]);
      await db.query(`select public.start_play_session('stack')`);
      await db.query(`select public.heartbeat('online')`);
      await db.query(`select public.send_friend_request($1)`, [ben]);
      await db.query(`select public.report_user($1, 'spam', 'ben spams the lobby')`, [ben]);
    });
    await asUser(db, ann, async () => {
      await db.query(`select public.send_friend_request($1)`, [dee]);
      await db.query(`select public.report_user($1, 'harassment')`, [dee]);
    });
    await asUser(db, dee, () => db.query(`select public.respond_friend_request($1, true)`, [ann]));
    // Blocks both ways with cat; a bug report with a screenshot in dee's own folder.
    const cat = await user(db, `cat${++matchSeq}`);
    await db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($2, $1)`, [dee, cat]);
    await asUser(db, dee, () =>
      db.query(`insert into public.bug_reports (note, screenshot_path) values ('it broke', $1)`, [`${dee}/shot.jpg`]),
    );
    // Coins, an owned and equipped item, XP, today's challenges, a vote, achievements, stats, a board entry.
    await db.query(`select private.apply_coins($1, 500, 'adjustment', 'seed')`, [dee]);
    await asUser(db, dee, async () => {
      await db.query(`select public.buy_item('name-mint')`);
      await db.query(`select public.equip_item('name_color', 'name-mint')`);
    });
    await db.query(`select private.apply_xp($1, 300, 'adjustment', 'seed')`, [dee]);
    await db.query(`select private.ensure_daily_challenges($1, (now() at time zone 'utc')::date)`, [dee]);
    matchId = await playMatch(db, [dee, ann, ben], dee);
    otherMatch = await playMatch(db, [ann, ben], ann);
    await asUser(db, dee, () => db.query(`select public.vote_game('sumo', true)`));
    // A live room seating dee, ann and ben; a sanction dee issued as a moderator, and one against dee.
    await asService(db, () =>
      db.query(`select public.server_upsert_game_room($1::jsonb)`, [
        JSON.stringify({ roomId: 'live1', gameId: 'sumo', clients: 3, maxClients: 8, playerIds: [dee, ann, ben] }),
      ]),
    );
    await db.query(
      `insert into public.user_sanctions (user_id, kind, reason, created_by) values ($1, 'mute', 'spam', $2), ($2, 'mute', 'test', null)`,
      [ben, dee],
    );
  }

  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'sumo');
    await db.query(`update public.games set modes = '{quick,browser,private}', max_players = 8 where id = 'sumo'`);
    await db.query(
      `insert into public.leaderboards (game_id, key, sort, mode) values ('sumo', 'wins', 'desc', 'total')`,
    );
    await db.query(`insert into public.achievements (game_id, key, title) values ('stack', 'first', 'First')`);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    dee = await user(db, 'dee');
    await db.query(`insert into auth.identities (user_id, provider) values ($1, 'email')`, [dee]);
    await seedDee();
    await asUser(db, dee, () => db.query(`select public.unlock_achievement('stack', 'first')`));
  });
  after(() => db.close());

  test('every foreign key to profiles / auth.users is classified (cascade or set null)', async () => {
    const fks = await db.query<{ key: string; rule: string }>(
      `select c.conrelid::regclass::text as tbl,
              replace(c.conrelid::regclass::text, 'public.', '') || '.' ||
                (select string_agg(a.attname, ',' order by k.ord)
                   from unnest(c.conkey) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as key,
              c.confdeltype as rule
         from pg_constraint c
        where c.contype = 'f' and c.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)
          and c.connamespace = 'public'::regnamespace
          -- equipped_items' (user_id, item_id) key points at user_items, which is keyed on the user.
          or (c.contype = 'f' and c.confrelid = 'public.user_items'::regclass)
        order by 2`,
    );
    assert.deepEqual(Object.fromEntries(fks.rows.map((r) => [r.key, r.rule])), USER_FOREIGN_KEYS);
  });

  test('deletes the account and everything personal; what other players need survives without them', async () => {
    const before = await rowsNaming(db, dee);
    // The seed reached every table the delete must empty.
    for (const [name, n] of Object.entries(before)) assert.ok(n > 0, `seed has no ${name} row for dee`);
    const annBefore = await rowsNaming(db, ann);

    await asUser(db, dee, () => db.query(`select public.delete_my_account()`));

    const after = await rowsNaming(db, dee);
    assert.deepEqual(after, Object.fromEntries(Object.keys(before).map((k) => [k, 0])));

    // The username is free again, for anyone.
    assert.equal(
      await asUser(
        db,
        ann,
        async () => (await db.query<{ v: boolean }>(`select public.username_available('dee') as v`)).rows[0]!.v,
      ),
      true,
    );
    const newDee = await user(db, 'dee');
    assert.notEqual(newDee, dee);

    // ann lost only what involved dee: the friendship and the report about dee (one each), and the old room seat
    // listing is untouched for her.
    const annAfter = await rowsNaming(db, ann);
    assert.equal(annAfter.friendships, annBefore.friendships! - 1);
    assert.equal(annAfter.reports, annBefore.reports! - 1);
    for (const k of ['profiles', 'coin_ledger', 'game_stats', 'leaderboard_entries', 'match_results', 'game_rooms']) {
      assert.equal(annAfter[k], annBefore[k], k);
    }

    // dee's report about ben stays for moderators, without the reporter.
    const kept = await db.query<{ reporter_id: string | null; note: string }>(
      `select reporter_id, note from public.reports where target_id = $1`,
      [ben],
    );
    assert.deepEqual(kept.rows, [{ reporter_id: null, note: 'ben spams the lobby' }]);
    // The bug report stays for the developer, screenshot path included.
    const bug = await db.query<{ user_id: string | null; screenshot_path: string }>(
      `select user_id, screenshot_path from public.bug_reports where note = 'it broke'`,
    );
    assert.deepEqual(bug.rows, [{ user_id: null, screenshot_path: `${dee}/shot.jpg` }]);
    // The sanction dee issued stays, without the moderator.
    assert.equal(
      await count(db, `select 1 from public.user_sanctions where user_id = $1 and created_by is null`, [ben]),
      1,
    );
    // The live room keeps its other players.
    const room = await db.query<{ player_ids: string[] }>(
      `select player_ids from public.game_rooms where room_id = 'live1'`,
    );
    assert.deepEqual(room.rows[0]!.player_ids, [ann, ben]);
  });

  test('match history: the match stays for the others, scrubbed of the deleted player', async () => {
    const m = await db.query<{ winner_id: string | null; payload: Record<string, unknown> }>(
      `select winner_id, payload from public.match_results where match_id = $1`,
      [matchId],
    );
    const { winner_id, payload } = m.rows[0]!;
    assert.equal(winner_id, null);
    assert.equal(payload.winnerUserId, null);
    assert.equal(payload.details, undefined);
    assert.deepEqual(payload.leaderboardDeltas, { wins: {} });
    const players = payload.players as Record<string, unknown>[];
    assert.deepEqual(players[0], { deleted: true, guest: false, placement: 1, score: 3, achievements: [] });
    assert.equal(players[1]!.userId, ann);
    assert.equal(players[2]!.userId, ben);
    assert.ok(!JSON.stringify(payload).includes(dee.slice(0, 8)), 'no trace of the id or the name');
    // A match dee was not in is untouched.
    const other = await db.query<{ winner_id: string; payload: Record<string, unknown> }>(
      `select winner_id, payload from public.match_results where match_id = $1`,
      [otherMatch],
    );
    assert.equal(other.rows[0]!.winner_id, ann);
    assert.ok(other.rows[0]!.payload.details);
    // "Recently played with" still shows ben to ann, and nobody else from that match.
    const recent = await asUser(
      db,
      ann,
      async () =>
        (
          await db.query<{ user_id: string; matches: number }>(
            `select user_id, matches from public.recently_played_with()`,
          )
        ).rows,
    );
    assert.deepEqual(recent, [{ user_id: ben, matches: 2 }]);
    // The leaderboard re-ranked without dee.
    assert.equal(await count(db, `select 1 from public.leaderboard_entries where user_id = $1`, [dee]), 0);
  });

  test('a second call (the same token, account already gone) succeeds and changes nothing', async () => {
    const annBefore = await rowsNaming(db, ann);
    await asUser(db, dee, () => db.query(`select public.delete_my_account()`));
    assert.deepEqual(await rowsNaming(db, ann), annBefore);
  });

  test('signed out has no grant; a token without a user is UNAUTHENTICATED; an anonymous session deletes its own', async () => {
    await assert.rejects(
      asAnon(db, () => db.query(`select public.delete_my_account()`)),
      permissionDenied,
    );
    await assert.rejects(
      asService(db, () => db.query(`select public.delete_my_account()`)),
      unauthenticated,
    );
    const ghost = await signUpAnonymously(db, { username: 'ghosty', birth_date: '2000-01-01' });
    await asAnonymousUser(db, ghost, () => db.query(`select public.delete_my_account()`));
    assert.equal(await count(db, `select 1 from auth.users where id = $1`, [ghost]), 0);
    assert.equal(await count(db, `select 1 from public.profiles where username = 'ghosty'`), 0);
    // Nobody else was touched.
    assert.equal(await count(db, `select 1 from public.profiles where id in ($1, $2)`, [ann, ben]), 2);
  });
});

describe('the bug-report screenshot no longer blocks the delete', () => {
  test('before this migration the set null broke the screenshot check; now the report outlives the account', async () => {
    const db = await createTestDb({ before: MIGRATION });
    const tester = await user(db, 'tester');
    await asUser(db, tester, () =>
      db.query(`insert into public.bug_reports (note, screenshot_path) values ('x', $1)`, [`${tester}/a.jpg`]),
    );
    await assert.rejects(db.query(`delete from auth.users where id = $1`, [tester]), /bug_reports_screenshot/);
    await applyMigrations(db, { from: MIGRATION });
    await asUser(db, tester, () => db.query(`select public.delete_my_account()`));
    const rows = await db.query<{ user_id: string | null; screenshot_path: string }>(
      `select user_id, screenshot_path from public.bug_reports`,
    );
    assert.deepEqual(rows.rows, [{ user_id: null, screenshot_path: `${tester}/a.jpg` }]);
    // A live reporter still cannot point at someone else's folder.
    const other = await user(db, 'other');
    await assert.rejects(
      asUser(db, other, () =>
        db.query(`insert into public.bug_reports (note, screenshot_path) values ('y', $1)`, [`${tester}/b.jpg`]),
      ),
      /bug_reports_screenshot/,
    );
    await db.close();
  });
});

describe('privileges', () => {
  test('who may call what; internal helpers are unreachable; definer functions pin search_path', async () => {
    const db = await createTestDb();
    const expect: Record<string, [anon: boolean, auth: boolean]> = {
      'public.report_user(uuid, text, text, text, text)': [false, true],
      'public.delete_my_account()': [false, true],
    };
    for (const [fn, [anon, auth]] of Object.entries(expect)) {
      const r = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('service_role', $1, 'execute') as svc, has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon, auth, svc: true, pub: false }, fn);
    }
    const internal = await db.query<{ proname: string; public_exec: boolean; svc_exec: boolean }>(
      `select proname, has_function_privilege('public', oid, 'execute') as public_exec,
              has_function_privilege('service_role', oid, 'execute') as svc_exec
         from pg_proc where pronamespace = 'private'::regnamespace
          and proname in ('reports_before_update', 'scrub_match_payload') order by 1`,
    );
    assert.deepEqual(
      internal.rows.map((r) => [r.proname, r.public_exec, r.svc_exec]),
      [
        ['reports_before_update', false, false],
        ['scrub_match_payload', false, false],
      ],
    );
    const loose = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p where p.prosecdef and p.proname in ('report_user', 'delete_my_account')
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    assert.deepEqual(loose.rows, []);
    const table = await db.query<{ rls: boolean; anon: boolean; auth: boolean }>(
      `select relrowsecurity as rls,
              has_table_privilege('anon', 'public.reports', 'select') as anon,
              has_table_privilege('authenticated', 'public.reports', 'select') as auth
         from pg_class where oid = 'public.reports'::regclass`,
    );
    assert.deepEqual(table.rows[0], { rls: true, anon: false, auth: false });
    await db.close();
  });
});
