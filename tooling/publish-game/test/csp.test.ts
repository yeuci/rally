import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsp, colyseusOrigins, originOf } from '../src/csp.ts';

test('buildCsp produces the exact documented policy', () => {
  const csp = buildCsp({
    cdnOrigin: 'https://abc.supabase.co',
    colyseusOrigins: colyseusOrigins(['https://eu.rally.colyseus.cloud']),
  });
  assert.equal(
    csp,
    "default-src 'self' https://abc.supabase.co; " +
      "script-src 'self' https://abc.supabase.co; " +
      "style-src 'self' 'unsafe-inline' https://abc.supabase.co; " +
      "img-src 'self' data: blob: https://abc.supabase.co; " +
      "font-src 'self' data: https://abc.supabase.co; " +
      "connect-src 'self' https://abc.supabase.co https://eu.rally.colyseus.cloud wss://eu.rally.colyseus.cloud ws: wss:; " +
      "worker-src 'self' blob:; " +
      "media-src 'self' blob: https://abc.supabase.co; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test('buildCsp without Colyseus origins still allows sockets via ws:/wss:', () => {
  const csp = buildCsp({ cdnOrigin: 'https://abc.supabase.co' });
  assert.match(csp, /connect-src 'self' https:\/\/abc\.supabase\.co ws: wss:;/);
});

test('colyseusOrigins: several URLs, comma lists, ws input, dedupe', () => {
  assert.deepEqual(
    colyseusOrigins(['http://localhost:2567/', 'wss://eu.example.com/path,https://eu.example.com', ' ']),
    ['http://localhost:2567', 'ws://localhost:2567', 'https://eu.example.com', 'wss://eu.example.com'],
  );
});

test('originOf strips paths and rejects junk', () => {
  assert.equal(originOf('https://abc.supabase.co/storage/v1'), 'https://abc.supabase.co');
  assert.equal(originOf('ws://127.0.0.1:2567'), 'ws://127.0.0.1:2567');
  assert.throws(() => originOf('abc.supabase.co'), /absolute URL/);
  assert.throws(() => originOf('ftp://x.example'), /scheme/);
});
