import { bundleBasePath } from './bridge';

/**
 * The game's entry document, fetched by the shell and handed to the WebView as `source={{ html, baseUrl }}`.
 *
 * Why not `source={{ uri }}`: Supabase Storage serves `text/html` objects as `text/plain` on purpose (phishing
 * pages on the shared `*.supabase.co` origin), so a WebView pointed straight at `entry_url` renders the source as
 * text, runs nothing and never calls `ready()`. Scripts and stylesheets keep their real content types, so loading
 * the document ourselves with the bundle directory as `baseUrl` leaves everything else as it was: the page's
 * origin is the CDN's, `'self'` in the CSP and the SRI on every script and stylesheet still apply, and the
 * bridge's URL gate sees the same directory.
 *
 * The document itself is verified against `game_versions.sha256` (the publisher hashes the hardened entry), so
 * the whole bundle is integrity-checked end to end: this hash covers the HTML, the SRI inside it covers the rest.
 */
export interface EntryDocument {
  html: string;
  /** Origin + directory of the entry URL (ends in `/`); the WebView resolves `./assets/…` against it. */
  baseUrl: string;
}

export interface FetchEntryOptions {
  /** Hex sha256 of the expected document; null/undefined skips the check (Developer launcher only). */
  expectedSha256?: string | null;
  /** Hex sha256 of a UTF-8 string; required when `expectedSha256` is set. */
  digest?: (text: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Bytes received so far, for the loading screen. `total` is the response's Content-Length (null when it has none,
   * or the body is content-encoded so the length is not what arrives). Called per chunk where the fetch exposes the
   * body as a stream (expo/fetch, browsers), else once with the whole document.
   */
  onProgress?: (loaded: number, total: number | null) => void;
}

/**
 * The hash to verify an entry document against: `game_versions.sha256` for https (every published bundle), none
 * for plain http. An http entry is a LAN dev server (`vite dev` on the PC, hand-inserted catalog row for the spike),
 * whose HTML changes on every edit and whose row carries a placeholder hash; production bundles never use http
 * (App Transport Security would refuse them anyway).
 */
export function expectedEntryHash(entryUrl: string, sha256: string | null | undefined): string | null {
  if (!sha256 || /^http:\/\//i.test(entryUrl)) return null;
  return sha256;
}

export async function fetchEntryDocument(url: string, opts: FetchEntryOptions = {}): Promise<EntryDocument> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { signal: opts.signal, headers: { accept: 'text/html' } });
  } catch (err) {
    throw new Error(`could not download the game: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  const html = await readText(res, opts.onProgress);

  if (opts.expectedSha256) {
    if (!opts.digest) throw new Error('entry integrity check needs a digest function');
    const expected = opts.expectedSha256.toLowerCase();
    const actual = (await opts.digest(html)).toLowerCase();
    if (actual !== expected) {
      throw new Error(
        `the game's entry document failed its integrity check (sha256 ${actual.slice(0, 12)}…, catalog says ${expected.slice(0, 12)}…)`,
      );
    }
  }
  if (!/<!doctype html|<html[\s>]/i.test(html.slice(0, 2048))) {
    throw new Error(`${url} is not an HTML document`);
  }
  return { html, baseUrl: bundleBasePath(url) };
}

/** The usable size of a response body: Content-Length, unless the body is content-encoded (then it is not the size we read). */
export function responseLength(res: Pick<Response, 'headers'>): number | null {
  const encoding = res.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return null;
  const n = Number(res.headers.get('content-length'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readText(res: Response, onProgress?: (loaded: number, total: number | null) => void): Promise<string> {
  const total = responseLength(res);
  const reader = onProgress && res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader || !onProgress) {
    const text = await res.text();
    onProgress?.(total ?? text.length, total);
    return text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    text += decoder.decode(value, { stream: true });
    onProgress(loaded, total);
  }
  return text + decoder.decode();
}
