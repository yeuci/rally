import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostBridge, HostError, bundleBasePath, isUrlInsideBundle } from '../src/game-host/bridge';
import { BUNDLE, NONCE, Outbox, evt, req } from './helpers';

function makeBridge(handlers: ConstructorParameters<typeof HostBridge>[0]['handlers'] = {}) {
  const out = new Outbox();
  const drops: string[] = [];
  const events: unknown[] = [];
  const bridge = new HostBridge({
    nonce: NONCE,
    bundleUrl: BUNDLE,
    deliver: out.deliver,
    handlers,
    onGameEvent: (e) => events.push(e),
    onDrop: (reason) => drops.push(reason),
  });
  return { bridge, out, drops, events };
}

test('isInsideBundle pins the bundle directory', () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.isInsideBundle('https://cdn.example.com/games/spike/0.1.0/assets/a.js'), true);
  assert.equal(bridge.isInsideBundle('https://cdn.example.com/games/other/1.0.0/index.html'), false);
  assert.equal(bridge.isInsideBundle('https://evil.example.com/games/spike/0.1.0/index.html'), false);
  assert.equal(bridge.isInsideBundle('about:blank'), true);
});

test('isUrlInsideBundle is the only navigation gate: http(s) under the bundle directory, nothing else', () => {
  const base = bundleBasePath(BUNDLE);
  assert.equal(base, 'https://cdn.example.com/games/spike/0.1.0/');
  const ok = (url: string) => isUrlInsideBundle(url, base);
  assert.equal(ok(BUNDLE), true);
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/level2.html?x=1#top'), true);
  assert.equal(ok('about:blank'), true);
  // Other directories, hosts, and look-alike hosts
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.1/index.html'), false);
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0'), false);
  assert.equal(ok('https://cdn.example.com.evil.com/games/spike/0.1.0/index.html'), false);
  assert.equal(ok('https://cdn.example.com@evil.com/games/spike/0.1.0/index.html'), false);
  assert.equal(ok('http://cdn.example.com/games/spike/0.1.0/index.html'), false, 'scheme downgrade');
  // Dot segments that resolve outside the directory
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/../../other/index.html'), false);
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/%2e%2e/x.html'), false);
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/.%2E/x.html'), false);
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/a/..'), false);
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/x.html?next=../../y'), true, 'dots in the query are fine');
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/..\\..\\x.html'), false, 'backslash');
  assert.equal(ok('https://cdn.example.com/games/spike/0.1.0/.\n./x.html'), false, 'control characters');
  // Non-http(s) schemes never load (and with originWhitelist ['*'] are never handed to Linking.openURL)
  for (const url of [
    'rally://game/other/play',
    'exp://192.168.1.10:8081/--/profile',
    'tel:+15555550100',
    'sms:+15555550100',
    'mailto:a@example.com',
    'intent://scan/#Intent;scheme=zxing;end',
    'itms-apps://apps.apple.com/app/id1',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'blob:https://cdn.example.com/games/spike/0.1.0/uuid',
    'file:///etc/hosts',
    'about:srcdoc',
    '',
  ]) {
    assert.equal(ok(url), false, url);
  }
  assert.equal(isUrlInsideBundle(BUNDLE, 'rally://x/'), false, 'a non-http base path allows nothing');
});

test('drops messages with a bad origin, bad nonce or bad envelope', async () => {
  const { bridge, out, drops } = makeBridge({ ping: ({ t }) => ({ t, hostTime: 1 }) });
  bridge.handleMessage(req('ping', { t: 1 }), 'https://evil.example.com/x.html');
  bridge.handleMessage(req('ping', { t: 1 }, 'ffffffffffffffffffffffffffffffff'), BUNDLE);
  bridge.handleMessage('{not json', BUNDLE);
  bridge.handleMessage(req('ping', { t: 1 }), undefined);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(out.sent.length, 0);
  assert.equal(drops.length, 4);
});

test('answers UNKNOWN_METHOD, NOT_SUPPORTED, INVALID_PARAMS', async () => {
  const { bridge, out } = makeBridge({ ping: ({ t }) => ({ t, hostTime: 1 }) });
  const unknown = req('nope.nope');
  bridge.handleMessage(unknown, BUNDLE);
  assert.equal((await out.response(unknown)).error?.code, 'UNKNOWN_METHOD');
  const unsupported = req('leaderboard.top', { boardId: 'x' });
  bridge.handleMessage(unsupported, BUNDLE);
  assert.equal((await out.response(unsupported)).error?.code, 'NOT_SUPPORTED');
  const invalid = req('ping', { t: 'soon' });
  bridge.handleMessage(invalid, BUNDLE);
  assert.equal((await out.response(invalid)).error?.code, 'INVALID_PARAMS');
});

test('handler results and HostErrors become responses; other errors become INTERNAL', async () => {
  const { bridge, out } = makeBridge({
    ping: ({ t }) => ({ t, hostTime: 42 }),
    'save.get': () => {
      throw new HostError('CONFLICT', 'nope');
    },
    'party.get': () => {
      throw new Error('boom');
    },
  });
  const ping = req('ping', { t: 7 });
  bridge.handleMessage(ping, BUNDLE);
  assert.deepEqual((await out.response(ping)).params, { t: 7, hostTime: 42 });
  const save = req('save.get', { slot: 'a' });
  bridge.handleMessage(save, BUNDLE);
  assert.deepEqual((await out.response(save)).error, { code: 'CONFLICT', message: 'nope' });
  const party = req('party.get');
  bridge.handleMessage(party, BUNDLE);
  assert.equal((await out.response(party)).error?.code, 'INTERNAL');
});

test('game events are validated and dispatched; host events carry the nonce', () => {
  const { bridge, out, events, drops } = makeBridge();
  bridge.handleMessage(evt('telemetry.report', { name: 'fps', values: { fps: 60 } }), BUNDLE);
  bridge.handleMessage(evt('telemetry.report', { name: 'fps' }), BUNDLE);
  assert.deepEqual(events, [{ method: 'telemetry.report', params: { name: 'fps', values: { fps: 60 } } }]);
  assert.equal(drops.length, 1);
  bridge.sendEvent('pause', {});
  assert.equal(out.sent[0]?.method, 'pause');
  assert.equal(out.sent[0]?.nonce, NONCE);
  bridge.close();
  bridge.sendEvent('resume', {});
  assert.equal(out.sent.length, 1);
});
