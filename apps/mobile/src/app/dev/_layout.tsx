import { Stack } from 'expo-router';
import { useUniwind } from 'uniwind';
import { NAV_THEME } from '@/lib/theme';

export default function DevLayout() {
  const { theme } = useUniwind();
  const nav = NAV_THEME[theme ?? 'dark'];
  return (
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
  );
}
