// 20261031000300_board_modes.sql: leaderboards.mode ('best' | 'total'), the backfill, submit_solo_score refusing
// 'total' boards, and server_record_match's leaderboardScores for 'best' boards. Concurrency races are reproduced as
// in hardening.test.ts: a test-only trigger on rate_limits (the token is taken right before each board upsert)
// writes the competing entry first, which is what a concurrent transaction committing in between looks like.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyMigrations,
  asAnon,
  asService,
  asUser,
  createTestDb,
  insertGame,
  signUp,
  signUpAnonymously,
} from './harness.ts';
import { MAX_SERVER_BOARD_SCORE, type RecordedMatch } from '../src/index.ts';

const MIGRATION = '20261031000300';

const sqlstate =
  (code: string, message: RegExp) =>
  (e: unknown): boolean => {
    const err = e as { code?: string; message?: string };
    return err.code === code && message.test(err.message ?? '');
  };
const invalid = sqlstate('22023', /^INVALID/);

const count = async (db: PGlite, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]!.n);

const user = (db: PGlite, username: string) => signUp(db, { username, birth_date: '2000-01-01' });

async function insertMultiplayerGame(db: PGlite, id: string): Promise<void> {
  await insertGame(db, id);
  await db.query(`update public.games set modes = '{quick,browser,private}', max_players = 8 where id = $1`, [id]);
}

type Scores = Record<string, Record<string, unknown>>;
interface MatchPlayer {
  userId: string;
  guest: boolean;
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
  leaderboardDeltas?: Scores;
  leaderboardScores?: Scores | null;
  players: MatchPlayer[];
}

let seq = 0;
function match(players: MatchPlayer[], over: Partial<Match> = {}): Match {
  const duration = over.durationSec ?? 95;
  const ended = new Date();
  return {
    matchId: `bm${++seq}:1`,
    gameId: 'overrun',
    roomId: `bm${seq}`,
    private: false,
    winnerUserId: null,
    startedAt: new Date(ended.getTime() - duration * 1000).toISOString(),
    endedAt: ended.toISOString(),
    durationSec: duration,
    rounds: 1,
    leaderboardDeltas: {},
    leaderboardScores: {},
    players: players.map((p) => ({ username: 'x', placement: 1, score: 0, achievements: [], ...p })),
    ...over,
  };
}
const p = (userId: string): MatchPlayer => ({ userId, guest: false });

/** `json` is sent as is (so it can hold numbers JSON.stringify cannot write, like 1e400). */
const recordRaw = (db: PGlite, json: string) =>
  asService(
    db,
    async () => (await db.query<{ r: RecordedMatch }>(`select public.server_record_match($1::jsonb) as r`, [json])).rows[0]!.r,
  );
const record = (db: PGlite, m: unknown) => recordRaw(db, JSON.stringify(m));
const playersOf = (r: RecordedMatch) => (r as Extract<RecordedMatch, { duplicate: false }>).players;

/** {user id → score} on a board of a game. */
const board = async (db: PGlite, game: string, key: string) =>
  Object.fromEntries(
    (
      await db.query<{ user_id: string; score: number; source: string }>(
        `select e.user_id, e.score, e.source from public.leaderboard_entries e
           join public.leaderboards b on b.id = e.leaderboard_id where b.game_id = $1 and b.key = $2`,
        [game, key],
      )
    ).rows.map((r) => [r.user_id, r.score]),
  );

// ---------------------------------------------------------------------------------------------------------------

describe('leaderboards.mode: column, check, backfill', () => {
  test('existing rows: Sumo wins becomes total, the rest stays best; server deltas on best boards are dropped', async () => {
    const db = await createTestDb({ before: MIGRATION });
    try {
      await insertMultiplayerGame(db, 'sumo');
      await insertMultiplayerGame(db, 'overrun');
      await insertGame(db, 'stack');
      await db.query(`update public.games set modes = '{solo}' where id = 'stack'`);
      const ann = await user(db, 'ann');
      await db.exec(`
        insert into public.leaderboards (game_id, key, sort, period) values
          ('sumo', 'wins', 'desc', 'weekly'), ('overrun', 'wave', 'desc', 'alltime'),
          ('overrun', 'kills', 'desc', 'alltime'), ('stack', 'height', 'desc', 'alltime');
      `);
      const entry = (game: string, key: string, score: number, source: string) =>
        db.query(
          `insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score, source)
           select id, public.period_key(period, now()), $3, $4, $5 from public.leaderboards where game_id = $1 and key = $2`,
          [game, key, ann, score, source],
        );
      await entry('sumo', 'wins', 7, 'server');
      await entry('overrun', 'wave', 25, 'server'); // cumulative deltas under the old rule
      await entry('overrun', 'kills', 30, 'server');
      await entry('stack', 'height', 40, 'client');

      await applyMigrations(db, { from: MIGRATION });

      const modes = await db.query<{ k: string; mode: string }>(
        `select game_id || '.' || key as k, mode from public.leaderboards order by 1`,
      );
      assert.deepEqual(
        Object.fromEntries(modes.rows.map((r) => [r.k, r.mode])),
        { 'overrun.kills': 'best', 'overrun.wave': 'best', 'stack.height': 'best', 'sumo.wins': 'total' },
      );
      assert.deepEqual(await board(db, 'sumo', 'wins'), { [ann]: 7 });
      assert.deepEqual(await board(db, 'overrun', 'wave'), {});
      assert.deepEqual(await board(db, 'overrun', 'kills'), {});
      assert.deepEqual(await board(db, 'stack', 'height'), { [ann]: 40 });
    } finally {
      await db.close();
    }
  });

  test("default 'best'; only best / total pass the check; clients read it; publish upserts change it", async () => {
    const db = await createTestDb();
    try {
      await insertMultiplayerGame(db, 'sumo');
      await db.exec(`insert into public.leaderboards (game_id, key, sort) values ('sumo', 'wins', 'desc')`);
      const mode = async () =>
        (await db.query<{ mode: string }>(`select mode from public.leaderboards where key = 'wins'`)).rows[0]!.mode;
      assert.equal(await mode(), 'best');
      await assert.rejects(db.query(`update public.leaderboards set mode = 'max'`), /leaderboards_mode/);
      await assert.rejects(db.query(`update public.leaderboards set mode = null`), /null value/);

      // tooling/publish-game: upsert on (game_id, key) with the service role, mode from game.json.
      const publish = (m: string) =>
        asService(db, () =>
          db.query(
            `insert into public.leaderboards (game_id, key, sort, period, max_score_per_minute, mode)
             values ('sumo', 'wins', 'desc', 'alltime', null, $1)
             on conflict (game_id, key) do update
               set sort = excluded.sort, period = excluded.period,
                   max_score_per_minute = excluded.max_score_per_minute, mode = excluded.mode`,
            [m],
          ),
        );
      await publish('total');
      assert.equal(await mode(), 'total');
      await publish('best');
      assert.equal(await mode(), 'best');
      await assert.rejects(publish('sum'), /leaderboards_mode/);

      const ann = await user(db, 'ann');
      const read = async () => (await db.query<{ mode: string }>(`select mode from public.leaderboards`)).rows;
      assert.deepEqual(await asAnon(db, read), [{ mode: 'best' }]);
      assert.deepEqual(await asUser(db, ann, read), [{ mode: 'best' }]);
      await assert.rejects(
        asUser(db, ann, () => db.query(`update public.leaderboards set mode = 'total'`)),
        /permission denied/,
      );
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('submit_solo_score: best boards only', () => {
  let db: PGlite;
  let ann: string;
  before(async () => {
    db = await createTestDb();
    await insertGame(db, 'stack');
    await db.query(`update public.games set modes = '{solo}' where id = 'stack'`);
    await db.exec(`
      insert into public.leaderboards (game_id, key, sort, created_at) values ('stack', 'height', 'desc', now() - interval '1 day');
      insert into public.leaderboards (game_id, key, sort, mode) values ('stack', 'combo', 'desc', 'total');
    `);
    ann = await user(db, 'ann');
  });
  after(() => db.close());

  test("a 'total' board is INVALID; a best board keeps the best as before", async () => {
    const session = await asUser(
      db,
      ann,
      async () => (await db.query<{ id: string }>(`select public.start_play_session('stack') as id`)).rows[0]!.id,
    );
    await db.query(`update public.play_sessions set started_at = now() - interval '60 seconds' where id = $1`, [session]);
    const submit = (key: string, score: number) =>
      asUser(
        db,
        ann,
        async () =>
          (
            await db.query<{ r: { accepted: boolean; best: number; reason: string | null } }>(
              `select public.submit_solo_score('stack', $1, $2, $3) as r`,
              [key, score, session],
            )
          ).rows[0]!.r,
      );
    await assert.rejects(submit('combo', 5), sqlstate('22023', /^INVALID: leaderboard combo is not a best-score board$/));
    assert.deepEqual(await board(db, 'stack', 'combo'), {});
    assert.equal((await submit('height', 12)).accepted, true);
    assert.deepEqual(await submit('height', 8), { accepted: false, best: 12, rank: 1, reason: 'not_best' });
    assert.equal((await submit('height', 20)).best, 20);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('server_record_match: leaderboardScores on best boards', () => {
  let db: PGlite;
  let ann: string;
  let ben: string;
  let cat: string;
  let ghost: string;
  before(async () => {
    db = await createTestDb();
    await insertMultiplayerGame(db, 'overrun');
    await insertMultiplayerGame(db, 'sumo');
    await db.exec(`
      insert into public.leaderboards (game_id, key, sort, period, mode, max_score_per_minute) values
        ('overrun', 'wave', 'desc', 'alltime', 'best', null),
        ('overrun', 'kills', 'desc', 'alltime', 'best', null),
        ('overrun', 'fastest', 'asc', 'alltime', 'best', null),
        ('overrun', 'bounded', 'desc', 'alltime', 'best', 10),
        ('overrun', 'tally', 'desc', 'alltime', 'total', null),
        ('sumo', 'wins', 'desc', 'weekly', 'total', null);
    `);
    ann = await user(db, 'ann');
    ben = await user(db, 'ben');
    cat = await user(db, 'cat');
    ghost = await signUpAnonymously(db, { username: 'ghost', birth_date: '2000-01-01' });
  });
  beforeEach(() =>
    db.exec(`delete from public.match_results; delete from public.game_stats; delete from public.leaderboard_entries;
             delete from public.rate_limits; delete from public.user_sanctions;`),
  );
  after(() => db.close());

  test('desc board keeps the highest score of a run, never lowered; the result reports score and rank', async () => {
    const r1 = await record(db, match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: 7, [ben]: 3 }, kills: { [ann]: 142 } } }));
    assert.deepEqual(playersOf(r1)[ann]!.boards, { wave: { score: 7, rank: 1 }, kills: { score: 142, rank: 1 } });
    assert.deepEqual(playersOf(r1)[ben]!.boards, { wave: { score: 3, rank: 2 } });
    const r2 = await record(db, match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: 5, [ben]: 9 }, kills: { [ann]: 142 } } }));
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 7, [ben]: 9 });
    assert.deepEqual(await board(db, 'overrun', 'kills'), { [ann]: 142 });
    // The result shows the kept best, not the run's score.
    assert.deepEqual(playersOf(r2)[ann]!.boards, { wave: { score: 7, rank: 2 }, kills: { score: 142, rank: 1 } });
    assert.deepEqual(playersOf(r2)[ben]!.boards, { wave: { score: 9, rank: 1 } });
    const src = await db.query<{ source: string }>(`select distinct source from public.leaderboard_entries`);
    assert.deepEqual(src.rows, [{ source: 'server' }]);
  });

  test('asc board keeps the lowest score; fractional scores are kept as sent', async () => {
    await record(db, match([p(ann), p(ben)], { leaderboardScores: { fastest: { [ann]: 90.5 } } }));
    await record(db, match([p(ann), p(ben)], { leaderboardScores: { fastest: { [ann]: 120 } } }));
    assert.deepEqual(await board(db, 'overrun', 'fastest'), { [ann]: 90.5 });
    const r = await record(db, match([p(ann), p(ben)], { leaderboardScores: { fastest: { [ann]: 60.25, [ben]: 75 } } }));
    assert.deepEqual(await board(db, 'overrun', 'fastest'), { [ann]: 60.25, [ben]: 75 });
    assert.deepEqual(playersOf(r)[ben]!.boards, { fastest: { score: 75, rank: 2 } });
  });

  test('a concurrent better score is never lowered; a concurrent worse one is replaced', async () => {
    // Another match commits a score for ann between our token and our upsert (see the file header).
    await db.exec(`
      create function public.test_race_entry() returns trigger language plpgsql as $$
      declare v_score text := current_setting('test.race', true);
      begin
        if coalesce(v_score, '') <> '' then
          perform set_config('test.race', '', false); -- fire once
          insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score, source)
            select b.id, 'all', new.user_id, v_score::double precision, 'server'
              from public.leaderboards b where b.game_id = 'overrun' and b.key = 'wave'
          on conflict (leaderboard_id, period_key, user_id) do update set score = excluded.score;
        end if;
        return new;
      end $$;
      create trigger test_race_entry after insert or update on public.rate_limits
        for each row execute function public.test_race_entry();
    `);
    try {
      await db.query(`select set_config('test.race', '50', false)`);
      const r = await record(db, match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: 10 } } }));
      assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 50 });
      assert.deepEqual(playersOf(r)[ann]!.boards, { wave: { score: 50, rank: 1 } });

      await db.exec(`delete from public.leaderboard_entries`);
      await db.query(`select set_config('test.race', '3', false)`);
      await record(db, match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: 10 } } }));
      assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 10 });
    } finally {
      await db.exec(`drop trigger test_race_entry on public.rate_limits; drop function public.test_race_entry();`);
      await db.query(`select set_config('test.race', '', false)`);
    }
  });

  test('caps: > 0; <= 1e9 unbounded; <= max_score_per_minute × ceil(minutes), at least 1 minute', async () => {
    assert.equal(MAX_SERVER_BOARD_SCORE, 1e9);
    await record(db, match([p(ann), p(ben)], {
      leaderboardScores: { wave: { [ann]: 1e9, [ben]: 1e9 + 1 }, kills: { [ann]: 0, [ben]: -4 } },
    }));
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 1e9 });
    assert.deepEqual(await board(db, 'overrun', 'kills'), {});

    // Not numbers, or numbers beyond double precision: ignored without an error.
    await record(db, match([p(ann), p(ben)], {
      leaderboardScores: { kills: { [ann]: '12', [ben]: null }, fastest: { [ann]: true, [ben]: [3] } },
    }));
    const huge = match([p(ann), p(ben)], { leaderboardScores: { kills: { [ann]: 0 } } });
    assert.equal((await recordRaw(db, JSON.stringify(huge).replace(`"${ann}":0`, `"${ann}":1e400`))).duplicate, false);
    assert.deepEqual(await board(db, 'overrun', 'kills'), {});
    assert.deepEqual(await board(db, 'overrun', 'fastest'), {});

    // Bounded board (10 per minute): 95 s → 2 minutes → 20; 21 is ignored.
    await record(db, match([p(ann), p(ben)], { durationSec: 95, leaderboardScores: { bounded: { [ann]: 20, [ben]: 21 } } }));
    assert.deepEqual(await board(db, 'overrun', 'bounded'), { [ann]: 20 });
    // 30 s still counts as a whole minute: 10 passes, 10.5 does not.
    await record(db, match([p(ann), p(ben)], { durationSec: 30, leaderboardScores: { bounded: { [ben]: 10.5 } } }));
    await record(db, match([p(ann), p(ben)], { durationSec: 30, leaderboardScores: { bounded: { [ben]: 10 } } }));
    assert.deepEqual(await board(db, 'overrun', 'bounded'), { [ann]: 20, [ben]: 10 });
  });

  test('mismatches are ignored and take no token: deltas on best boards, scores on total boards', async () => {
    const r = await record(db, match([p(ann), p(ben)], {
      leaderboardDeltas: { wave: { [ann]: 3 }, kills: { [ann]: 10 } },
      leaderboardScores: { tally: { [ann]: 5 } },
    }));
    assert.deepEqual(playersOf(r)[ann]!.boards, {});
    await record(db, match([p(ann), p(ben)], { gameId: 'sumo', leaderboardScores: { wins: { [ann]: 4 } } }));
    assert.equal(await count(db, `select 1 from public.leaderboard_entries`), 0);
    assert.equal(await count(db, `select 1 from public.rate_limits where action = 'server_board'`), 0);
  });

  test('total boards: deltas still add up (Sumo wins), beside best scores in the same match', async () => {
    await record(db, match([p(ann), p(ben)], { gameId: 'sumo', winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } }));
    const r = await record(db, match([p(ann), p(ben)], { gameId: 'sumo', winnerUserId: ann, leaderboardDeltas: { wins: { [ann]: 1 } } }));
    assert.deepEqual(await board(db, 'sumo', 'wins'), { [ann]: 2 });
    assert.deepEqual(playersOf(r)[ann]!.boards, { wins: { score: 2, rank: 1 } });
    // Delta rule unchanged: integers 1..10 only.
    await record(db, match([p(ann), p(ben)], { gameId: 'sumo', leaderboardDeltas: { wins: { [ann]: 11, [ben]: 2.5 } } }));
    assert.deepEqual(await board(db, 'sumo', 'wins'), { [ann]: 2 });

    await record(db, match([p(ann), p(ben)], {
      leaderboardDeltas: { tally: { [ann]: 4 } },
      leaderboardScores: { wave: { [ann]: 6 } },
    }));
    await record(db, match([p(ann), p(ben)], {
      leaderboardDeltas: { tally: { [ann]: 4 } },
      leaderboardScores: { wave: { [ann]: 2 } },
    }));
    assert.deepEqual(await board(db, 'overrun', 'tally'), { [ann]: 8 });
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 6 });
  });

  test('anti-boost and eligibility apply to scores: short or lonely private matches, guests, anonymous, banned', async () => {
    const scores = { wave: { [ann]: 12 } };
    await record(db, match([p(ann), p(ben)], { durationSec: 19.9, leaderboardScores: scores }));
    await record(db, match([p(ann), { userId: 'guest:1', guest: true }], { private: true, leaderboardScores: scores }));
    await record(db, match([p(ann), p(ghost)], { private: true, leaderboardScores: scores }));
    assert.equal(await count(db, `select 1 from public.leaderboard_entries`), 0);

    await db.query(`insert into public.user_sanctions (user_id, kind, reason) values ($1, 'ban', 'cheating')`, [cat]);
    await record(db, match([p(ann), { userId: ben, guest: true }, p(ghost), p(cat)], {
      leaderboardScores: { wave: { [ann]: 4, [ben]: 9, [ghost]: 9, [cat]: 9, 'guest:1': 9 } },
    }));
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 4 });
    // A public match with one eligible player counts; private needs two.
    await record(db, match([p(ann), p(ben)], { private: true, leaderboardScores: { wave: { [ben]: 5 } } }));
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 4, [ben]: 5 });
  });

  test('60 board writes per player per hour, scores included; idempotent on matchId', async () => {
    const m = match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: 3 } } });
    await record(db, m);
    assert.deepEqual(await record(db, { ...m, leaderboardScores: { wave: { [ann]: 30 } } }), { duplicate: true });
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 3 });
    // 1 token used; 59 more writes, then the bucket is empty.
    for (let i = 4; i < 63; i++) await record(db, match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: i } } }));
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 62 });
    await record(db, match([p(ann), p(ben)], { leaderboardScores: { wave: { [ann]: 100 } } }));
    assert.deepEqual(await board(db, 'overrun', 'wave'), { [ann]: 62 });
  });

  test('leaderboardScores: absent or null is fine; another type is INVALID', async () => {
    const { leaderboardScores: _s, ...without } = match([p(ann)]);
    assert.equal((await record(db, without)).duplicate, false);
    assert.equal((await record(db, match([p(ann)], { leaderboardScores: null }))).duplicate, false);
    for (const bad of [[], 'wave', 3]) {
      await assert.rejects(record(db, { ...match([p(ann)]), leaderboardScores: bad }), invalid);
    }
  });
});
