import { cleanAvatarUrl } from './auth.js';

/**
 * Display identity of a signed-in player, read from `public.profiles` (the source of truth: unique, validated
 * `^[A-Za-z0-9_]{3,20}$`, banned-word filtered). Never from the JWT's `user_metadata`, which the user can rewrite
 * at will with `supabase.auth.updateUser({ data })`.
 */
export interface Profile {
  username: string;
  avatarUrl: string | null;
}

/** Resolve a verified user's profile with their own access token; null when it cannot be read (never throws). */
export type ProfileLookup = (userId: string, accessToken: string) => Promise<Profile | null>;

export interface ProfileLookupOptions {
  supabaseUrl: string;
  /** The project's public anon key (PostgREST's `apikey`); the bearer token is the player's own. */
  anonKey: string;
  /** How long a profile is reused for the same user. Default 10 min. */
  ttlMs?: number;
  /** Per-request timeout. Default 3 s. */
  timeoutMs?: number;
  /** Profiles kept at most. Default 5000. */
  maxEntries?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

const PROFILE_USERNAME = /^[A-Za-z0-9_]{3,20}$/;

/**
 * `GET <SUPABASE_URL>/rest/v1/profiles?select=username,avatar_url&id=eq.<userId>` with `apikey: <anon key>` and the
 * player's `Authorization: Bearer <token>`: RLS lets every signed-in user (anonymous ones included) read their own
 * row. Results are cached per user id; failures are not cached, so the next join tries again.
 */
export function createProfileLookup(opts: ProfileLookupOptions): ProfileLookup {
  const base = opts.supabaseUrl.replace(/\/+$/, '');
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxEntries = opts.maxEntries ?? 5000;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const cache = new Map<string, { profile: Profile; expires: number }>();

  return async (userId, accessToken) => {
    const hit = cache.get(userId);
    if (hit && hit.expires > now()) return hit.profile;
    cache.delete(userId);

    const url = `${base}/rest/v1/profiles?select=username,avatar_url&id=eq.${encodeURIComponent(userId)}`;
    let profile: Profile | null = null;
    try {
      const res = await doFetch(url, {
        headers: { apikey: opts.anonKey, Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as unknown;
      const row = Array.isArray(rows) ? (rows[0] as { username?: unknown; avatar_url?: unknown } | undefined) : null;
      if (!row) throw new Error('no profile row');
      if (typeof row.username !== 'string' || !PROFILE_USERNAME.test(row.username)) {
        throw new Error('profile username has an unexpected format');
      }
      profile = { username: row.username, avatarUrl: cleanAvatarUrl(row.avatar_url) ?? null };
    } catch (err) {
      log(`[auth] profile lookup for ${userId} failed (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(userId, { profile, expires: now() + ttlMs });
    return profile;
  };
}
