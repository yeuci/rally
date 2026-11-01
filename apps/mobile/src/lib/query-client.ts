import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { onlineForQueries } from '@/lib/network-state';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
});

// React Native has no window focus: treat "app came to the foreground" as focus so stale queries refetch.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
}

// No network: queries and mutations pause instead of failing, and everything stale refetches when it comes back
// (refetchOnReconnect). Only "no network at all" counts (lib/network-state.ts); the banner also reads reachability.
onlineManager.setEventListener((setOnline) => NetInfo.addEventListener((state) => setOnline(onlineForQueries(state))));
