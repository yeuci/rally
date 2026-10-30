import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { keepSessionWhenReleaseFails, planAnonymousUser, type AbandonReason, type SignupMetadata } from './anonymous';
import { EMAIL_ACCOUNT_EXISTS, classifyLinkError, isNewUserRejected } from './errors';
import { parseAuthRedirect } from './redirect';

/**
 * Sign-in / sign-up flows.
 *
 * Account creation always carries `{ username, birth_date }` in the user metadata because the
 * `on_auth_user_created` trigger builds the profile from it and refuses the insert without a valid 13+ birth date.
 *
 * - Email: `signUp({ options: { data } })`.
 * - Apple / Google: neither `signInWithIdToken` nor `signInWithOAuth` can carry metadata, so a first-time provider
 *   sign-in is refused by the trigger (no account is created). The app treats that refusal as "new user", runs the
 *   age gate and username step, then creates an anonymous user WITH the metadata (the trigger creates the profile
 *   at that moment) and links the Apple/Google identity to it, which turns it into a permanent account.
 *   Needs "Allow anonymous sign-ins" and "Manual linking" enabled in the Supabase project (packages/db/README.md).
 *
 * The anonymous user's profile holds the chosen username from the start (`username_available` ignores the
 * caller's own profile, so the live check keeps saying "Available" for it). Every path that gives the anonymous
 * user up (cancel, provider error, "already has an account", a different username or date of birth, any other
 * sign-in, sign-out) calls `release_username()` first and then signs out locally (`abandonAnonymousUser`);
 * a retry with the same username and date of birth reuses the session instead (lib/auth/anonymous.ts).
 *
 * PKCE: `experimental.appendPkceFlowIdToRedirects` (lib/supabase.ts) puts `sb_flow_id` on every redirect, and
 * each exchange passes its flow id, so several flows in flight (a Google attempt, a reset link, a confirmation
 * link) never borrow each other's code verifier.
 */
export type OAuthProvider = 'apple' | 'google';
export type { SignupMetadata } from './anonymous';

export const authCallbackUrl = () => Linking.createURL('/auth/callback');
export const passwordResetUrl = () => Linking.createURL('/auth/reset-password');

export class AuthFlowError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PKCE code exchange. Shared by openAuthSessionAsync results and the auth/* routes; on Android the redirect
// can reach both, and a code may only be exchanged once.
// ---------------------------------------------------------------------------------------------------------------

const exchanges = new Map<string, Promise<void>>();

/**
 * `flowId` selects the code verifier stored when that flow started (from `signInWithOAuth` / `linkIdentity`, or
 * the redirect's `sb_flow_id`). Without one auth-js falls back to the most recently stored verifier.
 */
export function exchangeCodeOnce(code: string, flowId?: string | null): Promise<void> {
  let p = exchanges.get(code);
  if (!p) {
    p = supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined).then(({ error }) => {
      if (error) throw error;
    });
    exchanges.set(code, p);
  }
  return p;
}

let browserFlows = 0;
let browserFlowEndedAt = 0;

/** While true, `+native-intent` swallows auth redirects so expo-router does not also navigate to auth/callback. */
export function isBrowserAuthInProgress(): boolean {
  return browserFlows > 0 || Date.now() - browserFlowEndedAt < 3000;
}

/**
 * `error`: the redirect came back refusing the flow (nothing happened server-side). A failed code exchange
 * throws instead: the server may already have completed the flow (e.g. linked the identity).
 */
type BrowserFlowResult = { type: 'success' } | { type: 'cancelled' } | { type: 'error'; error: AuthFlowError };

async function runBrowserFlow(url: string, flowId: string | null | undefined): Promise<BrowserFlowResult> {
  browserFlows += 1;
  try {
    const res = await WebBrowser.openAuthSessionAsync(url, authCallbackUrl());
    if (res.type !== 'success') return { type: 'cancelled' };
    const redirect = parseAuthRedirect(res.url);
    if (redirect.error) {
      return { type: 'error', error: new AuthFlowError(redirect.errorDescription ?? redirect.error, redirect.errorCode ?? redirect.error) };
    }
    if (!redirect.code) return { type: 'error', error: new AuthFlowError('The sign-in redirect did not include an authorization code.') };
    await exchangeCodeOnce(redirect.code, flowId ?? redirect.flowId);
    return { type: 'success' };
  } finally {
    browserFlows -= 1;
    browserFlowEndedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Apple (iOS only, native sheet → ID token)
// ---------------------------------------------------------------------------------------------------------------

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Apple gets the SHA-256 of the nonce; Supabase gets the raw nonce and checks the hash in the ID token. */
async function appleCredential(): Promise<{ token: string; nonce: string } | null> {
  const nonce = Crypto.randomUUID();
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  try {
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    });
    if (!cred.identityToken) throw new AuthFlowError('Apple did not return an identity token.');
    return { token: cred.identityToken, nonce };
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The anonymous user behind an Apple/Google signup
// ---------------------------------------------------------------------------------------------------------------

/**
 * Give up the current anonymous user, if there is one: `release_username()` while its session is still active
 * (frees the chosen name), then sign out locally. No-op for any other session.
 */
async function abandonAnonymousUser(reason: AbandonReason): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.user.is_anonymous) return;
  const { error } = await supabase.rpc('release_username');
  if (error) {
    console.warn(`[release_username] (${reason})`, error.message);
    if (keepSessionWhenReleaseFails(reason)) return;
  }
  await supabase.auth.signOut({ scope: 'local' });
}

/** The anonymous user that will own the provider identity: reused on a retry with the same details, else new. */
async function ensureAnonymousUser(meta: SignupMetadata): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  let plan = planAnonymousUser(user, meta);
  if (plan === 'reuse' && user) {
    // The metadata never changes; the profile is what holds the name (a release may have run without the sign-out).
    const { data: profile, error } = await supabase.from('profiles').select('username').eq('id', user.id).maybeSingle();
    if (error) throw error;
    if (profile?.username !== meta.username) plan = 'replace';
  }
  if (plan === 'reuse') return;
  if (plan === 'replace') await abandonAnonymousUser('replaced');
  const { error } = await supabase.auth.signInAnonymously({ options: { data: meta } });
  if (error) throw error;
}

/**
 * After a successful link: the session's token may still claim `is_anonymous` (the server then refuses saves,
 * plays and favorites with ANONYMOUS_FORBIDDEN, and the session gate keeps the user out of the app until it
 * changes). Refresh it now.
 */
async function refreshLinkedSession(): Promise<void> {
  const { error } = await supabase.auth.refreshSession();
  if (error) {
    throw new AuthFlowError("Your account is ready, but we couldn't finish signing you in. Check your connection and try again.");
  }
}

/** A refused link: sign into the identity's own account, or explain that the email has an account, or rethrow. */
async function handleLinkError(err: unknown, signInExisting: () => Promise<ProviderSignUpOutcome>): Promise<ProviderSignUpOutcome> {
  const kind = classifyLinkError(err);
  if (kind === 'identity-linked') {
    // The identity already has a Rally account (e.g. created on another device meanwhile): sign into that one.
    await abandonAnonymousUser('identity-linked');
    return signInExisting();
  }
  if (kind === 'email-exists') {
    await abandonAnonymousUser('email-exists');
    throw new AuthFlowError(EMAIL_ACCOUNT_EXISTS, 'email_exists');
  }
  await abandonAnonymousUser('provider-error');
  throw err;
}

// ---------------------------------------------------------------------------------------------------------------
// Public flows
// ---------------------------------------------------------------------------------------------------------------

export type ProviderSignInOutcome = 'signed-in' | 'cancelled' | 'new-user';

/** Signs in an existing Rally account. A first-time identity comes back as 'new-user' (nothing was created). */
export async function signInWithProvider(provider: OAuthProvider): Promise<ProviderSignInOutcome> {
  if (provider === 'apple') {
    const cred = await appleCredential();
    if (!cred) return 'cancelled';
    await abandonAnonymousUser('sign-in');
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.token, nonce: cred.nonce });
    if (error) {
      if (isNewUserRejected(error)) return 'new-user';
      throw error;
    }
    return 'signed-in';
  }

  await abandonAnonymousUser('sign-in');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: authCallbackUrl(), skipBrowserRedirect: true },
  });
  if (error) throw error;
  const result = await runBrowserFlow(data.url, data.flowId);
  if (result.type === 'error') {
    if (isNewUserRejected(result.error)) return 'new-user';
    throw result.error;
  }
  return result.type === 'success' ? 'signed-in' : 'cancelled';
}

export type ProviderSignUpOutcome = 'created' | 'signed-in' | 'cancelled';

/** Creates a Rally account for an Apple/Google identity (after the age gate). See the module comment. */
export async function createAccountWithProvider(provider: OAuthProvider, meta: SignupMetadata): Promise<ProviderSignUpOutcome> {
  // A previous attempt linked the identity but could not refresh the token: finish that instead of starting over.
  const { data: current } = await supabase.auth.getSession();
  if (current.session && !current.session.user.is_anonymous) {
    await refreshLinkedSession();
    return 'signed-in';
  }

  if (provider === 'apple') {
    // The native sheet first, so a cancel leaves no anonymous user behind.
    const cred = await appleCredential();
    if (!cred) return 'cancelled';
    await ensureAnonymousUser(meta);
    const { error } = await supabase.auth.linkIdentity({ provider: 'apple', token: cred.token, nonce: cred.nonce });
    if (error) {
      return handleLinkError(error, async () => {
        const signIn = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.token, nonce: cred.nonce });
        if (signIn.error) throw signIn.error;
        return 'signed-in';
      });
    }
    await refreshLinkedSession();
    return 'created';
  }

  // Google's link URL is authorized by the session, so the anonymous user has to exist before the browser opens.
  await ensureAnonymousUser(meta);
  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: { redirectTo: authCallbackUrl(), skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    await abandonAnonymousUser('provider-error');
    throw error ?? new AuthFlowError('Could not start Google sign-in.');
  }
  // A failed code exchange propagates without abandoning: the link may have happened, and releasing the username
  // with the pre-link token would rename the new account.
  const result = await runBrowserFlow(data.url, data.flowId);
  if (result.type === 'cancelled') {
    await abandonAnonymousUser('cancelled');
    return 'cancelled';
  }
  if (result.type === 'error') {
    return handleLinkError(result.error, async () => ((await signInWithProvider('google')) === 'signed-in' ? 'signed-in' : 'cancelled'));
  }
  await refreshLinkedSession();
  return 'created';
}

export type EmailSignUpOutcome = 'signed-in' | 'confirm-email';

export async function signUpWithEmail(input: { email: string; password: string } & SignupMetadata): Promise<EmailSignUpOutcome> {
  await abandonAnonymousUser('replaced');
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: { username: input.username, birth_date: input.birth_date },
      emailRedirectTo: authCallbackUrl(),
    },
  });
  if (error) throw error;
  return data.session ? 'signed-in' : 'confirm-email';
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  await abandonAnonymousUser('sign-in');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: passwordResetUrl() });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await abandonAnonymousUser('sign-out');
  const { error } = await supabase.auth.signOut();
  if (!error) return;
  // auth-js removes the local session even when revoking it fails (offline): signed out on this device.
  const { data } = await supabase.auth.getSession();
  if (data.session) throw error;
  console.warn('[signOut]', error.message);
}
