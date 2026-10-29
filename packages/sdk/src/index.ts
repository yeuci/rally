export { Rally } from './rally.ts';
export { RallyClient, SDK_VERSION, type RallyClientOptions } from './client.ts';
export { RallyError } from './errors.ts';
export type { RallyHostGlobal } from './global.ts';
export type {
  LaunchContext,
  LaunchIntent,
  HostEvent,
  HostEventPayload,
  BridgeErrorCode,
  GameManifest,
} from '@rally/protocol';

import { Rally } from './rally.ts';

/** Default singleton. `import { rally } from '@rally/sdk'`. */
export const rally: Rally = new Rally();

if (typeof window !== 'undefined') {
  window.addEventListener('error', (ev) => rally.reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => rally.reportError(ev.reason));
}
