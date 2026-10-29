import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, signUp, asUser } from './harness.ts';

test('migrations apply from scratch', async () => {
  const db = await createTestDb();
  const tables = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  );
  const names = tables.rows.map((r) => r.table_name);
  for (const t of ['profiles', 'games', 'game_versions', 'game_consents', 'game_saves', 'favorites', 'game_stats', 'banned_words']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  await db.close();
});

test('signup creates a profile; under-13 is refused', async () => {
  const db = await createTestDb();
  const id = await signUp(db, { username: 'alice_01', birth_date: '2000-05-04' });
  const p = await db.query<{ username: string }>(`select username from public.profiles where id = $1`, [id]);
  assert.equal(p.rows[0]?.username, 'alice_01');

  const thisYear = new Date().getFullYear();
  await assert.rejects(signUp(db, { username: 'kid', birth_date: `${thisYear - 10}-01-01` }), /AGE_GATE/);
  await db.close();
});

test('save_put enforces optimistic concurrency', async () => {
  const db = await createTestDb();
  await db.exec(`insert into public.games (id, title, engine) values ('spike', 'Spike', 'playcanvas')`);
  const id = await signUp(db, { username: 'bob_02', birth_date: '1999-01-01' });
  await asUser(db, id, async () => {
    const v1 = await db.query<{ save_put: number }>(`select public.save_put('spike', 'main', '{"x":1}'::jsonb, null)`);
    assert.equal(v1.rows[0]?.save_put, 1);
    const v2 = await db.query<{ save_put: number }>(`select public.save_put('spike', 'main', '{"x":2}'::jsonb, 1)`);
    assert.equal(v2.rows[0]?.save_put, 2);
    await assert.rejects(db.query(`select public.save_put('spike', 'main', '{"x":3}'::jsonb, 1)`), /CONFLICT/);
  });
  await db.close();
});
