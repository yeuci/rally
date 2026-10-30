/**
 * Game-server configuration from the environment (architecture §6, §8).
 *
 * | Variable              | Meaning                                                                                       |
 * | --------------------- | --------------------------------------------------------------------------------------------- |
 * | `SUPABASE_URL`        | Project URL; JWTs are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`.         |
 * | `SUPABASE_JWT_SECRET` | Optional legacy HS256 secret, for projects that still sign with the shared secret.            |
 * | `RALLY_ALLOW_GUESTS`  | `1`: a missing or invalid token joins as a guest. Default `1` unless `NODE_ENV=production`.     |
 *
 * Production without guests requires `SUPABASE_URL` (or the legacy secret): the server refuses to start otherwise.
 */
export interface ServerConfig {
  production: boolean;
  /** Without a trailing slash. */
  supabaseUrl: string | undefined;
  jwtSecret: string | undefined;
  allowGuests: boolean;
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const flag = env.RALLY_ALLOW_GUESTS?.trim().toLowerCase();
  const allowGuests = flag === undefined || flag === '' ? !production : flag === '1' || flag === 'true';
  const supabaseUrl = env.SUPABASE_URL?.trim().replace(/\/+$/, '') || undefined;
  const jwtSecret = env.SUPABASE_JWT_SECRET?.trim() || undefined;
  if (supabaseUrl && !/^https?:\/\//.test(supabaseUrl)) {
    throw new Error(`SUPABASE_URL must be an http(s) URL, got "${supabaseUrl}"`);
  }
  if (production && !allowGuests && !supabaseUrl && !jwtSecret) {
    throw new Error('SUPABASE_URL is required in production (or set RALLY_ALLOW_GUESTS=1 to admit guests only)');
  }
  return { production, supabaseUrl, jwtSecret, allowGuests };
}

/** One line for the startup log, without secrets. */
export function describeConfig(c: ServerConfig): string {
  const verify = [c.supabaseUrl ? `JWKS ${c.supabaseUrl}` : null, c.jwtSecret ? 'HS256 secret' : null].filter(Boolean);
  return `auth: ${verify.length ? verify.join(' + ') : 'no verifier configured'}, guests ${c.allowGuests ? 'allowed' : 'refused'}`;
}
