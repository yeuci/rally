import type { ResultMessage, UnlockedAchievement } from '@rally/game-northdale-server';

/**
 * The `result` message (see `ResultMessage` in @rally/game-northdale-server) on the run-over screen: validation, the
 * one-line text, and which match a message belongs to.
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
  if (raw.recorded !== true) return null;
  const boards: Record<string, { score: number; rank: number }> = {};
  if (isObj(raw.boards)) {
    for (const [key, b] of Object.entries(raw.boards)) {
      if (isObj(b) && isCount(b.score) && isCount(b.rank) && b.rank >= 1) {
        boards[key] = { score: b.score, rank: Math.floor(b.rank) };
      }
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
  return { matchId, recorded: true, boards, unlocked };
}

export type ResultKind = 'recorded' | 'guest' | 'unavailable' | 'pending';

const BOARD_LABEL: Record<string, string> = { nights: 'Nights', kills: 'Kills', escapes: 'Escapes' };

/** The match-over line, as plain text (the HUD escapes it). */
export function resultLine(result: ResultMessage | 'pending'): { kind: ResultKind; text: string } {
  if (result === 'pending') return { kind: 'pending', text: 'Saving your result…' };
  if (!result.recorded) {
    return result.reason === 'guest'
      ? { kind: 'guest', text: 'Guest: sign in to keep your stats' }
      : { kind: 'unavailable', text: 'Result not saved' };
  }
  const parts: string[] = [];
  for (const key of ['nights', 'kills', 'escapes']) {
    const b = result.boards[key];
    if (b) parts.push(`${BOARD_LABEL[key]} #${b.rank}`);
  }
  if (parts.length === 0) parts.push('Run saved');
  for (const a of result.unlocked) parts.push(`${a.icon ?? '🏅'} ${a.title} unlocked`);
  return { kind: 'recorded', text: parts.join(' · ') };
}

/** How much earlier than the run-over screen (as this client sees it) its result may arrive. */
const EARLY_MS = 2000;

/**
 * Which `result` belongs on screen. Feed it every message and every frame's phase; `current()` is this run's result
 * during `over`, `'pending'` while it has not arrived, or null outside the result screen. A result that answered too late
 * (after the next run started) is never shown.
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

  observe(phase: string, now: number): void {
    const ending = phase === 'over';
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
