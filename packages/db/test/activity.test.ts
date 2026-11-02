// 20261102000500_activity.sql: the friends activity feed. The AFTER INSERT triggers that write `activity` rows
// (xp_ledger: level-ups and achievements; leaderboard_entries: new bests on all-time best boards; match_results: wins
// and co-op escapes), their safety (a refused row never fails the writer), friends_activity (friends only, privacy,
// blocks, bans, pagination), the retention purge and privileges.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { ACTIVITY_RETENTION_DAYS, type ActivityKind } from '../src/index.ts';
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

// --- the catalog ---------------------------------------------------------------------------------------------------

/** A multiplayer game (no 'solo' mode), like Sumo. */
async function insertMultiplayerGame(db: PGlite, id: string, title = id): Promise<void> {
  await insertGame(db, id);
  await db.query(
    `update public.games set modes = '{quick,browser,private}', max_players = 8, title = $2 where id = $1`,
    [id, title],
  );
}
const board = (db: PGlite, game: string, key: string, mode: 'best' | 'total' = 'best', period = 'alltime') =>
  db.query(`insert into public.leaderboards (game_id, key, sort, mode, period) values ($1, $2, 'desc', $3, $4)`, [
    game,
    key,
    mode,
    period,
  ]);
const achievement = (db: PGlite, game: string, key: string, title: string) =>
  db.query(`insert into public.achievements (game_id, key, title) values ($1, $2, $3)`, [game, key, title]);

/** Stack (solo: `height`), Sumo (total `wins`), Overrun (best `wave` / `kills`), Northdale (co-op, `escapes` total). */
async function seedCatalog(db: PGlite): Promise<void> {
  await insertGame(db, 'stack');
  await db.query(
    `update public.games set title = 'Stack', icon_url = 'https://cdn.example.com/stack/icon.png' where id = 'stack'`,
  );
  await board(db, 'stack', 'height');
  await achievement(db, 'stack', 'ten_high', 'Ten High');
  await insertMultiplayerGame(db, 'sumo', 'Sumo');
  await board(db, 'sumo', 'wins', 'total');
  await achievement(db, 'sumo', 'yokozuna', 'Yokozuna');
  await insertMultiplayerGame(db, 'overrun', 'Overrun');
  await board(db, 'overrun', 'wave');
  await board(db, 'overrun', 'kills');
  await insertMultiplayerGame(db, 'northdale', 'Northdale');
  await board(db, 'northdale', 'nights');
  await board(db, 'northdale', 'escapes', 'total');
}

// --- the writers ----------------------------------------------------------------------------------------------------

interface MatchPlayer {
  userId: string;
  guest: boolean;
  achievements?: string[];
}
const p = (userId: string, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ userId, guest: false, ...extra });
const guest = (n: number): MatchPlayer => ({ userId: `guest:${n}`, guest: true });

let matchSeq = 0;
/** Records a finished match the way the game server does (server_record_match, service role); returns its id. */
async function playMatch(
  db: PGlite,
  players: MatchPlayer[],
  over: {
    gameId?: string;
    durationSec?: number;
    private?: boolean;
    winnerUserId?: string | null;
    leaderboardDeltas?: Record<string, Record<string, number>>;
    leaderboardScores?: Record<string, Record<string, number>>;
    details?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const ended = new Date();
  const duration = over.durationSec ?? 95;
  const matchId = `room${++matchSeq}:1`;
  const r = await asService(
    db,
    async () =>
      (
        await db.query<{ r: { duplicate: boolean } }>(`select public.server_record_match($1::jsonb) as r`, [
          JSON.stringify({
            matchId,
            gameId: over.gameId ?? 'sumo',
            roomId: `room${matchSeq}`,
            private: over.private ?? false,
            winnerUserId: over.winnerUserId ?? null,
            startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
            endedAt: ended.toISOString(),
            durationSec: duration,
            rounds: 3,
            leaderboardDeltas: over.leaderboardDeltas ?? {},
            leaderboardScores: over.leaderboardScores,
            players: players.map((pl, i) => ({
              username: `p${i}`,
              placement: i + 1,
              score: 0,
              achievements: [],
              ...pl,
            })),
            details: over.details,
          }),
        ])
      ).rows[0]!.r,
  );
  assert.equal(r.duplicate, false, 'the match was recorded');
  return matchId;
}

/** An open Stack play session old enough for submit_solo_score (started `ageS` seconds ago). */
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
const submit = async (db: PGlite, uid: string, score: number, boardKey = 'height') => {
  const sid = await session(db, uid);
  return asUser(
    db,
    uid,
    async () =>
      (
        await db.query<{ r: { accepted: boolean; reason: string | null } }>(
          `select public.submit_solo_score('stack', $1, $2::float8, $3) as r`,
          [boardKey, score, sid],
        )
      ).rows[0]!.r,
  );
};
const unlock = async (db: PGlite, uid: string, key: string) => {
  await session(db, uid);
  await asUser(db, uid, () => db.query(`select public.unlock_achievement('stack', $1)`, [key]));
};
/** XP the way a support grant does it (superuser; private.apply_xp is the only writer). */
const grantXp = (db: PGlite, uid: string, amount: number, ref = `grant-${Math.random()}`) =>
  db.query(`select private.apply_xp($1, $2, 'adjustment', $3)`, [uid, amount, ref]);

// --- what was written -----------------------------------------------------------------------------------------------

interface ActivityRow {
  id: number;
  kind: ActivityKind;
  game_id: string | null;
  payload: Record<string, unknown>;
}
const rowsOf = async (db: PGlite, uid: string, kind?: ActivityKind): Promise<ActivityRow[]> =>
  (
    await db.query<ActivityRow>(
      `select id, kind, game_id, payload from public.activity where actor_id = $1 and ($2::text is null or kind = $2) order by id`,
      [uid, kind ?? null],
    )
  ).rows;

describe('activity triggers', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
    await seedCatalog(db);
  });
  after(() => db.close());

  test('level_up: one row when an award crosses a level (whatever the jump), none otherwise', async () => {
    const ann = await user(db, 'act_ann');
    await grantXp(db, ann, 50);
    assert.deepEqual(await rowsOf(db, ann), [], 'still level 1');
    await grantXp(db, ann, 60); // 110 XP: level 2
    await grantXp(db, ann, 500); // 610 XP: level 5 (level 6 starts at 750)
    const rows = await rowsOf(db, ann);
    assert.deepEqual(
      rows.map((r) => [r.kind, r.game_id, r.payload]),
      [
        ['level_up', null, { level: 2, from: 1 }],
        ['level_up', null, { level: 5, from: 2 }],
      ],
    );
    // A history purged after a year: the stored level is the baseline, so nothing is invented.
    await db.query(`delete from public.xp_ledger where user_id = $1`, [ann]);
    await grantXp(db, ann, 10); // 620 XP, still level 5
    assert.equal((await rowsOf(db, ann, 'level_up')).length, 2);
    await grantXp(db, ann, 200); // 820 XP: level 6
    const last = (await rowsOf(db, ann, 'level_up')).at(-1)!;
    assert.deepEqual(last.payload, { level: 6, from: 5 });
  });

  test('achievement: a solo unlock and a match unlock write one row each, with the key and the title', async () => {
    const ben = await user(db, 'act_ben');
    await unlock(db, ben, 'ten_high');
    await unlock(db, ben, 'ten_high'); // already had it: no second XP row, no second card
    await playMatch(db, [p(ben, { achievements: ['yokozuna'] }), guest(1)]);
    const rows = await rowsOf(db, ben, 'achievement');
    assert.deepEqual(
      rows.map((r) => [r.game_id, r.payload]),
      [
        ['stack', { key: 'ten_high', title: 'Ten High' }],
        ['sumo', { key: 'yokozuna', title: 'Yokozuna' }],
      ],
    );
  });

  test('new_best: a first or better score on an all-time best board; never a worse one, a total board or a daily board', async () => {
    const cat = await user(db, 'act_cat');
    assert.equal((await submit(db, cat, 10)).accepted, true);
    assert.equal((await submit(db, cat, 8)).reason, 'not_best');
    assert.equal((await submit(db, cat, 15)).accepted, true);
    let rows = await rowsOf(db, cat, 'new_best');
    assert.deepEqual(
      rows.map((r) => [r.game_id, r.payload]),
      [
        ['stack', { board: 'height', score: 10, boards: 1 }],
        ['stack', { board: 'height', score: 15, previous: 10, boards: 1 }],
      ],
    );
    // Server-written best boards (Overrun): one row per board improved, naming the board among the game's two.
    await playMatch(db, [p(cat), guest(1)], {
      gameId: 'overrun',
      leaderboardScores: { wave: { [cat]: 12 }, kills: { [cat]: 40 } },
    });
    await playMatch(db, [p(cat), guest(1)], {
      gameId: 'overrun',
      leaderboardScores: { wave: { [cat]: 9 }, kills: { [cat]: 41 } },
    });
    rows = (await rowsOf(db, cat, 'new_best')).filter((r) => r.game_id === 'overrun');
    assert.deepEqual(
      rows.map((r) => r.payload),
      [
        { board: 'kills', score: 40, boards: 2 },
        { board: 'wave', score: 12, boards: 2 },
        { board: 'kills', score: 41, previous: 40, boards: 2 },
      ],
    );
    // A total board (Sumo's wins) accumulates: not a best.
    await playMatch(db, [p(cat), guest(1)], { winnerUserId: cat, leaderboardDeltas: { wins: { [cat]: 1 } } });
    assert.equal(
      await count(
        db,
        `select 1 from public.leaderboard_entries e join public.leaderboards b on b.id = e.leaderboard_id where e.user_id = $1 and b.key = 'wins'`,
        [cat],
      ),
      1,
    );
    assert.equal((await rowsOf(db, cat, 'new_best')).filter((r) => r.game_id === 'sumo').length, 0);
    // A daily board resets every day: not a personal best either.
    await board(db, 'stack', 'daily_height', 'best', 'daily');
    assert.equal((await submit(db, cat, 20, 'daily_height')).accepted, true);
    assert.equal((await rowsOf(db, cat, 'new_best')).filter((r) => r.payload.board === 'daily_height').length, 0);
  });

  test('match_win: the winner of a counted match only; short matches and lonely private ones do not count', async () => {
    const dan = await user(db, 'act_dan');
    const eve = await user(db, 'act_eve');
    const id = await playMatch(db, [p(dan), p(eve)], { winnerUserId: dan });
    assert.deepEqual(
      (await rowsOf(db, dan, 'match_win')).map((r) => [r.game_id, r.payload]),
      [['sumo', { match_id: id, players: 2 }]],
    );
    assert.deepEqual(await rowsOf(db, eve, 'match_win'), []);
    await playMatch(db, [p(dan), p(eve)], { winnerUserId: dan, durationSec: 10 });
    await playMatch(db, [p(dan), guest(1)], { winnerUserId: dan, private: true });
    assert.equal((await rowsOf(db, dan, 'match_win')).length, 1, 'too short, or private with one linked player');
    await playMatch(db, [p(dan), p(eve), guest(1)], { winnerUserId: eve, private: true });
    assert.equal((await rowsOf(db, eve, 'match_win')).length, 1, 'a private match with two linked players counts');
    // A guest winner, or no winner (co-op), is nobody's win.
    await playMatch(db, [p(dan), guest(1)], { winnerUserId: 'guest:1' });
    await playMatch(db, [p(dan), p(eve)], { gameId: 'overrun' });
    assert.equal((await rowsOf(db, dan, 'match_win')).length, 1);
  });

  test('coop_escape: one row per linked player when the run escaped; guests and junk entries are skipped', async () => {
    const fay = await user(db, 'act_fay');
    const gus = await user(db, 'act_gus');
    const anon = await signUpAnonymously(db, { username: 'act_anon', birth_date: '2000-01-01' });
    const escaped = await playMatch(db, [p(fay), p(gus), guest(1), { userId: 'nobody', guest: false }, p(anon)], {
      gameId: 'northdale',
      details: { nights: 5, escaped: true },
    });
    await playMatch(db, [p(fay), p(gus)], { gameId: 'northdale', details: { nights: 2, escaped: false } });
    await playMatch(db, [p(fay), p(gus)], { gameId: 'northdale' });
    for (const uid of [fay, gus]) {
      assert.deepEqual(
        (await rowsOf(db, uid, 'coop_escape')).map((r) => [r.game_id, r.payload]),
        [['northdale', { match_id: escaped, players: 5 }]],
      );
      assert.deepEqual(await rowsOf(db, uid, 'match_win'), [], 'co-op runs have no winner');
    }
    // The anonymous account is a profile too (it earns nothing elsewhere, and can have no friends to show it to).
    assert.equal((await rowsOf(db, anon, 'coop_escape')).length, 1);
    assert.equal(await count(db, `select 1 from public.activity where payload ->> 'match_id' = $1`, [escaped]), 3);
  });

  test('a refused activity row never fails the match, the score or the award that caused it', async () => {
    const hal = await user(db, 'act_hal');
    await db.query(`alter table public.activity add constraint activity_test_block check (false) not valid`);
    try {
      await playMatch(db, [p(hal), guest(1)], { winnerUserId: hal });
      assert.equal((await submit(db, hal, 30)).accepted, true);
      await grantXp(db, hal, 150);
      await unlock(db, hal, 'ten_high');
    } finally {
      await db.query(`alter table public.activity drop constraint activity_test_block`);
    }
    assert.deepEqual(await rowsOf(db, hal), []);
    assert.equal(await count(db, `select 1 from public.match_results where winner_id = $1`, [hal]), 1);
    assert.equal(await count(db, `select 1 from public.user_achievements where user_id = $1`, [hal]), 1);
    assert.ok((await count(db, `select 1 from public.xp_ledger where user_id = $1`, [hal])) >= 2);
    // Back to normal afterwards.
    await grantXp(db, hal, 500);
    assert.equal((await rowsOf(db, hal, 'level_up')).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// friends_activity
// ---------------------------------------------------------------------------------------------------------------

interface FeedRow {
  id: number;
  actor_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  kind: ActivityKind;
  game_id: string | null;
  game_title: string | null;
  game_icon_url: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
const feed = (db: PGlite, uid: string, args: { limit?: number; before?: string; beforeId?: number } = {}) =>
  asUser(
    db,
    uid,
    async () =>
      (
        await db.query<FeedRow>(`select * from public.friends_activity($1, $2, $3)`, [
          args.limit ?? null,
          args.before ?? null,
          args.beforeId ?? null,
        ])
      ).rows,
  );
const actors = (rows: FeedRow[]) => rows.map((r) => r.username);
/** created_at as a number (PGlite hands timestamptz back as a Date). */
const at = (row: FeedRow) => new Date(row.created_at).getTime();

/** Accepted friendship, written as superuser (the RPCs are covered by social.test.ts). */
const befriend = (db: PGlite, a: string, b: string) =>
  db.query(
    `insert into public.friendships (user_id, friend_id, status, accepted_at) values ($1, $2, 'accepted', now())`,
    [a, b],
  );
const unfriend = (db: PGlite, a: string, b: string) =>
  db.query(`delete from public.friendships where (user_id, friend_id) in (($1, $2), ($2, $1))`, [a, b]);
/** A block written directly, so the friendship it would normally remove stays and the read-side check is what hides. */
const block = (db: PGlite, blocker: string, blocked: string) =>
  db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, blocked]);
const unblock = (db: PGlite, blocker: string, blocked: string) =>
  db.query(`delete from public.blocks where blocker_id = $1 and blocked_id = $2`, [blocker, blocked]);
const setPrivacy = (db: PGlite, uid: string, privacy: object) =>
  asUser(db, uid, () =>
    db.query(`update public.profiles set privacy = $2::jsonb where id = $1`, [uid, JSON.stringify(privacy)]),
  );

describe('friends_activity', () => {
  let db: PGlite;
  let me: string;
  let ann: string;
  let ben: string;
  before(async () => {
    db = await createTestDb();
    await seedCatalog(db);
    me = await user(db, 'feed_me');
    ann = await user(db, 'feed_ann');
    ben = await user(db, 'feed_ben');
    await db.query(
      `update public.profiles set display_name = 'Ann', avatar_url = 'defaults/avatar-01.webp' where id = $1`,
      [ann],
    );
    await befriend(db, me, ann);
    await befriend(db, ben, me);
  });
  after(() => db.close());

  test("friends' rows newest first with the actor's profile and the game; never mine or a stranger's", async () => {
    const cat = await user(db, 'feed_cat');
    await grantXp(db, me, 150); // my own level-up: not in my feed
    await grantXp(db, cat, 150); // a stranger's
    await grantXp(db, ann, 150);
    await submit(db, ben, 42);
    const rows = await feed(db, me);
    assert.deepEqual(
      rows.map((r) => [r.username, r.kind, r.game_id, r.game_title, r.game_icon_url]),
      [
        ['feed_ben', 'new_best', 'stack', 'Stack', 'https://cdn.example.com/stack/icon.png'],
        ['feed_ann', 'level_up', null, null, null],
      ],
    );
    assert.deepEqual(rows[0]!.payload, { board: 'height', score: 42, boards: 1 });
    assert.equal(rows[1]!.actor_id, ann);
    assert.equal(rows[1]!.display_name, 'Ann');
    assert.equal(rows[1]!.avatar_url, 'defaults/avatar-01.webp');
    assert.deepEqual(rows[1]!.payload, { level: 2, from: 1 });
    // Ann sees mine (we are friends) but not Ben's (they are not).
    assert.deepEqual(actors(await feed(db, ann)), ['feed_me']);
    assert.deepEqual(await feed(db, cat), []);
  });

  test('pages: p_limit, then p_before / p_before_id continue without skipping rows that share a timestamp', async () => {
    // A co-op escape writes Ann's and Ben's rows in one transaction: the same created_at.
    await playMatch(db, [p(ann), p(ben), guest(1)], { gameId: 'northdale', details: { escaped: true } });
    await grantXp(db, ben, 300);
    const all = await feed(db, me, { limit: 100 });
    assert.ok(all.length >= 5, `enough rows to page (${all.length})`);
    const same = all.filter((r) => r.kind === 'coop_escape');
    assert.equal(same.length, 2);
    assert.equal(at(same[0]!), at(same[1]!));

    const paged: FeedRow[] = [];
    let cursor: { before?: string; beforeId?: number } = {};
    for (let i = 0; i < 20; i++) {
      const page = await feed(db, me, { limit: 1, ...cursor });
      if (page.length === 0) break;
      paged.push(...page);
      cursor = { before: page.at(-1)!.created_at, beforeId: page.at(-1)!.id };
    }
    assert.deepEqual(
      paged.map((r) => r.id),
      all.map((r) => r.id),
    );
    // p_limit is clamped: 0 still returns a row; the default is 20.
    assert.equal((await feed(db, me, { limit: 0 })).length, 1);
    assert.equal((await feed(db, me)).length, Math.min(20, all.length));
    // p_before alone is a coarser cursor (rows strictly older).
    const older = await feed(db, me, { before: same[0]!.created_at });
    assert.ok(older.every((r) => at(r) < at(same[0]!)));
  });

  test("privacy: a friend's 'private' games hide their rows, 'friends' shows them; blocks and bans hide", async () => {
    const dan = await user(db, 'feed_dan');
    await befriend(db, me, dan);
    await grantXp(db, dan, 150);
    assert.ok(actors(await feed(db, me)).includes('feed_dan'));
    await setPrivacy(db, dan, { games: 'friends' });
    assert.ok(actors(await feed(db, me)).includes('feed_dan'), "'friends' lets friends see");
    await setPrivacy(db, dan, { games: 'private' });
    assert.ok(!actors(await feed(db, me)).includes('feed_dan'), "'private' hides everything");
    await setPrivacy(db, dan, { games: 'public' });
    // My own privacy never hides others from me.
    await setPrivacy(db, me, { games: 'private' });
    assert.ok(actors(await feed(db, me)).includes('feed_dan'));
    await setPrivacy(db, me, {});

    await block(db, dan, me); // they blocked me
    assert.ok(!actors(await feed(db, me)).includes('feed_dan'));
    await unblock(db, dan, me);
    await block(db, me, dan); // I blocked them
    assert.ok(!actors(await feed(db, me)).includes('feed_dan'));
    await unblock(db, me, dan);
    assert.ok(actors(await feed(db, me)).includes('feed_dan'));

    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'test')`, [dan]);
    assert.ok(!actors(await feed(db, me)).includes('feed_dan'), 'banned');
    await db.query(`update public.user_sanctions set revoked_at = now() where user_id = $1`, [dan]);
    assert.ok(actors(await feed(db, me)).includes('feed_dan'));
  });

  test('only accepted friendships count: a pending request shows nothing, unfriending hides at once', async () => {
    const eve = await user(db, 'feed_eve');
    await grantXp(db, eve, 150);
    await db.query(`insert into public.friendships (user_id, friend_id) values ($1, $2)`, [eve, me]);
    assert.ok(!actors(await feed(db, me)).includes('feed_eve'), 'pending');
    await db.query(
      `update public.friendships set status = 'accepted', accepted_at = now() where user_id = $1 and friend_id = $2`,
      [eve, me],
    );
    assert.ok(actors(await feed(db, me)).includes('feed_eve'));
    await unfriend(db, me, eve);
    assert.ok(!actors(await feed(db, me)).includes('feed_eve'));
  });

  test('anonymous sessions get nothing, signed out is refused, and nobody reads the table directly', async () => {
    const anon = await signUpAnonymously(db, { username: 'feed_anon', birth_date: '2000-01-01' });
    await asAnonymousUser(db, anon, async () => {
      assert.deepEqual((await db.query(`select * from public.friends_activity()`)).rows, []);
      await assert.rejects(db.query(`select * from public.activity`), permissionDenied);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.friends_activity()`), permissionDenied);
      await assert.rejects(db.query(`select * from public.activity`), permissionDenied);
    });
    // The authenticated role without a user (no JWT subject): UNAUTHENTICATED rather than an empty answer.
    await asRole(db, 'authenticated', async () => {
      await assert.rejects(db.query(`select * from public.friends_activity()`), unauthenticated);
    });
    await asUser(db, me, async () => {
      await assert.rejects(db.query(`select * from public.activity`), permissionDenied);
      await assert.rejects(
        db.query(`insert into public.activity (actor_id, kind) values ($1, 'level_up')`, [me]),
        permissionDenied,
      );
    });
    await asService(db, async () => {
      assert.ok((await count(db, `select 1 from public.activity`)) > 0, 'the service role reads everything');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Retention and privileges
// ---------------------------------------------------------------------------------------------------------------

describe('retention and privileges', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
    await seedCatalog(db);
  });
  after(() => db.close());

  test(`the purge deletes rows older than ${ACTIVITY_RETENTION_DAYS} days and keeps the rest`, async () => {
    const ann = await user(db, 'purge_ann');
    await db.query(
      `insert into public.activity (actor_id, kind, game_id, payload, created_at) values
         ($1, 'level_up', null, '{"level": 2, "from": 1}', now() - interval '31 days'),
         ($1, 'new_best', 'stack', '{"board": "height", "score": 9, "boards": 1}', now() - interval '29 days'),
         ($1, 'match_win', 'sumo', '{"match_id": "r:1", "players": 2}', now())`,
      [ann],
    );
    await db.query(`select private.purge_activity_rows()`);
    const left = await db.query<{ kind: string }>(`select kind from public.activity where actor_id = $1 order by id`, [
      ann,
    ]);
    assert.deepEqual(
      left.rows.map((r) => r.kind),
      ['new_best', 'match_win'],
    );
  });

  test('deleting a player takes their rows along; an unknown game is stored as null', async () => {
    const ben = await user(db, 'purge_ben');
    await db.query(
      `select private.record_activity($1, 'match_win', 'no-such-game', '{"match_id": "x:1", "players": 2}')`,
      [ben],
    );
    assert.deepEqual(
      (await db.query<{ game_id: string | null }>(`select game_id from public.activity where actor_id = $1`, [ben]))
        .rows,
      [{ game_id: null }],
    );
    await db.query(`delete from auth.users where id = $1`, [ben]);
    assert.equal(await count(db, `select 1 from public.activity where actor_id = $1`, [ben]), 0);
  });

  test('who may call what', async () => {
    const expect: Record<string, [anon: boolean, auth: boolean]> = {
      'public.friends_activity(int, timestamptz, bigint)': [false, true],
      'private.record_activity(uuid, text, text, jsonb)': [false, false],
      'private.activity_from_xp()': [false, false],
      'private.activity_from_board_entry()': [false, false],
      'private.match_payload_players(jsonb)': [false, false],
      'private.activity_from_match()': [false, false],
      'private.purge_activity_rows()': [false, false],
    };
    for (const [fn, [anon, auth]] of Object.entries(expect)) {
      const r = await db.query<{ anon: boolean; auth: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as auth,
                has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      assert.deepEqual(r.rows[0], { anon, auth, pub: false }, fn);
    }
  });

  test('activity: RLS on, no client privileges at all', async () => {
    const privs = await db.query<{ anon: string[]; auth: string[]; rls: boolean }>(
      `select array(select p from unnest(array['select', 'insert', 'update', 'delete']) p
                     where has_table_privilege('anon', 'public.activity', p)) as anon,
              array(select p from unnest(array['select', 'insert', 'update', 'delete']) p
                     where has_table_privilege('authenticated', 'public.activity', p)
                        or (p <> 'delete' and has_any_column_privilege('authenticated', 'public.activity', p))) as auth,
              (select relrowsecurity from pg_class where oid = 'public.activity'::regclass) as rls`,
    );
    assert.deepEqual(privs.rows[0], { anon: [], auth: [], rls: true });
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          `select has_sequence_privilege('authenticated', 'public.activity_id_seq', 'usage') as ok`,
        )
      ).rows[0]!.ok,
      false,
    );
  });
});
