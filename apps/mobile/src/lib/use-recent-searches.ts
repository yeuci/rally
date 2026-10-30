import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { addRecentSearch, parseRecentSearches, removeRecentSearch } from './recent-searches';

/**
 * The search screen's recent searches (last 8, newest first), kept on the device in AsyncStorage. Read once when
 * this module loads; until then the list is empty. Writes are fire-and-forget.
 */
const KEY = 'rally.recent-searches';

let state: string[] = [];
const listeners = new Set<() => void>();

function set(next: string[], persist = true) {
  state = next;
  for (const l of listeners) l();
  if (persist) AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
}

void AsyncStorage.getItem(KEY)
  .then((raw) => {
    // A search recorded before the read finished wins over the stored list's copy of it.
    const stored = parseRecentSearches(raw);
    set(
      state.reduceRight((list, q) => addRecentSearch(list, q), stored),
      state.length > 0,
    );
  })
  .catch(() => {});

export const recentSearches = {
  get: () => state,
  add: (query: string) => {
    const next = addRecentSearch(state, query);
    if (next.length !== state.length || next.some((q, i) => q !== state[i])) set(next);
  },
  remove: (query: string) => set(removeRecentSearch(state, query)),
  clear: () => set([]),
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useRecentSearches(): string[] {
  return useSyncExternalStore(recentSearches.subscribe, recentSearches.get, recentSearches.get);
}
