import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { expectedEntryHash, fetchEntryDocument, responseLength } from '../src/game-host/entry';

const URL = 'https://cdn.example.com/storage/v1/object/public/games/stack/0.1.0/index.html';
const HTML = '<!doctype html>\n<html><head><meta charset="UTF-8" /></head><body>Leaderboard …</body></html>\n';
const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const serve = (body: string, status = 200, type = 'text/plain') =>
  (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

test('loads the entry served as text/plain, verifies its sha256 and derives the bundle directory as baseUrl', async () => {
  const doc = await fetchEntryDocument(URL, {
    expectedSha256: (await sha256(HTML)).toUpperCase(),
    digest: sha256,
    fetchImpl: serve(HTML),
  });
  assert.equal(doc.html, HTML);
  assert.equal(doc.baseUrl, 'https://cdn.example.com/storage/v1/object/public/games/stack/0.1.0/');
});

test('a document that does not match the catalog hash is refused', async () => {
  await assert.rejects(
    fetchEntryDocument(URL, {
      expectedSha256: await sha256(HTML),
      digest: sha256,
      fetchImpl: serve(HTML.replace('…', '...')),
    }),
    /integrity check/,
  );
});

test('HTTP errors, network errors and non-HTML bodies are reported by name', async () => {
  await assert.rejects(fetchEntryDocument(URL, { fetchImpl: serve('nope', 404) }), /HTTP 404 loading/);
  const offline = (async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchEntryDocument(URL, { fetchImpl: offline }),
    /could not download the game: Network request failed/,
  );
  await assert.rejects(
    fetchEntryDocument(URL, { fetchImpl: serve('{"error":"Bucket not found"}') }),
    /not an HTML document/,
  );
});

test('without an expected hash (Developer launcher) no digest is needed', async () => {
  const doc = await fetchEntryDocument('http://10.0.0.201:5181/index.html', { fetchImpl: serve(HTML) });
  assert.equal(doc.baseUrl, 'http://10.0.0.201:5181/');
});

test('byte progress: streamed chunks against Content-Length; none usable when the body is content-encoded', async () => {
  const bytes = new TextEncoder().encode(HTML);
  // Split inside the three bytes of "…" (everything before it is ASCII).
  const cut = HTML.indexOf('…') + 1;
  const chunked = (headers: Record<string, string>) =>
    (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(bytes.slice(0, cut));
            ctrl.enqueue(bytes.slice(cut));
            ctrl.close();
          },
        }),
        { headers: { 'content-type': 'text/plain', ...headers } },
      )) as unknown as typeof fetch;
  const seen: [number, number | null][] = [];
  const doc = await fetchEntryDocument(URL, {
    fetchImpl: chunked({ 'content-length': String(bytes.byteLength) }),
    onProgress: (loaded, total) => seen.push([loaded, total]),
  });
  assert.equal(doc.html, HTML, 'multi-byte characters survive the chunk boundary');
  assert.deepEqual(seen, [
    [cut, bytes.byteLength],
    [bytes.byteLength, bytes.byteLength],
  ]);

  const encoded: [number, number | null][] = [];
  await fetchEntryDocument(URL, {
    fetchImpl: chunked({ 'content-length': '12', 'content-encoding': 'gzip' }),
    onProgress: (loaded, total) => encoded.push([loaded, total]),
  });
  assert.deepEqual(
    encoded.map(([, total]) => total),
    [null, null],
  );
  assert.equal(
    responseLength(new Response('x', { headers: { 'content-length': '1', 'content-encoding': 'identity' } })),
    1,
  );
});

test('https entries are verified against the catalog hash; http dev servers are not', () => {
  assert.equal(expectedEntryHash(URL, 'abc'), 'abc');
  assert.equal(
    expectedEntryHash(
      'http://10.0.0.201:5180/index.html',
      '0000000000000000000000000000000000000000000000000000000000000000',
    ),
    null,
  );
  assert.equal(expectedEntryHash(URL, null), null);
});
