import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { parseWelcomed, welcomedKey, welcomedRecord, type WelcomeEnd } from './welcome-model';

/**
 * The first-run welcome's device memory: one "welcomed" flag per account in AsyncStorage (`rally.welcomed.<uid>`), and
 * which accounts the welcome was already pushed for in this run. The rules live in lib/welcome-model.ts; the screens in
 * components/rally/welcome-tour.tsx and app/(app)/get-started.tsx.
 */
export const welcomedStore = {
  /** Whether `userId` was welcomed on this device. Unreadable storage counts as welcomed: a missed welcome is better than a repeated one. */
  async get(userId: string): Promise<boolean> {
    try {
      return parseWelcomed(await AsyncStorage.getItem(welcomedKey(userId))) !== null;
    } catch {
      return true;
    }
  },
  /** Remember that `userId` saw the welcome and how it ended. Best effort: the run itself never shows it twice. */
  async set(userId: string, how: WelcomeEnd, now = Date.now()): Promise<void> {
    try {
      await AsyncStorage.setItem(welcomedKey(userId), JSON.stringify(welcomedRecord(how, now)));
    } catch {
      // Storage refused the write: the account is new, so the welcome may show once more on the next launch.
    }
  },
};

/** The flag for `userId`, read once per account: null until it has been read (and while another account's is). */
export function useWelcomed(userId: string | null): boolean | null {
  const [state, setState] = useState<{ userId: string; welcomed: boolean } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void welcomedStore.get(userId).then((welcomed) => {
      if (live) setState({ userId, welcomed });
    });
    return () => {
      live = false;
    };
  }, [userId]);
  return state && state.userId === userId ? state.welcomed : null;
}

/**
 * Accounts the welcome has been pushed for in this JS run (`openedThisRun` in lib/welcome-model.ts): the flag read
 * above is not repeated after the welcome closes, and a failed flag write must not bring it straight back.
 */
const opened = new Set<string>();

export const welcomeOpened = {
  has: (userId: string) => opened.has(userId),
  add(userId: string) {
    opened.add(userId);
  },
};
