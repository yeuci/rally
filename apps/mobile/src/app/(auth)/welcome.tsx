import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { Gamepad2Icon, MailIcon, WrenchIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUniwind } from 'uniwind';
import { ErrorText } from '@/components/rally/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { describeAuthError } from '@/lib/auth/errors';
import { isAppleSignInAvailable, signInWithProvider, type OAuthProvider } from '@/lib/auth/providers';

/**
 * Entry point when signed out. Apple / Google first try to sign into an existing account; a first-time identity
 * creates nothing and is sent through the age gate (see lib/auth/providers.ts).
 */
export default function Welcome() {
  const insets = useSafeAreaInsets();
  const { theme } = useUniwind();
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
    <View className="bg-background flex-1 px-6" style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }}>
      <View className="flex-1 items-center justify-center gap-5">
        <View className="bg-primary size-20 items-center justify-center rounded-3xl">
          <Icon as={Gamepad2Icon} className="text-primary-foreground size-10" />
        </View>
        <View className="items-center gap-2">
          <Text variant="h1">Rally</Text>
          <Text variant="lead" className="text-center">
            One app. Every game.{'\n'}Play together.
          </Text>
        </View>
      </View>

      <View className="gap-3">
        {!config.supabaseConfigured && (
          <Card className="py-4">
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
            cornerRadius={8}
            style={{ height: 48, width: '100%' }}
            onPress={() => void continueWith('apple')}
          />
        )}

        <Button size="lg" variant="outline" className="h-12" disabled={!!busy} onPress={() => void continueWith('google')}>
          {busy === 'google' ? <ActivityIndicator /> : <Text className="text-base">Continue with Google</Text>}
        </Button>

        <Button size="lg" variant="secondary" className="h-12" disabled={!!busy} onPress={() => router.push('/sign-in')}>
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
