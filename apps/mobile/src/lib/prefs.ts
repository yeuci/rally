import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Uniwind } from 'uniwind';
import { DEFAULTS, parsePrefs, type Prefs } from './prefs-parse';

/**
 * Device-side preferences (not account data): persisted in AsyncStorage, read once at startup, defaults until then.
 * `appearance` is applied here, whenever it changes (`Uniwind.setTheme`: every `useUniwind()` reader, the CSS
 * tokens and the native `Appearance` follow); until the stored value is read the app follows the system, behind the
 * cold-start intro overlay.
 */
export type { Appearance, Prefs } from './prefs-parse';
export { APPEARANCES, parsePrefs } from './prefs-parse';

const KEY = 'rally.prefs';

let state: Prefs = DEFAULTS;
const listeners = new Set<() => void>();

function set(next: Prefs) {
  const before = state;
  state = next;
  if (next.appearance !== before.appearance) {
    try {
      Uniwind.setTheme(next.appearance);
    } catch {
      /* an unregistered theme name cannot reach here (parsePrefs), but never let a preference crash the app */
    }
  }
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
