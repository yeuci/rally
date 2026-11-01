// 20261101000200_social_discovery.sql: recently_played_with (match_results payloads, the 14-day window, guests,
// blocks, privacy, bans), game_votes (vote_game / game_vote_summary: one changeable vote per user and game, played
// first, aggregates, guests refused) and bug reports (the bug_reports table and the private bug-reports bucket:
// insert own, read own only, anon and anonymous sessions refused).
import { after, before, describe, test } from 'node:test';
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
import type { GameVoteSummary } from '../src/index.ts';

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const anonymousForbidden = sqlstate('42501', /^ANONYMOUS_FORBIDDEN/);
const notFound = sqlstate('P0002', /^NOT_FOUND/);
const invalid = sqlstate('22023', /^INVALID/);
const rateLimited = sqlstate('P0001', /^RATE_LIMITED/);
const permissionDenied = (e: unknown) => /permission denied/.test((e as Error).message);
const rlsViolation = (e: unknown) => /row-level security/.test((e as Error).message);
const checkViolation = (constraint: string) => (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return err.code === '23514' && (err.message ?? '').includes(constraint);
};

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

/** Accepted friendship, written as superuser (the RPCs are covered by social.test.ts). */
const befriend = (db: PGlite, a: string, b: string) =>
  db.query(
    `insert into public.friendships (user_id, friend_id, status, accepted_at) values ($1, $2, 'accepted', now())`,
    [a, b],
  );
const block = (db: PGlite, blocker: string, blocked: string) =>
  db.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [blocker, blocked]);
const setPrivacy = (db: PGlite, uid: string, privacy: object) =>
  asUser(db, uid, () =>
    db.query(`update public.profiles set privacy = $2::jsonb where id = $1`, [uid, JSON.stringify(privacy)]),
  );

/** A multiplayer game (no 'solo' mode), like Sumo. */
async function insertMultiplayerGame(db: PGlite, id: string): Promise<void> {
  await insertGame(db, id);
  await db.query(`update public.games set modes = '{quick,browser,private}', max_players = 8 where id = $1`, [id]);
}

// ---------------------------------------------------------------------------------------------------------------
// recently_played_with
// ---------------------------------------------------------------------------------------------------------------

interface MatchPlayer {
  userId: string;
  guest: boolean;
}
let matchSeq = 0;
/** Records a finished match the way the game server does (server_record_match, service role); returns its id. */
async function playMatch(
  db: PGlite,
  players: MatchPlayer[],
  over: { gameId?: string; durationSec?: number; private?: boolean; endedAt?: Date } = {},
): Promise<string> {
  const ended = over.endedAt ?? new Date();
  const duration = over.durationSec ?? 95;
  const matchId = `room${++matchSeq}:1`;
  await asService(db, () =>
    db.query(`select public.server_record_match($1::jsonb)`, [
      JSON.stringify({
        matchId,
        gameId: over.gameId ?? 'sumo',
        roomId: `room${matchSeq}`,
        private: over.private ?? false,
        winnerUserId: null,
        startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
        endedAt: ended.toISOString(),
        durationSec: duration,
        rounds: 3,
        leaderboardDeltas: {},
        players: players.map((p, i) => ({ username: `p${i}`, placement: i + 1, score: 0, achievements: [], ...p })),
      }),
    ]),
  );
  return matchId;
}
const p = (userId: string, guest = false): MatchPlayer => ({ userId, guest });

/** Moves a recorded match back in time (as if the server had recorded it then). */
const ageMatch = (db: PGlite, matchId: string, days: number) =>
  db.query(
    `update public.match_results
        set recorded_at = now() - make_interval(days => $2), ended_at = now() - make_interval(days => $2)
      where match_id = $1`,
    [matchId, days],
  );

interface RecentRow {
  user_id: string;
  username: string;
  game_id: string;
  game_title: string | null;
  played_at: string;
  matches: number;
  friendship: string;
}
const recent = (db: PGlite, uid: string, limit?: number) =>
  asUser(
    db,
    uid,
    async () =>
      (
        await db.query<RecentRow>(
          limit === undefined
            ? `select * from public.recently_played_with()`
            : `select * from public.recently_played_with($1)`,
          limit === undefined ? [] : [limit],
        )
      ).rows,
  );
const names = (rows: RecentRow[]) => rows.map((r) => r.username);

describe('recently_played_with', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'sumo');
    await insertMultiplayerGame(db, 'overrun');
    await db.query(`update public.games set title = 'Sumo' where id = 'sumo'`);
  });
  after(() => db.close());

  test('the people you shared counted matches with: most recent first, one row each, with game, when and count', async () => {
    const ann = await user(db, 'rpw_ann');
    const ben = await user(db, 'rpw_ben');
    const cat = await user(db, 'rpw_cat');
    const dan = await user(db, 'rpw_dan');
    const now = Date.now();
    await playMatch(db, [p(ann), p(ben), p(cat)], { endedAt: new Date(now - 3 * 3600_000) });
    await playMatch(db, [p(ann), p(ben)], { gameId: 'overrun', endedAt: new Date(now - 3600_000) });
    await playMatch(db, [p(ben), p(dan)]); // ann was not there

    const rows = await recent(db, ann);
    assert.deepEqual(names(rows), ['rpw_ben', 'rpw_cat']);
    const benRow = rows[0]!;
    assert.equal(benRow.user_id, ben);
    assert.equal(benRow.game_id, 'overrun', 'the latest shared match');
    assert.equal(benRow.matches, 2);
    assert.equal(benRow.friendship, 'none');
    assert.ok(Math.abs(Date.parse(benRow.played_at) - (now - 3600_000)) < 5000);
    assert.equal(rows[1]!.game_title, 'Sumo');
    assert.equal(rows[1]!.matches, 1);

    // Friendship state comes along (the Add friend button).
    await befriend(db, ann, cat);
    await db.query(`insert into public.friendships (user_id, friend_id) values ($1, $2)`, [ben, ann]);
    const after = await recent(db, ann);
    assert.deepEqual(
      after.map((r) => [r.username, r.friendship]),
      [
        ['rpw_ben', 'incoming'],
        ['rpw_cat', 'friends'],
      ],
    );
    assert.deepEqual(names(await recent(db, dan)), ['rpw_ben']);
    assert.deepEqual(names(await recent(db, ann, 1)), ['rpw_ben'], 'p_limit');
  });

  test('only the last 14 days count', async () => {
    const eve = await user(db, 'rpw_eve');
    const fay = await user(db, 'rpw_fay');
    const gus = await user(db, 'rpw_gus');
    await ageMatch(db, await playMatch(db, [p(eve), p(fay)]), 13);
    await ageMatch(db, await playMatch(db, [p(eve), p(gus)]), 15);
    const rows = await recent(db, eve);
    assert.deepEqual(names(rows), ['rpw_fay']);
    // An older shared match still counts toward the person, never past the window.
    await ageMatch(db, await playMatch(db, [p(eve), p(fay)]), 20);
    assert.equal((await recent(db, eve))[0]!.matches, 1);
  });

  test('matches too short to count (coin_rules.match_min_duration_s) are left out', async () => {
    const hal = await user(db, 'rpw_hal');
    const ivy = await user(db, 'rpw_ivy');
    const jon = await user(db, 'rpw_jon');
    await playMatch(db, [p(hal), p(ivy)], { durationSec: 12 });
    await playMatch(db, [p(hal), p(jon)], { durationSec: 20 });
    assert.deepEqual(names(await recent(db, hal)), ['rpw_jon']);
  });

  test('guests: guest seats, anonymous accounts and junk entries are never listed; a guest seat of yours does not count', async () => {
    const kai = await user(db, 'rpw_kai');
    const lea = await user(db, 'rpw_lea');
    const max = await user(db, 'rpw_max');
    const anon = await signUpAnonymously(db, { username: 'rpw_anon', birth_date: '2000-01-01' });
    await playMatch(db, [
      p(kai),
      p(lea, true),
      { userId: anon, guest: false },
      { userId: 'guest-7', guest: false },
      p(max),
    ]);
    assert.deepEqual(names(await recent(db, kai)), ['rpw_max']);
    // Seated as a guest: lea's own list stays empty.
    assert.deepEqual(await recent(db, lea), []);
    // Anonymous sessions and signed-out callers cannot ask at all.
    await asAnonymousUser(db, anon, async () => {
      await assert.rejects(db.query(`select * from public.recently_played_with()`), anonymousForbidden);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.recently_played_with()`), permissionDenied);
    });
  });

  test('blocks hide people either way, and banned users are hidden', async () => {
    const ned = await user(db, 'rpw_ned');
    const ola = await user(db, 'rpw_ola');
    const pia = await user(db, 'rpw_pia');
    const quinn = await user(db, 'rpw_quinn');
    await playMatch(db, [p(ned), p(ola), p(pia), p(quinn)]);
    assert.deepEqual(names(await recent(db, ned)).sort(), ['rpw_ola', 'rpw_pia', 'rpw_quinn']);
    await block(db, ned, ola); // ned blocked ola
    await block(db, pia, ned); // pia blocked ned
    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'test')`, [quinn]);
    assert.deepEqual(await recent(db, ned), []);
    assert.ok(!names(await recent(db, ola)).includes('rpw_ned'));
    assert.ok(!names(await recent(db, pia)).includes('rpw_ned'));
  });

  test('privacy: players whose "Games played" is hidden from you are left out (friends see friends-only players)', async () => {
    const rex = await user(db, 'rpw_rex');
    const sia = await user(db, 'rpw_sia');
    const tom = await user(db, 'rpw_tom');
    const uma = await user(db, 'rpw_uma');
    await playMatch(db, [p(rex), p(sia), p(tom), p(uma)]);
    await setPrivacy(db, sia, { games: 'private' });
    await setPrivacy(db, tom, { games: 'friends' });
    assert.deepEqual(names(await recent(db, rex)), ['rpw_uma']);
    await befriend(db, tom, rex);
    assert.deepEqual(names(await recent(db, rex)).sort(), ['rpw_tom', 'rpw_uma']);
    // Your own privacy does not hide others from you.
    assert.ok(names(await recent(db, sia)).includes('rpw_rex'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// game_votes
// ---------------------------------------------------------------------------------------------------------------

const vote = (db: PGlite, uid: string, game: string, liked?: boolean) =>
  asUser(
    db,
    uid,
    async () =>
      (
        await db.query<{ r: GameVoteSummary }>(
          liked === undefined ? `select public.vote_game($1) as r` : `select public.vote_game($1, $2) as r`,
          liked === undefined ? [game] : [game, liked],
        )
      ).rows[0]!.r,
  );
const summaryAs = (db: PGlite, run: <T>(fn: () => Promise<T>) => Promise<T>, game: string) =>
  run(
    async () => (await db.query<{ r: GameVoteSummary }>(`select public.game_vote_summary($1) as r`, [game])).rows[0]!.r,
  );
/** Played a game: a game_stats row, as record_play / server_record_match write it. */
const played = (db: PGlite, uid: string, game: string) =>
  db.query(`insert into public.game_stats (user_id, game_id, plays, last_played_at) values ($1, $2, 1, now())`, [
    uid,
    game,
  ]);

describe('game votes', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await insertGame(db, 'secret', 'draft');
  });
  after(() => db.close());

  test('one vote per user and game, changeable and removable; only after playing', async () => {
    const ann = await user(db, 'vote_ann');
    await assert.rejects(vote(db, ann, 'stack', true), invalid, 'not played yet');
    // An open solo session counts as having played.
    await asUser(db, ann, () => db.query(`select public.start_play_session('stack')`));
    let s = await vote(db, ann, 'stack', true);
    assert.deepEqual(s, { game_id: 'stack', up: 1, down: 0, total: 1, my_vote: true, can_vote: true });
    s = await vote(db, ann, 'stack', true);
    assert.equal(s.total, 1, 'voting the same way again changes nothing');
    s = await vote(db, ann, 'stack', false);
    assert.deepEqual([s.up, s.down, s.total, s.my_vote], [0, 1, 1, false]);
    assert.equal(await count(db, `select 1 from public.game_votes where user_id = $1`, [ann]), 1);
    s = await vote(db, ann, 'stack');
    assert.deepEqual([s.total, s.my_vote, s.can_vote], [0, null, true], 'leaving p_liked out removes the vote');
    assert.equal(await count(db, `select 1 from public.game_votes where user_id = $1`, [ann]), 0);
  });

  test('aggregates over every voter; my_vote and can_vote follow the caller', async () => {
    const voters = await Promise.all(['agg_a', 'agg_b', 'agg_c', 'agg_d'].map((n) => user(db, n)));
    for (const v of voters) await played(db, v, 'stack');
    await vote(db, voters[0]!, 'stack', true);
    await vote(db, voters[1]!, 'stack', true);
    await vote(db, voters[2]!, 'stack', true);
    const last = await vote(db, voters[3]!, 'stack', false);
    assert.deepEqual([last.up, last.down, last.total, last.my_vote], [3, 1, 4, false]);
    const asFirst = await summaryAs(db, (fn) => asUser(db, voters[0]!, fn), 'stack');
    assert.deepEqual([asFirst.up, asFirst.down, asFirst.my_vote, asFirst.can_vote], [3, 1, true, true]);
    // Someone who never played sees the counts but may not vote.
    const viewer = await user(db, 'agg_viewer');
    const asViewer = await summaryAs(db, (fn) => asUser(db, viewer, fn), 'stack');
    assert.deepEqual([asViewer.total, asViewer.my_vote, asViewer.can_vote], [4, null, false]);
    // Signed out: the aggregate is public.
    const signedOut = await summaryAs(db, (fn) => asAnon(db, fn), 'stack');
    assert.deepEqual([signedOut.up, signedOut.down, signedOut.my_vote, signedOut.can_vote], [3, 1, null, false]);
  });

  test('guests are refused; unknown and unpublished games are NOT_FOUND', async () => {
    const anon = await signUpAnonymously(db, { username: 'vote_guest', birth_date: '2000-01-01' });
    await played(db, anon, 'stack');
    await asAnonymousUser(db, anon, async () => {
      await assert.rejects(db.query(`select public.vote_game('stack', true)`), anonymousForbidden);
      const s = (await db.query<{ r: GameVoteSummary }>(`select public.game_vote_summary('stack') as r`)).rows[0]!.r;
      assert.deepEqual([s.my_vote, s.can_vote], [null, false]);
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select public.vote_game('stack', true)`), permissionDenied);
    });
    const bob = await user(db, 'vote_bob');
    await played(db, bob, 'secret');
    await assert.rejects(vote(db, bob, 'secret', true), notFound);
    await assert.rejects(vote(db, bob, 'nope', true), notFound);
    await assert.rejects(
      summaryAs(db, (fn) => asAnon(db, fn), 'secret'),
      notFound,
    );
  });

  test('clients cannot write game_votes directly and read only their own rows', async () => {
    const cy = await user(db, 'vote_cy');
    const di = await user(db, 'vote_di');
    await played(db, cy, 'stack');
    await played(db, di, 'stack');
    await vote(db, cy, 'stack', true);
    await vote(db, di, 'stack', false);
    await asUser(db, cy, async () => {
      await assert.rejects(
        db.query(`insert into public.game_votes (user_id, game_id, liked) values ($1, 'stack', true)`, [cy]),
        permissionDenied,
      );
      await assert.rejects(db.query(`update public.game_votes set liked = true`), permissionDenied);
      await assert.rejects(db.query(`delete from public.game_votes`), permissionDenied);
      const rows = await db.query<{ user_id: string }>(`select user_id from public.game_votes`);
      assert.deepEqual(
        rows.rows.map((r) => r.user_id),
        [cy],
      );
    });
    await asAnon(db, async () => {
      await assert.rejects(db.query(`select * from public.game_votes`), permissionDenied);
    });
  });

  test('votes are rate limited (20 in a burst)', async () => {
    const ed = await user(db, 'vote_ed');
    await played(db, ed, 'stack');
    for (let i = 0; i < 20; i++) await vote(db, ed, 'stack', i % 2 === 0);
    await assert.rejects(vote(db, ed, 'stack', true), rateLimited);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// bug reports
// ---------------------------------------------------------------------------------------------------------------

const fileReport = (db: PGlite, uid: string, fields: Record<string, unknown> = {}) =>
  asUser(db, uid, async () => {
    const cols = Object.keys({ note: '', ...fields });
    const values = Object.values({ note: 'it broke', ...fields }).map((v) =>
      v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
    );
    await db.query(
      `insert into public.bug_reports (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  });

describe('bug reports', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  test('a signed-in user files a report as themselves; the server stamps user_id and created_at', async () => {
    const ann = await user(db, 'bug_ann');
    await fileReport(db, ann, {
      note: 'Sumo froze after the second round',
      app_version: '0.1.0',
      platform: 'ios',
      os_version: '18.1',
      route: '/game/sumo/play',
      game_id: 'sumo',
      game_version: '0.2.1',
      logs: 'W [bridge] dropped message: bad nonce',
      screenshot_path: `${ann}/abc.jpg`,
      context: { executionEnvironment: 'storeClient' },
    });
    const row = (
      await db.query<{ user_id: string; note: string; game_id: string; context: object; age_s: number }>(
        `select user_id, note, game_id, context, extract(epoch from now() - created_at) as age_s from public.bug_reports`,
      )
    ).rows[0]!;
    assert.equal(row.user_id, ann);
    assert.equal(row.note, 'Sumo froze after the second round');
    assert.deepEqual(row.context, { executionEnvironment: 'storeClient' });
    assert.ok(row.age_s < 60);
    // Their own reports come back (Settings → Developer → Bug reports).
    await asUser(db, ann, async () => {
      assert.equal(await count(db, `select 1 from public.bug_reports`), 1);
    });
  });

  test("nobody can read someone else's reports, set another user_id, or change a report", async () => {
    const ben = await user(db, 'bug_ben');
    const cat = await user(db, 'bug_cat');
    await fileReport(db, ben, { note: 'ben was here' });
    await asUser(db, cat, async () => {
      assert.equal(await count(db, `select 1 from public.bug_reports where note = 'ben was here'`), 0);
      assert.equal(await count(db, `select 1 from public.bug_reports`), 0);
      await assert.rejects(
        db.query(`insert into public.bug_reports (user_id, note) values ($1, 'framed')`, [ben]),
        permissionDenied,
      );
      await assert.rejects(
        db.query(`insert into public.bug_reports (id, note) values (gen_random_uuid(), 'x')`),
        permissionDenied,
      );
      await assert.rejects(
        db.query(`insert into public.bug_reports (created_at, note) values (now(), 'x')`),
        permissionDenied,
      );
    });
    await asUser(db, ben, async () => {
      await assert.rejects(db.query(`update public.bug_reports set note = 'edited'`), permissionDenied);
      await assert.rejects(db.query(`delete from public.bug_reports`), permissionDenied);
    });
    // A screenshot must sit in the reporter's own folder.
    await assert.rejects(
      fileReport(db, cat, { screenshot_path: `${ben}/x.jpg` }),
      checkViolation('bug_reports_screenshot'),
    );
    await assert.rejects(fileReport(db, cat, { note: 'x'.repeat(2001) }), checkViolation('bug_reports_note'));
    // The service role (SQL editor, dashboard) reads every report.
    await asService(db, async () => {
      assert.ok((await count(db, `select 1 from public.bug_reports`)) >= 1);
    });
  });

  test('signed-out clients and anonymous sessions are refused', async () => {
    await asAnon(db, async () => {
      await assert.rejects(db.query(`insert into public.bug_reports (note) values ('anon')`), permissionDenied);
      await assert.rejects(db.query(`select * from public.bug_reports`), permissionDenied);
    });
    const guest = await signUpAnonymously(db, { username: 'bug_guest', birth_date: '2000-01-01' });
    await asAnonymousUser(db, guest, async () => {
      await assert.rejects(db.query(`insert into public.bug_reports (note) values ('guest')`), rlsViolation);
    });
  });

  test('ten reports per hour per user', async () => {
    const dot = await user(db, 'bug_dot');
    for (let i = 0; i < 10; i++) await fileReport(db, dot, { note: `#${i}` });
    await assert.rejects(fileReport(db, dot, { note: 'one too many' }), rateLimited);
  });

  test('bug-reports bucket: private, owner insert only into their own folder, no client reads, guests refused', async () => {
    const bucket = (
      await db.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
        `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'bug-reports'`,
      )
    ).rows[0]!;
    assert.deepEqual(bucket, {
      public: false,
      file_size_limit: 5242880,
      allowed_mime_types: ['image/jpeg', 'image/png'],
    });

    const eli = await user(db, 'bug_eli');
    const fox = await user(db, 'bug_fox');
    const put = (name: string) =>
      db.query(`insert into storage.objects (bucket_id, name) values ('bug-reports', $1)`, [name]);
    await asUser(db, eli, async () => {
      await put(`${eli}/shot.jpg`);
      await assert.rejects(put(`${fox}/shot.jpg`), rlsViolation, "another user's folder");
      await assert.rejects(put('shot.jpg'), rlsViolation, 'the bucket root');
      // Owner insert only: no listing, replacing or deleting, not even their own files.
      assert.equal(await count(db, `select 1 from storage.objects where bucket_id = 'bug-reports'`), 0);
      const upd = await db.query(`update storage.objects set metadata = '{}' where bucket_id = 'bug-reports'`);
      assert.equal(upd.affectedRows, 0);
      const del = await db.query(`delete from storage.objects where bucket_id = 'bug-reports'`);
      assert.equal(del.affectedRows, 0);
    });
    await asUser(db, fox, async () => {
      assert.equal(await count(db, `select 1 from storage.objects where bucket_id = 'bug-reports'`), 0);
    });
    const guest = await signUpAnonymously(db, { username: 'bug_guest2', birth_date: '2000-01-01' });
    await asAnonymousUser(db, guest, async () => {
      await assert.rejects(put(`${guest}/shot.jpg`), rlsViolation);
    });
    await asAnon(db, async () => {
      await assert.rejects(put('anon/shot.jpg'), rlsViolation);
    });
    // Avatars are untouched by the new policies.
    await asUser(db, eli, () =>
      db.query(`insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${eli}/a.webp`]),
    );
    assert.equal(await count(db, `select 1 from storage.objects where bucket_id = 'bug-reports'`), 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------------------------

describe('grants', () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });
  after(() => db.close());

  test('who may call what', async () => {
    const expect: Record<string, [anon: boolean, auth: boolean]> = {
      'public.recently_played_with(int)': [false, true],
      'public.game_vote_summary(text)': [true, true],
      'public.vote_game(text, boolean)': [false, true],
      'private.has_played(uuid, text)': [false, false],
      'private.game_vote_summary(text, uuid)': [false, false],
      'private.bug_reports_before_insert()': [false, false],
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

  test('tables: RLS on; game_votes select-only, bug_reports insert + select for signed-in users', async () => {
    const privs = await db.query<{ t: string; anon: string[]; auth: string[] }>(
      `select t,
              array(select p from unnest(array['select', 'insert', 'update', 'delete']) p
                     where has_table_privilege('anon', 'public.' || t, p)) as anon,
              array(select p from unnest(array['select', 'insert', 'update', 'delete']) p
                     where has_table_privilege('authenticated', 'public.' || t, p)
                        or (p <> 'delete' and has_any_column_privilege('authenticated', 'public.' || t, p))) as auth
         from unnest(array['game_votes', 'bug_reports']) t order by t`,
    );
    assert.deepEqual(privs.rows, [
      { t: 'bug_reports', anon: [], auth: ['select', 'insert'] },
      { t: 'game_votes', anon: [], auth: ['select'] },
    ]);
    const rls = await db.query<{ relname: string; on: boolean }>(
      `select relname, relrowsecurity as on from pg_class
        where relnamespace = 'public'::regnamespace and relname in ('game_votes', 'bug_reports') order by 1`,
    );
    assert.deepEqual(
      rls.rows.map((r) => [r.relname, r.on]),
      [
        ['bug_reports', true],
        ['game_votes', true],
      ],
    );
  });
});
