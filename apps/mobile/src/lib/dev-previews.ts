import { useSyncExternalStore } from 'react';
import type { QueuedRequest } from './social-realtime-model';

/**
 * The Developer page's previews that draw over the screen (components/dev/preview-host.tsx, mounted by the dev
 * layout): a made-up friend request for the banner, the offline pill, and the first-run welcome. The first two are
 * kept apart from the real stores, so the shell's own prompt never sees the preview request and nothing reaches the
 * server; the welcome is the real thing with the signed-in account, only its "welcomed" flag is left alone.
 */
export interface DevPreviews {
  banner: QueuedRequest | null;
  /** When the offline pill preview was asked for (epoch ms); null when hidden. */
  offlineSince: number | null;
  /** The first-run welcome is up over the Developer page. */
  welcome: boolean;
}

let state: DevPreviews = { banner: null, offlineSince: null, welcome: false };
let seq = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<DevPreviews>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const devPreviews = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** A new preview request (a new key, so the banner restarts even if one is up). */
  showBanner() {
    seq += 1;
    const now = Date.now();
    set({ banner: { userId: '', key: `preview:${seq}`, createdAt: new Date(now).toISOString(), queuedAt: now } });
  },
  /** Hide banner `key` (a newer preview stays). */
  endBanner(key: string) {
    if (state.banner?.key === key) set({ banner: null });
  },
  showOffline() {
    set({ offlineSince: Date.now() });
  },
  /** Hide the pill asked for at `since` (asking again restarts it). */
  hideOffline(since: number) {
    if (state.offlineSince === since) set({ offlineSince: null });
  },
  showWelcome() {
    set({ welcome: true });
  },
  hideWelcome() {
    set({ welcome: false });
  },
};

export function useDevPreviews(): DevPreviews {
  return useSyncExternalStore(devPreviews.subscribe, devPreviews.get, devPreviews.get);
}
