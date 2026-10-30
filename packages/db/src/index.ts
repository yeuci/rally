export * from "./types.ts";

/**
 * The profile columns clients may select (column-level grant in 20261029000400_m1_review_fixes.sql).
 * `birth_date` and `privacy` are not readable by clients at all, so `select('*')` on profiles fails:
 * pass this (or a subset) to `.select()`.
 */
export const PROFILE_COLUMNS = "id, username, display_name, avatar_url, bio, created_at, updated_at" as const;
