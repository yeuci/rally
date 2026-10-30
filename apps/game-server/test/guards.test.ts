import assert from 'node:assert/strict';
import { adminGuard, basicAuth } from '../src/admin.js';
import { KeyedRateLimiter, clientAddress } from '../src/rateLimit.js';
import { corsHeadersFor } from '../src/routes.js';

/** Minimal Express req/res doubles for the admin middleware. */
function call(mw: ReturnType<typeof basicAuth>, req: { authorization?: string; remote?: string }) {
  const out = { status: 0, headers: {} as Record<string, string>, next: false };
  const res = {
    setHeader: (k: string, v: string) => (out.headers[k] = v),
    status(code: number) {
      out.status = code;
      return { send: () => undefined };
    },
  };
  mw(
    { headers: { authorization: req.authorization }, socket: { remoteAddress: req.remote } } as never,
    res as never,
    () => (out.next = true),
  );
  return out;
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('guards', () => {
  it('KeyedRateLimiter: a sliding window per key, bounded memory', () => {
    const l = new KeyedRateLimiter(2, 1000, 3);
    assert.deepEqual(
      [l.allow('a', 0), l.allow('a', 10), l.allow('a', 20), l.allow('b', 20)],
      [true, true, false, true],
    );
    assert.equal(l.allow('a', 1000), true, 'the first hit left the window');
    assert.equal(l.allow('a', 1005), false);
    for (const k of ['c', 'd', 'e', 'f']) assert.equal(l.allow(k, 5000), true, 'old keys are pruned');
    l.reset();
    assert.equal(l.allow('a', 1006), true);
  });

  it('clientAddress: the first hop of the proxy headers, else "direct"', () => {
    assert.equal(clientAddress({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }), '203.0.113.1');
    assert.equal(clientAddress(new Headers({ 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
    assert.equal(clientAddress({}), 'direct');
    assert.equal(clientAddress(undefined, '127.0.0.1'), '127.0.0.1');
  });

  it('CORS: listed origins are echoed, others get nothing, "*" allows any; never credentials', () => {
    assert.deepEqual(corsHeadersFor(['https://a.test'], 'https://a.test'), {
      'Access-Control-Allow-Origin': 'https://a.test',
    });
    assert.deepEqual(corsHeadersFor(['https://a.test'], 'https://evil.test'), {});
    assert.deepEqual(corsHeadersFor([], 'https://a.test'), {});
    assert.deepEqual(corsHeadersFor('*', 'http://10.0.0.201:5182'), { 'Access-Control-Allow-Origin': '*' });
    assert.deepEqual(corsHeadersFor('*', null), {});
  });

  it('monitor/playground: basic auth with RALLY_MONITOR_PASSWORD, else localhost-only in development, else off', () => {
    const pw = adminGuard({ mode: 'production', monitorPassword: 's3cret' })!;
    assert.equal(call(pw, { remote: '127.0.0.1' }).status, 401, 'password needed even from localhost');
    assert.equal(call(pw, { authorization: basic('admin', 'wrong') }).status, 401);
    assert.match(call(pw, {}).headers['WWW-Authenticate'] ?? '', /^Basic realm=/);
    assert.equal(call(pw, { authorization: basic('anyone', 's3cret') }).next, true);
    assert.equal(call(pw, { authorization: basic('x', 's3cret:with:colons') }).next, false);
    assert.equal(call(basicAuth('a:b'), { authorization: basic('x', 'a:b') }).next, true);

    const dev = adminGuard({ mode: 'development', monitorPassword: undefined })!;
    assert.equal(call(dev, { remote: '127.0.0.1' }).next, true);
    assert.equal(call(dev, { remote: '::1' }).next, true);
    assert.equal(call(dev, { remote: '10.0.0.5' }).status, 403, 'not from the LAN');

    assert.equal(adminGuard({ mode: 'production', monitorPassword: undefined }), null);
    assert.equal(adminGuard({ mode: 'test', monitorPassword: undefined }), null);
  });
});
