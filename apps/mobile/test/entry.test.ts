import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { expectedEntryHash, fetchEntryDocument } from '../src/game-host/entry';

const URL = 'https://cdn.example.com/storage/v1/object/public/games/stack/0.1.0/index.html';
const HTML = '<!doctype html>\n<html><head><meta charset="UTF-8" /></head><body>Leaderboard …</body></html>\n';
const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const serve = (body: string, status = 200, type = 'text/plain') =>
  (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

test('loads the entry served as text/plain, verifies its sha256 and derives the bundle directory as baseUrl', async () => {
  const doc = await fetchEntryDocument(URL, { expectedSha256: (await sha256(HTML)).toUpperCase(), digest: sha256, fetchImpl: serve(HTML) });
  assert.equal(doc.html, HTML);
  assert.equal(doc.baseUrl, 'https://cdn.example.com/storage/v1/object/public/games/stack/0.1.0/');
});

test('a document that does not match the catalog hash is refused', async () => {
  await assert.rejects(
    fetchEntryDocument(URL, { expectedSha256: await sha256(HTML), digest: sha256, fetchImpl: serve(HTML.replace('…', '...')) }),
    /integrity check/,
  );
});

test('HTTP errors, network errors and non-HTML bodies are reported by name', async () => {
  await assert.rejects(fetchEntryDocument(URL, { fetchImpl: serve('nope', 404) }), /HTTP 404 loading/);
  const offline = (async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;
  await assert.rejects(fetchEntryDocument(URL, { fetchImpl: offline }), /could not download the game: Network request failed/);
  await assert.rejects(fetchEntryDocument(URL, { fetchImpl: serve('{"error":"Bucket not found"}') }), /not an HTML document/);
});

test('without an expected hash (Developer launcher) no digest is needed', async () => {
  const doc = await fetchEntryDocument('http://10.0.0.201:5181/index.html', { fetchImpl: serve(HTML) });
  assert.equal(doc.baseUrl, 'http://10.0.0.201:5181/');
});

test('https entries are verified against the catalog hash; http dev servers are not', () => {
  assert.equal(expectedEntryHash(URL, 'abc'), 'abc');
  assert.equal(expectedEntryHash('http://10.0.0.201:5180/index.html', '0000000000000000000000000000000000000000000000000000000000000000'), null);
  assert.equal(expectedEntryHash(URL, null), null);
});
