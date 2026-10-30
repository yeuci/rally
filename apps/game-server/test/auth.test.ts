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
  guestIdentity,
  jwksUrl,
} from '../src/auth.js';
import { readServerConfig } from '../src/config.js';

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

/** A fake Supabase: serves /auth/v1/.well-known/jwks.json with whatever keys are in `published`. */
async function fakeSupabase(published: JWK[]) {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: published }));
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
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Claims {
  sub?: string;
  role?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  user_metadata?: Record<string, unknown>;
  is_anonymous?: boolean;
}

function sign(
  key: { privateKey: CryptoKey | Uint8Array; alg: string; kid?: string },
  issuer: string,
  claims: Claims = {},
) {
  const { sub = USER, role = 'authenticated', aud = 'authenticated', iss = issuer, exp, ...rest } = claims;
  const jwt = new SignJWT({ role, ...rest })
    .setProtectedHeader({ alg: key.alg, typ: 'JWT', ...(key.kid ? { kid: key.kid } : {}) })
    .setSubject(sub)
    .setAudience(aud)
    .setIssuer(iss)
    .setIssuedAt();
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

  it('verifies RS256 and ES256 tokens against the project JWKS and reads the username claim', async () => {
    const verify = createTokenVerifier({ supabaseUrl: supa.url });
    const iss = `${supa.url}/auth/v1`;
    const a = await verify(
      await sign(rsa, iss, { user_metadata: { username: 'alice', avatar_url: 'https://x.test/a.png' } }),
    );
    assert.deepEqual(a, { sub: USER, username: 'alice', avatarUrl: 'https://x.test/a.png', anonymous: false });
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
      ['expired', sign(rsa, iss, { exp: Math.floor(Date.now() / 1000) - 60 }), /expired/],
      ['anon', sign(rsa, iss, { role: 'anon' }), /role/],
      ['no sub', sign(rsa, iss, { sub: '' }), /sub/],
    ];
    for (const [name, token, re] of cases) {
      await assert.rejects(verify(await token), (e: Error) => e instanceof AuthError && re.test(e.message), name);
    }
    await assert.rejects(verify('not.a.jwt'), AuthError);
  });

  it('accepts legacy HS256 tokens only when SUPABASE_JWT_SECRET is set', async () => {
    const secret = 'super-secret-jwt-token-with-at-least-32-characters';
    const key = { privateKey: new TextEncoder().encode(secret), alg: 'HS256' };
    const iss = `${supa.url}/auth/v1`;
    const token = await sign(key, iss, { user_metadata: { username: 'legacy' } });
    const withSecret = createTokenVerifier({ supabaseUrl: supa.url, jwtSecret: secret });
    assert.equal((await withSecret(token)).username, 'legacy');
    // Without SUPABASE_URL there is no issuer to check, the secret alone verifies.
    assert.equal((await createTokenVerifier({ jwtSecret: secret })(token)).sub, USER);
    await assert.rejects(createTokenVerifier({ supabaseUrl: supa.url })(token), /SUPABASE_JWT_SECRET/);
    await assert.rejects(createTokenVerifier({ jwtSecret: 'x'.repeat(40) })(token), /signature/);
  });

  describe('createAuthenticator', () => {
    const quiet = () => {};

    it('a valid token is that user; options never override the user id', async () => {
      const auth = createAuthenticator({ supabaseUrl: supa.url, allowGuests: false }, {}, quiet);
      const token = await sign(rsa, `${supa.url}/auth/v1`, { user_metadata: { username: 'alice' } });
      const who = await auth(token, { userId: 'someone-else', username: 'mallory', avatarUrl: 'https://x.test/m.png' });
      assert.deepEqual(who, { userId: USER, username: 'alice', avatarUrl: 'https://x.test/m.png', guest: false });
      // No username claim: the matchmaking option is the display name.
      const plain = await auth(await sign(rsa, `${supa.url}/auth/v1`), { username: 'bob' });
      assert.equal(plain.username, 'bob');
      assert.equal(plain.userId, USER);
    });

    it('guests allowed: a missing or invalid token yields a guest with the requested name', async () => {
      const logs: string[] = [];
      const auth = createAuthenticator({ supabaseUrl: supa.url, allowGuests: true }, {}, (m) => logs.push(m));
      const g1 = await auth(undefined, {});
      assert.equal(g1.guest, true);
      assert.match(g1.userId, /^guest:[A-Za-z0-9_-]{12}$/);
      assert.match(g1.username, /^guest-[a-z0-9]{4}$/);
      assert.equal(g1.avatarUrl, null);
      const g2 = await auth('garbage', { username: '  Chrome  Tab ' });
      assert.equal(g2.guest, true);
      assert.equal(g2.username, 'Chrome Tab');
      assert.notEqual(g1.userId, g2.userId);
      assert.equal(logs.length, 1);
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

  it('cleans display names and avatar URLs from untrusted input', () => {
    assert.equal(cleanUsername(' a\u0000b<script> '), 'abscript');
    assert.equal(cleanUsername('x'.repeat(40)), 'x'.repeat(20));
    assert.equal(cleanUsername('   '), undefined);
    assert.equal(cleanUsername(42), undefined);
    assert.equal(cleanAvatarUrl('javascript:alert(1)'), undefined);
    assert.equal(cleanAvatarUrl('https://cdn.test/a.png'), 'https://cdn.test/a.png');
    assert.equal(guestIdentity({ username: 'Zed' }).username, 'Zed');
  });

  it('reads the config: guests default on in development, off in production, SUPABASE_URL required there', () => {
    assert.deepEqual(readServerConfig({}), {
      production: false,
      supabaseUrl: undefined,
      jwtSecret: undefined,
      allowGuests: true,
    });
    const prod = readServerConfig({ NODE_ENV: 'production', SUPABASE_URL: 'https://abc.supabase.co/' });
    assert.equal(prod.allowGuests, false);
    assert.equal(prod.supabaseUrl, 'https://abc.supabase.co');
    assert.throws(() => readServerConfig({ NODE_ENV: 'production' }), /SUPABASE_URL is required/);
    assert.equal(readServerConfig({ NODE_ENV: 'production', RALLY_ALLOW_GUESTS: '1' }).allowGuests, true);
    assert.equal(readServerConfig({ RALLY_ALLOW_GUESTS: '0' }).allowGuests, false);
    assert.throws(() => readServerConfig({ SUPABASE_URL: 'abc.supabase.co' }), /http/);
  });
});
