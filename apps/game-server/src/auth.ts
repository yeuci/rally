import { randomBytes } from 'node:crypto';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { ServerConfig } from './config.js';
import type { ProfileLookup } from './profiles.js';
import type { SanctionStatus, ServiceApi } from './supabase.js';

/**
 * Who a client is, as `client.auth` in every Rally room. Built by `RallyRoom.onAuth` at matchmaking time (the HTTP
 * `POST /matchmake/...` request) and carried inside the seat reservation, so the game bundle cannot change it.
 */
export interface RallyAuth {
  /** Supabase user id (`sub`), or `guest:<random>` for guests. Never taken from the client when a token is present. */
  userId: string;
  /**
   * Display name. Signed in: `profiles.username` (read server-side, see profiles.ts), else `user-<4 chars of id>`.
   * Guests: always `guest-<name>` (profile usernames cannot contain `-`, so a guest can never pose as a user).
   */
  username: string;
  /** http(s) URL or null: `profiles.avatar_url` for signed-in players, always null for guests. */
  avatarUrl: string | null;
  /** True for guests and for Supabase anonymous users: results are not recorded for them. */
  guest: boolean;
  /**
   * Present (true) only while the player has an active mute (`user_sanctions`, checked at matchmaking): rooms with
   * chat must not relay their messages. Reconnects keep the value from the original join.
   */
  muted?: true;
}

export class AuthError extends Error {
  override name = 'AuthError';
}

/**
 * What a verified token proves: who the user is. Deliberately no username or avatar: `user_metadata` is writable
 * by the user (`supabase.auth.updateUser({ data })`), so display names come from `profiles` instead.
 */
export interface VerifiedClaims {
  sub: string;
  /** Supabase anonymous sign-in (`is_anonymous`): a real user row, but treated as a guest for results. */
  anonymous: boolean;
}

export interface VerifierOptions {
  supabaseUrl?: string;
  jwtSecret?: string;
  /** Key source for RS256/ES256; default = the project's remote JWKS (cached, refetched on an unknown `kid`). */
  jwks?: JWTVerifyGetKey;
  /** Expected `aud`. Supabase user tokens carry `authenticated`. */
  audience?: string;
  /** Minimum time between JWKS refetches triggered by an unknown `kid`. Default 30 s. */
  jwksCooldownMs?: number;
  /** Accepted clock skew for `exp` / `nbf`, seconds. Default 60. */
  clockToleranceSec?: number;
}

const ASYMMETRIC = ['RS256', 'ES256'];

/** The JWKS URL Supabase publishes for asymmetric signing keys. */
export function jwksUrl(supabaseUrl: string): URL {
  return new URL(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`);
}

/**
 * Verify a Supabase access token. RS256/ES256 tokens are checked against the JWKS (jose caches the key set for
 * 10 minutes and refetches it, at most every 30 s, when a token names a `kid` it does not know — that is how key
 * rotation is picked up). HS256 tokens are accepted only when the legacy `SUPABASE_JWT_SECRET` is configured.
 * Issuer (`<SUPABASE_URL>/auth/v1`), audience (`authenticated`), expiry (60 s clock tolerance) and
 * `role = authenticated` are enforced, so the anon key (a JWT with `role: anon` and no `sub`) is not a user.
 */
export function createTokenVerifier(opts: VerifierOptions): (token: string) => Promise<VerifiedClaims> {
  const supabaseUrl = opts.supabaseUrl?.replace(/\/+$/, '');
  const issuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined;
  const audience = opts.audience ?? 'authenticated';
  const jwks =
    opts.jwks ??
    (supabaseUrl
      ? createRemoteJWKSet(jwksUrl(supabaseUrl), {
          cacheMaxAge: 10 * 60_000,
          cooldownDuration: opts.jwksCooldownMs ?? 30_000,
        })
      : undefined);
  const secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : undefined;
  const clockTolerance = opts.clockToleranceSec ?? 60;

  return async (token) => {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new AuthError('malformed token');
    }
    let payload: JWTPayload;
    try {
      if (alg === 'HS256') {
        if (!secret) throw new AuthError('HS256 token but SUPABASE_JWT_SECRET is not configured');
        ({ payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer, audience, clockTolerance }));
      } else if (alg && ASYMMETRIC.includes(alg)) {
        if (!jwks) throw new AuthError(`${alg} token but SUPABASE_URL is not configured`);
        ({ payload } = await jwtVerify(token, jwks, { algorithms: ASYMMETRIC, issuer, audience, clockTolerance }));
      } else {
        throw new AuthError(`unsupported alg ${String(alg)}`);
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(describeJoseError(err));
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthError('token has no sub');
    if (payload.role !== 'authenticated')
      throw new AuthError(`token role is ${String(payload.role)}, not authenticated`);
    return { sub: payload.sub, anonymous: payload.is_anonymous === true };
  };
}

function describeJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) return `claim "${err.claim}" invalid (${err.reason})`;
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'no JWKS key matches the token kid';
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'bad signature';
  if (err instanceof joseErrors.JOSEError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Display names from untrusted sources: control characters and angle brackets dropped, whitespace collapsed, ≤ 20. */
export function cleanUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value
    .replace(/[\p{C}<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20)
    .trim();
  return s.length > 0 ? s : undefined;
}

export function cleanAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const GUEST_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomTag(): string {
  return Array.from(randomBytes(4), (b) => GUEST_CHARS[b % GUEST_CHARS.length]).join('');
}

/**
 * A guest's display name: `guest-` + the requested name reduced to letters, digits and `_` (≤ 12), or a random
 * tag. Profile usernames match `^[A-Za-z0-9_]{3,20}$`, so a `guest-…` name can never equal a signed-in player's.
 */
export function guestName(requested?: unknown): string {
  const base = (cleanUsername(requested) ?? '')
    .normalize('NFKC')
    .replace(/^guest-/i, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, 12);
  return `guest-${base || randomTag()}`;
}

/** Display name of a signed-in player whose profile could not be read. */
export function fallbackUsername(userId: string): string {
  return `user-${userId.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || randomTag()}`;
}

/** A guest: random id, `guest-<name>` display name, no avatar (a guest-chosen URL is neither trusted nor fetched). */
export function guestIdentity(options: { username?: unknown } = {}): RallyAuth {
  return {
    userId: `guest:${randomBytes(9).toString('base64url')}`,
    username: guestName(options.username),
    avatarUrl: null,
    guest: true,
  };
}

/** True for `guest:<random>` identities (not for Supabase anonymous users, who have a real profile). */
export function isGuestId(userId: string): boolean {
  return userId.startsWith('guest:');
}

// ---- sanctions (design §5) ------------------------------------------------------------------------------------------

/** A user's sanctions, or null when they could not be read (the caller fails open). Never throws. */
export type SanctionLookup = (userId: string) => Promise<SanctionStatus | null>;

export interface SanctionLookupOptions {
  /** How long a user's status is reused. Default 60 s (an admin's new ban applies within a minute). */
  ttlMs?: number;
  /** Users kept at most. Default 5000. */
  maxEntries?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * `server_sanction_status` through the service role, cached per user for `ttlMs`. Failures are logged and not
 * cached, and return null: a Supabase outage must not lock everyone out (bans are also enforced by `heartbeat` and
 * `server_record_match`).
 */
export function createSanctionLookup(
  api: Pick<ServiceApi, 'sanctionStatus'>,
  opts: SanctionLookupOptions = {},
): SanctionLookup {
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 5000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const cache = new Map<string, { status: SanctionStatus; expires: number }>();
  return async (userId) => {
    const hit = cache.get(userId);
    if (hit && hit.expires > now()) return hit.status;
    cache.delete(userId);
    let status: SanctionStatus;
    try {
      status = await api.sanctionStatus(userId);
    } catch (err) {
      log(
        `[auth] sanction check for ${userId} failed, admitting (${err instanceof Error ? err.message : String(err)})`,
      );
      return null;
    }
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(userId, { status, expires: now() + ttlMs });
    return status;
  };
}

/** `AUTH_FAILED` message for a ban: `account suspended until 2026-11-02T14:00:00Z` (or `until further notice`). */
export function suspensionMessage(bannedUntil: number): string {
  return Number.isFinite(bannedUntil)
    ? `account suspended until ${new Date(bannedUntil).toISOString().replace(/\.\d{3}Z$/, 'Z')}`
    : 'account suspended until further notice';
}

export type Authenticate = (token: string | undefined, options: unknown) => Promise<RallyAuth>;

/**
 * The `onAuth` policy: a valid token → that user (`userId` = `sub`, display name and avatar from `profiles` through
 * `profiles`, else `user-<4 chars of id>`; anonymous users are flagged `guest`); no token or an invalid one → a guest
 * when guests are allowed, otherwise an `AuthError` (the matchmaking request fails with AUTH_FAILED). `options` are
 * the matchmaking body the shell or dev harness sent (`{ username? }`): only a guest's requested name is read.
 * With `sanctions`, a verified user with an active ban is refused (`account suspended until …`) and an active mute
 * sets `muted`; a failed lookup admits the player (fail open).
 */
export function createAuthenticator(
  config: { allowGuests: boolean; profiles?: ProfileLookup | null; sanctions?: SanctionLookup | null } & Partial<
    Pick<ServerConfig, 'supabaseUrl' | 'jwtSecret'>
  >,
  verifierOptions: Omit<VerifierOptions, 'supabaseUrl' | 'jwtSecret'> = {},
  log: (msg: string) => void = (m) => console.warn(m),
): Authenticate {
  const canVerify = Boolean(config.supabaseUrl || config.jwtSecret || verifierOptions.jwks);
  const verify = canVerify
    ? createTokenVerifier({ ...verifierOptions, supabaseUrl: config.supabaseUrl, jwtSecret: config.jwtSecret })
    : null;
  return async (token, rawOptions) => {
    const options = (rawOptions && typeof rawOptions === 'object' ? rawOptions : {}) as { username?: unknown };
    if (token) {
      let claims: VerifiedClaims;
      try {
        if (!verify) throw new AuthError('no verifier configured (set SUPABASE_URL)');
        claims = await verify(token);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!config.allowGuests) throw err instanceof AuthError ? err : new AuthError(reason);
        log(`[auth] token rejected (${reason}); joining as a guest`);
        return guestIdentity(options);
      }
      const [profile, sanctions] = await Promise.all([
        config.profiles ? config.profiles(claims.sub, token).catch(() => null) : null,
        config.sanctions ? config.sanctions(claims.sub).catch(() => null) : null,
      ]);
      const now = Date.now();
      // A verified but banned player is refused, never downgraded to a guest.
      if (sanctions?.bannedUntil != null && sanctions.bannedUntil > now) {
        throw new AuthError(suspensionMessage(sanctions.bannedUntil));
      }
      const auth: RallyAuth = {
        userId: claims.sub,
        username: profile?.username ?? fallbackUsername(claims.sub),
        avatarUrl: profile?.avatarUrl ?? null,
        guest: claims.anonymous,
      };
      if (sanctions?.mutedUntil != null && sanctions.mutedUntil > now) auth.muted = true;
      return auth;
    }
    if (!config.allowGuests) throw new AuthError('missing token');
    return guestIdentity(options);
  };
}
