import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostBridge, HostError } from '../src/game-host/bridge';
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
