import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AuthScreen } from '@/components/rally/auth-screen';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { describeAuthError } from '@/lib/auth/errors';
import { signInWithEmail } from '@/lib/auth/providers';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = /\S+@\S+\.\S+/.test(email) && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithEmail(email.trim(), password);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      title="Sign in"
      lede="Welcome back."
      footer={
        <View className="flex-row items-center justify-center gap-1">
          <Text variant="muted">New to Rally?</Text>
          <Button variant="link" size="sm" className="px-1" onPress={() => router.push({ pathname: '/age', params: { method: 'email' } })}>
            <Text>Create an account</Text>
          </Button>
        </View>
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
          returnKeyType="next"
        />
      </FormField>
      <FormField id="password" label="Password">
        <Input
          aria-labelledby="password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
      </FormField>
      <ErrorText>{error}</ErrorText>
      <Button size="lg" disabled={!canSubmit} onPress={() => void submit()}>
        <Text>{busy ? 'Signing in…' : 'Sign in'}</Text>
      </Button>
      <Button variant="link" size="sm" className="self-center" onPress={() => router.push({ pathname: '/forgot-password', params: { email } })}>
        <Text>Forgot password?</Text>
      </Button>
    </AuthScreen>
  );
}
