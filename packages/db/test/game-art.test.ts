// 20261030000200_game_art.sql: games.icon_url / games.cover_url, readable like the rest of the catalog row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAnon, asService, asUser, createTestDb, insertGame, signUp } from './harness.ts';

const ICON = 'https://abc.supabase.co/storage/v1/object/public/games/stack/art/icon-0123456789ab.png';
const COVER = 'https://abc.supabase.co/storage/v1/object/public/games/stack/art/cover-ba9876543210.jpg';

test('games has nullable icon_url and cover_url text columns', async () => {
  const db = await createTestDb();
  const cols = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'games' and column_name in ('icon_url', 'cover_url')
      order by column_name`,
  );
  assert.deepEqual(cols.rows, [
    { column_name: 'cover_url', data_type: 'text', is_nullable: 'YES', column_default: null },
    { column_name: 'icon_url', data_type: 'text', is_nullable: 'YES', column_default: null },
  ]);
  // Existing rows (and rows inserted without art) get null.
  await insertGame(db, 'spike');
  const row = await db.query<{ icon_url: string | null; cover_url: string | null }>(
    `select icon_url, cover_url from public.games where id = 'spike'`,
  );
  assert.deepEqual(row.rows[0], { icon_url: null, cover_url: null });
  await db.close();
});

test('icon_url and cover_url are publicly readable on published games, like the rest of the row', async () => {
  const db = await createTestDb();
  await asService(db, () =>
    db.query(
      `insert into public.games (id, title, engine, status, icon_url, cover_url, screenshots)
       values ('stack', 'Stack', 'playcanvas', 'published', $1, $2, $3), ('wip', 'WIP', 'playcanvas', 'draft', $1, $2, '{}')`,
      [ICON, COVER, [COVER]],
    ),
  );
  const select = `select id, icon_url, cover_url, screenshots from public.games order by id`;
  const expected = [{ id: 'stack', icon_url: ICON, cover_url: COVER, screenshots: [COVER] }];

  assert.deepEqual((await asAnon(db, () => db.query(select))).rows, expected);
  const uid = await signUp(db, { username: 'art_fan', birth_date: '2000-01-01' });
  assert.deepEqual((await asUser(db, uid, () => db.query(select))).rows, expected);

  // Writes stay service-role only (grants unchanged).
  await assert.rejects(
    asUser(db, uid, () => db.query(`update public.games set icon_url = 'https://evil.example/x.png' where id = 'stack'`)),
    /permission denied/,
  );
  await assert.rejects(
    asAnon(db, () => db.query(`update public.games set cover_url = null where id = 'stack'`)),
    /permission denied/,
  );
  await asService(db, () => db.query(`update public.games set icon_url = null where id = 'stack'`));
  const after = await db.query<{ icon_url: string | null }>(`select icon_url from public.games where id = 'stack'`);
  assert.equal(after.rows[0]!.icon_url, null);
  await db.close();
});
