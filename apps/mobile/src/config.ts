import Constants from 'expo-constants';

/** Build-time configuration. EXPO_PUBLIC_* variables are inlined by Metro. */
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const config = {
  supabaseUrl,
  supabaseAnonKey,
  /** False when the env vars are missing: auth screens say so and only the Developer launcher works. */
  supabaseConfigured: supabaseUrl.length > 0 && supabaseAnonKey.length > 0,
  colyseusUrl: (process.env.EXPO_PUBLIC_COLYSEUS_URL ?? 'http://localhost:2567').replace(/\/$/, ''),
  spikeBundleUrl: process.env.EXPO_PUBLIC_SPIKE_BUNDLE_URL ?? 'http://localhost:5180/index.html',
  /** Developer launcher (M0 spike path). Always on in __DEV__; opt-in for internal preview builds. */
  devTools: __DEV__ || process.env.EXPO_PUBLIC_DEV_TOOLS === '1',
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? 'support@example.com',
  /** Compared against `games.min_app_version` / `manifest.minAppVersion`. */
  appVersion: Constants.expoConfig?.version ?? '0.0.0',
};

/** `http(s)://host` → `ws(s)://host` for the game's WebSocket endpoint. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
