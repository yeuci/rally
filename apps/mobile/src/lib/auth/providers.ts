import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { isIdentityAlreadyLinked, isNewUserRejected } from './errors';
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
 */
export type OAuthProvider = 'apple' | 'google';
export type SignupMetadata = { username: string; birth_date: string };

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
// PKCE code exchange. Shared by openAuthSessionAsync results and the auth/callback route; on Android the redirect
// can reach both, and a code may only be exchanged once.
// ---------------------------------------------------------------------------------------------------------------

const exchanges = new Map<string, Promise<void>>();

export function exchangeCodeOnce(code: string): Promise<void> {
  let p = exchanges.get(code);
  if (!p) {
    p = supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
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

async function runBrowserFlow(url: string): Promise<'success' | 'cancelled'> {
  browserFlows += 1;
  try {
    const res = await WebBrowser.openAuthSessionAsync(url, authCallbackUrl());
    if (res.type !== 'success') return 'cancelled';
    const redirect = parseAuthRedirect(res.url);
    if (redirect.error) {
      throw new AuthFlowError(redirect.errorDescription ?? redirect.error, redirect.errorCode ?? redirect.error);
    }
    if (!redirect.code) throw new AuthFlowError('The sign-in redirect did not include an authorization code.');
    await exchangeCodeOnce(redirect.code);
    return 'success';
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
// Public flows
// ---------------------------------------------------------------------------------------------------------------

export type ProviderSignInOutcome = 'signed-in' | 'cancelled' | 'new-user';

/** Signs in an existing Rally account. A first-time identity comes back as 'new-user' (nothing was created). */
export async function signInWithProvider(provider: OAuthProvider): Promise<ProviderSignInOutcome> {
  if (provider === 'apple') {
    const cred = await appleCredential();
    if (!cred) return 'cancelled';
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.token, nonce: cred.nonce });
    if (error) {
      if (isNewUserRejected(error)) return 'new-user';
      throw error;
    }
    return 'signed-in';
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: authCallbackUrl(), skipBrowserRedirect: true },
  });
  if (error) throw error;
  try {
    return (await runBrowserFlow(data.url)) === 'success' ? 'signed-in' : 'cancelled';
  } catch (err) {
    if (isNewUserRejected(err)) return 'new-user';
    throw err;
  }
}

export type ProviderSignUpOutcome = 'created' | 'signed-in' | 'cancelled';

/** Creates a Rally account for an Apple/Google identity (after the age gate). See the module comment. */
export async function createAccountWithProvider(provider: OAuthProvider, meta: SignupMetadata): Promise<ProviderSignUpOutcome> {
  await ensureAnonymousUser(meta);

  if (provider === 'apple') {
    const cred = await appleCredential();
    if (!cred) return 'cancelled';
    const { error } = await supabase.auth.linkIdentity({ provider: 'apple', token: cred.token, nonce: cred.nonce });
    if (!error) return 'created';
    if (!isIdentityAlreadyLinked(error)) throw error;
    // The identity already has an account (e.g. created on another device meanwhile): sign into that one.
    const signIn = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.token, nonce: cred.nonce });
    if (signIn.error) throw signIn.error;
    return 'signed-in';
  }

  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: { redirectTo: authCallbackUrl(), skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new AuthFlowError('Could not start Google sign-in.');
  try {
    return (await runBrowserFlow(data.url)) === 'success' ? 'created' : 'cancelled';
  } catch (err) {
    if (!isIdentityAlreadyLinked(err)) throw err;
    const outcome = await signInWithProvider('google');
    return outcome === 'signed-in' ? 'signed-in' : 'cancelled';
  }
}

/**
 * The anonymous user that will own the provider identity. Reused across retries (a cancelled Apple sheet or
 * browser) so the chosen username is not stranded on an abandoned user.
 */
async function ensureAnonymousUser(meta: SignupMetadata): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (user?.is_anonymous) {
    if (user.user_metadata?.birth_date === meta.birth_date) {
      if (user.user_metadata?.username !== meta.username) {
        const { error } = await supabase.from('profiles').update({ username: meta.username }).eq('id', user.id);
        if (error) throw error;
        await supabase.auth.updateUser({ data: meta });
      }
      return;
    }
    // birth_date is immutable on the profile: start over with a fresh anonymous user.
    await supabase.auth.signOut({ scope: 'local' });
  }
  const { error } = await supabase.auth.signInAnonymously({ options: { data: meta } });
  if (error) throw error;
}

export type EmailSignUpOutcome = 'signed-in' | 'confirm-email';

export async function signUpWithEmail(input: { email: string; password: string } & SignupMetadata): Promise<EmailSignUpOutcome> {
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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: passwordResetUrl() });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
