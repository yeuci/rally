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
})(); true;`;
}

/** JS the host runs to deliver one envelope to the game. */
export function buildDeliverScript(json: string): string {
  return `window.__rally && window.__rally.recv(${JSON.stringify(json)}); true;`;
}
