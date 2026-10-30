import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { MailIcon, WrenchIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUniwind } from 'uniwind';
import { ErrorText } from '@/components/rally/form-field';
import { Wordmark } from '@/components/rally/logo';
import { PulseGlow } from '@/components/rally/pulse-glow';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { describeAuthError } from '@/lib/auth/errors';
import { isAppleSignInAvailable, signInWithProvider, type OAuthProvider } from '@/lib/auth/providers';
import { columnPadding } from '@/lib/layout';
import { useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/**
 * Entry point when signed out. Apple / Google first try to sign into an existing account; a first-time identity
 * creates nothing and is sent through the age gate (see lib/auth/providers.ts). Landscape: brand on the left, buttons
 * on the right, so everything fits a phone's ≈390 pt height without scrolling.
 */
export default function Welcome() {
  const { width, insets, landscape } = useLayout();
  const { theme } = useUniwind();
  const palette = usePalette();
  const column = columnPadding(width, insets, landscape ? 840 : 560, 24);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void isAppleSignInAvailable().then((ok) => alive && setAppleAvailable(ok));
    return () => {
      alive = false;
    };
  }, []);

  async function continueWith(provider: OAuthProvider) {
    if (busy) return;
    setError(null);
    setBusy(provider);
    try {
      const outcome = await signInWithProvider(provider);
      if (outcome === 'new-user') router.push({ pathname: '/age', params: { method: provider } });
      // 'signed-in': the root layout's session gate swaps to the app.
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View
      className={cn('bg-background flex-1', landscape && 'flex-row items-center gap-10')}
      style={[column, { paddingTop: insets.top + (landscape ? 16 : 24), paddingBottom: insets.bottom + 16 }]}
    >
      <View className={cn('flex-1 items-center justify-center', landscape ? 'gap-4' : 'gap-6')}>
        <View className="items-center justify-center" style={{ width: 300, height: landscape ? 120 : 140 }}>
          <PulseGlow size={landscape ? 300 : 340} />
          <Wordmark size={landscape ? 52 : 60} />
        </View>
        <Text className="text-muted-foreground max-w-xs text-center text-[17px] leading-6">
          Quick games with your friends, all in one app.
        </Text>
      </View>

      <View className={cn('gap-3', landscape && 'flex-1 justify-center')}>
        {!config.supabaseConfigured && (
          <Card className="border-subtle-line bg-subtle py-4">
            <CardContent className="px-4">
              <Text variant="muted">
                Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in apps/mobile/.env.
              </Text>
            </CardContent>
          </Card>
        )}

        <ErrorText>{error}</ErrorText>

        {appleAvailable && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={
              theme === 'light'
                ? AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                : AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
            }
            cornerRadius={18}
            style={{ height: 52, width: '100%' }}
            onPress={() => void continueWith('apple')}
          />
        )}

        <Button size="lg" variant="outline" disabled={!!busy} onPress={() => void continueWith('google')}>
          {busy === 'google' ? <ActivityIndicator color={palette.foreground} /> : <Text className="text-base">Continue with Google</Text>}
        </Button>

        <Button size="lg" variant="secondary" disabled={!!busy} onPress={() => router.push('/sign-in')}>
          <Icon as={MailIcon} className="size-4" />
          <Text className="text-base">Continue with email</Text>
        </Button>

        {config.devTools && (
          <Button variant="ghost" size="sm" className="self-center" onPress={() => router.push('/dev')}>
            <Icon as={WrenchIcon} className="text-muted-foreground size-4" />
            <Text className="text-muted-foreground">Developer</Text>
          </Button>
        )}
      </View>
    </View>
  );
}
