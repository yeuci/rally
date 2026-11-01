import { useSyncExternalStore } from 'react';
import { queueCelebration, type Celebration } from './levels-model';

/**
 * The level-up and challenge-complete celebrations (rules in lib/levels-model.ts `queueCelebration`): one on screen at
 * a time, the next one after it. Fed by the Realtime router (lib/levels.ts `handleProgressBroadcast`) when Settings →
 * Coin popups is on; drawn by `CelebrationToast`, which `CoinToastHost` renders under the coin pill (so the shell and
 * the play route both show it, like the coin toast).
 */

let queue: Celebration[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function nextCelebrationKey(): number {
  seq += 1;
  return seq;
}

export function pushCelebration(c: Celebration): void {
  const next = queueCelebration(queue, c);
  if (next.length === queue.length && next.every((x, i) => x === queue[i])) return;
  queue = next;
  emit();
}

/** Hide celebration `key` (the head); the next one in the queue shows. */
export function hideCelebration(key: number): void {
  if (queue[0]?.key !== key) return;
  queue = queue.slice(1);
  emit();
}

export function clearCelebrations(): void {
  if (queue.length === 0) return;
  queue = [];
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const head = () => queue[0] ?? null;

export function useCelebration(): Celebration | null {
  return useSyncExternalStore(subscribe, head, () => null);
}
