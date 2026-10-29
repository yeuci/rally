import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

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
