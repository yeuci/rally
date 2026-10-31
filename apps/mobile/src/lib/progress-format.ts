/**
 * Pure helpers for leaderboards, achievements and public profiles (no React Native imports, so
 * test/progress-format.test.ts runs them under plain Node).
 */

/** Rows the game page shows before the "Your rank" line. */
export const LEADERBOARD_ROWS = 10;

/** A leaderboard row as the UI uses it (from `leaderboard_top`). */
export interface LeaderboardRow {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  score: number;
  isMe: boolean;
}

/** "12,345", "3.14", "-7": grouped integers, at most two decimals. `locale` is injectable for tests. */
export function formatScore(score: number, locale?: string): string {
  if (!Number.isFinite(score)) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(score);
}

/**
 * The leaderboard header's subtitle for a board's mode (`leaderboards.mode`): "Total" for a cumulative board
 * (Sumo's wins), "Best run" for a best-score board of a multiplayer game (one run's score, Overrun's wave). Solo
 * boards and rows without a mode (an older database) get none.
 */
export function boardModeLabel(mode: string | null | undefined, multiplayer: boolean): string | null {
  if (mode === 'total') return 'Total';
  if (mode === 'best' && multiplayer) return 'Best run';
  return null;
}

/** Board key → tab label: "high-score" → "High score", "best_time" → "Best time". */
export function boardLabel(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.:]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return key;
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Boards in manifest order (the first one is the game's primary board, used for "Best"), boards the manifest does
 * not list after them by key.
 */
export function orderBoards<B extends { key: string }>(
  boards: readonly B[],
  manifestOrder: readonly string[] = [],
): B[] {
  const pos = (k: string) => {
    const i = manifestOrder.indexOf(k);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...boards].sort((a, b) => pos(a.key) - pos(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The top `limit` rows plus "Your rank" when the player is on the board but outside them. `mine` is
 * `my_leaderboard_rank` (null when the player has no score yet).
 */
export function splitLeaderboard(
  rows: readonly LeaderboardRow[],
  mine: { rank: number; score: number } | null,
  limit = LEADERBOARD_ROWS,
): { top: LeaderboardRow[]; yourRank: { rank: number; score: number } | null } {
  const top = rows.slice(0, limit);
  if (!mine || top.some((r) => r.isMe)) return { top, yourRank: null };
  return { top, yourRank: mine };
}

/** `my_leaderboard_rank` jsonb → `{ rank, score }`, or null without a score (or an unexpected shape). */
export function parseMyRank(raw: unknown): { rank: number; score: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { rank?: unknown; score?: unknown };
  const rank = Number(r.rank);
  const score = Number(r.score);
  if (r.rank == null || r.score == null || !Number.isFinite(rank) || rank < 1 || !Number.isFinite(score)) return null;
  return { rank, score };
}

/** `leaderboard_top` rows → UI rows; `resolveAvatar` turns `avatar_url` into an absolute URL. */
export function toLeaderboardRows(
  rows:
    | readonly {
        rank: number | string;
        user_id: string;
        username: string;
        avatar_url: string | null;
        score: number | string;
        is_me: boolean;
      }[]
    | null,
  resolveAvatar: (value: string | null) => string | null,
): LeaderboardRow[] {
  return (rows ?? []).flatMap((r) => {
    const rank = Number(r.rank);
    const score = Number(r.score);
    if (!Number.isFinite(rank) || !Number.isFinite(score)) return [];
    return [
      { rank, userId: r.user_id, username: r.username, avatarUrl: resolveAvatar(r.avatar_url), score, isMe: !!r.is_me },
    ];
  });
}

export interface AchievementTile {
  id: string;
  key: string;
  title: string;
  description: string | null;
  icon: AchievementIcon;
  unlocked: boolean;
  /** Hidden and still locked: title and description stay "???" until unlocked. */
  secret: boolean;
}

export type AchievementIcon = { kind: 'image'; uri: string } | { kind: 'glyph'; text: string } | { kind: 'default' };

/** `achievements.icon`: an http(s) URL is drawn as an image, a short string (an emoji) as text, else the trophy. */
export function achievementIcon(icon: string | null | undefined): AchievementIcon {
  const v = icon?.trim();
  if (!v) return { kind: 'default' };
  if (/^https?:\/\//i.test(v)) return { kind: 'image', uri: v };
  if ([...v].length <= 4) return { kind: 'glyph', text: v };
  return { kind: 'default' };
}

/** One achievement as a tile: hidden + locked shows "???" (and no icon) until it is unlocked. */
export function toAchievementTile(
  a: { id: string; key: string; title: string; description: string | null; icon: string | null; hidden: boolean },
  unlocked: boolean,
): AchievementTile {
  const secret = a.hidden && !unlocked;
  return {
    id: a.id,
    key: a.key,
    title: secret ? '???' : a.title,
    description: secret ? null : a.description,
    icon: secret ? { kind: 'default' } : achievementIcon(a.icon),
    unlocked,
    secret,
  };
}

/** "3 / 5". */
export function achievementCount(tiles: readonly { unlocked: boolean }[]): string {
  return `${tiles.filter((t) => t.unlocked).length} / ${tiles.length}`;
}

export interface PublicStats {
  achievements: number;
  /** null when the owner's privacy (or a block) hides their games from the viewer: show a dash, never 0. */
  gamesPlayed: number | null;
  friends: number;
}

/** `public_profile_stats` jsonb → counts (0 for anything missing; `games_played` null/missing stays null). */
export function parsePublicStats(raw: unknown): PublicStats {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { achievements?: unknown; games_played?: unknown; friends?: unknown };
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  };
  return {
    achievements: n(r.achievements),
    gamesPlayed: r.games_played === null || r.games_played === undefined ? null : n(r.games_played),
    friends: n(r.friends),
  };
}

/** Usernames are citext: compare case-insensitively (the own-profile redirect). */
export function sameUsername(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The top three's medal tint on a leaderboard rank badge (theme tokens `gold` / `silver` / `bronze`); null below. */
export type PodiumTint = 'gold' | 'silver' | 'bronze';

export function podiumTint(rank: number): PodiumTint | null {
  if (!Number.isInteger(rank)) return null;
  return rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
}
