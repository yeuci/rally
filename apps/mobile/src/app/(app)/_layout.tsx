import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/lib/auth/session';

export const unstable_settings = { initialRouteName: 'index' };

export default function AppLayout() {
  const { signedIn } = useSession();
  // Signed out (or an unlinked anonymous session) never sees the app: back to the welcome screen.
  if (!signedIn) return <Redirect href="/welcome" />;
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
