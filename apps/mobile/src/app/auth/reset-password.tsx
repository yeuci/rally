import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { AuthScreen } from '@/components/rally/auth-screen';
import { ErrorText, FormField } from '@/components/rally/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { describeAuthError } from '@/lib/auth/errors';
import { exchangeCodeOnce } from '@/lib/auth/providers';
import { useSession } from '@/lib/auth/session';
import { supabase } from '@/lib/supabase';

type Phase = 'exchanging' | 'ready' | 'invalid' | 'saving';

/** `rally://auth/reset-password?code=…` from `resetPasswordForEmail`: recovery session → new password. */
export default function ResetPassword() {
  const params = useLocalSearchParams<{ code?: string }>();
  const code = typeof params.code === 'string' ? params.code : null;
  const { signedIn } = useSession();
  const [phase, setPhase] = useState<Phase>(() => (code ? 'exchanging' : signedIn ? 'ready' : 'invalid'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    exchangeCodeOnce(code).then(
      () => alive && setPhase('ready'),
      () => alive && setPhase('invalid'),
    );
    return () => {
      alive = false;
    };
  }, [code]);

  async function save() {
    setPhase('saving');
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) {
      setError(describeAuthError(err));
      setPhase('ready');
      return;
    }
    router.replace('/');
  }

  if (phase === 'exchanging') {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (phase === 'invalid') {
    return (
      <AuthScreen title="Link expired" lede="This reset link has expired or was opened on a different device. Request a new one.">
        <Button size="lg" variant="secondary" onPress={() => router.replace('/')}>
          <Text>Continue</Text>
        </Button>
      </AuthScreen>
    );
  }

  const valid = password.length >= 8 && password === confirm;
  return (
    <AuthScreen title="Choose a new password">
      <FormField id="new-password" label="New password" hint={password && password.length < 8 ? 'At least 8 characters.' : null} tone="error">
        <Input
          aria-labelledby="new-password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
        />
      </FormField>
      <FormField id="confirm-password" label="Confirm password" hint={confirm && confirm !== password ? "Passwords don't match." : null} tone="error">
        <Input aria-labelledby="confirm-password" value={confirm} onChangeText={setConfirm} secureTextEntry textContentType="newPassword" />
      </FormField>
      <ErrorText>{error}</ErrorText>
      <Button size="lg" disabled={!valid || phase === 'saving'} onPress={() => void save()}>
        <Text>{phase === 'saving' ? 'Saving…' : 'Save password'}</Text>
      </Button>
    </AuthScreen>
  );
}
