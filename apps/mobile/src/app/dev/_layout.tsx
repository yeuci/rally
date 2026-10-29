import { Stack } from 'expo-router';

export default function DevLayout() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Developer' }} />
      <Stack.Screen
        name="play"
        options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
      />
    </Stack>
  );
}
