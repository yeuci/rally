/**
 * Pure parts of in-app account deletion (`delete_my_account`, 20261102000100_moderation.sql; docs/moderation.md): the
 * typed-username check that enables the button, which Storage objects are the user's own photos, and the copy for each
 * way it can fail. No React Native imports: test/delete-account.test.ts runs it under plain Node. The flow lives in
 * lib/delete-account.ts, the sheet in components/rally/delete-account-sheet.tsx.
 */
import { socialErrorKind } from './social';

/**
 * The confirmation field matches the account's username: trimmed, an "@" in front allowed, any case (usernames are
 * case-insensitive in the database). Never true for an unknown username.
 */
export function confirmsUsername(typed: string, username: string | null | undefined): boolean {
  if (!username) return false;
  return typed.trim().replace(/^@/, '').toLowerCase() === username.toLowerCase();
}

/** What the sheet lists as deleted, in that order. */
export const DELETED_DATA: readonly string[] = [
  'Your profile, username and photos',
  'Friends, friend requests and blocks',
  'Coins, items, levels and daily challenges',
  'Saves, scores, achievements and play history',
];

/** One entry of a Storage `list()`: folders have no id. */
export interface StorageEntry {
  name: string;
  id: string | null;
}

/** A page of `list(prefix)`, split into object paths (to remove) and folder paths (to list in turn). */
export function splitListing(prefix: string, entries: readonly StorageEntry[]): { files: string[]; folders: string[] } {
  const base = prefix.replace(/\/+$/, '');
  const files: string[] = [];
  const folders: string[] = [];
  for (const e of entries) {
    if (!e.name) continue;
    (e.id ? files : folders).push(`${base}/${e.name}`);
  }
  return { files, folders };
}

/**
 * Only paths inside the user's own folder of the avatars bucket (`<userId>/…`), never the shared `defaults/`, another
 * folder, or a path that climbs out with `..`. The bucket's policies refuse anything else anyway; this keeps a
 * mistake from even asking.
 */
export function ownAvatarPaths(userId: string, paths: readonly string[]): string[] {
  if (!userId) return [];
  return [...new Set(paths)].filter(
    (p) => p.startsWith(`${userId}/`) && p.length > userId.length + 1 && !p.split('/').includes('..'),
  );
}

/** `items` in runs of at most `size` (Storage removes a bounded number of paths per call). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** Which step failed: removing the photos (the account is untouched then) or deleting the account itself. */
export type DeleteAccountStep = 'photos' | 'account';

/** An error raised by a step, tagged with it so the sheet can say what happened. */
export class DeleteAccountError extends Error {
  readonly step: DeleteAccountStep;
  /** What the step threw (a StorageError, a PostgREST error, a network failure). */
  readonly original: unknown;
  constructor(step: DeleteAccountStep, original: unknown) {
    const m = (original as { message?: unknown } | null)?.message;
    super(typeof m === 'string' ? m : String(original));
    this.name = 'DeleteAccountError';
    this.step = step;
    this.original = original;
  }
}

/**
 * The sheet's error line. Retrying is always safe (the photos step skips what is already gone, and the RPC succeeds
 * when the account already is), so every message ends in "try again".
 */
export function deleteAccountErrorMessage(err: unknown): string {
  const step: DeleteAccountStep = err instanceof DeleteAccountError ? err.step : 'account';
  const kind = socialErrorKind(err instanceof DeleteAccountError ? err.original : err);
  if (kind === 'network') return "You're offline. Check your connection and try again.";
  if (kind === 'unauthenticated') return 'Your session has expired. Sign in again, then delete your account.';
  return step === 'photos'
    ? "Couldn't remove your photos, so your account wasn't deleted. Try again."
    : "Couldn't delete your account. Try again.";
}
