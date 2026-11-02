/**
 * Pure rules behind the friends activity feed (lib/activity.ts, the ActivityFeed cards on the dashboard and the
 * /activity screen): parsing `friends_activity` rows, grouping the rows that belong together into one card (everyone
 * who escaped a Northdale run, the boards one run improved), the card copy per kind ("sloth and 2 others escaped
 * Northdale"), the dashboard's window and the page cursor. No React Native imports: test/activity.test.ts runs them
 * under plain Node. What counts as activity is decided by the database (20261102000500_activity.sql, docs/activity.md);
 * nothing here invents an event.
 */
import type { ActivityKind } from '@rally/db';
import { timeAgo } from './format';
import { formatScore } from './progress-format';

export type { ActivityKind };

/** Rows per `friends_activity` page. */
export const ACTIVITY_PAGE = 30;
/** Cards the dashboard shows ("See all" opens the rest). */
export const ACTIVITY_DASHBOARD_CARDS = 6;
/** The dashboard shows only the last few days; the screen everything the database kept (30 days). */
export const ACTIVITY_DASHBOARD_DAYS = 7;

const KINDS: readonly ActivityKind[] = ['level_up', 'new_best', 'achievement', 'match_win', 'coop_escape'];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export interface ActivityActor {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ActivityGame {
  id: string;
  title: string;
  iconUrl: string | null;
}

/** One `activity` row as `friends_activity` returns it. */
export interface ActivityItem {
  id: number;
  actor: ActivityActor;
  kind: ActivityKind;
  /** Null for a level-up. */
  game: ActivityGame | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** `friends_activity` rows → items, newest first as given; malformed rows are dropped. */
export function toActivityItems(rows: readonly unknown[] | null | undefined): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const raw of rows ?? []) {
    const r = obj(raw);
    if (!r) continue;
    const id = num(r.id);
    const userId = str(r.actor_id);
    const username = str(r.username);
    const kind = str(r.kind);
    const createdAt = str(r.created_at);
    if (id === null || !userId || !username || !createdAt || !(KINDS as readonly string[]).includes(kind ?? ''))
      continue;
    const gameId = str(r.game_id);
    out.push({
      id,
      actor: { userId, username, displayName: str(r.display_name), avatarUrl: str(r.avatar_url) },
      kind: kind as ActivityKind,
      game: gameId ? { id: gameId, title: str(r.game_title) ?? gameId, iconUrl: str(r.game_icon_url) } : null,
      payload: obj(r.payload) ?? {},
      createdAt,
    });
  }
  return out;
}

/** Where the next page starts: the last row's time and id, or nothing after a short page. */
export interface ActivityCursor {
  before: string;
  beforeId: number;
}

export function nextActivityCursor(page: readonly ActivityItem[]): ActivityCursor | undefined {
  const last = page.at(-1);
  return page.length >= ACTIVITY_PAGE && last ? { before: last.createdAt, beforeId: last.id } : undefined;
}

// --- cards ---------------------------------------------------------------------------------------------------------

/**
 * What one card on the feed says. Usually one row; a co-op escape that several friends were in is one card with
 * every friend in `actors` (`others` counts the seats taken by guests and strangers), and one run that improved
 * several boards of a game is one card with every board in `bests`.
 */
export interface ActivityCard {
  key: string;
  kind: ActivityKind;
  /** Never empty; the first actor is the card's face (avatar, profile on tap). */
  actors: ActivityActor[];
  /** Co-op: players in the run who are not in `actors`. */
  others: number;
  game: ActivityGame | null;
  /** The newest row's time. */
  createdAt: string;
  /** level_up */
  level: number | null;
  /** achievement */
  achievement: { key: string; title: string | null } | null;
  /** new_best, in the order written. */
  bests: { board: string; score: number }[];
  /** The game has more than one best board, so a best names its board ("wave 12"). */
  namedBoards: boolean;
}

function cardKey(item: ActivityItem): string {
  const matchId = str(item.payload.match_id);
  if (item.kind === 'coop_escape' && matchId) return `coop_escape:${item.game?.id ?? ''}:${matchId}`;
  if (item.kind === 'new_best' && item.game) return `new_best:${item.actor.userId}:${item.game.id}:${item.createdAt}`;
  return `${item.kind}:${item.id}`;
}

/** Items (newest first) → cards in the same order, rows that belong together merged into one. */
export function groupActivity(items: readonly ActivityItem[]): ActivityCard[] {
  const cards = new Map<string, ActivityCard>();
  for (const item of items) {
    const key = cardKey(item);
    const existing = cards.get(key);
    if (existing) {
      if (item.kind === 'coop_escape' && !existing.actors.some((a) => a.userId === item.actor.userId)) {
        existing.actors.push(item.actor);
        existing.others = Math.max(0, (num(item.payload.players) ?? 0) - existing.actors.length);
      } else if (item.kind === 'new_best') {
        const best = bestOf(item);
        if (best) existing.bests.push(best);
      }
      continue;
    }
    const best = item.kind === 'new_best' ? bestOf(item) : null;
    cards.set(key, {
      key,
      kind: item.kind,
      actors: [item.actor],
      others: item.kind === 'coop_escape' ? Math.max(0, (num(item.payload.players) ?? 0) - 1) : 0,
      game: item.game,
      createdAt: item.createdAt,
      level: item.kind === 'level_up' ? num(item.payload.level) : null,
      achievement:
        item.kind === 'achievement' ? { key: str(item.payload.key) ?? '', title: str(item.payload.title) } : null,
      bests: best ? [best] : [],
      namedBoards: item.kind === 'new_best' && (num(item.payload.boards) ?? 1) > 1,
    });
  }
  return [...cards.values()];
}

function bestOf(item: ActivityItem): { board: string; score: number } | null {
  const board = str(item.payload.board);
  const score = num(item.payload.score);
  return board && score !== null ? { board, score } : null;
}

/** Cards from the last `days` days (the dashboard's window). */
export function recentCards(cards: readonly ActivityCard[], days: number, now: number = Date.now()): ActivityCard[] {
  const since = now - days * 86_400_000;
  return cards.filter((c) => {
    const t = Date.parse(c.createdAt);
    return !Number.isNaN(t) && t >= since;
  });
}

// --- copy ----------------------------------------------------------------------------------------------------------

/** How a player is named on a card. */
export function actorName(actor: Pick<ActivityActor, 'username' | 'displayName'>): string {
  return actor.displayName || actor.username;
}

/** "a", "a and b", "a, b and c". */
function listNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The card's subject: "sloth", "ann and ben", "sloth and 2 others", "ann, ben and 1 other". */
export function cardSubject(card: Pick<ActivityCard, 'actors' | 'others'>): string {
  const names = card.actors.map(actorName);
  if (card.others > 0) names.push(`${card.others} ${card.others === 1 ? 'other' : 'others'}`);
  return listNames(names);
}

/** "daily_height" → "daily height". */
function boardLabel(key: string): string {
  return key.replace(/[-_]+/g, ' ');
}

/** The card's verb phrase: "reached level 5", "set a new best in Stack: 216", "escaped Northdale". */
export function cardAction(card: ActivityCard, locale?: string): string {
  const game = card.game?.title ?? 'a game';
  switch (card.kind) {
    case 'level_up':
      return card.level !== null ? `reached level ${card.level}` : 'reached a new level';
    case 'new_best': {
      if (card.bests.length === 0) return `set a new best in ${game}`;
      const scores = card.bests
        .map((b) =>
          card.namedBoards ? `${boardLabel(b.board)} ${formatScore(b.score, locale)}` : formatScore(b.score, locale),
        )
        .join(' · ');
      return `set ${card.bests.length > 1 ? 'new bests' : 'a new best'} in ${game}: ${scores}`;
    }
    case 'achievement': {
      const title = card.achievement?.title || card.achievement?.key;
      return title ? `unlocked ${title} in ${game}` : `unlocked an achievement in ${game}`;
    }
    case 'match_win':
      return `won a match of ${game}`;
    case 'coop_escape':
      return `escaped ${game}`;
  }
}

/** The whole sentence: "sloth and 2 others escaped Northdale". */
export function cardSentence(card: ActivityCard, locale?: string): string {
  return `${cardSubject(card)} ${cardAction(card, locale)}`;
}

/** For screen readers: the sentence, the game when the sentence does not name it, and when. */
export function cardA11y(card: ActivityCard, now: number = Date.now()): string {
  const when = timeAgo(card.createdAt, now);
  return when ? `${cardSentence(card)}, ${when}` : cardSentence(card);
}
