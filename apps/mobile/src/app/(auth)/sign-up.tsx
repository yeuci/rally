import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { AuthScreen } from '@/components/rally/auth-screen';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { UsernameField } from '@/components/rally/username-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toIsoDate } from '@/lib/auth/age';
import { ageGate, useAgeGate } from '@/lib/auth/age-gate-store';
import { NEUTRAL_REFUSAL, USERNAME_JUST_TAKEN, describeAuthError, isNewUserRejected, isUsernameTaken } from '@/lib/auth/errors';
import { createAccountWithProvider, signUpWithEmail } from '@/lib/auth/providers';
import { parseSignupMethod } from '@/lib/auth/signup-method';
import { currentUserId } from '@/lib/auth/session';
import { usernameAvailabilityKey, useUsernameAvailability } from '@/lib/auth/use-username-availability';
import { supabase } from '@/lib/supabase';

const MIN_PASSWORD = 8;

/**
 * Second signup step (after the age gate). Username + birth_date travel in the signup metadata, from which the
 * `on_auth_user_created` trigger creates the profile and re-checks the age gate and word filter server-side.
 */
export default function SignUp() {
  const method = parseSignupMethod(useLocalSearchParams<{ method?: string }>().method);
  const qc = useQueryClient();
  const { pendingDob } = useAgeGate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = useUsernameAvailability(username);

  // Reached without passing the gate in this run (deep link, app restart): the gate comes first.
  if (!pendingDob) return <Redirect href={{ pathname: '/age', params: { method } }} />;
  const birthDate = toIsoDate(pendingDob);

  const usernameOk = availability.status === 'available';
  const emailOk = method !== 'email' || (/\S+@\S+\.\S+/.test(email) && password.length >= MIN_PASSWORD);
  const canSubmit = usernameOk && emailOk && !busy;

  /** Re-check the name as the current caller and feed the answer to the field, so it shows "isn't available". */
  async function recheckUsername(): Promise<boolean | null> {
    const { data, error: rpcError } = await supabase.rpc('username_available', { p_username: username });
    if (rpcError) return null;
    qc.setQueryData(usernameAvailabilityKey(currentUserId(), username), data);
    return data;
  }

  async function explain(err: unknown): Promise<string> {
    // Someone else registered the name between the live check and the insert (unique violation).
    if (isUsernameTaken(err)) {
      await recheckUsername();
      return USERNAME_JUST_TAKEN;
    }
    if (!isNewUserRejected(err)) return describeAuthError(err);
    // GoTrue hides the trigger's reason (a unique violation reads "Database error saving new user"); the username
    // is the one thing we can re-check.
    return (await recheckUsername()) === false ? "That username was just taken or isn't allowed. Try another one." : NEUTRAL_REFUSAL;
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (method === 'email') {
        const outcome = await signUpWithEmail({ email: email.trim(), password, username, birth_date: birthDate });
        ageGate.clearPending();
        if (outcome === 'confirm-email') router.replace({ pathname: '/check-email', params: { email: email.trim() } });
      } else {
        const outcome = await createAccountWithProvider(method, { username, birth_date: birthDate });
        if (outcome !== 'cancelled') ageGate.clearPending();
      }
      // Signed in: the root layout's session gate swaps to the app.
    } catch (err) {
      setError(await explain(err));
    } finally {
      setBusy(false);
    }
  }

  const providerName = method === 'apple' ? 'Apple' : method === 'google' ? 'Google' : null;

  return (
    <AuthScreen
      title={providerName ? 'Pick a username' : 'Create your account'}
      lede={providerName ? `Then confirm with ${providerName} to finish.` : 'You can change your display name later.'}
      footer={
        <Button size="lg" disabled={!canSubmit} onPress={() => void submit()}>
          <Text>{busy ? 'Creating account…' : providerName ? `Continue with ${providerName}` : 'Create account'}</Text>
        </Button>
      }
    >
      <UsernameField value={username} onChangeText={setUsername} status={availability.status} message={availability.message} autoFocus />
      {method === 'email' && (
        <>
          <FormField id="email" label="Email">
            <Input
              aria-labelledby="email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="you@example.com"
            />
          </FormField>
          <FormField
            id="password"
            label="Password"
            hint={password.length > 0 && password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters.` : null}
            tone="error"
          >
            <Input
              aria-labelledby="password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
            />
          </FormField>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </AuthScreen>
  );
}
