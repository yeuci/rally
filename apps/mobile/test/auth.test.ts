import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NEUTRAL_REFUSAL,
  describeAuthError,
  isIdentityAlreadyLinked,
  isNewUserRejected,
  isUsernameRejected,
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
  assert.equal(isIdentityAlreadyLinked({ message: 'Database error saving new user' }), false);
});

test('parseAuthRedirect reads PKCE codes from the query and errors from query or fragment', () => {
  assert.deepEqual(parseAuthRedirect('rally://auth/callback?code=abc-123'), {
    code: 'abc-123',
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
