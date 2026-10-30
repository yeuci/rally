import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/lib/auth/session';

export const unstable_settings = { initialRouteName: 'welcome' };

export default function AuthLayout() {
  const { signedIn } = useSession();
  if (signedIn) return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerTransparent: true, title: '', headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="age" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="check-email" options={{ headerShown: false }} />
    </Stack>
  );
}
