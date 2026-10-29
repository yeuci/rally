import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessTokenIsAnonymous, keepSessionWhenReleaseFails, planAnonymousUser } from '../src/lib/auth/anonymous';
import {
  EMAIL_ACCOUNT_EXISTS,
  NEUTRAL_REFUSAL,
  USERNAME_JUST_TAKEN,
  classifyLinkError,
  describeAuthError,
  isAnonymousForbidden,
  isEmailAlreadyRegistered,
  isIdentityAlreadyLinked,
  isNewUserRejected,
  isUsernameRejected,
  isUsernameTaken,
} from '../src/lib/auth/errors';
import { isAuthRedirectPath, parseAuthRedirect } from '../src/lib/auth/redirect';
import { parseSignupMethod } from '../src/lib/auth/signup-method';
import { usernameFormatError } from '../src/lib/auth/username';

test('trigger refusals are recognised (GoTrue hides the reason)', () => {
  assert.equal(isNewUserRejected({ message: 'Database error saving new user', code: 'unexpected_failure' }), true);
  assert.equal(isNewUserRejected(new Error('Database error saving new user')), true);
  assert.equal(isNewUserRejected({ message: 'AGE_GATE: must be at least 13 years old' }), true);
  assert.equal(isNewUserRejected({ message: 'Invalid login credentials' }), false);
  assert.equal(describeAuthError({ message: 'Database error saving new user' }), NEUTRAL_REFUSAL);
  assert.equal(describeAuthError({ message: 'AGE_GATE: must be at least 13 years old' }), NEUTRAL_REFUSAL);
});

test('error copy', () => {
  assert.match(describeAuthError({ message: 'USERNAME_FILTERED: username not allowed', code: '23514' }), /isn't allowed/);
  assert.match(describeAuthError({ message: 'DISPLAY_NAME_FILTERED: display name not allowed' }), /display name/);
  assert.match(
    describeAuthError({ message: 'duplicate key value violates unique constraint "profiles_username_key"', code: '23505' }),
    /taken/,
  );
  assert.match(describeAuthError({ message: 'Invalid login credentials', code: 'invalid_credentials' }), /Wrong email/);
  assert.match(describeAuthError({ message: 'Anonymous sign-ins are disabled', code: 'anonymous_provider_disabled' }), /not enabled/);
  assert.match(describeAuthError('Network request failed'), /No connection/);
  assert.equal(isUsernameRejected({ message: 'USERNAME_FILTERED: x' }), true);
});

test('identity already linked', () => {
  assert.equal(isIdentityAlreadyLinked({ code: 'identity_already_exists', message: 'Identity is already linked to another user' }), true);
  assert.equal(isIdentityAlreadyLinked({ message: 'Identity is already linked to another user' }), true);
  assert.equal(isIdentityAlreadyLinked({ code: 'server_error', message: 'Identity is already linked to another user' }), true);
  assert.equal(isIdentityAlreadyLinked({ message: 'Database error saving new user' }), false);
  assert.equal(
    isIdentityAlreadyLinked({ code: 'email_exists', message: 'A user with this email address has already been registered' }),
    false,
  );
});

test('linking an identity whose email has an email + password account (GoTrue email_exists)', () => {
  const emailExists = { code: 'email_exists', message: 'A user with this email address has already been registered', status: 422 };
  assert.equal(isEmailAlreadyRegistered(emailExists), true);
  assert.equal(isEmailAlreadyRegistered({ code: 'user_already_exists', message: 'User already registered' }), true);
  assert.equal(isEmailAlreadyRegistered({ message: 'A user with this email address has already been registered' }), true, 'message fallback');
  assert.equal(isEmailAlreadyRegistered({ code: 'identity_already_exists', message: 'Identity is already linked to another user' }), false);
  assert.equal(classifyLinkError(emailExists), 'email-exists');
  assert.equal(classifyLinkError({ code: 'identity_already_exists', message: 'Identity is already linked to another user' }), 'identity-linked');
  assert.equal(classifyLinkError({ code: 'manual_linking_disabled', message: 'Manual linking is disabled' }), 'other');
  // Google: the link refusal comes back on the redirect and is rethrown as AuthFlowError(description, error_code).
  const fromRedirect = parseAuthRedirect(
    'rally://auth/callback?sb_flow_id=f1&error=invalid_request&error_code=email_exists&error_description=A+user+with+this+email+address+has+already+been+registered',
  );
  assert.equal(classifyLinkError({ message: fromRedirect.errorDescription, code: fromRedirect.errorCode }), 'email-exists');
  assert.equal(describeAuthError(emailExists), EMAIL_ACCOUNT_EXISTS);
  assert.match(EMAIL_ACCOUNT_EXISTS, /sign in with email/);
});

test('username races and anonymous-session refusals', () => {
  const dup = { message: 'duplicate key value violates unique constraint "profiles_username_key"', code: '23505' };
  assert.equal(isUsernameTaken(dup), true);
  assert.equal(describeAuthError(dup), USERNAME_JUST_TAKEN);
  assert.equal(isUsernameTaken({ message: 'USERNAME_FILTERED: username not allowed', code: '23514' }), false);
  const forbidden = { message: 'ANONYMOUS_FORBIDDEN: link an account first', code: '42501' };
  assert.equal(isAnonymousForbidden(forbidden), true);
  assert.equal(isAnonymousForbidden({ message: 'new row violates row-level security policy', code: '42501' }), false);
  assert.match(describeAuthError(forbidden), /Finish creating your account/);
});

test('planAnonymousUser: reuse only for the same username and date of birth', () => {
  const meta = { username: 'rally_fan', birth_date: '2000-01-02' };
  const anon = (m: Record<string, unknown>) => ({ is_anonymous: true, user_metadata: m });
  assert.equal(planAnonymousUser(null, meta), 'create');
  assert.equal(planAnonymousUser(undefined, meta), 'create');
  assert.equal(planAnonymousUser({ is_anonymous: false, user_metadata: { ...meta } }, meta), 'create');
  assert.equal(planAnonymousUser(anon({ ...meta }), meta), 'reuse');
  assert.equal(planAnonymousUser(anon({ ...meta, username: 'Rally_Fan' }), meta), 'replace', 'case matters: the profile keeps the old casing');
  assert.equal(planAnonymousUser(anon({ ...meta, username: 'someone' }), meta), 'replace');
  assert.equal(planAnonymousUser(anon({ ...meta, birth_date: '2000-01-03' }), meta), 'replace', 'date of birth corrected');
  assert.equal(planAnonymousUser({ is_anonymous: true, user_metadata: null }, meta), 'replace');
});

test('a failed release keeps the anonymous session only where nothing replaces it', () => {
  assert.equal(keepSessionWhenReleaseFails('cancelled'), true);
  assert.equal(keepSessionWhenReleaseFails('provider-error'), true);
  for (const reason of ['email-exists', 'identity-linked', 'replaced', 'sign-in', 'sign-out'] as const) {
    assert.equal(keepSessionWhenReleaseFails(reason), false, reason);
  }
});

test('accessTokenIsAnonymous reads the is_anonymous claim', () => {
  const jwt = (claims: object) =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  assert.equal(accessTokenIsAnonymous(jwt({ sub: 'u', is_anonymous: true })), true);
  assert.equal(accessTokenIsAnonymous(jwt({ sub: 'u', is_anonymous: false })), false);
  assert.equal(accessTokenIsAnonymous(jwt({ sub: 'u', name: '\u00e9\u00e9?>' })), false, 'base64url with padding');
  assert.equal(accessTokenIsAnonymous(jwt({ sub: 'u' })), false);
  assert.equal(accessTokenIsAnonymous('not-a-jwt'), false);
  assert.equal(accessTokenIsAnonymous('a.!!!.c'), false);
  assert.equal(accessTokenIsAnonymous(null), false);
});

test('parseAuthRedirect reads PKCE codes from the query and errors from query or fragment', () => {
  assert.deepEqual(parseAuthRedirect('rally://auth/callback?code=abc-123'), {
    code: 'abc-123',
    flowId: null,
    error: null,
    errorCode: null,
    errorDescription: null,
  });
  const err = parseAuthRedirect(
    'rally://auth/callback?error=server_error&error_code=unexpected_failure&error_description=Database+error+saving+new+user',
  );
  assert.equal(err.error, 'server_error');
  assert.equal(err.errorDescription, 'Database error saving new user');
  assert.equal(isNewUserRejected({ message: err.errorDescription }), true);
  const tagged = parseAuthRedirect('rally://auth/callback?sb_flow_id=5f0c7a2e-1&code=abc');
  assert.equal(tagged.flowId, '5f0c7a2e-1');
  assert.equal(tagged.code, 'abc');
  const frag = parseAuthRedirect('rally://auth/callback#error=access_denied&error_description=Identity%20is%20already%20linked');
  assert.equal(frag.error, 'access_denied');
  assert.equal(frag.errorDescription, 'Identity is already linked');
});

test('isAuthRedirectPath', () => {
  assert.equal(isAuthRedirectPath('rally://auth/callback?code=x'), true);
  assert.equal(isAuthRedirectPath('/auth/callback'), true);
  assert.equal(isAuthRedirectPath('exp://192.168.1.10:8081/--/auth/callback?code=x'), true);
  assert.equal(isAuthRedirectPath('rally://auth/reset-password?code=x'), true);
  assert.equal(isAuthRedirectPath('rally://game/spike'), false);
  assert.equal(isAuthRedirectPath('/auth/callbacks'), false);
});

test('username format mirrors the DB constraint', () => {
  assert.equal(usernameFormatError('ab'), 'At least 3 characters.');
  assert.equal(usernameFormatError('a'.repeat(21)), 'At most 20 characters.');
  assert.equal(usernameFormatError('bad-name'), 'Letters, numbers and underscores only.');
  assert.equal(usernameFormatError('Good_Name_1'), null);
  assert.equal(usernameFormatError(''), null);
});

test('parseSignupMethod defaults to email', () => {
  assert.equal(parseSignupMethod('apple'), 'apple');
  assert.equal(parseSignupMethod(['google']), 'google');
  assert.equal(parseSignupMethod('facebook'), 'email');
  assert.equal(parseSignupMethod(undefined), 'email');
});
