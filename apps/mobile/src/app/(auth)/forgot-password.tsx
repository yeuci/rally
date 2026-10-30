import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { AuthScreen } from '@/components/rally/auth-screen';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { describeAuthError } from '@/lib/auth/errors';
import { sendPasswordReset } from '@/lib/auth/providers';

/** `resetPasswordForEmail` with the `rally://auth/reset-password` deep link (PKCE: open the link on this device). */
export default function ForgotPassword() {
  const initial = useLocalSearchParams<{ email?: string }>().email;
  const [email, setEmail] = useState(typeof initial === 'string' ? initial : '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await sendPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      title="Reset your password"
      lede={
        sent
          ? 'If an account exists for that email, a reset link is on its way. Open it on this phone.'
          : "Enter your account's email and we'll send you a link."
      }
    >
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
      <ErrorText>{error}</ErrorText>
      <Button size="lg" disabled={busy || !/\S+@\S+\.\S+/.test(email)} onPress={() => void submit()}>
        <Text>{busy ? 'Sending…' : sent ? 'Send again' : 'Send reset link'}</Text>
      </Button>
    </AuthScreen>
  );
}
