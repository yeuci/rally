import { PROTOCOL_VERSION } from '@rally/protocol';

/**
 * Installed via `injectedJavaScriptBeforeContentLoaded` (main frame only) so `window.__rally`
 * exists before any game script runs. Messages delivered before the SDK installs its
 * dispatcher are queued; the SDK drains `queue` on init. iframes never receive the nonce.
 */
export function buildInjectedScript(nonce: string): string {
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
${DIAGNOSTICS_SCRIPT}
true;`;
}

/** Prefix of a page-diagnostics message (never a bridge envelope); see `DIAGNOSTICS_SCRIPT`. */
export const DIAG_PREFIX = '{"rallyDiag":1,';

export interface PageDiagnostic {
  kind: 'boot' | 'error' | 'resource' | 'rejection' | 'csp' | 'console.error';
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
  function flush() { while (pending.length && window.ReactNativeWebView) post(pending.shift()); }
  document.addEventListener('DOMContentLoaded', flush);
  window.addEventListener('load', flush);
  diag('boot', 'injected script ran (ReactNativeWebView ' + (window.ReactNativeWebView ? 'present' : 'missing') + ', ' + location.href + ')');
})();`;

/** JS the host runs to deliver one envelope to the game. */
export function buildDeliverScript(json: string): string {
  return `window.__rally && window.__rally.recv(${JSON.stringify(json)}); true;`;
}
