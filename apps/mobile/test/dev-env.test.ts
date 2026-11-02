import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEALTH_TIMEOUT_MS,
  accountLabel,
  buildLabel,
  checkServerHealth,
  deviceLabel,
  healthSummary,
  hostOf,
  insetsLabel,
  osLabel,
  parseHealthz,
  parseVersions,
  serverBaseUrl,
  sizeLabel,
  versionLabel,
  type HealthFetch,
} from '../src/lib/dev-env-model';

test('a URL shows its host only: no credentials, path or query', () => {
  assert.equal(hostOf('https://abcd.supabase.co'), 'abcd.supabase.co');
  assert.equal(hostOf('https://ABCD.supabase.co/rest/v1?apikey=secret'), 'abcd.supabase.co');
  assert.equal(hostOf('http://user:secret@192.168.1.20:54321/'), '192.168.1.20:54321');
  assert.equal(hostOf('http://[::1]:2567'), '[::1]:2567');
  assert.equal(hostOf(''), null);
  assert.equal(hostOf(undefined), null);
  assert.equal(hostOf('not a url'), null);
});

test('build, version, OS, device, size, insets and account labels', () => {
  assert.equal(buildLabel(true, true), 'Dev JS · Expo Go');
  assert.equal(buildLabel(false, false), 'Release JS · Native build');
  assert.equal(versionLabel('0.1.0', '58.0.0'), '0.1.0 · SDK 58');
  assert.equal(versionLabel('0.1.0', undefined), '0.1.0');

  assert.equal(osLabel('ios', '18.1', '18.1'), 'iOS 18.1');
  assert.equal(osLabel('ios', '18.1', '18.1', 'iPadOS'), 'iPadOS 18.1');
  assert.equal(osLabel('android', '15', 35), 'Android 15');
  assert.equal(osLabel('android', null, 35), 'Android API 35');
  assert.equal(osLabel('ios', null, '17.5'), 'iOS 17.5');

  assert.equal(deviceLabel(false, 'iPhone 15 Pro'), 'Phone · iPhone 15 Pro');
  assert.equal(deviceLabel(true, null), 'Tablet');
  assert.equal(sizeLabel(393.4, 852), '393 × 852 pt');
  assert.equal(insetsLabel({ top: 59, right: 0, bottom: 34.2, left: 0 }), 't59 r0 b34 l0');

  assert.equal(accountLabel({ signedIn: true, userId: 'u1', username: 'sloth' }), '@sloth');
  assert.equal(accountLabel({ signedIn: true, userId: 'u1', username: null }), 'Signed in');
  assert.equal(accountLabel({ signedIn: false, userId: 'u1' }), 'Anonymous session');
  assert.equal(accountLabel({ signedIn: false, userId: null }), 'Signed out');
});

test('the server base URL is trimmed and must be http(s)', () => {
  assert.equal(serverBaseUrl(' http://192.168.1.20:2567/ '), 'http://192.168.1.20:2567');
  assert.equal(serverBaseUrl('https://app.colyseus.cloud'), 'https://app.colyseus.cloud');
  assert.equal(serverBaseUrl('ws://host:2567'), null);
  assert.equal(serverBaseUrl(''), null);
});

test('healthz and versions answers', () => {
  assert.deepEqual(parseHealthz(200, '{"ok":true,"serverVersion":5}'), { ok: true, serverVersion: 5, error: null });
  assert.deepEqual(parseHealthz(200, '{"ok":false}'), { ok: false, serverVersion: null, error: 'Unexpected answer' });
  assert.deepEqual(parseHealthz(200, '<html>'), { ok: false, serverVersion: null, error: 'Unexpected answer' });
  assert.deepEqual(parseHealthz(502, ''), { ok: false, serverVersion: null, error: 'HTTP 502' });
  assert.deepEqual(parseVersions(200, '{"serverVersion":5,"rooms":["hello","sumo",3]}'), {
    serverVersion: 5,
    rooms: ['hello', 'sumo'],
  });
  assert.equal(parseVersions(404, '{"rooms":[]}'), null);
  assert.equal(parseVersions(200, '{"serverVersion":5}'), null);
});

/** A fake server: answers per path, and a clock that moves 40 ms per request. */
function fakeServer(routes: Record<string, { status: number; body: string } | 'throw' | 'hang'>) {
  let t = 1000;
  const calls: string[] = [];
  const fetch: HealthFetch = (url, init) => {
    calls.push(url);
    const route = routes[new URL(url).pathname];
    if (!route || route === 'throw') return Promise.reject(new Error('Network request failed'));
    if (route === 'hang') {
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('Aborted'))),
      );
    }
    t += 40;
    return Promise.resolve({ status: route.status, text: () => Promise.resolve(route.body) });
  };
  return { fetch, now: () => t, calls };
}

test('a healthy server: OK, the latency of /healthz, its version and rooms', async () => {
  const server = fakeServer({
    '/healthz': { status: 200, body: '{"ok":true,"serverVersion":5}' },
    '/versions': { status: 200, body: '{"serverVersion":5,"rooms":["hello","sumo"]}' },
  });
  const h = await checkServerHealth('http://192.168.1.20:2567/', server);
  assert.deepEqual(server.calls.sort(), ['http://192.168.1.20:2567/healthz', 'http://192.168.1.20:2567/versions']);
  assert.equal(h.ok, true);
  assert.equal(typeof h.latencyMs, 'number');
  assert.equal(h.serverVersion, 5);
  assert.deepEqual(h.rooms, ['hello', 'sumo']);
  assert.equal(h.error, null);
  assert.match(healthSummary(h), /^OK · \d+ ms · v5$/);
});

test('an unreachable, failing or silent server is down with its reason; the check never throws', async () => {
  const down = await checkServerHealth('http://10.0.0.9:2567', fakeServer({}));
  assert.deepEqual(down, {
    ok: false,
    latencyMs: null,
    serverVersion: null,
    rooms: null,
    error: 'Network request failed',
  });
  assert.equal(healthSummary(down), 'Down · Network request failed');

  const failing = await checkServerHealth(
    'http://10.0.0.9:2567',
    fakeServer({
      '/healthz': { status: 503, body: '' },
      '/versions': { status: 200, body: '{"serverVersion":4,"rooms":[]}' },
    }),
  );
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'HTTP 503');
  assert.equal(failing.serverVersion, 4);
  assert.deepEqual(failing.rooms, []);

  const silent = await checkServerHealth('http://10.0.0.9:2567', {
    ...fakeServer({ '/healthz': 'hang', '/versions': 'hang' }),
    timeoutMs: 20,
  });
  assert.equal(silent.ok, false);
  assert.equal(silent.error, 'No answer within 20 ms');

  const bad = await checkServerHealth('ws://10.0.0.9:2567', fakeServer({}));
  assert.equal(bad.error, 'Not an http(s) URL');
  assert.equal(HEALTH_TIMEOUT_MS, 5000);
  assert.equal(healthSummary({ ok: true, latencyMs: null, serverVersion: null, rooms: null, error: null }), 'OK');
});
