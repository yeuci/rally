import '../../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { isRunningInExpoGo } from 'expo';
import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useUniwind } from 'uniwind';
import { BugReportHost } from '@/components/rally/bug-report-sheet';
import { IntroOverlay, introPending } from '@/components/rally/intro-overlay';
import { OfflineBanner } from '@/components/rally/offline-banner';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import { installConsoleCapture, logBuffer } from '@/lib/log-buffer';
// Loaded at startup on purpose: reading the stored preferences applies the chosen appearance (Settings) early.
import '@/lib/prefs';
import { queryClient } from '@/lib/query-client';
import { NAV_THEME } from '@/lib/theme';
import { ViewportProvider } from '@/lib/viewport';

export { ErrorBoundary } from 'expo-router';

// Playtest builds keep the last ~200 warnings, errors and game host lines for bug reports (lib/log-buffer.ts).
if (config.bugReports) installConsoleCapture(console, logBuffer);

void SplashScreen.preventAutoHideAsync().catch(() => {});
// Hide the native splash instantly (Android fades it over 400 ms by default): the intro overlay underneath is
// pixel-identical, so a cut is invisible while a fade would ghost the static mark over the spinning one.
if (!isRunningInExpoGo()) SplashScreen.setOptions({ duration: 0, fade: false });

/**
 * Session gate: `(app)` needs a signed-in (non-anonymous) session, `(auth)` is for everyone else. `auth/*` holds the
 * deep-link targets (OAuth / email callbacks, password reset) and is reachable either way. `dev` is the M0
 * launcher, available without an account in dev builds.
 */
export default function RootLayout() {
  const { theme } = useUniwind();
  const nav = NAV_THEME[theme ?? 'dark'];
  const { initialized } = useSession();
  // Cold start only: the overlay takes over the native splash and hides it once it has drawn a frame.
  const [intro] = useState(introPending);

  useEffect(() => {
    if (initialized && !intro) void SplashScreen.hideAsync().catch(() => {});
  }, [initialized, intro]);

  if (!initialized) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ViewportProvider>
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
            {/* The gate itself lives in each group's layout as a <Redirect>: Stack.Protected on the root `/`
              route leaves the router with nothing to fall back to and renders "Unmatched Route". */}
            <Stack.Screen name="(app)" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="auth/callback" options={{ title: '', headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="auth/reset-password" options={{ title: 'New password' }} />
            <Stack.Protected guard={config.devTools}>
              <Stack.Screen name="dev" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
          <PortalHost />
          {/* "You're offline" under the status bar on every screen but a running game. */}
          <OfflineBanner />
          {/* Shake to report a bug (playtest builds); the play route mounts the in-game host. */}
          <BugReportHost placement="shell" />
          {intro && <IntroOverlay />}
        </ThemeProvider>
      </ViewportProvider>
    </QueryClientProvider>
  );
}
