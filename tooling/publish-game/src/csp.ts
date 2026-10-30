/**
 * The Content-Security-Policy every published game bundle carries (architecture §2, Security).
 *
 * Changing the policy means changing this one function; `publish-game --dry-run` prints the result.
 *
 * - `<cdn>` is the origin of the Supabase project (`SUPABASE_URL`), which serves the bundle from Storage.
 *   'self' already covers it when the bundle is loaded from the CDN; it is listed explicitly so the policy
 *   stays valid when the same bundle is served from 127.0.0.1 in M6 and still fetches from the CDN.
 * - Colyseus origins are listed in both their http(s) form (matchmaking / standalone HTTP) and their
 *   ws(s) form (the room socket). The shell hands the socket endpoint over at runtime (`session.join` →
 *   `endpoint`), so the publisher must list every environment's endpoint the bundle will be launched against
 *   (`--colyseus` repeatable, or a comma-separated `RALLY_COLYSEUS_URL`). With at least one origin listed the
 *   socket is pinned to them: no `ws:` / `wss:` wildcards, so a bundle cannot open a socket to any other host.
 *   Only when none is listed and `socketFallback` is set (a game with a `server`) do the wildcards come back,
 *   and the publisher prints a loud warning; a game without a server gets no socket source at all.
 * - `'wasm-unsafe-eval'` lets the bundle compile WebAssembly (Draco, Basis/KTX2 transcoders, physics) without
 *   allowing `eval`: Chromium/Android WebView and WebKit block `WebAssembly.instantiate` under a script-src
 *   without it.
 * - `'unsafe-inline'` is allowed for styles only (engines and HUDs set inline styles); scripts must be files
 *   in the bundle with SRI, never inline (that includes `<script type="importmap">`).
 * - `blob:` for workers/media and `data:`/`blob:` for images and fonts cover PlayCanvas texture and font loading.
 */
export function buildCsp(opts: {
  cdnOrigin: string;
  colyseusOrigins?: readonly string[];
  /** Allow `ws: wss:` when no Colyseus origin is listed (the game has a server). Default true. */
  socketFallback?: boolean;
}): string {
  const cdn = opts.cdnOrigin;
  const colyseus = opts.colyseusOrigins ?? [];
  const sockets = colyseus.length === 0 && (opts.socketFallback ?? true) ? ['ws:', 'wss:'] : [];
  const directives: [string, string[]][] = [
    ['default-src', ["'self'", cdn]],
    ['script-src', ["'self'", "'wasm-unsafe-eval'", cdn]],
    ['style-src', ["'self'", "'unsafe-inline'", cdn]],
    ['img-src', ["'self'", 'data:', 'blob:', cdn]],
    ['font-src', ["'self'", 'data:', cdn]],
    ['connect-src', ["'self'", cdn, ...colyseus, ...sockets]],
    ['worker-src', ["'self'", 'blob:']],
    ['media-src', ["'self'", 'blob:', cdn]],
    // No plugins, no <base> rewriting, no form posts (a POST would be a main-frame navigation the host must
    // refuse), and never framed by another page.
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${dedupe(sources).join(' ')}`).join('; ');
}

/** `https://abc.supabase.co/anything` → `https://abc.supabase.co`. */
export function originOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not an absolute URL: "${url}"`);
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) throw new Error(`unsupported URL scheme in "${url}"`);
  return u.origin === 'null' ? `${u.protocol}//${u.host}` : u.origin;
}

/**
 * Colyseus URLs (http, https, ws or wss; comma-separated lists allowed) → the CSP sources for
 * connect-src: each URL contributes its http(s) origin and its ws(s) origin.
 */
export function colyseusOrigins(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of urls.flatMap((u) => u.split(','))) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = originOf(trimmed);
    const [scheme, rest] = origin.split('://') as [string, string];
    const secure = scheme === 'https' || scheme === 'wss';
    out.push(`${secure ? 'https' : 'http'}://${rest}`, `${secure ? 'wss' : 'ws'}://${rest}`);
  }
  return dedupe(out);
}

function dedupe(list: readonly string[]): string[] {
  return Array.from(new Set(list));
}
