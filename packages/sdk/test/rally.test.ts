import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEventSchemas, parseEnvelope, type BridgeEnvelope } from '@rally/protocol';
import { Rally, truncate } from '../src/rally.ts';
import { RallyError } from '../src/errors.ts';

const NONCE = 'n'.repeat(32);

/** A fake shell: records what the game posts and lets the test answer requests. */
function fakeHost(opts: { requestTimeoutMs?: number; post?: (json: string) => void } = {}) {
  const sent: BridgeEnvelope[] = [];
  const host = { nonce: NONCE, version: 1, recv: (_json: string) => {} };
  const rally = new Rally({
    host,
    requestTimeoutMs: opts.requestTimeoutMs ?? 50,
    post:
      opts.post ??
      ((json) => {
        const env = parseEnvelope(json);
        assert.ok(env, 'the SDK posts valid envelopes');
        sent.push(env);
      }),
  });
  const respond = (id: string, params: unknown) =>
    host.recv(JSON.stringify({ v: 1, nonce: NONCE, id, kind: 'res', method: 'x', params }));
  return { rally, sent, respond };
}

const launch = {
  game: { id: 'demo', version: '1.0.0' },
  user: { id: 'u', username: 'alice', avatarUrl: null },
  intent: 'solo',
  device: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, orientation: 'portrait', pixelRatio: 2, locale: 'en' },
};

test('reportError cuts message and stack to the protocol limits so the host accepts the event', () => {
  const { rally, sent } = fakeHost();
  const err = new Error('m'.repeat(5000));
  err.stack = 's'.repeat(20_000);
  rally.reportError(err);
  const evt = sent.at(-1)!;
  assert.equal(evt.kind, 'evt');
  assert.equal(evt.method, 'game.error');
  const parsed = GameEventSchemas['game.error'].safeParse(evt.params);
  assert.ok(parsed.success, 'within the limits the host validates');
  const p = evt.params as { message: string; stack: string };
  assert.equal(p.message.length, 2000);
  assert.ok(p.message.endsWith('…'));
  assert.equal(p.stack.length, 8000);

  rally.reportError('plain string');
  assert.deepEqual(sent.at(-1)!.params && (sent.at(-1)!.params as { message: string }).message, 'plain string');
});

test('truncate never splits a surrogate pair', () => {
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'ab…');
  assert.equal(truncate('a😀b', 3), 'a…');
  assert.equal(truncate('a😀bc', 4), 'a😀…');
});

test('a response that arrives after the timeout is ignored (no double settle)', async () => {
  const { rally, sent, respond } = fakeHost({ requestTimeoutMs: 20 });
  const p = rally.ping();
  await assert.rejects(p, (e: unknown) => e instanceof RallyError && e.code === 'TIMEOUT');
  assert.doesNotThrow(() => respond(sent[0]!.id, { t: 0, hostTime: 1 }));
});

test('a failed ready() is not cached: the game can retry the handshake', async () => {
  const { rally, sent, respond } = fakeHost({ requestTimeoutMs: 20 });
  await assert.rejects(rally.ready(), (e: unknown) => e instanceof RallyError && e.code === 'TIMEOUT');
  const second = rally.ready();
  assert.equal(rally.ready(), second, 'idempotent while pending');
  respond(sent.at(-1)!.id, launch);
  assert.equal((await second).user.username, 'alice');
  assert.equal(sent.filter((e) => e.method === 'ready').length, 2);
});

test('a post that throws settles the request at once', async () => {
  const { rally } = fakeHost({
    requestTimeoutMs: 60_000,
    post: () => {
      throw new Error('gone');
    },
  });
  await assert.rejects(rally.ping(), (e: unknown) => e instanceof RallyError && e.code === 'NO_HOST');
});
