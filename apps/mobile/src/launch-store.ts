import { useSyncExternalStore } from 'react';
import { config } from './config';

/**
 * Tiny module-level store for the Developer launcher (M0 spike path): what to launch (bundle, game server, room
 * type and join mode) and what the last run reported. The catalog path uses React Query + Supabase instead.
 */
export interface LaunchSettings {
  bundleUrl: string;
  colyseusUrl: string;
  /** Colyseus room type to matchmake into: `hello` (the spike) by default, `sumo` preset. */
  roomName: string;
  /** How `session.join` matchmakes; mapped to the play route's `JoinTarget` (lib/join-target.ts). */
  join: DevJoinMode;
  /** The join code (`code`) or room id (`room`); ignored for `quick` / `create`. */
  joinValue: string;
}

/** quick → `joinOrCreate`; create → a private room; code → `GET /rooms/code` then `joinById` + code; room → `joinById`. */
export type DevJoinMode = 'quick' | 'create' | 'code' | 'room';

export const DEV_ROOM_PRESETS = ['hello', 'sumo'] as const;

export interface RunReport {
  endedAt: number;
  reason: string;
  metrics: Record<string, number | string | boolean> | null;
  readyMs: number | null;
  entryMs: number | null;
  pageMs: number | null;
  playtimeS: number;
  error: string | null;
}

interface State {
  settings: LaunchSettings;
  lastRun: RunReport | null;
}

let state: State = {
  settings: { bundleUrl: config.spikeBundleUrl, colyseusUrl: config.colyseusUrl, roomName: 'hello', join: 'quick', joinValue: '' },
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
