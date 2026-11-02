import { Stack } from 'expo-router';
import { useUniwind } from 'uniwind';
import { DevPreviewHost } from '@/components/dev/preview-host';
import { CoinToastHost } from '@/components/rally/coins';
import { ToastHost } from '@/components/rally/toast';
import { NAV_THEME } from '@/lib/theme';

export default function DevLayout() {
  const { theme } = useUniwind();
  const nav = NAV_THEME[theme ?? 'dark'];
  return (
    <>
      <Stack
        screenOptions={{
          // Opaque header, like the (app) stack: the native default is translucent and content slides under it.
          headerStyle: { backgroundColor: nav.colors.background },
          headerTintColor: nav.colors.text,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: nav.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Developer' }} />
        <Stack.Screen
          name="play"
          options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
        />
      </Stack>
      {/* The Developer page's own toast and coin hosts (its copy confirmations, resets and UI previews): the (app)
          layout's hosts sit under this stack when signed in and are not mounted at all when signed out. */}
      <ToastHost />
      <CoinToastHost />
      {/* UI previews drawn at the top of the screen: the friend-request banner and the offline pill. */}
      <DevPreviewHost />
    </>
  );
}
