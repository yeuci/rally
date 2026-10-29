import '../../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { useUniwind } from 'uniwind';
import { NAV_THEME } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  const { theme } = useUniwind();
  const nav = NAV_THEME[theme ?? 'dark'];

  return (
    <ThemeProvider value={nav}>
      <StatusBar style={theme === 'light' ? 'dark' : 'light'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: nav.colors.card },
          headerTintColor: nav.colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: nav.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Rally' }} />
        <Stack.Screen
          name="game/[id]"
          options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
        />
      </Stack>
      <PortalHost />
    </ThemeProvider>
  );
}
