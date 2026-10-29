import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Database } from '@rally/db';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import { config } from '@/config';

/**
 * The app's only Supabase client: anon key + the user's session, bounded by RLS (architecture §1, §8).
 *
 * The session lives in AsyncStorage. SecureStore caps values at ~2 KB and a Supabase session (access + refresh
 * token + user) is larger; splitting it across keys is not worth it for M1 since the refresh token is
 * single-use and rotated. PKCE is used for every redirect-based flow (Google OAuth, email links), with a flow id on
 * each redirect.
 */
export const supabase = createClient<Database>(
  // Placeholders keep the client constructible when .env is missing, so the Developer launcher still works.
  config.supabaseUrl || 'http://127.0.0.1:54321',
  config.supabaseAnonKey || 'missing-anon-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      // Tag every PKCE redirect with `sb_flow_id` so each exchange picks its own verifier even when several flows
      // are in flight (an abandoned Google attempt, a reset link, a confirmation link). Without it auth-js uses the
      // most recently stored verifier and burns the single-use code on a mismatch. Needs wildcard redirect URL
      // entries (`rally://**`, `exp://**`), which the auth setup already uses.
      experimental: { appendPkceFlowIdToRedirects: true },
    },
  },
);

// Refresh tokens only while the app is in the foreground (supabase-js guidance for React Native).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
  if (AppState.currentState === 'active') supabase.auth.startAutoRefresh();
}
