import { useSyncExternalStore } from 'react';

/**
 * Which BottomSheets are open right now (each one registers while `open`). On iOS two React Native Modals cannot
 * be presented from the same view controller at once (UIKit refuses the second), so a sheet that opens by itself
 * (the friend-request sheet) waits until the others have closed.
 */
const open = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setSheetOpen(id: string, isOpen: boolean): void {
  if (isOpen === open.has(id)) return;
  if (isOpen) open.add(id);
  else open.delete(id);
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const anyOpen = () => open.size > 0;

/** True while another (registered) sheet is open. */
export function useOtherSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, anyOpen, anyOpen);
}
