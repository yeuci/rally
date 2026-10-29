import { Stack } from 'expo-router';

export const unstable_settings = { initialRouteName: 'welcome' };

export default function AuthLayout() {
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
