import { Redirect, Stack } from 'expo-router';
import { useUniwind } from 'uniwind';
import { useSession } from '@/lib/auth/session';
import { NAV_THEME } from '@/lib/theme';

export const unstable_settings = { anchor: 'index' };

export default function AppLayout() {
  const { signedIn } = useSession();
  const { theme } = useUniwind();
  const nav = NAV_THEME[theme ?? 'dark'];
  // Signed out (or an unlinked anonymous session) never sees the app: back to the welcome screen.
  if (!signedIn) return <Redirect href="/welcome" />;
  return (
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
    </Stack>
  );
}
