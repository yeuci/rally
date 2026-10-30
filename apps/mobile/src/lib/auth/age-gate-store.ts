import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { CalendarDate } from './age';

/**
 * Device-side age gate state.
 *
 * - The refusal flag ("this device was refused at the DOB screen") lives in SecureStore. On iOS the keychain
 *   survives an app reinstall, which is what "remembered per device" should mean. Only a flag is stored, never the date.
 * - The DOB that passed the gate is kept in memory only, for the length of one signup flow, and goes to the
 *   server in the signup metadata.
 */
const REFUSED_KEY = 'rally.ageGate.refused';

interface State {
  loaded: boolean;
  refused: boolean;
  pendingDob: CalendarDate | null;
}

let state: State = { loaded: false, refused: false, pendingDob: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

async function readFlag(): Promise<boolean> {
  try {
    if (Platform.OS === 'web') return globalThis.localStorage?.getItem(REFUSED_KEY) === '1';
    return (await SecureStore.getItemAsync(REFUSED_KEY)) === '1';
  } catch {
    return false;
  }
}

async function writeFlag(): Promise<void> {
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(REFUSED_KEY, '1');
    else await SecureStore.setItemAsync(REFUSED_KEY, '1');
  } catch {
    /* best effort: the in-memory flag still closes the flow for this run */
  }
}

void readFlag().then((refused) => set({ loaded: true, refused: refused || state.refused }));

export const ageGate = {
  get: () => state,
  refuse: () => {
    set({ refused: true, pendingDob: null });
    void writeFlag();
  },
  pass: (dob: CalendarDate) => set({ pendingDob: dob }),
  clearPending: () => set({ pendingDob: null }),
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useAgeGate(): State {
  return useSyncExternalStore(ageGate.subscribe, ageGate.get, ageGate.get);
}
