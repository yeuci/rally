import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import {
  AuthError,
  cleanAvatarUrl,
  cleanUsername,
  createAuthenticator,
  createTokenVerifier,
  fallbackUsername,
  guestIdentity,
  guestName,
  jwksUrl,
} from '../src/auth.js';
import { readServerConfig } from '../src/config.js';
import { createProfileLookup, type ProfileLookup } from '../src/profiles.js';

const USER = '0b7f6f2e-6a51-4c39-9a8e-2b8f1b3c9d10';

interface Key {
  kid: string;
  alg: 'RS256' | 'ES256';
  privateKey: CryptoKey;
  jwk: JWK;
}

async function makeKey(kid: string, alg: 'RS256' | 'ES256'): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, jwk };
}

const ANON_KEY = 'anon-key-for-tests';

/**
 * A fake Supabase: serves /auth/v1/.well-known/jwks.json with whatever keys are in `published`, and PostgREST's
 * `GET /rest/v1/profiles?select=username,avatar_url&id=eq.<id>` from `profiles` (only with the anon key as `apikey`
 * and a Bearer token, like RLS would need).
 */
async function fakeSupabase(
  published: JWK[],
  profiles = new Map<string, { username: string; avatar_url: string | null }>(),
) {
  let hits = 0;
  const restCalls: { url: string; apikey: unknown; authorization: unknown }[] = [];
  let restStatus = 200;
  const server: Server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: published }));
    } else if (req.url?.startsWith('/rest/v1/profiles?')) {
      restCalls.push({ url: req.url, apikey: req.headers.apikey, authorization: req.headers.authorization });
      const id = new URL(req.url, 'http://x').searchParams.get('id')?.replace(/^eq\./, '') ?? '';
      const ok =
        restStatus === 200 && req.headers.apikey === ANON_KEY && /^Bearer \S+$/.test(req.headers.authorization ?? '');
      res.writeHead(ok ? 200 : restStatus === 200 ? 401 : restStatus, { 'content-type': 'application/json' });
      const row = profiles.get(id);
      res.end(JSON.stringify(ok ? (row ? [row] : []) : { message: 'nope' }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get hits() {
      return hits;
    },
    restCalls,
    set restStatus(code: number) {
      restStatus = code;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Claims {
  sub?: string;
  role?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  user_metadata?: Record<string, unknown>;
  is_anonymous?: boolean;
}

function sign(
  key: { privateKey: CryptoKey | Uint8Array; alg: string; kid?: string },
  issuer: string,
  claims: Claims = {},
) {
  const { sub = USER, role = 'authenticated', aud = 'authenticated', iss = issuer, exp, nbf, ...rest } = claims;
  const jwt = new SignJWT({ role, ...rest })
    .setProtectedHeader({ alg: key.alg, typ: 'JWT', ...(key.kid ? { kid: key.kid } : {}) })
    .setSubject(sub)
    .setAudience(aud)
    .setIssuer(iss)
    .setIssuedAt();
  if (nbf !== undefined) jwt.setNotBefore(nbf);
  if (exp !== undefined) jwt.setExpirationTime(exp);
  else jwt.setExpirationTime('1h');
  return jwt.sign(key.privateKey);
}

describe('auth', () => {
  let rsa: Key;
  let ec: Key;
  let rotated: Key;
  let supa: Awaited<ReturnType<typeof fakeSupabase>>;
  const published: JWK[] = [];

  before(async () => {
    rsa = await makeKey('rsa-1', 'RS256');
    ec = await makeKey('ec-1', 'ES256');
    rotated = await makeKey('ec-2', 'ES256');
    published.push(rsa.jwk, ec.jwk);
    supa = await fakeSupabase(published);
  });
  after(async () => supa.close());

  it('builds the JWKS URL from SUPABASE_URL', () => {
    assert.equal(jwksUrl('https://abc.supabase.co/').href, 'https://abc.supabase.co/auth/v1/.well-known/jwks.json');
  });

  it('verifies RS256 and ES256 tokens against the project JWKS; user_metadata is ignored', async () => {
    const verify = createTokenVerifier({ supabaseUrl: supa.url });
    const iss = `${supa.url}/auth/v1`;
    const a = await verify(
      await sign(rsa, iss, { user_metadata: { username: 'alice', avatar_url: 'https://x.test/a.png' } }),
    );
    assert.deepEqual(a, { sub: USER, anonymous: false });
    const b = await verify(await sign(ec, iss, { is_anonymous: true }));
    assert.deepEqual(b, { sub: USER, anonymous: true });
    assert.equal(supa.hits, 1, 'the key set is fetched once and cached');
  });

  it('refetches the JWKS when a token names an unknown kid (key rotation)', async () => {
    const verify = createTokenVerifier({ supabaseUrl: supa.url, jwksCooldownMs: 0 });
    const iss = `${supa.url}/auth/v1`;
    await verify(await sign(rsa, iss));
    const before = supa.hits;
    const token = await sign(rotated, iss);
    await assert.rejects(verify(token), (e: Error) => e instanceof AuthError && /kid/.test(e.message));
    published.push(rotated.jwk);
    const claims = await verify(token);
    assert.equal(claims.sub, USER);
    assert.ok(supa.hits > before, 'refetched');
  });

  it('rejects bad signatures, wrong issuer/audience, expired tokens, the anon role and tokens without sub', async () => {
    const verify = createTokenVerifier({ supabaseUrl: supa.url });
    const iss = `${supa.url}/auth/v1`;
    const forged = await makeKey('rsa-1', 'RS256'); // same kid, different key
    const cases: [string, Promise<string>, RegExp][] = [
      ['forged', sign(forged, iss), /signature/],
      ['issuer', sign(rsa, iss, { iss: 'https://evil.test/auth/v1' }), /iss/],
      ['audience', sign(rsa, iss, { aud: 'service' }), /aud/],
      ['expired', sign(rsa, iss, { exp: Math.floor(Date.now() / 1000) - 120 }), /expired/],
      ['not yet valid', sign(rsa, iss, { nbf: Math.floor(Date.now() / 1000) + 120 }), /nbf/],
      ['anon', sign(rsa, iss, { role: 'anon' }), /role/],
      ['no sub', sign(rsa, iss, { sub: '' }), /sub/],
    ];
    for (const [name, token, re] of cases) {
      await assert.rejects(verify(await token), (e: Error) => e instanceof AuthError && re.test(e.message), name);
    }
    await assert.rejects(verify('not.a.jwt'), AuthError);
  });

  it('tolerates 60 s of clock skew on exp and nbf', async () => {
    const verify = createTokenVerifier({ supabaseUrl: supa.url });
    const iss = `${supa.url}/auth/v1`;
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await verify(await sign(rsa, iss, { exp: now - 30 }))).sub, USER, 'expired 30 s ago');
    assert.equal((await verify(await sign(rsa, iss, { nbf: now + 30 }))).sub, USER, 'valid in 30 s');
  });

  it('accepts legacy HS256 tokens only when SUPABASE_JWT_SECRET is set', async () => {
    const secret = 'super-secret-jwt-token-with-at-least-32-characters';
    const key = { privateKey: new TextEncoder().encode(secret), alg: 'HS256' };
    const iss = `${supa.url}/auth/v1`;
    const token = await sign(key, iss, { user_metadata: { username: 'legacy' } });
    const withSecret = createTokenVerifier({ supabaseUrl: supa.url, jwtSecret: secret });
    assert.equal((await withSecret(token)).sub, USER);
    // Without SUPABASE_URL there is no issuer to check, the secret alone verifies.
    assert.equal((await createTokenVerifier({ jwtSecret: secret })(token)).sub, USER);
    await assert.rejects(createTokenVerifier({ supabaseUrl: supa.url })(token), /SUPABASE_JWT_SECRET/);
    await assert.rejects(createTokenVerifier({ jwtSecret: 'x'.repeat(40) })(token), /signature/);
  });

  describe('createAuthenticator', () => {
    const quiet = () => {};
    const fixed =
      (username: string, avatarUrl: string | null = null): ProfileLookup =>
      async () => ({ username, avatarUrl });

    it('a valid token is that user; the name and avatar come from profiles, never from metadata or options', async () => {
      const seen: [string, string][] = [];
      const profiles: ProfileLookup = async (id, token) => {
        seen.push([id, token]);
        return { username: 'alice', avatarUrl: 'https://cdn.test/alice.png' };
      };
      const auth = createAuthenticator({ supabaseUrl: supa.url, allowGuests: false, profiles }, {}, quiet);
      // Metadata says "bob" (the user can rewrite user_metadata with supabase.auth.updateUser); profiles say "alice".
      const token = await sign(rsa, `${supa.url}/auth/v1`, {
        user_metadata: { username: 'bob', avatar_url: 'https://x.test/b.png' },
      });
      const who = await auth(token, { userId: 'someone-else', username: 'mallory', avatarUrl: 'https://x.test/m.png' });
      assert.deepEqual(who, { userId: USER, username: 'alice', avatarUrl: 'https://cdn.test/alice.png', guest: false });
      assert.deepEqual(seen, [[USER, token]], 'looked up with the player’s own token');
    });

    it('without a readable profile a verified player is user-<4 chars of id>, whatever the token or options say', async () => {
      const token = await sign(rsa, `${supa.url}/auth/v1`, { user_metadata: { username: 'alice' } });
      for (const profiles of [null, async () => null, async () => Promise.reject(new Error('down'))]) {
        const auth = createAuthenticator({ supabaseUrl: supa.url, allowGuests: false, profiles }, {}, quiet);
        assert.deepEqual(await auth(token, { username: 'alice' }), {
          userId: USER,
          username: 'user-0b7f',
          avatarUrl: null,
          guest: false,
        });
      }
      assert.equal(fallbackUsername(USER), 'user-0b7f');
    });

    it('Supabase anonymous users keep their user id but count as guests (no results recorded)', async () => {
      const auth = createAuthenticator(
        { supabaseUrl: supa.url, allowGuests: false, profiles: fixed('user_1a2b3c4d') },
        {},
        quiet,
      );
      const who = await auth(await sign(ec, `${supa.url}/auth/v1`, { is_anonymous: true }), {});
      assert.deepEqual(who, { userId: USER, username: 'user_1a2b3c4d', avatarUrl: null, guest: true });
    });

    it('guests allowed: a missing or invalid token yields a guest named guest-<requested name>', async () => {
      const logs: string[] = [];
      const auth = createAuthenticator({ supabaseUrl: supa.url, allowGuests: true }, {}, (m) => logs.push(m));
      const g1 = await auth(undefined, {});
      assert.equal(g1.guest, true);
      assert.match(g1.userId, /^guest:[A-Za-z0-9_-]{12}$/);
      assert.match(g1.username, /^guest-[a-z0-9]{4}$/);
      assert.equal(g1.avatarUrl, null);
      const g2 = await auth('garbage', { username: '  Chrome  Tab ', avatarUrl: 'https://x.test/real-user.png' });
      assert.equal(g2.guest, true);
      assert.equal(g2.username, 'guest-ChromeTab');
      assert.equal(g2.avatarUrl, null, 'a guest cannot borrow an avatar');
      assert.notEqual(g1.userId, g2.userId);
      assert.equal(logs.length, 1);
      // A guest asking for a real user's name still gets the guest- prefix.
      assert.equal((await auth(undefined, { username: 'alice' })).username, 'guest-alice');
      // No verifier at all (no SUPABASE_URL in dev): a signed-in phone still plays, as a guest.
      const none = createAuthenticator({ allowGuests: true }, {}, quiet);
      assert.equal((await none(await sign(rsa, `${supa.url}/auth/v1`), {})).guest, true);
    });

    it('guests refused: no token or a bad token fails', async () => {
      const auth = createAuthenticator({ supabaseUrl: supa.url, allowGuests: false }, {}, quiet);
      await assert.rejects(auth(undefined, {}), /missing token/);
      await assert.rejects(auth('garbage', {}), AuthError);
    });
  });

  describe('createProfileLookup (PostgREST profiles with the player’s token)', () => {
    let rest: Awaited<ReturnType<typeof fakeSupabase>>;
    const rows = new Map([
      [USER, { username: 'alice', avatar_url: 'https://cdn.test/a.png' }],
      ['11111111-2222-3333-4444-555555555555', { username: 'bad-name', avatar_url: 'javascript:alert(1)' }],
      ['22222222-2222-3333-4444-555555555555', { username: 'bob', avatar_url: 'javascript:alert(1)' }],
    ]);
    before(async () => (rest = await fakeSupabase([], rows)));
    after(async () => rest.close());

    it('reads username and avatar with apikey = anon key and the player’s bearer token, cached per user', async () => {
      let t = 0;
      const lookup = createProfileLookup({
        supabaseUrl: `${rest.url}/`,
        anonKey: ANON_KEY,
        now: () => t,
        log: () => {},
      });
      rest.restCalls.length = 0;
      assert.deepEqual(await lookup(USER, 'tok-1'), { username: 'alice', avatarUrl: 'https://cdn.test/a.png' });
      assert.deepEqual(rest.restCalls, [
        {
          url: `/rest/v1/profiles?select=username,avatar_url&id=eq.${USER}`,
          apikey: ANON_KEY,
          authorization: 'Bearer tok-1',
        },
      ]);
      t += 9 * 60_000;
      await lookup(USER, 'tok-2');
      assert.equal(rest.restCalls.length, 1, 'cached for 10 minutes');
      t += 2 * 60_000;
      await lookup(USER, 'tok-3');
      assert.equal(rest.restCalls.length, 2, 'refetched after the TTL');
      assert.deepEqual(await lookup('22222222-2222-3333-4444-555555555555', 't'), { username: 'bob', avatarUrl: null });
    });

    it('returns null (not cached) for a missing row, a malformed username, a wrong key or a server error', async () => {
      const logs: string[] = [];
      const lookup = createProfileLookup({ supabaseUrl: rest.url, anonKey: ANON_KEY, log: (m) => logs.push(m) });
      assert.equal(await lookup('33333333-2222-3333-4444-555555555555', 't'), null);
      assert.equal(await lookup('11111111-2222-3333-4444-555555555555', 't'), null);
      const wrongKey = createProfileLookup({ supabaseUrl: rest.url, anonKey: 'nope', log: () => {} });
      assert.equal(await wrongKey(USER, 't'), null);
      rest.restStatus = 500;
      const fresh = createProfileLookup({ supabaseUrl: rest.url, anonKey: ANON_KEY, log: () => {} });
      assert.equal(await fresh(USER, 't'), null);
      rest.restStatus = 200;
      assert.equal((await fresh(USER, 't'))?.username, 'alice', 'a failure is not cached');
      assert.equal(logs.length, 2);
    });
  });

  it('cleans display names and avatar URLs from untrusted input', () => {
    assert.equal(cleanUsername(' a\u0000b<script> '), 'abscript');
    assert.equal(cleanUsername('x'.repeat(40)), 'x'.repeat(20));
    assert.equal(cleanUsername('   '), undefined);
    assert.equal(cleanUsername(42), undefined);
    assert.equal(cleanAvatarUrl('javascript:alert(1)'), undefined);
    assert.equal(cleanAvatarUrl('https://cdn.test/a.png'), 'https://cdn.test/a.png');
    assert.equal(guestIdentity({ username: 'Zed' }).username, 'guest-Zed');
    assert.equal(guestName('guest-Bob'), 'guest-Bob', 'no double prefix');
    assert.equal(guestName('Anna-Lena O’Brien'), 'guest-AnnaLenaOBri', '≤ 12 letters/digits/_ after the prefix');
    assert.equal(guestName('Zoë_2'), 'guest-Zoë_2');
    assert.match(guestName('<>  '), /^guest-[a-z0-9]{4}$/);
    // Never a valid profile username (^[A-Za-z0-9_]{3,20}$), so never a signed-in player's name.
    for (const n of ['alice', 'user_12345678', 'x'.repeat(30)])
      assert.doesNotMatch(guestName(n), /^[A-Za-z0-9_]{3,20}$/);
  });

  it('reads the config: relaxed defaults only under NODE_ENV=development/test, production otherwise', () => {
    assert.deepEqual(readServerConfig({ NODE_ENV: 'development' }), {
      mode: 'development',
      production: false,
      supabaseUrl: undefined,
      supabaseAnonKey: undefined,
      jwtSecret: undefined,
      allowGuests: true,
      devRules: false,
      corsOrigins: '*',
      monitorPassword: undefined,
    });
    // NODE_ENV unset (e.g. `node build/index.js` without the ecosystem file) is production: no guests, so the
    // missing SUPABASE_URL is fatal.
    assert.throws(() => readServerConfig({}), /SUPABASE_URL is required/);
    const env = { SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_ANON_KEY: 'anon' };
    const unset = readServerConfig(env);
    assert.equal(unset.mode, 'production');
    assert.equal(unset.allowGuests, false);
    assert.deepEqual(unset.corsOrigins, []);
    assert.equal(unset.devRules, false);
    assert.equal(unset.supabaseUrl, 'https://abc.supabase.co');
    assert.equal(unset.supabaseAnonKey, 'anon');
    const prod = readServerConfig({ NODE_ENV: 'production', ...env });
    assert.equal(prod.allowGuests, false);
    assert.equal(readServerConfig({ NODE_ENV: 'staging', ...env }).production, true);
    assert.throws(() => readServerConfig({ NODE_ENV: 'production' }), /SUPABASE_URL is required/);
    assert.equal(readServerConfig({ NODE_ENV: 'production', RALLY_ALLOW_GUESTS: '1' }).allowGuests, true);
    assert.equal(readServerConfig({ NODE_ENV: 'development', RALLY_ALLOW_GUESTS: '0' }).allowGuests, false);
    assert.throws(() => readServerConfig({ NODE_ENV: 'development', SUPABASE_URL: 'abc.supabase.co' }), /http/);
    assert.throws(
      () => readServerConfig({ NODE_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co' }),
      /SUPABASE_ANON_KEY is required/,
    );
    // Client-supplied match rules: tests, or explicitly.
    assert.equal(readServerConfig({ NODE_ENV: 'test' }).devRules, true);
    assert.equal(readServerConfig({ NODE_ENV: 'development', RALLY_DEV_RULES: '1' }).devRules, true);
    // CORS.
    assert.deepEqual(
      readServerConfig({ ...env, RALLY_CORS_ORIGINS: 'https://a.test/, http://10.0.0.2:5182' }).corsOrigins,
      ['https://a.test', 'http://10.0.0.2:5182'],
    );
    assert.equal(readServerConfig({ ...env, RALLY_CORS_ORIGINS: '*' }).corsOrigins, '*');
    assert.throws(() => readServerConfig({ ...env, RALLY_CORS_ORIGINS: 'not a url' }), /RALLY_CORS_ORIGINS/);
    assert.equal(readServerConfig({ ...env, RALLY_MONITOR_PASSWORD: 'pw' }).monitorPassword, 'pw');
  });
});
