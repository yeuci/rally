import { useQueryClient } from '@tanstack/react-query';
import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { useUniwind } from 'uniwind';
import { AppDrawer } from '@/components/rally/app-drawer';
import { useSession } from '@/lib/auth/session';
import { recoverPlaySession } from '@/lib/launch';
import { NAV_THEME } from '@/lib/theme';

export const unstable_settings = { anchor: 'index' };

export default function AppLayout() {
  const { signedIn, userId } = useSession();
  const { theme } = useUniwind();
  const qc = useQueryClient();
  // A play session an earlier run left open (app killed while a game was in the background) is closed now.
  useEffect(() => {
    if (signedIn && userId) void recoverPlaySession(qc, userId);
  }, [signedIn, userId, qc]);
  const nav = NAV_THEME[theme ?? 'dark'];
  // Signed out (or an unlinked anonymous session) never sees the app: back to the welcome screen.
  if (!signedIn) return <Redirect href="/welcome" />;
  // The left drawer wraps the whole stack; it swipes open only on the dashboard (never over the game host).
  return (
    <AppDrawer>
      <Stack
        screenOptions={{
          // Opaque header: the native stack's default is translucent on recent iOS and content slides under it.
          headerStyle: { backgroundColor: nav.colors.background },
          headerTintColor: nav.colors.text,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: nav.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="game/[id]/index" options={{ headerShown: false }} />
        <Stack.Screen
          name="game/[id]/play"
          options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
        />
        <Stack.Screen name="profile/index" options={{ title: 'Profile' }} />
        <Stack.Screen name="profile/edit" options={{ title: 'Edit profile' }} />
        <Stack.Screen name="u/[username]" options={{ title: 'Player' }} />
        {/* Pushed from the dashboard pill; draws its own bar (search field + Cancel). */}
        <Stack.Screen name="search" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="friends" options={{ title: 'Friends' }} />
      </Stack>
    </AppDrawer>
  );
}
