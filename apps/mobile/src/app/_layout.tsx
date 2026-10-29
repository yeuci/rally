import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0b1019' },
          headerTintColor: '#f8fafc',
          contentStyle: { backgroundColor: '#0b1019' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Rally · M0 spike' }} />
        <Stack.Screen
          name="game/[id]"
          options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}
