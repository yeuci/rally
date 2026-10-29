/**
 * Maps Supabase Auth / PostgREST errors to user-facing copy. Pure, unit-tested in test/auth-errors.test.ts.
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

export function isUsernameRejected(err: unknown): boolean {
  const { message, code } = parts(err);
  return /USERNAME_FILTERED/.test(message) || (code === '23505' && /username/i.test(message));
}

export function isIdentityAlreadyLinked(err: unknown): boolean {
  const { message, code } = parts(err);
  return code === 'identity_already_exists' || /already (linked|exists|registered)/i.test(message);
}

export const NEUTRAL_REFUSAL = "We couldn't create an account. Please try again later.";

export function describeAuthError(err: unknown): string {
  const { message, code } = parts(err);
  if (isAgeGateError(err)) return NEUTRAL_REFUSAL;
  if (/USERNAME_FILTERED/.test(message)) return "That username isn't allowed. Try another one.";
  if (/DISPLAY_NAME_FILTERED/.test(message)) return "That display name isn't allowed.";
  if (code === '23505' && /username/i.test(message)) return 'That username is taken.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'Wrong email or password.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'Confirm your email first: open the link we sent you.';
  }
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
