/**
 * Site configuration from environment variables. Anything Apple or Google will verify (team ID,
 * signing-cert fingerprints, the domain) falls back to an obvious placeholder plus a warning, so the
 * site always builds offline / in CI, and `--strict` (or WEB_STRICT=1) turns those warnings into a failure.
 */

/** iOS bundle identifier and Android package name (apps/mobile/app.json). */
export const IOS_BUNDLE_ID = 'app.rally.mobile';
export const ANDROID_PACKAGE = 'app.rally.mobile';
/** Custom URL scheme (apps/mobile/app.json `expo.scheme`). */
export const APP_SCHEME = 'rally';

export const PLACEHOLDER_ORIGIN = 'https://rally.example';
export const PLACEHOLDER_TEAM_ID = 'TEAMID0000';
/** 32 zero bytes: well-formed, never a real certificate. */
export const PLACEHOLDER_FINGERPRINT = Array.from({ length: 32 }, () => '00').join(':');
export const PLACEHOLDER_IOS_STORE_URL = 'https://apps.apple.com/';
export const DEFAULT_ANDROID_PLAY_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

/** Paths the app claims as Universal Links / App Links (docs/architecture.md §7). */
export const APP_LINK_PREFIXES = ['game', 'join', 'party', 'u', 'dm'] as const;
/** Of those, the ones with no static page: they fall back to /open/ (rewrite) or 404.html. */
export const APP_ONLY_PREFIXES = ['join', 'party', 'u', 'dm'] as const;

export interface SiteConfig {
  /** `https://<domain>` without a trailing slash: the domain in `applinks:<domain>`. */
  origin: string;
  appleTeamId: string;
  /** `<TEAM_ID>.app.rally.mobile`. */
  appleAppId: string;
  androidPackage: string;
  /** Upper-case, colon-separated SHA-256 fingerprints of the Android signing certificates. */
  androidFingerprints: string[];
  /** Numeric App Store ID for the Smart App Banner, when known. */
  iosAppId: string | undefined;
  iosStoreUrl: string;
  androidPlayUrl: string;
  scheme: string;
  supabase: { url: string; anonKey: string } | undefined;
}

export type Env = Record<string, string | undefined>;

export interface ResolveOptions {
  /** Default origin when SITE_ORIGIN is unset (the dev server), instead of the placeholder + warning. */
  devOrigin?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function read(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`SITE_ORIGIN "${raw}" is not a URL (expected e.g. https://rally.app)`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new ConfigError(`SITE_ORIGIN must be https:// (Apple and Google only verify HTTPS), got "${raw}"`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ConfigError(`SITE_ORIGIN must be an origin without a path, got "${raw}"`);
  }
  return url.origin;
}

/** Accepts `AA:BB:…` or bare hex (any case); returns upper-case colon-separated, or throws. */
export function normalizeFingerprint(raw: string): string {
  const hex = raw.trim().replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new ConfigError(
      `ANDROID_SHA256_FINGERPRINTS entry "${raw}" is not a SHA-256 fingerprint (32 hex bytes, e.g. 14:6D:E9:…)`,
    );
  }
  return hex.match(/../g)!.join(':');
}

export function parseFingerprints(raw: string): string[] {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeFingerprint);
  return [...new Set(list)];
}

function httpsUrl(key: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${key} "${raw}" is not a URL`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`${key} must be an https:// URL, got "${raw}"`);
  return url.href;
}

export function resolveConfig(env: Env, opts: ResolveOptions = {}): { config: SiteConfig; warnings: string[] } {
  const warnings: string[] = [];

  const rawOrigin = read(env, 'SITE_ORIGIN');
  let origin: string;
  if (rawOrigin) origin = normalizeOrigin(rawOrigin);
  else if (opts.devOrigin) origin = normalizeOrigin(opts.devOrigin);
  else {
    origin = PLACEHOLDER_ORIGIN;
    warnings.push(
      `SITE_ORIGIN is not set: using ${PLACEHOLDER_ORIGIN}. Universal Links and canonical URLs will point at a domain you do not own.`,
    );
  }

  let appleTeamId = read(env, 'APPLE_TEAM_ID');
  if (appleTeamId) {
    if (!/^[A-Z0-9]{10}$/.test(appleTeamId)) {
      throw new ConfigError(`APPLE_TEAM_ID must be the 10-character Apple Developer Team ID, got "${appleTeamId}"`);
    }
  } else {
    appleTeamId = PLACEHOLDER_TEAM_ID;
    warnings.push(
      `APPLE_TEAM_ID is not set: apple-app-site-association uses ${PLACEHOLDER_TEAM_ID}.${IOS_BUNDLE_ID}. iOS will NOT open Universal Links in the app.`,
    );
  }

  const rawFingerprints = read(env, 'ANDROID_SHA256_FINGERPRINTS');
  let androidFingerprints = rawFingerprints ? parseFingerprints(rawFingerprints) : [];
  if (androidFingerprints.length === 0) {
    androidFingerprints = [PLACEHOLDER_FINGERPRINT];
    warnings.push(
      'ANDROID_SHA256_FINGERPRINTS is not set: assetlinks.json uses an all-zero placeholder. Android App Links will NOT verify.',
    );
  }

  const iosAppId = read(env, 'IOS_APP_ID');
  if (iosAppId && !/^\d{6,12}$/.test(iosAppId)) {
    throw new ConfigError(`IOS_APP_ID must be the numeric App Store ID (e.g. 6740000000), got "${iosAppId}"`);
  }

  const rawIosStore = read(env, 'IOS_APP_STORE_URL');
  let iosStoreUrl: string;
  if (rawIosStore) iosStoreUrl = httpsUrl('IOS_APP_STORE_URL', rawIosStore);
  else if (iosAppId) iosStoreUrl = `https://apps.apple.com/app/id${iosAppId}`;
  else {
    iosStoreUrl = PLACEHOLDER_IOS_STORE_URL;
    warnings.push(
      `IOS_APP_STORE_URL (or IOS_APP_ID) is not set: the App Store button and the iOS fallback go to ${PLACEHOLDER_IOS_STORE_URL}.`,
    );
  }

  const rawPlay = read(env, 'ANDROID_PLAY_URL');
  const androidPlayUrl = rawPlay ? httpsUrl('ANDROID_PLAY_URL', rawPlay) : DEFAULT_ANDROID_PLAY_URL;

  const sbUrl = read(env, 'SUPABASE_URL');
  const sbKey = read(env, 'SUPABASE_ANON_KEY');
  let supabase: SiteConfig['supabase'];
  if (sbUrl && sbKey) supabase = { url: sbUrl, anonKey: sbKey };
  else if (sbUrl || sbKey) {
    warnings.push(
      `Only ${sbUrl ? 'SUPABASE_URL' : 'SUPABASE_ANON_KEY'} is set: both are needed for the live catalog, falling back to games/*/game.json.`,
    );
  }

  return {
    config: {
      origin,
      appleTeamId,
      appleAppId: `${appleTeamId}.${IOS_BUNDLE_ID}`,
      androidPackage: ANDROID_PACKAGE,
      androidFingerprints,
      iosAppId,
      iosStoreUrl,
      androidPlayUrl,
      scheme: APP_SCHEME,
      supabase,
    },
    warnings,
  };
}
