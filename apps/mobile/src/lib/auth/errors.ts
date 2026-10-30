/**
 * Maps Supabase Auth / PostgREST errors to user-facing copy. Pure, unit-tested in test/auth.test.ts.
 *
 * GoTrue hides the message of an exception raised by the `on_auth_user_created` trigger and answers
 * 500 "Database error saving new user" instead, so the trigger's AGE_GATE / USERNAME_FILTERED codes are matched
 * when present but the generic message is the common case; callers re-check what they can (username
 * availability) to explain it.
 */
interface ErrorLike {
  message?: unknown;
  code?: unknown;
  status?: unknown;
}

function parts(err: unknown): { message: string; code: string } {
  if (typeof err === 'string') return { message: err, code: '' };
  const e = (err ?? {}) as ErrorLike;
  return { message: typeof e.message === 'string' ? e.message : '', code: typeof e.code === 'string' ? e.code : '' };
}

/** The new-user trigger aborted the insert: for OAuth this means "no Rally account for this identity yet". */
export function isNewUserRejected(err: unknown): boolean {
  const { message } = parts(err);
  return /database error (saving|creating) new user/i.test(message) || /AGE_GATE|USERNAME_FILTERED/.test(message);
}

export function isAgeGateError(err: unknown): boolean {
  return /AGE_GATE/.test(parts(err).message);
}

/** Unique violation on profiles.username (PostgREST / an RPC passes it on; GoTrue hides it, see isNewUserRejected). */
export function isUsernameTaken(err: unknown): boolean {
  const { message, code } = parts(err);
  return code === '23505' && /username/i.test(message);
}

/** `save_put` / `record_play` / anonymous RLS fences: the access token still says `is_anonymous` (403, 42501). */
export function isAnonymousForbidden(err: unknown): boolean {
  return /^ANONYMOUS_FORBIDDEN\b/.test(parts(err).message);
}

export function isUsernameRejected(err: unknown): boolean {
  const { message, code } = parts(err);
  return /USERNAME_FILTERED/.test(message) || (code === '23505' && /username/i.test(message));
}

/**
 * `linkIdentity`: the Apple/Google identity already belongs to another Rally user (GoTrue `identity_already_exists`,
 * "Identity is already linked to another user"). The right move is to sign into that account.
 */
export function isIdentityAlreadyLinked(err: unknown): boolean {
  const { message, code } = parts(err);
  if (code === 'identity_already_exists') return true;
  if (EMAIL_EXISTS_CODES.has(code)) return false;
  return /identity is already linked|already linked to another user/i.test(message);
}

const EMAIL_EXISTS_CODES = new Set(['email_exists', 'user_already_exists']);

/**
 * The identity's email already belongs to another account, typically email + password (GoTrue `email_exists`,
 * "A user with this email address has already been registered"; `user_already_exists` from signUp).
 */
export function isEmailAlreadyRegistered(err: unknown): boolean {
  const { message, code } = parts(err);
  if (EMAIL_EXISTS_CODES.has(code)) return true;
  if (code === 'identity_already_exists') return false;
  return /email address has already been registered|user already registered|already (been )?registered/i.test(message);
}

export type LinkErrorKind = 'identity-linked' | 'email-exists' | 'other';

/** How a failed `linkIdentity` (Apple) or identity-link redirect (Google) should be handled. */
export function classifyLinkError(err: unknown): LinkErrorKind {
  if (isIdentityAlreadyLinked(err)) return 'identity-linked';
  if (isEmailAlreadyRegistered(err)) return 'email-exists';
  return 'other';
}

export const NEUTRAL_REFUSAL = "We couldn't create an account. Please try again later.";
export const EMAIL_ACCOUNT_EXISTS = 'An account with this email already exists — sign in with email instead.';
export const USERNAME_JUST_TAKEN = 'That username was just taken. Try another one.';

export const LINK_EXPIRED = 'This link was opened on a different device or has expired. Sign in to continue.';

/**
 * Copy for an error that arrived in a deep link (`rally://auth/callback?error=…&error_code=…&error_description=…`).
 * Anyone can craft such a link, so its text is never shown: only GoTrue's known `error_code`s pick one of our own
 * messages, everything else gets a generic one.
 */
export function describeCallbackError(params: { error?: string | null; errorCode?: string | null }): string {
  const code = params.errorCode ?? '';
  if (code === 'otp_expired' || code === 'flow_state_expired' || code === 'flow_state_not_found' || code === 'bad_code_verifier') {
    return LINK_EXPIRED;
  }
  if (params.error === 'access_denied') return 'Sign-in was cancelled or the link is no longer valid. Sign in to continue.';
  return "This sign-in link couldn't be used. Sign in to continue.";
}

export function describeAuthError(err: unknown): string {
  const { message, code } = parts(err);
  if (isAgeGateError(err)) return NEUTRAL_REFUSAL;
  if (/USERNAME_FILTERED/.test(message)) return "That username isn't allowed. Try another one.";
  if (/DISPLAY_NAME_FILTERED/.test(message)) return "That display name isn't allowed.";
  if (code === '23505' && /username/i.test(message)) return USERNAME_JUST_TAKEN;
  if (isAnonymousForbidden(err)) return 'Finish creating your account first, then try again.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'Wrong email or password.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'Confirm your email first: open the link we sent you.';
  }
  if (code === 'email_exists' || /email address has already been registered/i.test(message)) return EMAIL_ACCOUNT_EXISTS;
  if (code === 'user_already_exists' || /already registered/i.test(message)) {
    return 'An account with this email already exists. Sign in instead.';
  }
  if (code === 'weak_password' || /password should be/i.test(message)) return message || 'Choose a stronger password.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || /rate limit/i.test(message)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (code === 'anonymous_provider_disabled' || /anonymous sign-ins are disabled/i.test(message)) {
    return 'Signing up with this provider is not enabled yet. Use email instead.';
  }
  if (code === 'manual_linking_disabled' || /manual linking/i.test(message)) {
    return 'Signing up with this provider is not enabled yet. Use email instead.';
  }
  if (/network request failed|fetch failed/i.test(message)) return 'No connection. Check your network and try again.';
  if (isNewUserRejected(err)) return NEUTRAL_REFUSAL;
  return message || 'Something went wrong. Please try again.';
}
