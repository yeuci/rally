import '../../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useUniwind } from 'uniwind';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import { queryClient } from '@/lib/query-client';
import { NAV_THEME } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Session gate: `(app)` needs a signed-in (non-anonymous) session, `(auth)` is for everyone else. `auth/*` holds the
 * deep-link targets (OAuth / email callbacks, password reset) and is reachable either way. `dev` is the M0
 * launcher, available without an account in dev builds.
 */
export default function RootLayout() {
  const { theme } = useUniwind();
  const nav = NAV_THEME[theme ?? 'dark'];
  const { initialized, signedIn } = useSession();

  useEffect(() => {
    if (initialized) void SplashScreen.hideAsync().catch(() => {});
  }, [initialized]);

  if (!initialized) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={nav}>
        <StatusBar style={theme === 'light' ? 'dark' : 'light'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: nav.colors.background },
            headerTintColor: nav.colors.text,
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: nav.colors.background },
          }}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(app)" options={{ headerShown: false }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          </Stack.Protected>
          <Stack.Screen name="auth/callback" options={{ title: '', headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="auth/reset-password" options={{ title: 'New password' }} />
          <Stack.Protected guard={config.devTools}>
            <Stack.Screen name="dev" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
        <PortalHost />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
