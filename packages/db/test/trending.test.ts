// 20261102000600_trending.sql: trending_games, the dashboard hero's order (launches over the last seven UTC days).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { asAnon, asUser, createTestDb, insertGame, signUp } from './harness.ts';

let db: PGlite;

/** A game_visits_daily row `daysAgo` UTC days ago (0 = today), written as the migration's internal writer would. */
const dailyVisits = (game: string, daysAgo: number, visits: number) =>
  db.query(
    `insert into public.game_visits_daily (game_id, day, visits)
       values ($1, (now() at time zone 'utc')::date - $2::int, $3)
     on conflict (game_id, day) do update set visits = excluded.visits`,
    [game, daysAgo, visits],
  );

const allTime = (game: string, visits: number) =>
  db.query(`update public.games set visits = $2 where id = $1`, [game, visits]);

type Row = { id: string; recent_visits: number; visits: number };
const trending = (days?: number, limit?: number) =>
  db.query<Row>(
    `select id, recent_visits::int as recent_visits, visits::int as visits from public.trending_games($1, $2)`,
    [days ?? null, limit ?? null],
  );

before(async () => {
  db = await createTestDb();
  // Three published games with launches, one with none, one that only has history, and a draft nobody may see.
  for (const id of ['hot', 'warm', 'quiet', 'old-hit', 'empty']) await insertGame(db, id);
  await insertGame(db, 'draft', 'draft');
  await dailyVisits('hot', 0, 5);
  await dailyVisits('hot', 3, 4); // 9 in the window
  await dailyVisits('warm', 1, 3); // 3 in the window
  await dailyVisits('warm', 8, 100); // eight days ago: outside a 7-day window
  await dailyVisits('old-hit', 20, 500); // all outside the window
  await allTime('old-hit', 500);
  await allTime('quiet', 40); // no launches this week, some all time
  await dailyVisits('draft', 0, 1000);
  await allTime('draft', 1000);
});

after(async () => {
  await db.close();
});

test('trending: launches this week first, then all-time visits, then newest; drafts never', async () => {
  const rows = (await trending()).rows;
  assert.deepEqual(
    rows.map((r) => [r.id, r.recent_visits]),
    [
      ['hot', 9],
      ['warm', 3],
      ['old-hit', 0],
    ],
    'the default is three games; old-hit ranks on its 500 all-time visits once the week is a tie',
  );
  const all = (await trending(7, 10)).rows.map((r) => r.id);
  assert.deepEqual(all, ['hot', 'warm', 'old-hit', 'quiet', 'empty'], 'a fresh game with nothing still lists last');
  assert.ok(!all.includes('draft'), 'a draft never trends, however popular its launches');
});

test('trending: the window is the last p_days UTC days including today, clamped to 1..30', async () => {
  // A 9-day window reaches warm's row from eight days ago (100), which then beats hot's 9.
  const nine = (await trending(9, 2)).rows;
  assert.deepEqual(
    nine.map((r) => [r.id, r.recent_visits]),
    [
      ['warm', 103],
      ['hot', 9],
    ],
  );
  // One day: only today counts.
  const today = (await trending(1, 10)).rows;
  assert.deepEqual(today[0], { id: 'hot', recent_visits: 5, visits: 0 });
  assert.equal(today[1]!.recent_visits, 0);
  // Out-of-range and null arguments clamp instead of failing: 0 days behaves as 1, 1000 as 30, null as the default.
  assert.equal((await trending(0, 10)).rows[0]!.recent_visits, 5);
  assert.equal((await trending(1000, 10)).rows.find((r) => r.id === 'old-hit')!.recent_visits, 500, '30 days reach it');
  assert.equal((await trending(undefined, 100)).rows.length, 5, 'limit clamps to 10, which is all five here');
  assert.equal((await trending(7, 0)).rows.length, 1, 'limit clamps up to 1');
});

test('trending: readable signed out and signed in (the catalog is public)', async () => {
  const anon = await asAnon(db, () => trending());
  assert.deepEqual(
    anon.rows.map((r) => r.id),
    ['hot', 'warm', 'old-hit'],
  );
  const uid = await signUp(db, { username: 'ren', birth_date: '2000-01-01' });
  const signedIn = await asUser(db, uid, () => trending(7, 1));
  assert.deepEqual(
    signedIn.rows.map((r) => r.id),
    ['hot'],
  );
});
