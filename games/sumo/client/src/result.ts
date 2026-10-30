import type { Phase, ResultMessage, UnlockedAchievement } from '@rally/game-sumo-server';

/**
 * The `result` message (server v2+, see `ResultMessage` in @rally/game-sumo-server) on the match-over screen:
 * validation, the one-line text, and which match a message belongs to.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A well-formed `ResultMessage`, or null (a server message is still input: never trust its shape). */
export function parseResultMessage(raw: unknown): ResultMessage | null {
  if (!isObj(raw) || typeof raw.matchId !== 'string') return null;
  const matchId = raw.matchId;
  if (raw.recorded === false) {
    return raw.reason === 'guest' || raw.reason === 'unavailable'
      ? { matchId, recorded: false, reason: raw.reason }
      : null;
  }
  if (raw.recorded !== true || !isCount(raw.wins) || !isCount(raw.losses)) return null;
  const rank = isCount(raw.rank) && raw.rank >= 1 ? Math.floor(raw.rank) : null;
  const boards: Record<string, { score: number; rank: number }> = {};
  if (isObj(raw.boards)) {
    for (const [key, b] of Object.entries(raw.boards)) {
      if (isObj(b) && typeof b.score === 'number' && isCount(b.rank)) boards[key] = { score: b.score, rank: b.rank };
    }
  }
  const unlocked: UnlockedAchievement[] = [];
  if (Array.isArray(raw.unlocked)) {
    for (const a of raw.unlocked) {
      if (isObj(a) && typeof a.key === 'string' && typeof a.title === 'string') {
        unlocked.push({ key: a.key, title: a.title, icon: typeof a.icon === 'string' && a.icon ? a.icon : null });
      }
    }
  }
  return { matchId, recorded: true, wins: raw.wins, losses: raw.losses, rank, boards, unlocked };
}

export type ResultKind = 'recorded' | 'guest' | 'unavailable' | 'pending';

/** The match-over line, as plain text (the HUD escapes it). */
export function resultLine(result: ResultMessage | 'pending'): { kind: ResultKind; text: string } {
  if (result === 'pending') return { kind: 'pending', text: 'Saving your result…' };
  if (!result.recorded) {
    return result.reason === 'guest'
      ? { kind: 'guest', text: 'Guest: sign in to keep your wins' }
      : { kind: 'unavailable', text: 'Result not saved' };
  }
  const parts = [`Wins ${result.wins}`];
  if (result.rank !== null) parts.push(`Rank #${result.rank}`);
  for (const a of result.unlocked) parts.push(`${a.icon ?? '🏅'} ${a.title} unlocked`);
  return { kind: 'recorded', text: parts.join(' · ') };
}

/**
 * How much earlier than the decided match (as this client sees it) its result may arrive: the message goes out with
 * the deciding round, and state patches (20 Hz) can trail it.
 */
const EARLY_MS = 2000;

/**
 * Which `result` belongs on screen. Feed it every message and every frame's phase; `current()` is the result of the
 * match being shown (`matchWinner` set, in `roundOver` / `matchOver`), `'pending'` while it has not arrived, or null
 * outside a match end. The stored result is dropped when the room resets, so a write that answered too late (after
 * retries) is never shown on a later match.
 */
export class MatchResultView {
  private result: ResultMessage | null = null;
  private receivedAt = -Infinity;
  private endSeenAt = -Infinity;
  private ending = false;

  receive(result: ResultMessage, now: number): void {
    this.result = result;
    this.receivedAt = now;
  }

  observe(phase: Phase, matchWinner: string, now: number): void {
    const ending = matchWinner !== '' && (phase === 'roundOver' || phase === 'matchOver');
    if (ending && !this.ending) this.endSeenAt = now;
    if (!ending && this.ending) this.result = null;
    this.ending = ending;
  }

  current(): ResultMessage | 'pending' | null {
    if (!this.ending) return null;
    if (this.result && this.receivedAt >= this.endSeenAt - EARLY_MS) return this.result;
    return 'pending';
  }
}
