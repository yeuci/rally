/**
 * Pure rules behind the Developer page's Environment section (components/dev/environment-section.tsx): what each
 * row says about the build, the services and the device, and the game server's health check (fetch and the clock
 * injected). Nothing here reads a key or a token: the Supabase row shows the project's host only. No React Native
 * imports: test/dev-env.test.ts runs them under plain Node.
 */

/** "abcd.supabase.co" from "https://abcd.supabase.co/rest/v1?x": the host (and port) only, never credentials or a path. */
export function hostOf(url: string | null | undefined): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[0-9a-f:.]+\]|[^/:?#@\s]+)(?::(\d{1,5}))?/i.exec(
    (url ?? '').trim(),
  );
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  return m[2] ? `${host}:${m[2]}` : host;
}

/** "Dev JS · Expo Go", "Release JS · Native build". */
export function buildLabel(dev: boolean, expoGo: boolean): string {
  return `${dev ? 'Dev' : 'Release'} JS · ${expoGo ? 'Expo Go' : 'Native build'}`;
}

/** "0.1.0 · SDK 58" (the SDK only when known). */
export function versionLabel(appVersion: string, sdkVersion: string | null | undefined): string {
  const sdk = sdkVersion ? sdkVersion.split('.')[0] : null;
  return sdk ? `${appVersion} · SDK ${sdk}` : appVersion;
}

/**
 * "iOS 18.1", "iPadOS 18.1", "Android 15": expo-device's name and version when it has them, else React Native's
 * `Platform.Version` (on Android an API level, so "Android API 35").
 */
export function osLabel(
  os: string,
  osVersion: string | null | undefined,
  platformVersion: string | number,
  osName?: string | null,
): string {
  const name = osName || (os === 'ios' ? 'iOS' : os === 'android' ? 'Android' : os);
  if (osVersion) return `${name} ${osVersion}`;
  return os === 'android' ? `${name} API ${String(platformVersion)}` : `${name} ${String(platformVersion)}`;
}

/** "Phone · iPhone 15 Pro", "Tablet" (the model when known). */
export function deviceLabel(tablet: boolean, modelName: string | null | undefined): string {
  const kind = tablet ? 'Tablet' : 'Phone';
  return modelName ? `${kind} · ${modelName}` : kind;
}

/** "393 × 852 pt". */
export function sizeLabel(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)} pt`;
}

/** "t59 r0 b34 l0", the same order as the Show FPS readout (lib/viewport.tsx `ScreenReadout`). */
export function insetsLabel(insets: { top: number; right: number; bottom: number; left: number }): string {
  const n = (v: number) => String(Math.round(v));
  return `t${n(insets.top)} r${n(insets.right)} b${n(insets.bottom)} l${n(insets.left)}`;
}

/**
 * Who is signed in: "@sloth" (or "Signed in" while the profile loads), "Anonymous session" (an Apple or Google sign-up
 * that has not been linked yet, lib/auth/providers.ts), or "Signed out".
 */
export function accountLabel(s: { signedIn: boolean; userId: string | null; username?: string | null }): string {
  if (s.signedIn) return s.username ? `@${s.username}` : 'Signed in';
  return s.userId ? 'Anonymous session' : 'Signed out';
}

// --- the game server's health check --------------------------------------------------------------------------------

/** A check that has not answered by then counts as down. */
export const HEALTH_TIMEOUT_MS = 5000;

/**
 * What the game server's own endpoints say (apps/game-server/src/app.config.ts): `GET /healthz` → `{ ok, serverVersion }`
 * decides OK and the latency; `GET /versions` → `{ serverVersion, rooms }` adds the room types it serves.
 */
export interface ServerHealth {
  ok: boolean;
  /** Round trip of `/healthz` (ms), null when it never answered. */
  latencyMs: number | null;
  serverVersion: number | null;
  /** Room types from `/versions`; null when that request failed. */
  rooms: string[] | null;
  /** Why it is not OK. */
  error: string | null;
}

/** The slice of `fetch` the check uses (the global one in the app, a fake in tests). */
export type HealthFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** The server's base URL (trimmed, no trailing slash), or null when it is not an http(s) URL. */
export function serverBaseUrl(url: string): string | null {
  const base = url.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/i.test(base) ? base : null;
}

const json = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const version = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A `/healthz` answer: OK only for a 2xx with `{ ok: true }`. */
export function parseHealthz(
  status: number,
  text: string,
): { ok: boolean; serverVersion: number | null; error: string | null } {
  const body = obj(json(text));
  const serverVersion = version(body?.serverVersion);
  if (status < 200 || status >= 300) return { ok: false, serverVersion, error: `HTTP ${status}` };
  if (body?.ok !== true) return { ok: false, serverVersion, error: 'Unexpected answer' };
  return { ok: true, serverVersion, error: null };
}

/** A `/versions` answer → its room types and version; null for anything else. */
export function parseVersions(status: number, text: string): { serverVersion: number | null; rooms: string[] } | null {
  const body = obj(json(text));
  if (status < 200 || status >= 300 || !body || !Array.isArray(body.rooms)) return null;
  return {
    serverVersion: version(body.serverVersion),
    rooms: body.rooms.filter((r): r is string => typeof r === 'string'),
  };
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function getText(
  fetchFn: HealthFetch,
  url: string,
  timeoutMs: number,
  now: () => number,
): Promise<{ status: number; text: string; ms: number }> {
  // React Native's fetch has no timeout of its own: a server that never answers must still end the check.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const started = now();
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: abort.signal });
    const text = await res.text();
    return { status: res.status, text, ms: Math.max(0, Math.round(now() - started)) };
  } catch (err) {
    const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
    throw new Error(abort.signal.aborted ? `No answer within ${limit}` : messageOf(err));
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /healthz` and `GET /versions` side by side; never throws (a failure is a down server with its reason). */
export async function checkServerHealth(
  url: string,
  deps: { fetch: HealthFetch; now: () => number; timeoutMs?: number },
): Promise<ServerHealth> {
  const base = serverBaseUrl(url);
  if (!base) return { ok: false, latencyMs: null, serverVersion: null, rooms: null, error: 'Not an http(s) URL' };
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const [health, versions] = await Promise.allSettled([
    getText(deps.fetch, `${base}/healthz`, timeoutMs, deps.now),
    getText(deps.fetch, `${base}/versions`, timeoutMs, deps.now),
  ]);
  const listed = versions.status === 'fulfilled' ? parseVersions(versions.value.status, versions.value.text) : null;
  if (health.status === 'rejected') {
    return {
      ok: false,
      latencyMs: null,
      serverVersion: listed?.serverVersion ?? null,
      rooms: listed?.rooms ?? null,
      error: messageOf(health.reason),
    };
  }
  const h = parseHealthz(health.value.status, health.value.text);
  return {
    ok: h.ok,
    latencyMs: health.value.ms,
    serverVersion: h.serverVersion ?? listed?.serverVersion ?? null,
    rooms: listed?.rooms ?? null,
    error: h.error,
  };
}

/** "OK · 42 ms · v5", "Down · HTTP 502", "Down · No answer within 5 s". */
export function healthSummary(h: ServerHealth): string {
  if (!h.ok) return `Down · ${h.error ?? 'Unknown error'}`;
  const parts = ['OK'];
  if (h.latencyMs !== null) parts.push(`${h.latencyMs} ms`);
  if (h.serverVersion !== null) parts.push(`v${h.serverVersion}`);
  return parts.join(' · ');
}
