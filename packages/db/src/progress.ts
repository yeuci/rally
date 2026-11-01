/**
 * Account progress (20261101000100_progress.sql; docs/progress.md): the level curve, and the shapes of the progress
 * RPCs and Realtime events.
 *
 * The curve is the one formula the app uses for levels (ring, badge, toasts). The database has the same curve in
 * `private.xp_to_next_level` / `private.xp_for_level` / `private.level_for_xp`; test/progress.test.ts compares the
 * two over thousands of totals, so a change to one without the other fails the build.
 */

/** XP to go from level 1 to level 2. */
export const LEVEL_XP_BASE = 100;
/** How much more each level needs than the one before it. */
export const LEVEL_XP_STEP = 25;
/** The most XP one level ever needs (from level 17 on). */
export const LEVEL_XP_CAP = 500;
/** The first level whose size is the cap: 1 + (500 − 100) / 25 = 17. */
export const LEVEL_CAP_FROM = 1 + Math.ceil((LEVEL_XP_CAP - LEVEL_XP_BASE) / LEVEL_XP_STEP);

const whole = (n: number, min: number): number => (Number.isFinite(n) ? Math.max(min, Math.floor(n)) : min);

/** XP needed to go from `level` to `level + 1`: 100, 125, 150, … then 500 from level 17. */
export function xpToNextLevel(level: number): number {
  return Math.min(LEVEL_XP_BASE + LEVEL_XP_STEP * (whole(level, 1) - 1), LEVEL_XP_CAP);
}

/** Total XP at which `level` starts: 0 for level 1, 100 for level 2, 225 for level 3, 4,600 for level 17. */
export function xpForLevel(level: number): number {
  const l = whole(level, 1);
  const growing = Math.min(l - 1, LEVEL_CAP_FROM - 1); // levels whose size is still below the cap
  return LEVEL_XP_BASE * growing + (LEVEL_XP_STEP * growing * (growing - 1)) / 2 + LEVEL_XP_CAP * (l - 1 - growing);
}

/** The level a total of `totalXp` gives (1 for 0, negative or not a number). */
export function levelForXp(totalXp: number): number {
  const xp = whole(totalXp, 0);
  const capStart = xpForLevel(LEVEL_CAP_FROM);
  if (xp >= capStart) return LEVEL_CAP_FROM + Math.floor((xp - capStart) / LEVEL_XP_CAP);
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  return level;
}

/** Where a total stands: the level, XP into it, the level's size and the total (what `my_progress` returns). */
export interface LevelProgress {
  level: number;
  /** XP earned since the current level started. */
  xp_into_level: number;
  /** The current level's size: XP from its start to the next level. */
  xp_for_next: number;
  total_xp: number;
}

export function progressForXp(totalXp: number): LevelProgress {
  const xp = whole(totalXp, 0);
  const level = levelForXp(xp);
  return { level, xp_into_level: xp - xpForLevel(level), xp_for_next: xpToNextLevel(level), total_xp: xp };
}

/** `xp_ledger.reason`. Every award is positive; `adjustment` is a support grant. */
export type XpReason = 'match' | 'win' | 'solo' | 'achievement' | 'challenge' | 'adjustment';

/** `progress_rules.key`: XP amounts and caps, and the coins a level-up pays (tune with an UPDATE, no migration). */
export type ProgressRuleKey =
  | 'match'
  | 'win'
  | 'match_daily_cap'
  | 'achievement'
  | 'solo'
  | 'solo_daily_cap'
  | 'level_coins'
  | 'level_coins_step'
  | 'level_coins_max';

/** `my_progress()`: the caller's level plus the coins reaching the next one pays. */
export type MyProgress = LevelProgress & { next_level_coins: number };

/** `public_progress(p_user_id)`: null when the viewer may not see the player's games (privacy, block) or unknown. */
export type PublicProgress = LevelProgress | null;

/** `challenge_templates.kind` / `daily_challenges.kind`: what counts toward a challenge's target. */
export type ChallengeKind =
  'play_matches' | 'win_matches' | 'friend_match' | 'play_games' | 'play_game' | 'score' | 'solo_runs';

/**
 * A `my_daily_challenges()` row: today's three, plus yesterday's completed but unclaimed ones (claimable until
 * `expires_at`). `resets_at` is the end of the challenge's UTC day.
 */
export type DailyChallengeRow = {
  id: string;
  day: string;
  slot: number;
  kind: ChallengeKind;
  game_id: string | null;
  title: string;
  target: number;
  progress: number;
  coins: number;
  xp: number;
  completed_at: string | null;
  claimed_at: string | null;
  resets_at: string;
  expires_at: string;
};

/** `claim_daily_challenge(p_id)`: what was paid, the wallet after it, and the progress after it. */
export type ClaimChallengeResult = LevelProgress & { id: string; coins: number; xp: number; balance: number };

/** Realtime, private topic `user:<uid>`, event `progress`: one per XP award. */
export type XpAwardEvent = LevelProgress & {
  type: 'xp';
  id: number;
  amount: number;
  reason: XpReason;
  game_id: string | null;
  note: string | null;
  at: string;
};

/** Event `progress`: a level-up (`from` → `level`), with the coins it paid. */
export type LevelUpEvent = LevelProgress & { type: 'level'; from: number; coins: number; at: string };

/** Event `progress`: a daily challenge's progress, completion or claim. */
export type ChallengeProgressEvent = {
  type: 'challenge';
  id: string;
  day: string;
  kind: ChallengeKind;
  title: string;
  progress: number;
  target: number;
  coins: number;
  xp: number;
  completed: boolean;
  claimed: boolean;
  at: string;
};

export type ProgressEvent = XpAwardEvent | LevelUpEvent | ChallengeProgressEvent;
