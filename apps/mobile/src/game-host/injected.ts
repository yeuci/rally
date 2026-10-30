import { PROTOCOL_VERSION } from '@rally/protocol';

/**
 * Installed via `injectedJavaScriptBeforeContentLoaded` (main frame only) so `window.__rally`
 * exists before any game script runs. Messages delivered before the SDK installs its
 * dispatcher are queued; the SDK drains `queue` on init. iframes never receive the nonce.
 */
export function buildInjectedScript(nonce: string, opts: { fps?: boolean } = {}): string {
  return `(function () {
  if (window.__rally) return;
  var queue = [];
  window.__rally = {
    nonce: ${JSON.stringify(nonce)},
    version: ${PROTOCOL_VERSION},
    queue: queue,
    recv: function (json) { queue.push(json); }
  };
})();
${buildStorageResetScript(nonce)}
${DIAGNOSTICS_SCRIPT}
window.__rallyDiag.fps(${opts.fps ? 'true' : 'false'});
true;`;
}

/**
 * Every game is served from the same origin (the Supabase Storage CDN today, `localhost` in M6), and the WebView's
 * data store is persistent, so web storage would leak between games (architecture §3: games persist only through
 * the SDK). Before any game script runs, the first page load of each launch wipes what earlier launches left in
 * this origin: localStorage, sessionStorage, IndexedDB databases, Cache Storage and the cookies JS can see (every
 * path prefix of this page, host-only and domain cookies). The marker in sessionStorage (per WebView, keyed by the
 * launch nonce) keeps an in-page reload of the same launch from wiping the game's own data again. The HTTP cache
 * is left alone (warm loads). HttpOnly cookies are out of reach (the CDN sets none); see the README.
 */
export function buildStorageResetScript(nonce: string): string {
  return `(function () {
  var marker = '__rallyLaunch', launch = ${JSON.stringify(nonce)};
  try { if (window.sessionStorage && sessionStorage.getItem(marker) === launch) return; } catch (e) {}
  try { if (window.localStorage) localStorage.clear(); } catch (e) {}
  try { if (window.sessionStorage) { sessionStorage.clear(); sessionStorage.setItem(marker, launch); } } catch (e) {}
  try {
    if (window.indexedDB && typeof indexedDB.databases === 'function') {
      indexedDB.databases().then(function (dbs) {
        for (var i = 0; i < dbs.length; i++) if (dbs[i] && dbs[i].name) indexedDB.deleteDatabase(dbs[i].name);
      }, function () {});
    }
  } catch (e) {}
  try {
    if (window.caches && typeof caches.keys === 'function') {
      caches.keys().then(function (keys) { for (var i = 0; i < keys.length; i++) caches.delete(keys[i]); }, function () {});
    }
  } catch (e) {}
  try {
    var names = String(document.cookie || '').split(';');
    var parts = location.pathname.split('/'), paths = ['/'], acc = '';
    for (var p = 1; p < parts.length; p++) { acc += '/' + parts[p]; paths.push(acc); if (parts[p]) paths.push(acc + '/'); }
    for (var n = 0; n < names.length; n++) {
      var name = names[n].split('=')[0].trim();
      if (!name) continue;
      for (var k = 0; k < paths.length; k++) {
        document.cookie = name + '=; Max-Age=0; path=' + paths[k];
        document.cookie = name + '=; Max-Age=0; path=' + paths[k] + '; domain=' + location.hostname;
      }
    }
  } catch (e) {}
})();`;
}

/** Prefix of a page-diagnostics message (never a bridge envelope); see `DIAGNOSTICS_SCRIPT`. */
export const DIAG_PREFIX = '{"rallyDiag":1,';

export interface PageDiagnostic {
  kind: 'boot' | 'error' | 'resource' | 'rejection' | 'csp' | 'console.error' | 'fps';
  message: string;
}

/** Parse a message from the WebView as a page diagnostic, or null when it is anything else (bridge traffic). */
export function parseDiagnostic(data: string): PageDiagnostic | null {
  if (!data.startsWith(DIAG_PREFIX)) return null;
  try {
    const parsed = JSON.parse(data) as { kind?: unknown; message?: unknown };
    if (typeof parsed.kind !== 'string' || typeof parsed.message !== 'string') return null;
    return { kind: parsed.kind as PageDiagnostic['kind'], message: parsed.message };
  } catch {
    return null;
  }
}

/**
 * Page-level failure reporting, because nobody can attach Web Inspector to a WebView on a phone from a Windows
 * PC. Posts (at most a few) one-line reports to the host for: the injected script having run at all, uncaught
 * exceptions, failed resource loads (a script or stylesheet the CSP or SRI refused, a 404), unhandled promise
 * rejections, CSP violation reports and console.error. The host shows them in the load-failure overlay and never
 * treats them as bridge traffic (no envelope, no nonce; see `parseDiagnostic`).
 *
 * `window.__rallyDiag.fps(on)` starts/stops a requestAnimationFrame counter that reports the frame rate once a
 * second (`kind: 'fps'`), for the shell's optional FPS overlay. The page's own rAF is the only true measure of the
 * game's frame rate; the shell's JS thread knows nothing about it.
 */
const DIAGNOSTICS_SCRIPT = `(function () {
  var sent = 0, pending = [];
  function post(line) {
    var rn = window.ReactNativeWebView;
    if (!rn) { pending.push(line); return; }
    rn.postMessage(line);
  }
  function diag(kind, message) {
    if (sent++ >= 12) return;
    try { post(${JSON.stringify(DIAG_PREFIX)} + '"kind":' + JSON.stringify(kind) + ',"message":' + JSON.stringify(String(message).slice(0, 400)) + '}'); } catch (e) {}
  }
  function describe(value) {
    if (value && value.stack) return String(value.stack);
    if (value && typeof value === 'object') { try { return JSON.stringify(value); } catch (e) { return String(value); } }
    return String(value);
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    var url = t && t !== window && (t.src || t.href);
    if (url) diag('resource', (t.tagName || 'resource').toLowerCase() + ' failed to load: ' + url);
    else diag('error', (e.message || 'uncaught error') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { diag('rejection', describe(e.reason)); });
  document.addEventListener('securitypolicyviolation', function (e) {
    diag('csp', e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + (e.sourceFile ? ' from ' + e.sourceFile + ':' + e.lineNumber : ''));
  });
  var consoleError = console.error;
  console.error = function () {
    try { diag('console.error', Array.prototype.map.call(arguments, describe).join(' ')); } catch (e) {}
    return consoleError.apply(console, arguments);
  };
  var fpsOn = false, fpsFrames = 0, fpsSince = 0;
  function fpsTick(now) {
    if (!fpsOn) return;
    fpsFrames++;
    if (now - fpsSince >= 1000) {
      try { post(${JSON.stringify(DIAG_PREFIX)} + '"kind":"fps","message":"' + Math.round(fpsFrames * 1000 / (now - fpsSince)) + '"}'); } catch (e) {}
      fpsFrames = 0; fpsSince = now;
    }
    requestAnimationFrame(fpsTick);
  }
  window.__rallyDiag = {
    fps: function (on) {
      on = !!on;
      if (on === fpsOn) return;
      fpsOn = on;
      if (on) { fpsFrames = 0; fpsSince = performance.now(); requestAnimationFrame(fpsTick); }
    }
  };
  function flush() { while (pending.length && window.ReactNativeWebView) post(pending.shift()); }
  document.addEventListener('DOMContentLoaded', flush);
  window.addEventListener('load', flush);
  diag('boot', 'injected script ran (ReactNativeWebView ' + (window.ReactNativeWebView ? 'present' : 'missing') + ', ' + location.href + ')');
})();`;

/** JS the host runs to deliver one envelope to the game. */
export function buildDeliverScript(json: string): string {
  return `window.__rally && window.__rally.recv(${JSON.stringify(json)}); true;`;
}
