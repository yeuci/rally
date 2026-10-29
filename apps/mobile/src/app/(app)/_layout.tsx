import { Stack } from 'expo-router';

export const unstable_settings = { initialRouteName: 'index' };

export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="game/[id]/index" options={{ headerShown: false }} />
      <Stack.Screen
        name="game/[id]/play"
        options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
      />
      <Stack.Screen name="profile/index" options={{ title: 'Profile' }} />
      <Stack.Screen name="profile/edit" options={{ title: 'Edit profile' }} />
    </Stack>
  );
}
