/**
 * Thumbs up / down on games (`game_vote_summary`, `vote_game`; 20261101000200_social_discovery.sql): the summary
 * parser, the game page's "94% liked" line and the rules of the "Did you enjoy Sumo?" prompt shown after a match.
 * Pure: test/votes.test.ts runs it under plain Node. Data access lives in lib/votes.ts, the sheet in
 * components/rally/vote-prompt.tsx.
 */
import { formatCount } from './format';

export interface VoteSummary {
  gameId: string;
  up: number;
  down: number;
  total: number;
  /** The caller's own vote: true = thumbs up, false = thumbs down, null = none. */
  myVote: boolean | null;
  /** A linked account that played the game (only they may vote). */
  canVote: boolean;
}

const count = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** `game_vote_summary` / `vote_game` jsonb → summary; null for anything that is not an object. */
export function parseVoteSummary(raw: unknown, gameId?: string): VoteSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const up = count(r.up);
  const down = count(r.down);
  return {
    gameId: typeof r.game_id === 'string' ? r.game_id : (gameId ?? ''),
    up,
    down,
    total: Math.max(count(r.total), up + down),
    myVote: r.my_vote === true ? true : r.my_vote === false ? false : null,
    canVote: r.can_vote === true,
  };
}

/** The summary right after the caller votes `liked` (null = takes the vote back): the optimistic update. */
export function applyVote(s: VoteSummary, liked: boolean | null): VoteSummary {
  let { up, down } = s;
  if (s.myVote === true) up = Math.max(0, up - 1);
  if (s.myVote === false) down = Math.max(0, down - 1);
  if (liked === true) up += 1;
  if (liked === false) down += 1;
  return { ...s, up, down, total: up + down, myVote: liked };
}

/** Below this many votes the percentage is hidden ("New" reads better than "100% liked" from one vote). */
export const VOTES_MIN_FOR_PERCENT = 5;

/** Share of thumbs up, 0–100 (rounded down, so 99.6 % never reads 100 %), or null under `VOTES_MIN_FOR_PERCENT`. */
export function likedPercent(
  s: Pick<VoteSummary, 'up' | 'total'> | null | undefined,
  min = VOTES_MIN_FOR_PERCENT,
): number | null {
  if (!s || s.total < Math.max(1, min)) return null;
  return Math.floor((Math.min(s.up, s.total) / s.total) * 100);
}

/** "94% liked" (null under the minimum). */
export function likedLabel(
  s: Pick<VoteSummary, 'up' | 'total'> | null | undefined,
  min = VOTES_MIN_FOR_PERCENT,
): string | null {
  const pct = likedPercent(s, min);
  return pct === null ? null : `${pct}% liked`;
}

/** "1 vote", "128 votes", "1.2K votes". */
export function votesCountLabel(total: number): string {
  const n = count(total);
  return `${formatCount(n)} ${n === 1 ? 'vote' : 'votes'}`;
}

// --- the post-match prompt -------------------------------------------------------------------------------------------

/** "Not now" (or closing the sheet) keeps it away from that game for this long. */
export const VOTE_PROMPT_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
/** Asked this many times without an answer, the game is never asked about again. */
export const VOTE_PROMPT_MAX_ASKS = 3;
/** The play route closes with a native animation first: the sheet waits this long after the game screen is gone. */
export const VOTE_PROMPT_DELAY_MS = 900;

/**
 * The AsyncStorage key of an account's prompt memory is this prefix plus the user id (lib/votes.ts). Exported so the
 * Developer page can forget every account's memory on the device.
 */
export const VOTE_PROMPT_KEY_PREFIX = 'rally.vote-prompt.';

/** What the device remembers per game (AsyncStorage, per account). */
export interface VotePromptEntry {
  asks: number;
  lastAskedAt: number | null;
  snoozedUntil: number | null;
  /** Voted (here or on the game page): never asked again. */
  voted: boolean;
}

export type VotePromptState = Record<string, VotePromptEntry>;

const EMPTY: VotePromptEntry = { asks: 0, lastAskedAt: null, snoozedUntil: null, voted: false };

const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Stored JSON → state; anything malformed is dropped (worst case: a game is asked about once more). */
export function parseVotePromptState(raw: string | null | undefined): VotePromptState {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: VotePromptState = {};
  for (const [gameId, e] of Object.entries(value as Record<string, unknown>)) {
    if (!gameId || !e || typeof e !== 'object' || Array.isArray(e)) continue;
    const entry = e as Record<string, unknown>;
    out[gameId] = {
      asks: count(entry.asks),
      lastAskedAt: time(entry.lastAskedAt),
      snoozedUntil: time(entry.snoozedUntil),
      voted: entry.voted === true,
    };
  }
  return out;
}

export interface VotePromptInput {
  /** The device's memory of this game (absent: never asked). */
  entry: VotePromptEntry | undefined;
  now: number;
  /** The play screen's finish result: the game became ready, so a match (or a run) happened. */
  played: boolean;
  /** An anonymous (not yet linked) session: guests cannot vote. */
  guest: boolean;
  /** The server's answer for this game; null while unknown. Never asked without it. */
  summary: Pick<VoteSummary, 'myVote' | 'canVote'> | null;
}

/**
 * Whether to show "Did you enjoy <Game>?" now: only after a match that happened, for a linked account the server lets
 * vote (it played the game) and that has not voted; never again once voted (here or anywhere), not while snoozed
 * ("Not now" / closed: `VOTE_PROMPT_SNOOZE_MS`), and not after `VOTE_PROMPT_MAX_ASKS` unanswered asks.
 */
export function shouldOfferVotePrompt({ entry = EMPTY, now, played, guest, summary }: VotePromptInput): boolean {
  if (!played || guest || !summary) return false;
  if (entry.voted || summary.myVote !== null || !summary.canVote) return false;
  if (entry.asks >= VOTE_PROMPT_MAX_ASKS) return false;
  if (entry.snoozedUntil !== null && now < entry.snoozedUntil) return false;
  return true;
}

function update(
  state: VotePromptState,
  gameId: string,
  patch: (e: VotePromptEntry) => Partial<VotePromptEntry>,
): VotePromptState {
  const entry = state[gameId] ?? EMPTY;
  return { ...state, [gameId]: { ...entry, ...patch(entry) } };
}

/**
 * The sheet was shown. It counts as an ask and snoozes the game right away, so a second match before the user answers
 * (or an app kill with the sheet up) never brings it back the same day.
 */
export function afterAsk(state: VotePromptState, gameId: string, now: number): VotePromptState {
  return update(state, gameId, (e) => ({
    asks: e.asks + 1,
    lastAskedAt: now,
    snoozedUntil: now + VOTE_PROMPT_SNOOZE_MS,
  }));
}

/** "Not now" or the sheet closed without an answer: away for `VOTE_PROMPT_SNOOZE_MS` from now. */
export function afterNotNow(state: VotePromptState, gameId: string, now: number): VotePromptState {
  return update(state, gameId, () => ({ snoozedUntil: now + VOTE_PROMPT_SNOOZE_MS }));
}

/** Voted (or the server says so): never asked again. */
export function afterVote(state: VotePromptState, gameId: string): VotePromptState {
  return update(state, gameId, () => ({ voted: true }));
}

/** "Did you enjoy Sumo?" ("this game" when the title is unknown). */
export function voteQuestion(title: string | null | undefined): string {
  const t = title?.trim();
  return `Did you enjoy ${t || 'this game'}?`;
}
