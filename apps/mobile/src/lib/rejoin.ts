import { rejoinSecondsLeft, type RejoinRecord } from '../game-host/rejoin-journal';

/**
 * The rejoin sheet's rules (m3-phase2 §4), shown from `(app)/_layout.tsx` on cold start and when the app becomes
 * active. Pure, unit-tested; the record itself is game-host/rejoin-journal.ts.
 */

/** The sheet is offered only with more than this left (less is not enough to load the game and reconnect). */
export const REJOIN_OFFER_MIN_S = 5;

/** A game is open (the play route or the Developer launcher's): its host owns reconnection, no sheet over it. */
export function isGameScreen(pathname: string): boolean {
  return /\/play\/?$/.test(pathname);
}

/**
 * Whether to offer `rec`: it exists, no game is open, it was not dismissed (Leave clears it; a backdrop tap only
 * hides it, remembered by room id), and more than five seconds remain.
 */
export function shouldOfferRejoin(
  rec: Pick<RejoinRecord, 'roomId' | 'expiresAt'> | null,
  opts: { now: number; gameOpen: boolean; dismissedRoomId?: string | null },
): boolean {
  if (!rec || opts.gameOpen) return false;
  if (opts.dismissedRoomId && opts.dismissedRoomId === rec.roomId) return false;
  return rejoinSecondsLeft(rec, opts.now) > REJOIN_OFFER_MIN_S;
}

/** `42` → `0:42`, `65` → `1:05`. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface RejoinCountdown {
  secondsLeft: number;
  /** "0:42". */
  label: string;
  /** The seat is gone: the sheet closes itself. */
  expired: boolean;
  /** Screen-reader text: "42 seconds left". */
  spoken: string;
}

export function rejoinCountdown(rec: Pick<RejoinRecord, 'expiresAt'>, now: number): RejoinCountdown {
  const secondsLeft = rejoinSecondsLeft(rec, now);
  return {
    secondsLeft,
    label: formatCountdown(secondsLeft),
    expired: secondsLeft <= 0,
    spoken: secondsLeft === 1 ? '1 second left' : `${secondsLeft} seconds left`,
  };
}

/** "Rejoin your Sumo match?" (a game the catalog cannot name yet reads "your match"). */
export function rejoinTitle(gameTitle: string | null | undefined): string {
  const t = gameTitle?.trim();
  return t ? `Rejoin your ${t} match?` : 'Rejoin your match?';
}
