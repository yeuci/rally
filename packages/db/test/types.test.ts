// Compile-time checks that src/types.ts plugs into supabase-js the way generated types do.
// Runtime part only constructs the client (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  Constants,
  PROFILE_COLUMNS,
  REPORT_LIMITS,
  REPORT_REASONS,
  type BuyItemResult,
  type CoinAwardEvent,
  type Database,
  type EquippedItems,
  type WalletSummary,
  type Enums,
  type FriendJoinTarget,
  type FriendshipState,
  type GameRoomSnapshot,
  type HeartbeatResult,
  type ProfilePrivacy,
  type PublicPresence,
  type RecordedMatch,
  type ReportReason,
  type SanctionStatus,
  type Json,
  type LeaderboardMode,
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
  // Board modes: a checked text column ('best' | 'total').
  assertType<Equal<Tables<'leaderboards'>['mode'], string>>();
  const boardMode: LeaderboardMode = 'total';
  const _boardInsert: TablesInsert<'leaderboards'> = { game_id: 'sumo', key: 'wins', sort: 'desc', mode: boardMode };
  assert.equal(_boardInsert.mode, 'total');

  // M4 social RPCs.
  const _search = client.rpc('search_profiles', { p_query: 'sam' });
  type SearchRow = NonNullable<Awaited<typeof _search>['data']>[number];
  assertType<Equal<keyof SearchRow, 'user_id' | 'username' | 'display_name' | 'avatar_url' | 'friendship'>>();
  const _send = client.rpc('send_friend_request', { p_user_id: '00000000-0000-0000-0000-000000000000' });
  assertType<Equal<NonNullable<Awaited<typeof _send>['data']>, string>>();
  const _games = client.rpc('public_profile_games', { p_user_id: '00000000-0000-0000-0000-000000000000' });
  type GameRow = NonNullable<Awaited<typeof _games>['data']>[number];
  assertType<Equal<GameRow['plays'], number>>();
  assertType<Equal<Tables<'friendships'>['status'], Enums<'friendship_status'>>>();
  const state: FriendshipState = 'incoming';
  const privacy: ProfilePrivacy = { games: 'friends', friends: 'private', presence: 'public', online: false };
  assert.equal(state, 'incoming');
  assert.equal(privacy.games, 'friends');

  // M3 phase 2: presence, live counts, join targets, service-role RPCs.
  const _hb = client.rpc('heartbeat', { p_status: 'in_game', p_game_id: 'sumo', p_room_id: 'r1' });
  assertType<Equal<Awaited<typeof _hb>['data'], Json>>();
  const _fp = client.rpc('friends_presence');
  type FpRow = NonNullable<Awaited<typeof _fp>['data']>[number];
  assertType<Equal<keyof FpRow, 'user_id' | 'status' | 'game_id' | 'game_title' | 'room_id' | 'joinable'>>();
  assertType<Equal<FpRow['joinable'], boolean>>();
  const _counts = client.rpc('game_live_counts');
  type CountRow = NonNullable<Awaited<typeof _counts>['data']>[number];
  assertType<Equal<CountRow, { game_id: string; players: number; rooms: number }>>();
  const _jt = client.rpc('friend_join_target', { p_friend_id: '00000000-0000-0000-0000-000000000000' });
  assertType<Equal<Awaited<typeof _jt>['data'], Json>>();
  const _pp = client.rpc('public_presence', { p_user_id: '00000000-0000-0000-0000-000000000000' });
  assertType<Equal<Awaited<typeof _pp>['data'], Json>>();
  const snapshot: GameRoomSnapshot = { roomId: 'r1', gameId: 'sumo', clients: 2, maxClients: 8, playerIds: [] };
  const _up = client.rpc('server_upsert_game_room', { p_room: snapshot });
  assertType<Equal<Awaited<typeof _up>['data'], undefined | null>>();
  const _touch = client.rpc('server_touch_game_rooms', { p_room_ids: ['r1'] });
  assertType<Equal<NonNullable<Awaited<typeof _touch>['data']>, number>>();
  const _rec = client.rpc('server_record_match', { p_match: { matchId: 'r1:1' } });
  assertType<Equal<Awaited<typeof _rec>['data'], Json>>();
  assertType<Equal<Tables<'game_rooms'>['player_ids'], string[]>>();
  assertType<Equal<Tables<'presence'>['room_id'], string | null>>();
  assertType<Equal<Tables<'user_sanctions'>['expires_at'], string | null>>();
  assertType<Equal<Tables<'match_results'>['winner_id'], string | null>>();
  const hb: HeartbeatResult = { ok: true, ttl_s: 90, interval_s: 45 };
  const pres: PublicPresence = { status: 'in_game', game_id: 'sumo', game_title: 'Sumo' };
  const target: FriendJoinTarget = { game_id: 'sumo', room_id: 'r1', code: null };
  const sanctions: SanctionStatus = { banned_until: 'infinity', muted_until: null };
  const recorded: RecordedMatch = { duplicate: false, players: { u: { wins: 1, losses: 0, boards: {}, unlocked: [] } } };
  assert.equal(hb.interval_s, 45);
  assert.equal(pres?.status, 'in_game');
  assert.equal(target.code, null);
  assert.equal(sanctions.banned_until, 'infinity');
  assert.equal(recorded.duplicate, false);

  // Coins (20261031000400_coins.sql).
  const _buy = client.rpc('buy_item', { p_item_id: 'name-mint' });
  assertType<Equal<Awaited<typeof _buy>['data'], Json>>();
  const _equip = client.rpc('equip_item', { p_kind: 'name_color' });
  assertType<Equal<Awaited<typeof _equip>['data'], Json>>();
  const _wallet = client.rpc('my_wallet');
  assertType<Equal<Awaited<typeof _wallet>['data'], Json>>();
  const _owns = client.rpc('owns_game', { p_user_id: '00000000-0000-0000-0000-000000000000', p_game_id: 'sumo' });
  assertType<Equal<NonNullable<Awaited<typeof _owns>['data']>, boolean>>();
  const _cos = client.rpc('public_cosmetics', { p_user_ids: [] });
  type CosRow = NonNullable<Awaited<typeof _cos>['data']>[number];
  assertType<Equal<keyof CosRow, 'user_id' | 'kind' | 'item_id' | 'name' | 'data'>>();
  const _ledger = client.from('coin_ledger').select('id, amount, reason, note, balance_after, created_at');
  type LedgerRow = NonNullable<Awaited<typeof _ledger>['data']>[number];
  assertType<Equal<LedgerRow['id'], number>>();
  assertType<Equal<LedgerRow['note'], string | null>>();
  assertType<Equal<Tables<'wallets'>['balance'], number>>();
  assertType<Equal<Tables<'achievements'>['coins'], number | null>>();
  const _owned = client.from('user_items').select('item_id, item:shop_items(kind, name)');
  type OwnedRow = NonNullable<Awaited<typeof _owned>['data']>[number];
  assertType<Equal<OwnedRow['item'], { kind: string; name: string }>>();
  const wallet: WalletSummary = { balance: 1, lifetime_earned: 1, daily_claimed: true, solo_today: 5, solo_cap: 50, match_today: 0, match_cap: 500 };
  const bought: BuyItemResult = { status: 'owned', item_id: 'name-mint', balance: 0 };
  const equipped: EquippedItems = { name_color: 'name-mint' };
  const award: CoinAwardEvent = { type: 'coins', id: 1, amount: 25, reason: 'win', balance: 35, game_id: 'sumo', note: 'Sumo', at: '' };
  assert.equal(wallet.solo_cap + bought.balance + award.amount, 75);
  assert.equal(equipped.name_color, 'name-mint');

  // Moderation and account deletion (20261102000100_moderation.sql).
  const reason: ReportReason = 'inappropriate_profile';
  const _report = client.rpc('report_user', { p_user_id: '00000000-0000-0000-0000-000000000000', p_reason: reason });
  assertType<Equal<Awaited<typeof _report>['data'], undefined | null>>();
  const _delete = client.rpc('delete_my_account');
  assertType<Equal<Awaited<typeof _delete>['data'], undefined | null>>();
  assertType<Equal<Tables<'reports'>['reporter_id'], string | null>>();
  assertType<Equal<Tables<'reports'>['target_snapshot'], Json>>();
  assert.ok(REPORT_REASONS.includes(reason));
  assert.equal(REPORT_LIMITS.note, 500);

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
