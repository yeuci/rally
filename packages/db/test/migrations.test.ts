import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Constants } from '../src/types.ts';
import { createTestDb, signUp, asUser } from './harness.ts';

test('migrations apply from scratch', async () => {
  const db = await createTestDb();
  const tables = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  );
  const names = tables.rows.map((r) => r.table_name);
  for (const t of [
    'profiles',
    'games',
    'game_versions',
    'game_consents',
    'game_saves',
    'favorites',
    'game_stats',
    'banned_words',
    'leaderboards',
    'leaderboard_entries',
    'achievements',
    'user_achievements',
    'play_sessions',
    'friendships',
    'blocks',
  ]) {
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

// src/types.ts is hand-written in `supabase gen types` shape until a project is linked; keep it honest.
test('src/types.ts matches the migrated schema (columns, nullability, defaults, enums, functions)', async () => {
  const src = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
  // Indentation-based parse of the generated layout: table at 6 spaces, Row/Insert/Update at 8, fields at 10.
  type Section = 'Row' | 'Insert' | 'Update';
  const tables = new Map<string, Record<Section, Map<string, string>>>();
  const tablesBlock = src.slice(src.indexOf('    Tables: {'), src.indexOf('    Views: {'));
  let table = '';
  let section: Section | undefined;
  for (const line of tablesBlock.split('\n')) {
    const t = /^ {6}(\w+): \{$/.exec(line);
    if (t) {
      table = t[1]!;
      tables.set(table, { Row: new Map(), Insert: new Map(), Update: new Map() });
      continue;
    }
    const s = /^ {8}(Row|Insert|Update): \{$/.exec(line);
    if (s) section = s[1] as Section;
    else if (/^ {8}\S/.test(line)) section = undefined;
    const f = /^ {10}(\w+)(\??): (.+)$/.exec(line);
    if (f && section) tables.get(table)![section].set(f[1]! + f[2]!, f[3]!);
  }

  const db = await createTestDb();
  const cols = await db.query<{ table_name: string; column_name: string; is_nullable: string; has_default: boolean }>(
    `select table_name, column_name, is_nullable, column_default is not null as has_default
       from information_schema.columns where table_schema = 'public' order by table_name, column_name`,
  );
  const dbTables = [...new Set(cols.rows.map((c) => c.table_name))];
  assert.deepEqual([...tables.keys()].sort(), dbTables.sort());
  for (const c of cols.rows) {
    const t = tables.get(c.table_name)!;
    const nullable = c.is_nullable === 'YES';
    const rowType = t.Row.get(c.column_name);
    assert.ok(rowType, `${c.table_name}.${c.column_name} missing from Row`);
    assert.equal(rowType.endsWith('| null'), nullable, `${c.table_name}.${c.column_name} Row nullability`);
    const optional = nullable || c.has_default;
    assert.ok(t.Insert.has(c.column_name + (optional ? '?' : '')), `${c.table_name}.${c.column_name} Insert optionality`);
    assert.ok(t.Update.has(c.column_name + '?'), `${c.table_name}.${c.column_name} Update`);
  }
  for (const [name, t] of tables) {
    const n = cols.rows.filter((c) => c.table_name === name).length;
    assert.equal(t.Row.size, n, `${name}: Row has extra fields`);
    assert.equal(t.Insert.size, n, `${name}: Insert has extra fields`);
  }

  const enums = await db.query<{ name: string; labels: string[] }>(
    `select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' group by t.typname order by 1`,
  );
  assert.deepEqual(
    Object.fromEntries(enums.rows.map((e) => [e.name, e.labels])),
    JSON.parse(JSON.stringify(Constants.public.Enums)),
  );

  // Functions exposed to the API (non-trigger functions in public).
  const fns = await db.query<{ proname: string }>(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype order by 1`,
  );
  const fnBlock = src.slice(src.indexOf('    Functions: {'), src.indexOf('    Enums: {'));
  const typed = [...fnBlock.matchAll(/^ {6}(\w+): \{/gm)].map((m) => m[1]);
  assert.deepEqual(typed, fns.rows.map((f) => f.proname));
  await db.close();
});
