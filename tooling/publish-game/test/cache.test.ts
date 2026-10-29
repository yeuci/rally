import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL, cacheControlFor } from '../src/cache.ts';
import { contentTypeFor, publicObjectUrl } from '../src/plan.ts';

test('cache-control: entry document short, everything else immutable', () => {
  assert.equal(ENTRY_CACHE_CONTROL, 'public, max-age=60');
  assert.equal(IMMUTABLE_CACHE_CONTROL, 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('index.html'), 'public, max-age=60');
  assert.equal(cacheControlFor('assets/index-DB6uUof8.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('levels/index.html'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('play.html', 'play.html'), 'public, max-age=60');
  assert.equal(cacheControlFor('index.html', 'play.html'), 'public, max-age=31536000, immutable');
});

test('content types come from mime, text types with a charset', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('assets/a.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('assets/a.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('a.json'), 'application/json; charset=utf-8');
  assert.equal(contentTypeFor('m.glb'), 'model/gltf-binary');
  assert.equal(contentTypeFor('t.ktx2'), 'image/ktx2');
  assert.equal(contentTypeFor('e.wasm'), 'application/wasm');
  assert.equal(contentTypeFor('noext'), 'application/octet-stream');
});

test('public URLs follow the Supabase Storage public-object shape', () => {
  assert.equal(
    publicObjectUrl('https://abc.supabase.co/', 'games', 'spike/0.1.0/index.html'),
    'https://abc.supabase.co/storage/v1/object/public/games/spike/0.1.0/index.html',
  );
  assert.equal(
    publicObjectUrl('http://127.0.0.1:54321', 'games', 'x/1.0.0/a b.png'),
    'http://127.0.0.1:54321/storage/v1/object/public/games/x/1.0.0/a%20b.png',
  );
});
