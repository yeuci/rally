import { useSyncExternalStore } from 'react';
import { config } from './config';

/**
 * Tiny module-level store for the Developer launcher (M0 spike path): what to launch and what the last run
 * reported. The catalog path uses React Query + Supabase instead.
 */
export interface LaunchSettings {
  bundleUrl: string;
  colyseusUrl: string;
}

export interface RunReport {
  endedAt: number;
  reason: string;
  metrics: Record<string, number | string | boolean> | null;
  readyMs: number | null;
  playtimeS: number;
  error: string | null;
}

interface State {
  settings: LaunchSettings;
  lastRun: RunReport | null;
}

let state: State = {
  settings: { bundleUrl: config.spikeBundleUrl, colyseusUrl: config.colyseusUrl },
  lastRun: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const launchStore = {
  get: () => state,
  setSettings: (settings: Partial<LaunchSettings>) => set({ settings: { ...state.settings, ...settings } }),
  setLastRun: (lastRun: RunReport) => set({ lastRun }),
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useLaunchStore(): State {
  return useSyncExternalStore(launchStore.subscribe, launchStore.get, launchStore.get);
}
