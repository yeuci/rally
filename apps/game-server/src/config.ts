/**
 * Game-server configuration from the environment (architecture §6, §8). The README's Environment table is the
 * reference; in short:
 *
 * | Variable                 | Meaning                                                                                  |
 * | ------------------------ | ---------------------------------------------------------------------------------------- |
 * | `NODE_ENV`               | `development` (set by `pnpm dev:server`) or `test` (mocha) relax the defaults below.    |
 * |                          | Anything else, including unset, gets the production defaults.                           |
 * | `SUPABASE_URL`           | Project URL; JWTs are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`.  |
 * | `SUPABASE_ANON_KEY`      | Public anon key, required with `SUPABASE_URL`: reads the player's own `profiles` row.   |
 * | `SUPABASE_JWT_SECRET`    | Optional legacy HS256 secret, for projects that still sign with the shared secret.     |
 * | `RALLY_ALLOW_GUESTS`     | `1`/`0`. Default `1` in development and test, `0` otherwise.                             |
 * | `RALLY_DEV_RULES`        | `1`: honour client-supplied match `rules` (always on under `NODE_ENV=test`).           |
 * | `RALLY_CORS_ORIGINS`     | `*` or a comma-separated origin list. Default `*` in development and test, none else.  |
 * | `RALLY_MONITOR_PASSWORD` | Mounts /monitor and the playground behind basic auth (any environment).                 |
 *
 * Production without guests requires `SUPABASE_URL` (or the legacy secret): the server refuses to start otherwise.
 */
export type ServerMode = 'development' | 'test' | 'production';

export interface ServerConfig {
  mode: ServerMode;
  /** `mode === 'production'`: NODE_ENV is neither `development` nor `test` (unset counts as production). */
  production: boolean;
  /** Without a trailing slash. */
  supabaseUrl: string | undefined;
  /** Public anon key: `apikey` for the PostgREST profile lookup (with the player's own token). */
  supabaseAnonKey: string | undefined;
  jwtSecret: string | undefined;
  allowGuests: boolean;
  /** Rooms may take client-supplied rules (shorter matches in tests). */
  devRules: boolean;
  /** Origins that get `Access-Control-Allow-Origin`; `'*'` = any (no credentials either way). */
  corsOrigins: '*' | string[];
  /** Basic-auth password for /monitor and the playground; unset = localhost-only in development, else off. */
  monitorPassword: string | undefined;
}

function flag(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  return v === '1' || v === 'true' || v === 'yes';
}

function parseOrigins(value: string | undefined, fallback: '*' | string[]): '*' | string[] {
  const v = value?.trim();
  if (v === undefined || v === '') return fallback;
  if (v === '*') return '*';
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let origin: string;
      try {
        origin = new URL(s).origin;
      } catch {
        throw new Error(`RALLY_CORS_ORIGINS: "${s}" is not an origin (expected e.g. https://play.example.com)`);
      }
      if (origin === 'null') throw new Error(`RALLY_CORS_ORIGINS: "${s}" is not an http(s) origin`);
      return origin;
    });
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV?.trim();
  const mode: ServerMode = nodeEnv === 'development' ? 'development' : nodeEnv === 'test' ? 'test' : 'production';
  const production = mode === 'production';
  const allowGuests = flag(env.RALLY_ALLOW_GUESTS) ?? !production;
  const supabaseUrl = env.SUPABASE_URL?.trim().replace(/\/+$/, '') || undefined;
  const supabaseAnonKey = env.SUPABASE_ANON_KEY?.trim() || undefined;
  const jwtSecret = env.SUPABASE_JWT_SECRET?.trim() || undefined;
  if (supabaseUrl && !/^https?:\/\//.test(supabaseUrl)) {
    throw new Error(`SUPABASE_URL must be an http(s) URL, got "${supabaseUrl}"`);
  }
  if (supabaseUrl && !supabaseAnonKey) {
    throw new Error(
      'SUPABASE_ANON_KEY is required when SUPABASE_URL is set (the public anon key, same value as the app’s ' +
        'EXPO_PUBLIC_SUPABASE_ANON_KEY): usernames are read from profiles, never from token metadata',
    );
  }
  if (production && !allowGuests && !supabaseUrl && !jwtSecret) {
    throw new Error('SUPABASE_URL is required in production (or set RALLY_ALLOW_GUESTS=1 to admit guests only)');
  }
  return {
    mode,
    production,
    supabaseUrl,
    supabaseAnonKey,
    jwtSecret,
    allowGuests,
    devRules: mode === 'test' || (flag(env.RALLY_DEV_RULES) ?? false),
    corsOrigins: parseOrigins(env.RALLY_CORS_ORIGINS, production ? [] : '*'),
    monitorPassword: env.RALLY_MONITOR_PASSWORD || undefined,
  };
}

let cached: ServerConfig | null = null;

/** The process configuration, read once (app.config.ts reads it at startup, so a bad config fails fast). */
export function serverConfig(): ServerConfig {
  return (cached ??= readServerConfig());
}

/** One line for the startup log, without secrets. */
export function describeConfig(c: ServerConfig): string {
  const verify = [c.supabaseUrl ? `JWKS ${c.supabaseUrl}` : null, c.jwtSecret ? 'HS256 secret' : null].filter(Boolean);
  const cors = c.corsOrigins === '*' ? 'any origin' : c.corsOrigins.length ? c.corsOrigins.join(' ') : 'none';
  const monitor = c.monitorPassword ? 'password' : c.mode === 'development' ? 'localhost only' : 'off';
  return [
    `${c.mode} mode`,
    `auth: ${verify.length ? verify.join(' + ') : 'no verifier configured'}`,
    `profiles: ${c.supabaseUrl && c.supabaseAnonKey ? 'from Supabase' : 'not configured'}`,
    `guests ${c.allowGuests ? 'allowed' : 'refused'}`,
    ...(c.devRules ? ['client rules honoured'] : []),
    `CORS: ${cors}`,
    `monitor: ${monitor}`,
  ].join(', ');
}
