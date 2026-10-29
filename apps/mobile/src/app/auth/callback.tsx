import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { describeAuthError } from '@/lib/auth/errors';
import { exchangeCodeOnce } from '@/lib/auth/providers';
import { supabase } from '@/lib/supabase';

/**
 * `rally://auth/callback?code=…`: email confirmation links (and OAuth redirects that arrive outside an in-app
 * browser flow). Exchanges the PKCE code once, then hands over to the session gate.
 */
export default function AuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error?: string; error_description?: string }>();
  const code = typeof params.code === 'string' ? params.code : null;
  const [error, setError] = useState<string | null>(params.error_description ?? params.error ?? null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    exchangeCodeOnce(code).then(
      () => router.replace('/'),
      async (err) => {
        // Already signed in (the in-app flow won the race for this code): nothing to report.
        const { data } = await supabase.auth.getSession();
        if (data.session && !data.session.user.is_anonymous) router.replace('/');
        else if (alive) {
          setError(
            /code verifier|flow state|invalid/i.test(String((err as Error)?.message))
              ? 'This link was opened on a different device or has expired. Sign in to continue.'
              : describeAuthError(err),
          );
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [code]);

  if (!code && !error) return <Redirect href="/" />;

  return (
    <View className="bg-background flex-1 items-center justify-center gap-4 p-6">
      {error ? (
        <>
          <Text variant="h4" className="text-center">
            Couldn&apos;t sign you in
          </Text>
          <Text variant="muted" className="text-center">
            {error}
          </Text>
          <Button variant="secondary" onPress={() => router.replace('/')}>
            <Text>Continue</Text>
          </Button>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" />
          <Text variant="muted">Signing you in…</Text>
        </>
      )}
    </View>
  );
}
