import { useSyncExternalStore } from 'react';
import { mergeCoinToast, type CoinAward, type CoinToast } from './coins-model';

/**
 * The "+25 coins" toast (one at a time; rules in lib/coins-model.ts `mergeCoinToast`): awards that arrive while it is
 * up add to it ("+85 coins · Win · Daily bonus"), so a match's participation, win and daily bonus read as one.
 * Fed by the Realtime router (lib/coins.ts `handleCoinBroadcast`) when Settings → Coin popups is on; rendered by
 * `CoinToastHost` in `(app)/_layout.tsx` and in the play route (a game is a native modal over the shell).
 */

let current: CoinToast | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function pushCoinAward(award: CoinAward, now: number = Date.now()): void {
  seq += 1;
  const next = mergeCoinToast(current, award, now, seq);
  if (next === current) return;
  current = next;
  emit();
}

/** Hide toast `key` (a newer state of it stays). */
export function hideCoinToast(key: number): void {
  if (current?.key !== key) return;
  current = null;
  emit();
}

export function clearCoinToast(): void {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCoinToast(): CoinToast | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
