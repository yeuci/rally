import type { Json } from "./types.ts";

export * from "./types.ts";
export * from "./progress.ts";

/**
 * The profile columns clients may select (column-level grant in 20261029000400_m1_review_fixes.sql).
 * `birth_date` and `privacy` are not readable by clients at all, so `select('*')` on profiles fails:
 * pass this (or a subset) to `.select()`.
 */
export const PROFILE_COLUMNS = "id, username, display_name, avatar_url, bio, created_at, updated_at" as const;

/** What `friendship_with` returns, and `search_profiles` puts in `friendship` (20261030000300_m4_social.sql). */
export type FriendshipState = "self" | "friends" | "outgoing" | "incoming" | "blocked" | "none";

/** `my_friend_requests` row direction: `incoming` = they sent it to the caller. */
export type FriendRequestDirection = "incoming" | "outgoing";

/** Values of the checked `profiles.privacy` keys. An absent key means `public`. */
export type PrivacyLevel = "public" | "friends" | "private";

/**
 * Shape of `profiles.privacy` (owner-updatable, never client-readable). `games` gates `public_profile_games`
 * and `public_profile_stats.games_played`; `friends` gates `public_friends`; `presence` (M3 phase 2; absent means
 * `friends`, not `public`) gates `friends_presence`, `public_presence` and `friend_join_target`. Other keys are
 * unchecked.
 */
export type ProfilePrivacy = { games?: PrivacyLevel; friends?: PrivacyLevel; presence?: PrivacyLevel } & {
  [key: string]: Json | undefined;
};

// ---- M3 phase 2 (20261031000000_m3_phase2.sql): presence, game_rooms mirror, match results, sanctions ----------

/** A live presence as reported by `friends_presence` / `public_presence`. Offline users have no row (or `null`). */
export type PresenceStatus = "online" | "in_game";

/** `heartbeat(p_status)`: `offline` deletes the caller's row (sign-out). */
export type HeartbeatStatus = PresenceStatus | "offline";

/** `heartbeat` result. `ok: false` = rate limited (or banned); nothing was written. Send again after `interval_s`. */
export type HeartbeatResult = { ok: boolean; ttl_s: number; interval_s: number };

/** `public_presence(p_user_id)`: `null` when hidden (privacy, block, ban) or offline. Never a room id. */
export type PublicPresence = { status: PresenceStatus; game_id: string | null; game_title: string | null } | null;

/** `friend_join_target(p_friend_id)`: join with `joinById/<room_id>` and `{ code }` (null for public rooms). */
export type FriendJoinTarget = { game_id: string; room_id: string; code: string | null };

/**
 * `server_upsert_game_room(p_room)` (service role): the RallyRoom snapshot. `roomId` and `gameId` are required;
 * `playerIds` lists non-guest seats (non-uuids are dropped, capped at 64).
 */
export type GameRoomSnapshot = {
  roomId: string;
  gameId: string;
  roomName?: string;
  name?: string;
  private?: boolean;
  code?: string | null;
  clients?: number;
  maxClients?: number;
  locked?: boolean;
  phase?: string | null;
  serverVersion?: number;
  playerIds?: string[];
};

/**
 * `server_sanction_status(p_user_id)` (service role): end of the active ban / mute as an ISO timestamp,
 * `"infinity"` for a permanent one, `null` when none.
 */
export type SanctionStatus = { banned_until: string | null; muted_until: string | null };

// ---- Board modes (20261031000300_board_modes.sql) -----------------------------------------------------------------

/**
 * `leaderboards.mode` (synced from game.json `leaderboards[].mode` by tooling/publish-game, default `best`).
 * `best`: one entry per player and period keeping the best score by the board's sort (highest on `desc`, lowest on
 * `asc`); written by `submit_solo_score` and by `server_record_match`'s `leaderboardScores`. `total`: the server's
 * `leaderboardDeltas` (integers 1..10 per match) add up; `submit_solo_score` refuses it.
 */
export type LeaderboardMode = "best" | "total";

/**
 * Upper bound on a `leaderboardScores` value for a `best` board without `max_score_per_minute` (bounded boards:
 * `max_score_per_minute × ceil(durationSec / 60)`, at least 1 minute). Larger scores are ignored.
 */
export const MAX_SERVER_BOARD_SCORE = 1e9;

/** One eligible player in a `server_record_match` result. */
export type RecordedMatchPlayer = {
  /** game_stats totals after this match. */
  wins: number;
  losses: number;
  /** Every board of the game where the player has an entry for the match's period. */
  boards: Record<string, { score: number; rank: number }>;
  /** Achievements newly unlocked by this match. */
  unlocked: { key: string; title: string; icon: string | null }[];
};

/**
 * `server_record_match(p_match)` (service role). `duplicate: true` = this matchId was already recorded (nothing
 * written). `players` holds eligible players only (linked, unbanned accounts); guests and skipped players are absent.
 */
export type RecordedMatch =
  | { duplicate: true }
  | { duplicate: false; players: Record<string, RecordedMatchPlayer> };

// ---- Visits (20261031000100_visits.sql) ---------------------------------------------------------------------------

/**
 * `server_record_visits(p_game_id, p_count)` (service role) accepts 1..this many joins per call (INVALID otherwise).
 * Solo launches are counted by `start_play_session` / `record_play`; `games.visits` is the all-time total and
 * `game_visits_daily` the per-UTC-day count (kept 90 days).
 */
export const MAX_SERVER_VISITS_PER_CALL = 1000 as const;

// ---- Coins (20261031000400_coins.sql; docs/coins.md) --------------------------------------------------------------

/**
 * `coin_ledger.reason`. Earn reasons are positive; `purchase` is negative; `adjustment` (support) either sign.
 * `level` (ref = the level reached) and `challenge` (ref = the daily challenge id) come from 20261101000100_progress.sql;
 * `streak` (ref = the UTC date) from 20261102000400_streaks.sql.
 */
export type CoinReason =
  | "match"
  | "win"
  | "podium"
  | "achievement"
  | "solo"
  | "daily"
  | "purchase"
  | "adjustment"
  | "level"
  | "challenge"
  | "streak";

/** `coin_rules.key`: every amount, cap and threshold of the economy (tune with an UPDATE, no migration). */
export type CoinRuleKey =
  | "match"
  | "win"
  | "podium"
  | "podium_min_players"
  | "match_min_duration_s"
  | "match_daily_cap"
  | "achievement"
  | "solo"
  | "solo_daily_cap"
  | "daily";

/** `shop_items.kind`. `game_unlock` is never equippable (and v1 seeds none). */
export type ShopItemKind = "name_color" | "avatar_frame" | "profile_banner" | "badge" | "game_unlock";

/** The equippable kinds: one slot each per user (`equipped_items`), public through `public_cosmetics`. */
export type CosmeticKind = Exclude<ShopItemKind, "game_unlock">;

/** `shop_items.data` per kind (checked by a trigger; colours are `#RRGGBB`, `light` = the light-theme variant). */
export type NameColorData = { color: string; light?: string };
export type AvatarFrameData = { colors: string[] };
export type ProfileBannerData = { colors: string[] };
export type BadgeData = { icon: string; color: string; light?: string };
export type GameUnlockData = { game_id: string };

/** `my_wallet()`: the balance plus today's (UTC) progress toward the daily caps. */
export type WalletSummary = {
  balance: number;
  lifetime_earned: number;
  daily_claimed: boolean;
  solo_today: number;
  solo_cap: number;
  match_today: number;
  match_cap: number;
};

/** `buy_item(p_item_id)`: `owned` = already owned, nothing charged. Raises `INSUFFICIENT_FUNDS` when short. */
export type BuyItemResult = { status: "purchased" | "owned"; item_id: string; balance: number };

/** `equip_item(p_kind, p_item_id)`: the caller's equipped item per kind after the change. */
export type EquippedItems = Partial<Record<CosmeticKind, string>>;

/**
 * Realtime broadcast on the private topic `user:<uid>`, event `coins`: one per award (never for purchases).
 * `balance` is the wallet after this award; `id` the coin_ledger row (for de-duplication).
 */
export type CoinAwardEvent = {
  type: "coins";
  id: number;
  amount: number;
  reason: Exclude<CoinReason, "purchase">;
  balance: number;
  game_id: string | null;
  note: string | null;
  at: string;
};

// ---- Social discovery (20261101000200_social_discovery.sql) -------------------------------------------------------

/** Days of match history `recently_played_with` looks back over (`match_results.recorded_at`). */
export const RECENTLY_PLAYED_WITH_DAYS = 14 as const;

/**
 * `game_vote_summary(p_game_id)` and `vote_game(p_game_id, p_liked?)`: thumbs up / down on a published game. `my_vote`
 * is the caller's own vote (null: none, or signed out); `can_vote` is true for a linked account that played the game.
 */
export type GameVoteSummary = {
  game_id: string;
  up: number;
  down: number;
  total: number;
  my_vote: boolean | null;
  can_vote: boolean;
};

/** Size limits of a `bug_reports` row (check constraints): longer values are refused, so the app trims first. */
export const BUG_REPORT_LIMITS = { note: 2000, logs: 100000, route: 300, screenshotBytes: 5242880 } as const;

/** Private Storage bucket for bug-report screenshots: objects at `<auth.uid()>/<file>`, owner insert only. */
export const BUG_REPORTS_BUCKET = "bug-reports" as const;

// ---- Moderation and account deletion (20261102000100_moderation.sql; docs/moderation.md) ---------------------------

/** `report_user(p_reason)`: the fixed set (the `reports_reason` check). `inappropriate_profile` = name or photo. */
export const REPORT_REASONS = ["harassment", "hate", "cheating", "inappropriate_profile", "spam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Lengths `report_user` accepts (INVALID beyond them), so the app trims first. */
export const REPORT_LIMITS = { note: 500, roomId: 128 } as const;

/** `reports.status`, set by moderators in Studio (changing it stamps `reviewed_at`). */
export type ReportStatus = "open" | "actioned" | "dismissed";

// ---- Friends activity (20261102000500_activity.sql; docs/activity.md) -------------------------------------------------

/** `activity.kind`: what a friend did (the `activity_kind` check). */
export type ActivityKind = "level_up" | "new_best" | "achievement" | "match_win" | "coop_escape";

/**
 * `activity.payload` per kind, as the triggers write it. `boards` on a new best is how many best boards the game
 * has (one: show the score alone; more: name the board); `players` on a match is every seat, guests included.
 */
export type ActivityPayload =
  | { level: number; from: number }
  | { board: string; score: number; previous?: number; boards: number }
  | { key: string; title?: string }
  | { match_id: string; players: number };

/** Days an `activity` row is kept (the `purge-activity` cron job). */
export const ACTIVITY_RETENTION_DAYS = 30 as const;

/** Most rows one `friends_activity` call returns (`p_limit` is clamped to it). */
export const FRIENDS_ACTIVITY_MAX_LIMIT = 100 as const;
