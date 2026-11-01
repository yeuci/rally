/**
 * Pure parts of "Report a player" (`report_user`, 20261102000100_moderation.sql; docs/moderation.md): the reasons in the
 * order the sheet lists them, the RPC's arguments trimmed to its limits, when Send is enabled, and the copy for errors
 * and the thank-you toast. No React Native imports: test/report.test.ts runs it under plain Node. The RPC call lives in
 * lib/report.ts, the sheet in components/rally/report-sheet.tsx.
 */
import { REPORT_LIMITS, REPORT_REASONS, type ReportReason } from '@rally/db';
import { socialErrorKind } from './social';

export type { ReportReason };

/** The sheet's choices, one per reason the database accepts (a test keeps the two lists equal). */
export const REPORT_REASON_OPTIONS: readonly { value: ReportReason; label: string }[] = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate', label: 'Hate speech' },
  { value: 'cheating', label: 'Cheating' },
  { value: 'inappropriate_profile', label: 'Inappropriate name or photo' },
  { value: 'spam', label: 'Spam or scams' },
  { value: 'other', label: 'Something else' },
];

/** The note field's `maxLength` (the RPC refuses longer notes). */
export const REPORT_NOTE_MAX = REPORT_LIMITS.note;

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);
}

/** What the sheet collected, plus the context it was opened with (a game, a room). */
export interface ReportInput {
  userId: string;
  reason: ReportReason | null;
  note: string;
  gameId?: string | null;
  roomId?: string | null;
}

/** `report_user`'s arguments; optional ones are left out rather than sent as null. */
export interface ReportArgs {
  p_user_id: string;
  p_reason: ReportReason;
  p_note?: string;
  p_game_id?: string;
  p_room_id?: string;
}

/**
 * The RPC's arguments: the note trimmed (left out when blank) and cut to 500 characters, the room id cut to 128 (a
 * longer one would be refused, and it is only context). Null until a reason is chosen.
 */
export function buildReportArgs(input: ReportInput): ReportArgs | null {
  if (!input.userId || !isReportReason(input.reason)) return null;
  const args: ReportArgs = { p_user_id: input.userId, p_reason: input.reason };
  const note = input.note.trim().slice(0, REPORT_NOTE_MAX).trim();
  if (note) args.p_note = note;
  const gameId = input.gameId?.trim();
  if (gameId) args.p_game_id = gameId;
  const roomId = input.roomId?.trim().slice(0, REPORT_LIMITS.roomId);
  if (roomId) args.p_room_id = roomId;
  return args;
}

/** Send is enabled once a reason is picked, and not while a report is on its way. */
export function canSendReport(reason: ReportReason | null, sending: boolean): boolean {
  return !sending && isReportReason(reason);
}

/** The sheet's error line when `report_user` fails. */
export function reportErrorMessage(err: unknown): string {
  switch (socialErrorKind(err)) {
    case 'rate-limited':
      return "You've sent a lot of reports. Try again in a while.";
    case 'anonymous':
      return 'Finish creating your account to report players.';
    case 'unauthenticated':
      return 'Sign in again to report this player.';
    case 'network':
      return "You're offline. Try again when you're back online.";
    default:
      return "Couldn't send the report. Try again.";
  }
}

/** The toast once the report is in (`blocked`: "Also block" was on). */
export function reportThanks(name: string, blocked: boolean): string {
  return blocked ? `Thanks for reporting. ${name} is blocked.` : "Thanks for reporting. We'll take a look.";
}
