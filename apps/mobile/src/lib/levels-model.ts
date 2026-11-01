/**
 * Pure rules behind account progress (lib/levels.ts, lib/level-toast.ts, the progress ring on ProfileAvatar, the Daily
 * challenges card, the level-up toast and the XP in the coin history): parsing what the database returns, the level
 * ring's numbers, challenge states and the reset countdown, the Realtime `progress` events and the celebrations they
 * trigger. No React Native imports: test/levels.test.ts runs them under plain Node.
 *
 * Levels come from ONE formula, `@rally/db`'s level curve (packages/db/src/progress.ts), which the database mirrors
 * (20261101000100_progress.sql; the db tests compare the two): the app re-derives every level from the total XP it is
 * given, so the ring, the badge and the toasts always agree. Amounts (XP, coins) are decided by the database only.
 */
import {
  levelForXp,
  progressForXp,
  xpForLevel,
  xpToNextLevel,
  type ChallengeKind,
  type LevelProgress,
  type MyProgress,
  type ProgressEvent,
  type XpReason,
} from '@rally/db';

export { levelForXp, progressForXp, xpForLevel, xpToNextLevel };
export type { ChallengeKind, LevelProgress, MyProgress, ProgressEvent, XpReason };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/** A broadcast payload, or `{ payload }` around it. */
const unwrap = (raw: unknown): Record<string, unknown> | null => {
  const outer = obj(raw);
  return obj(outer?.payload) ?? outer;
};

// --- levels --------------------------------------------------------------------------------------------------------

/**
 * Any progress-shaped answer (`my_progress`, `public_progress`, a claim, an event) → the level it means, re-derived
 * from `total_xp` with the shared curve. null when there is no total (hidden profile, malformed).
 */
export function parseLevelProgress(raw: unknown): LevelProgress | null {
  const total = num(unwrap(raw)?.total_xp);
  return total === null ? null : progressForXp(total);
}

/** `my_progress()` → the caller's level and the next level's coins (level 1 with 0 XP when malformed). */
export function parseMyProgress(raw: unknown): MyProgress {
  return {
    ...(parseLevelProgress(raw) ?? progressForXp(0)),
    next_level_coins: Math.max(0, num(obj(raw)?.next_level_coins) ?? 0),
  };
}

/** How full the ring is: XP into the level over the level's size, 0..1. */
export function levelFraction(p: Pick<LevelProgress, 'xp_into_level' | 'xp_for_next'>): number {
  if (!(p.xp_for_next > 0)) return 0;
  return Math.min(1, Math.max(0, p.xp_into_level / p.xp_for_next));
}

/** "1,250 XP". */
export function formatXp(n: number, locale?: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0)} XP`;
}

/** "+30 XP". */
export function xpLabel(n: number, locale?: string): string {
  return `+${formatXp(n, locale)}`;
}

/** XP still needed for the next level. */
export function xpToGo(p: Pick<LevelProgress, 'xp_into_level' | 'xp_for_next'>): number {
  return Math.max(0, p.xp_for_next - p.xp_into_level);
}

/** For screen readers: "Level 3, 35 of 150 XP to level 4". */
export function levelA11y(p: LevelProgress): string {
  return `Level ${p.level}, ${p.xp_into_level} of ${formatXp(p.xp_for_next)} to level ${p.level + 1}`;
}

// --- daily challenges ----------------------------------------------------------------------------------------------

const KINDS: readonly ChallengeKind[] = [
  'play_matches',
  'win_matches',
  'friend_match',
  'play_games',
  'play_game',
  'score',
  'solo_runs',
];
export function isChallengeKind(v: unknown): v is ChallengeKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/** A daily challenge as the card shows it. */
export interface Challenge {
  id: string;
  /** The UTC day, 'YYYY-MM-DD'. */
  day: string;
  slot: number;
  kind: ChallengeKind;
  gameId: string | null;
  title: string;
  target: number;
  progress: number;
  coins: number;
  xp: number;
  completed: boolean;
  claimed: boolean;
  /** End of its day (epoch ms): the reset. */
  resetsAt: number;
  /** Claim deadline (epoch ms): the end of the next day. */
  expiresAt: number;
}

const dayOf = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = str(v);
  return s && /^\d{4}-\d\d-\d\d/.test(s) ? s.slice(0, 10) : null;
};
const timeOf = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/**
 * `my_daily_challenges()` rows → challenges, malformed rows dropped, in the server's order (yesterday's unclaimed
 * ones first, then today's by slot). Progress is clamped to the target.
 */
export function toChallenges(rows: readonly unknown[] | null | undefined): Challenge[] {
  const out: Challenge[] = [];
  for (const raw of rows ?? []) {
    const r = obj(raw);
    const id = str(r?.id);
    const day = dayOf(r?.day);
    const target = num(r?.target);
    const resetsAt = timeOf(r?.resets_at);
    if (!r || !id || !day || target === null || target < 1 || !isChallengeKind(r.kind) || resetsAt === null) continue;
    const progress = Math.min(target, Math.max(0, num(r.progress) ?? 0));
    out.push({
      id,
      day,
      slot: num(r.slot) ?? 0,
      kind: r.kind,
      gameId: str(r.game_id),
      title: str(r.title) ?? 'Challenge',
      target,
      progress,
      coins: Math.max(0, num(r.coins) ?? 0),
      xp: Math.max(0, num(r.xp) ?? 0),
      completed: r.completed_at != null || progress >= target,
      claimed: r.claimed_at != null,
      resetsAt,
      expiresAt: timeOf(r.expires_at) ?? resetsAt + 86_400_000,
    });
  }
  return out;
}

export type ChallengeStatus = 'open' | 'claimable' | 'claimed';

export function challengeStatus(c: Pick<Challenge, 'completed' | 'claimed'>): ChallengeStatus {
  return c.claimed ? 'claimed' : c.completed ? 'claimable' : 'open';
}

/** The bar: progress over target, 0..1. */
export function challengeFraction(c: Pick<Challenge, 'progress' | 'target'>): number {
  return c.target > 0 ? Math.min(1, Math.max(0, c.progress / c.target)) : 0;
}

/** "1/3". */
export function challengeCount(c: Pick<Challenge, 'progress' | 'target'>): string {
  return `${Math.min(c.progress, c.target)}/${c.target}`;
}

/** Left over from yesterday (finished but not claimed before the reset): claimable until `expiresAt`. */
export function isCarriedOver(c: Pick<Challenge, 'resetsAt'>, now: number): boolean {
  return c.resetsAt <= now;
}

/** Today's challenges and the ones carried over, as the card lists them. */
export function visibleChallenges(list: readonly Challenge[], now: number): Challenge[] {
  return list.filter((c) => (isCarriedOver(c, now) ? !c.claimed && c.expiresAt > now : true));
}

/** Completed, not yet claimed (and not expired). */
export function claimableCount(list: readonly Challenge[], now: number): number {
  return visibleChallenges(list, now).filter((c) => challengeStatus(c) === 'claimable').length;
}

/** "2 of 3 done": today's challenges that are completed (claimed or not). */
export function doneSummary(list: readonly Challenge[], now: number): string | undefined {
  const todays = list.filter((c) => !isCarriedOver(c, now));
  if (todays.length === 0) return undefined;
  return `${todays.filter((c) => c.completed).length} of ${todays.length} done`;
}

/** 00:00 UTC after `now` (epoch ms). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** When today's set resets: the server's `resets_at` of today's challenges, else the next 00:00 UTC. */
export function nextResetAt(list: readonly Challenge[], now: number): number {
  const future = list.map((c) => c.resetsAt).filter((t) => t > now);
  return future.length ? Math.min(...future) : nextUtcMidnight(now);
}

/** "5h 12m", "12m", "under a minute" until `at`. */
export function countdown(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, at - now) / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The card's reward line: "+20 coins · +30 XP". */
export function rewardLine(c: Pick<Challenge, 'coins' | 'xp'>): string {
  const parts: string[] = [];
  if (c.coins > 0) parts.push(`+${c.coins} ${c.coins === 1 ? 'coin' : 'coins'}`);
  if (c.xp > 0) parts.push(xpLabel(c.xp));
  return parts.join(' · ');
}

/** For screen readers: "Play 3 matches, 1 of 3, reward 35 coins and 50 XP" (+ ", ready to claim" / ", claimed"). */
export function challengeA11y(c: Challenge): string {
  const status = challengeStatus(c);
  const reward = [c.coins > 0 ? `${c.coins} coins` : null, c.xp > 0 ? `${c.xp} XP` : null]
    .filter(Boolean)
    .join(' and ');
  const state = status === 'claimable' ? ', ready to claim' : status === 'claimed' ? ', claimed' : '';
  return `${c.title}, ${Math.min(c.progress, c.target)} of ${c.target}${reward ? `, reward ${reward}` : ''}${state}`;
}

/** What a claim failure means for the UI. */
export type ClaimErrorKind =
  'claimed' | 'not_complete' | 'expired' | 'not_found' | 'rate_limited' | 'network' | 'other';

export function claimErrorKind(err: unknown): ClaimErrorKind {
  const message = (err as { message?: unknown } | null)?.message;
  const m = typeof message === 'string' ? message : '';
  if (m.startsWith('ALREADY_CLAIMED')) return 'claimed';
  if (m.startsWith('NOT_COMPLETE')) return 'not_complete';
  if (m.startsWith('EXPIRED')) return 'expired';
  if (m.startsWith('NOT_FOUND')) return 'not_found';
  if (m.startsWith('RATE_LIMITED')) return 'rate_limited';
  if (/network|fetch|timed? ?out|offline/i.test(m)) return 'network';
  return 'other';
}

/** Toast copy for a failed claim (null: nothing to say, the card just refreshes). */
export function claimErrorText(kind: ClaimErrorKind): string | null {
  switch (kind) {
    case 'claimed':
      return null;
    case 'not_complete':
      return "That challenge isn't finished yet.";
    case 'expired':
      return 'That challenge has expired.';
    case 'not_found':
      return 'That challenge is gone. Your list has been refreshed.';
    case 'rate_limited':
      return 'Too many claims at once. Try again in a moment.';
    case 'network':
      return "Couldn't reach Rally. Check your connection and try again.";
    default:
      return "Couldn't claim that challenge. Try again.";
  }
}

/** `claim_daily_challenge` → what was paid, the wallet and the progress after it (null fields when missing). */
export function parseClaimResult(raw: unknown): {
  coins: number;
  xp: number;
  balance: number | null;
  progress: LevelProgress | null;
} {
  const o = obj(raw) ?? {};
  return {
    coins: Math.max(0, num(o.coins) ?? 0),
    xp: Math.max(0, num(o.xp) ?? 0),
    balance: num(o.balance),
    progress: parseLevelProgress(o),
  };
}

/** The list after a claim (or a `claimed` event): that challenge marked claimed. */
export function markClaimed(list: readonly Challenge[], id: string): Challenge[] {
  return list.map((c) => (c.id === id ? { ...c, completed: true, claimed: true, progress: c.target } : c));
}

// --- Realtime ------------------------------------------------------------------------------------------------------

const XP_REASONS: readonly XpReason[] = ['match', 'win', 'solo', 'achievement', 'challenge', 'adjustment'];

/** A `progress` broadcast (`{type: 'xp' | 'level' | 'challenge', …}`, or `{ payload }` around it) → event; null if malformed. */
export function parseProgressEvent(raw: unknown): ProgressEvent | null {
  const v = unwrap(raw);
  if (!v) return null;
  const at = str(v.at) ?? new Date(0).toISOString();
  if (v.type === 'xp' || v.type === 'level') {
    const progress = parseLevelProgress(v);
    if (!progress) return null;
    if (v.type === 'level') {
      const from = num(v.from);
      if (from === null || from >= progress.level) return null;
      return { type: 'level', ...progress, from, coins: Math.max(0, num(v.coins) ?? 0), at };
    }
    const id = num(v.id);
    const amount = num(v.amount);
    if (id === null || amount === null || amount <= 0) return null;
    const reason = (XP_REASONS as readonly unknown[]).includes(v.reason) ? (v.reason as XpReason) : 'adjustment';
    return { type: 'xp', ...progress, id, amount, reason, game_id: str(v.game_id), note: str(v.note), at };
  }
  if (v.type === 'challenge') {
    const id = str(v.id);
    const target = num(v.target);
    const progress = num(v.progress);
    if (!id || target === null || progress === null || !isChallengeKind(v.kind)) return null;
    return {
      type: 'challenge',
      id,
      day: str(v.day) ?? '',
      kind: v.kind,
      title: str(v.title) ?? 'Challenge',
      progress,
      target,
      coins: Math.max(0, num(v.coins) ?? 0),
      xp: Math.max(0, num(v.xp) ?? 0),
      completed: v.completed === true,
      claimed: v.claimed === true,
      at,
    };
  }
  return null;
}

/**
 * The cached list after a `challenge` event: that challenge's progress / completion / claim (never backwards, since
 * events can arrive out of order with a refetch). `known: false` when the id is not in the list (refetch it).
 */
export function applyChallengeEvent(
  list: readonly Challenge[],
  e: Extract<ProgressEvent, { type: 'challenge' }>,
): { list: Challenge[]; known: boolean } {
  let known = false;
  const next = list.map((c) => {
    if (c.id !== e.id) return c;
    known = true;
    const progress = Math.min(c.target, Math.max(c.progress, e.progress));
    return {
      ...c,
      progress,
      completed: c.completed || e.completed || progress >= c.target,
      claimed: c.claimed || e.claimed,
    };
  });
  return { list: next, known };
}

/** My cached progress after an `xp` / `level` event: never backwards; `next_level_coins` kept (refetched on a level-up). */
export function applyLevelEvent(
  current: MyProgress | undefined,
  e: Extract<ProgressEvent, { type: 'xp' | 'level' }>,
): MyProgress {
  if (current && current.total_xp >= e.total_xp) return current;
  return { ...progressForXp(e.total_xp), next_level_coins: current?.next_level_coins ?? 0 };
}

// --- celebrations (the level-up and challenge-complete toasts) -----------------------------------------------------

export type Celebration =
  | { key: number; kind: 'level'; level: number; coins: number }
  | { key: number; kind: 'challenge'; id: string; title: string; coins: number; xp: number };

/** How long a celebration stays up. */
export const CELEBRATION_MS = 4200;

/**
 * What an event celebrates, given the challenge as it was cached before it (`before`): a level-up always; a challenge
 * only when this event completes it (not when it was already complete, and never for a claim).
 */
export function celebrationFor(
  e: ProgressEvent,
  before: Pick<Challenge, 'completed'> | undefined,
  key: number,
): Celebration | null {
  if (e.type === 'level') return { key, kind: 'level', level: e.level, coins: e.coins };
  if (e.type === 'challenge' && e.completed && !e.claimed && !before?.completed) {
    return { key, kind: 'challenge', id: e.id, title: e.title, coins: e.coins, xp: e.xp };
  }
  return null;
}

/**
 * Adds a celebration to the queue (the head is on screen). A level-up merges into a level-up already queued (the
 * higher level, the coins added); a challenge already queued is not queued twice. At most `max` wait.
 */
export function queueCelebration(queue: readonly Celebration[], c: Celebration, max = 4): Celebration[] {
  if (c.kind === 'level') {
    const i = queue.findIndex((q) => q.kind === 'level');
    if (i >= 0) {
      const q = queue[i] as Extract<Celebration, { kind: 'level' }>;
      const merged: Celebration = {
        key: c.key,
        kind: 'level',
        level: Math.max(q.level, c.level),
        coins: q.coins + c.coins,
      };
      return queue.map((x, j) => (j === i ? merged : x));
    }
  } else if (queue.some((q) => q.kind === 'challenge' && q.id === c.id)) {
    return [...queue];
  }
  return [...queue, c].slice(0, max);
}

/** The toast's lines: "Level 5" / "+80 coins", "Challenge complete" / "Play 3 matches". */
export function celebrationText(c: Celebration): { title: string; body: string; reward: string } {
  if (c.kind === 'level') {
    return { title: `Level ${c.level}`, body: 'You levelled up', reward: c.coins > 0 ? `+${c.coins} coins` : '' };
  }
  return { title: 'Challenge complete', body: c.title, reward: rewardLine(c) };
}

// --- the coin history's XP column ----------------------------------------------------------------------------------

/**
 * The XP that came with each coin award: an `xp_ledger` row with the same (reason, ref) as a `coin_ledger` row (a
 * match, a win, a solo run, an achievement, a claimed challenge). Map of coin_ledger id → XP.
 */
export function xpByLedgerId(
  coinRows: readonly { id: number; reason: string; ref: string }[],
  xpRows: readonly unknown[] | null | undefined,
): Map<number, number> {
  const xp = new Map<string, number>();
  for (const raw of xpRows ?? []) {
    const r = obj(raw);
    const reason = str(r?.reason);
    const ref = str(r?.ref);
    const amount = num(r?.amount);
    if (reason && ref && amount !== null && amount > 0) xp.set(`${reason}\u0000${ref}`, amount);
  }
  const out = new Map<number, number>();
  for (const c of coinRows) {
    const amount = xp.get(`${c.reason}\u0000${c.ref}`);
    if (amount) out.set(c.id, amount);
  }
  return out;
}
