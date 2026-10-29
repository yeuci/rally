import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, GameManifestSchema, RequestSchemas } from '../src/index.ts';

const nonce = 'a'.repeat(32);

test('parseEnvelope accepts a valid request', () => {
  const env = parseEnvelope(JSON.stringify({ v: 1, nonce, id: '1', kind: 'req', method: 'ping', params: { t: 1 } }));
  assert.ok(env);
  assert.equal(env?.method, 'ping');
});

test('parseEnvelope rejects garbage, wrong version and short nonce', () => {
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(parseEnvelope(JSON.stringify({ v: 2, nonce, id: '1', kind: 'req', method: 'ping' })), null);
  assert.equal(parseEnvelope(JSON.stringify({ v: 1, nonce: 'short', id: '1', kind: 'req', method: 'ping' })), null);
});

test('ping params schema', () => {
  assert.ok(RequestSchemas.ping.params.safeParse({ t: 12 }).success);
  assert.equal(RequestSchemas.ping.params.safeParse({}).success, false);
});

test('manifest applies defaults and validates players', () => {
  const m = GameManifestSchema.parse({
    id: 'spike',
    version: '0.1.0',
    title: 'Spike',
    engine: 'playcanvas',
    players: { min: 1, max: 8 },
    modes: ['quick'],
    ageRating: '4+',
  });
  assert.equal(m.entry, 'index.html');
  assert.equal(m.orientation, 'any');
  assert.deepEqual(m.capabilities, []);
  assert.equal(
    GameManifestSchema.safeParse({ ...m, players: { min: 4, max: 2 } }).success,
    false,
  );
});
