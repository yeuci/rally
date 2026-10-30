import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, signUp } from './harness.ts';

const DEFAULT_RE = /^defaults\/avatar-(0[1-9]|10)\.webp$/;

test('signup assigns a random default avatar unless metadata provides one', async () => {
  const db = await createTestDb();
  const id = await signUp(db, { username: 'ava_01', birth_date: '2000-01-01' });
  const row = await db.query<{ avatar_url: string }>(`select avatar_url from public.profiles where id = $1`, [id]);
  assert.match(row.rows[0]!.avatar_url, DEFAULT_RE);

  const withUrl = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
    ['oauth@example.com', JSON.stringify({ username: 'ava_02', birth_date: '2000-01-01', avatar_url: 'https://cdn.example.com/me.png' })],
  );
  const row2 = await db.query<{ avatar_url: string }>(`select avatar_url from public.profiles where id = $1`, [withUrl.rows[0]!.id]);
  assert.equal(row2.rows[0]!.avatar_url, 'https://cdn.example.com/me.png');
  await db.close();
});

test('random_default_avatar draws from all ten defaults', async () => {
  const db = await createTestDb();
  const seen = new Set<string>();
  for (let i = 0; i < 200 && seen.size < 10; i++) {
    const r = await db.query<{ p: string }>(`select public.random_default_avatar() as p`);
    seen.add(r.rows[0]!.p);
  }
  assert.equal(seen.size, 10);
  const count = await db.query<{ n: number }>(`select count(*)::int as n from public.default_avatars`);
  assert.equal(count.rows[0]!.n, 10);
  await db.close();
});

test('default_avatars is not readable by clients', async () => {
  const db = await createTestDb();
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`select * from public.default_avatars`), /permission denied/);
  await db.exec(`reset role`);
  await db.close();
});
