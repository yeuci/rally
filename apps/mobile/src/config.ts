import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import { bugReportsEnabled } from '@/lib/bug-report-model';
import { normalizeWebOrigin } from '@/lib/share';

/** Build-time configuration. EXPO_PUBLIC_* variables are inlined by Metro. */
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const config = {
  supabaseUrl,
  supabaseAnonKey,
  /** False when the env vars are missing: auth screens say so and only the Developer page works. */
  supabaseConfigured: supabaseUrl.length > 0 && supabaseAnonKey.length > 0,
  colyseusUrl: (process.env.EXPO_PUBLIC_COLYSEUS_URL ?? 'http://localhost:2567').replace(/\/$/, ''),
  /** The web catalog's origin (apps/web `SITE_ORIGIN`): the game page's Share adds `<origin>/game/<id>` when set. */
  webOrigin: normalizeWebOrigin(process.env.EXPO_PUBLIC_WEB_ORIGIN),
  spikeBundleUrl: process.env.EXPO_PUBLIC_SPIKE_BUNDLE_URL ?? 'http://localhost:5180/index.html',
  /**
   * The Developer page (`/dev`) and its game launcher. On in __DEV__ and in Expo Go (never a store build, and
   * `pnpm app:fast` runs release JS there); opt-in for internal preview builds.
   */
  devTools: __DEV__ || isRunningInExpoGo() || process.env.EXPO_PUBLIC_DEV_TOOLS === '1',
  /**
   * Shake to report a bug, the log buffer and Settings → Developer (docs/bug-reports.md). Always on in __DEV__ and in
   * Expo Go (also with `pnpm app:fast`); opt-in for playtest builds with EXPO_PUBLIC_BUG_REPORTS=1; off in store builds.
   */
  bugReports: bugReportsEnabled(__DEV__ || isRunningInExpoGo(), process.env.EXPO_PUBLIC_BUG_REPORTS),
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? 'support@example.com',
  /** Compared against `games.min_app_version` / `manifest.minAppVersion`. */
  appVersion: Constants.expoConfig?.version ?? '0.0.0',
};

/** `http(s)://host` → `ws(s)://host` for the game's WebSocket endpoint. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
