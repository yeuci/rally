/**
 * Pure decisions for the anonymous user behind an Apple/Google signup (see providers.ts). Unit-tested in
 * test/auth.test.ts.
 *
 * The anonymous user owns a profile holding the chosen username from the moment it is created. Whenever the app
 * gives up on one (cancel, provider error, "already has an account", a different username or date of birth,
 * any other sign-in or sign-out) it first calls `release_username()` (renames that profile to a generated
 * `user_…` name, freeing the chosen one) and then signs the anonymous session out locally.
 */
export type SignupMetadata = { username: string; birth_date: string };

export interface AnonymousUserLike {
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * - `create`: no anonymous session in hand; create one with the metadata.
 * - `reuse`: a retry with the same username and date of birth; keep the session (and the profile holding the name).
 * - `replace`: an anonymous session for other details; release its username, sign it out, create a new one.
 */
export type AnonymousUserPlan = 'create' | 'reuse' | 'replace';

export function planAnonymousUser(user: AnonymousUserLike | null | undefined, meta: SignupMetadata): AnonymousUserPlan {
  if (!user?.is_anonymous) return 'create';
  const m = user.user_metadata ?? {};
  return m.username === meta.username && m.birth_date === meta.birth_date ? 'reuse' : 'replace';
}

export type AbandonReason =
  /** The Apple sheet or Google browser was dismissed. */
  | 'cancelled'
  /** The provider or the link step failed for another reason. */
  | 'provider-error'
  /** The identity's email belongs to an existing (email + password) account. */
  | 'email-exists'
  /** The identity already has a Rally account: sign into that one instead. */
  | 'identity-linked'
  /** A new anonymous user (different username / date of birth) or an email signup replaces it. */
  | 'replaced'
  /** Another sign-in or a sign-out replaces it. */
  | 'sign-in'
  | 'sign-out';

/**
 * When `release_username()` fails (offline, say), signing out would strand the name on an unreachable user.
 * After a cancel or a provider error nothing else needs the session, so it is kept: a retry with the same
 * name reuses it (`username_available` ignores the caller's own profile), and anything else releases it later.
 * Every other reason replaces the session anyway, so it is signed out regardless.
 */
export function keepSessionWhenReleaseFails(reason: AbandonReason): boolean {
  return reason === 'cancelled' || reason === 'provider-error';
}

/**
 * Whether an access token still says `is_anonymous: true`. After `linkIdentity` the user object is already
 * permanent but the token can carry the old claim until it is refreshed, and RLS / `save_put` / `record_play`
 * read the claim (ANONYMOUS_FORBIDDEN). The session gate checks both. Unreadable tokens count as not anonymous;
 * the user object decides then.
 */
export function accessTokenIsAnonymous(accessToken: string | null | undefined): boolean {
  const payload = accessToken?.split('.')[1];
  if (!payload || typeof atob !== 'function') return false;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const claims = JSON.parse(atob(b64)) as { is_anonymous?: unknown };
    return claims.is_anonymous === true;
  } catch {
    return false;
  }
}
