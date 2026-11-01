import type { ResultMessage, UnlockedAchievement } from '@rally/game-sushi-server';

/** The `result` message after each day (see `ResultMessage`): validation and the one-line text the night shows. */

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

const BOARD_LABEL: Record<string, string> = { days: 'Days', tips: 'Tips' };

/** The night's line, as plain text (the HUD escapes it). */
export function resultLine(result: ResultMessage | 'pending'): { kind: ResultKind; text: string } {
  if (result === 'pending') return { kind: 'pending', text: 'Saving your day…' };
  if (!result.recorded) {
    return result.reason === 'guest'
      ? { kind: 'guest', text: 'Guest: sign in to keep your stats' }
      : { kind: 'unavailable', text: 'Day not saved' };
  }
  const parts: string[] = [];
  for (const key of ['days', 'tips']) {
    const b = result.boards[key];
    if (b) parts.push(`${BOARD_LABEL[key]} #${b.rank}`);
  }
  if (parts.length === 0) parts.push('Day saved');
  for (const a of result.unlocked) parts.push(`${a.icon ?? '🏅'} ${a.title} unlocked`);
  return { kind: 'recorded', text: parts.join(' · ') };
}
