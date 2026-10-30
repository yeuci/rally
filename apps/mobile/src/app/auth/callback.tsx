import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { describeAuthError, describeCallbackError, LINK_EXPIRED } from '@/lib/auth/errors';
import { exchangeCodeOnce } from '@/lib/auth/providers';
import { supabase } from '@/lib/supabase';

/**
 * `rally://auth/callback?code=…`: email confirmation links (and OAuth redirects that arrive outside an in-app
 * browser flow). Exchanges the PKCE code once with its flow's verifier (`sb_flow_id`), then hands over to the
 * session gate. An `error` in the link is shown as our own copy only (anyone can craft such a link; its text is
 * logged in dev builds).
 */
export default function AuthCallback() {
  const params = useLocalSearchParams<{
    code?: string;
    sb_flow_id?: string;
    error?: string;
    error_code?: string;
    error_description?: string;
  }>();
  const code = typeof params.code === 'string' ? params.code : null;
  const flowId = typeof params.sb_flow_id === 'string' ? params.sb_flow_id : null;
  const linkError = typeof params.error === 'string' ? params.error : null;
  const linkErrorCode = typeof params.error_code === 'string' ? params.error_code : null;
  const linkErrorDescription = typeof params.error_description === 'string' ? params.error_description : null;
  const [error, setError] = useState<string | null>(() =>
    linkError || linkErrorCode || linkErrorDescription ? describeCallbackError({ error: linkError, errorCode: linkErrorCode }) : null,
  );

  useEffect(() => {
    if (__DEV__ && (linkError || linkErrorCode || linkErrorDescription)) {
      console.warn('[auth/callback] link error', { error: linkError, code: linkErrorCode, description: linkErrorDescription });
    }
  }, [linkError, linkErrorCode, linkErrorDescription]);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    exchangeCodeOnce(code, flowId).then(
      () => router.replace('/'),
      async (err) => {
        // Already signed in (the in-app flow won the race for this code): nothing to report.
        const { data } = await supabase.auth.getSession();
        if (data.session && !data.session.user.is_anonymous) router.replace('/');
        else if (alive) {
          setError(
            /code verifier|flow state|invalid/i.test(String((err as Error)?.message)) ? LINK_EXPIRED : describeAuthError(err),
          );
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [code, flowId]);

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
