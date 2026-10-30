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
 * and `public_profile_stats.games_played`; `friends` gates `public_friends`. Other keys are unchecked.
 */
export type ProfilePrivacy = { games?: PrivacyLevel; friends?: PrivacyLevel } & { [key: string]: Json | undefined };
