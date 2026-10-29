// Compile-time checks that src/types.ts plugs into supabase-js the way generated types do.
// Runtime part only constructs the client (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { Constants, type Database, type Enums, type Tables, type TablesInsert } from '../src/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {}

test('Database type drives supabase-js inference', async () => {
  const client = createClient<Database>('http://127.0.0.1:54321', 'anon-key');

  // Row inference from select().
  const _q = client.from('games').select('id, status, modes, current_version_id');
  type Row = NonNullable<Awaited<typeof _q>['data']>[number];
  assertType<Equal<Row['status'], Enums<'game_status'>>>();
  assertType<Equal<Row['modes'], Enums<'game_mode'>[]>>();
  assertType<Equal<Row['current_version_id'], string | null>>();

  // Embedded relationship (games -> game_versions via games_current_version_fk).
  const _embed = client.from('games').select('id, current:game_versions!games_current_version_fk(entry_url, version)');
  type Embed = NonNullable<Awaited<typeof _embed>['data']>[number];
  assertType<Equal<Embed['current'], { entry_url: string; version: string } | null>>();

  // RPC args/returns.
  const _put = client.rpc('save_put', { p_game_id: 'spike', p_slot: 'main', p_data: { x: 1 } });
  assertType<Equal<NonNullable<Awaited<typeof _put>['data']>, number>>();
  const _avail = client.rpc('username_available', { p_username: 'alice' });
  assertType<Equal<NonNullable<Awaited<typeof _avail>['data']>, boolean>>();

  // Helpers.
  assertType<Equal<Tables<'profiles'>['birth_date'], string>>();
  const insert: TablesInsert<'games'> = { id: 'x', title: 'X', engine: 'phaser' };
  assert.equal(insert.engine, 'phaser');
  assert.deepEqual([...Constants.public.Enums.game_status], ['draft', 'published', 'hidden']);
  await client.removeAllChannels();
});
