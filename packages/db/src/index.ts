import type { Json } from "./types.ts";

export * from "./types.ts";

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
