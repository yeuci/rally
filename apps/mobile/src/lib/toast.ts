import { useSyncExternalStore } from 'react';

/**
 * A one-line notice that outlives the screen that raised it ("That match has ended" as the play route closes).
 * One at a time: a new toast replaces the shown one. Rendered by `ToastHost` in `(app)/_layout.tsx`.
 */
export interface Toast {
  id: number;
  message: string;
}

let current: Toast | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(message: string): void {
  seq += 1;
  current = { id: seq, message };
  emit();
}

/** Hide toast `id` (a newer one stays). */
export function hideToast(id: number): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
