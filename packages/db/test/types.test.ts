// Compile-time checks that src/types.ts plugs into supabase-js the way generated types do.
// Runtime part only constructs the client (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  Constants,
  PROFILE_COLUMNS,
  type Database,
  type Enums,
  type Json,
  type Tables,
  type TablesInsert,
} from '../src/index.ts';

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

  const _release = client.rpc('release_username');
  assertType<Equal<Awaited<typeof _release>['data'], undefined | null>>();

  // M2 RPCs: jsonb results are Json; leaderboard_top returns rows.
  const _submit = client.rpc('submit_solo_score', {
    p_game_id: 'stack',
    p_board_key: 'height',
    p_score: 12,
    p_session_id: '00000000-0000-0000-0000-000000000000',
  });
  assertType<Equal<Awaited<typeof _submit>['data'], Json>>();
  const _start = client.rpc('start_play_session', { p_game_id: 'stack' });
  assertType<Equal<NonNullable<Awaited<typeof _start>['data']>, string>>();
  const _top = client.rpc('leaderboard_top', { p_game_id: 'stack', p_board_key: 'height', p_scope: 'friends' });
  type TopRow = NonNullable<Awaited<typeof _top>['data']>[number];
  assertType<Equal<keyof TopRow, 'rank' | 'user_id' | 'username' | 'avatar_url' | 'score' | 'is_me'>>();
  assertType<Equal<TopRow['rank'], number>>();
  const _stats = client.rpc('public_profile_stats', { p_user_id: '00000000-0000-0000-0000-000000000000' });
  assertType<Equal<Awaited<typeof _stats>['data'], Json>>();
  const _entries = client.from('leaderboard_entries').select('score, period_key, board:leaderboards(key, sort)');
  type EntryRow = NonNullable<Awaited<typeof _entries>['data']>[number];
  assertType<Equal<EntryRow['board'], { key: string; sort: string }>>();
  assertType<Equal<Tables<'achievements'>['icon'], string | null>>();

  // The selectable profile columns parse into a typed row.
  const _profile = client.from('profiles').select(PROFILE_COLUMNS);
  type Profile = NonNullable<Awaited<typeof _profile>['data']>[number];
  assertType<Equal<keyof Profile, 'id' | 'username' | 'display_name' | 'avatar_url' | 'bio' | 'created_at' | 'updated_at'>>();

  // Helpers.
  assertType<Equal<Tables<'profiles'>['birth_date'], string>>();
  const insert: TablesInsert<'games'> = { id: 'x', title: 'X', engine: 'phaser' };
  assert.equal(insert.engine, 'phaser');
  assert.deepEqual([...Constants.public.Enums.game_status], ['draft', 'published', 'hidden']);
  await client.removeAllChannels();
});
