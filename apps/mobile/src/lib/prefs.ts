import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { DEFAULTS, parsePrefs, type Prefs } from './prefs-parse';

/**
 * Device-side preferences (not account data): persisted in AsyncStorage, read once at startup, defaults until then.
 */
export type { Prefs } from './prefs-parse';
export { parsePrefs } from './prefs-parse';

const KEY = 'rally.prefs';

let state: Prefs = DEFAULTS;
const listeners = new Set<() => void>();

function set(next: Prefs) {
  state = next;
  for (const l of listeners) l();
}

void AsyncStorage.getItem(KEY)
  .then((raw) => set(parsePrefs(raw)))
  .catch(() => {});

export const prefs = {
  get: () => state,
  update(patch: Partial<Prefs>) {
    set({ ...state, ...patch });
    AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {});
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefs.subscribe, prefs.get, prefs.get);
}
