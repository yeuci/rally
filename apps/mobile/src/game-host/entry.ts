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
  const html = await res.text();

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
