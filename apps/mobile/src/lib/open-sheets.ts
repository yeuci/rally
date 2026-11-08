import { useEffect, useSyncExternalStore } from 'react';

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

/** Non-hook read, for code that decides once whether to present a sheet (the vote prompt, shake to report). */
export const isAnySheetOpen = anyOpen;

/** True while another (registered) sheet is open. */
export function useOtherSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, anyOpen, anyOpen);
}

/**
 * The one prompt slot. The prompts that open by themselves (friend request, party or room invite, party follow)
 * pass `register={false}` so they do not wait on themselves, which also means they cannot see each other: two
 * arriving together would both present, and UIKit refuses the second Modal (two banners over a game overlap). So a
 * prompt shows only while it holds this slot. The first prompt that wants it takes it; the others keep their items
 * queued and take it in turn when the holder lets go (nothing to show, answered, dismissed, unmounted).
 */
export function createPromptSlot() {
  let holder: string | null = null;
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((l) => l());
  return {
    holder: () => holder,
    /** Takes the slot when it is free; true when `id` holds it afterwards. */
    claim(id: string): boolean {
      if (holder === null) {
        holder = id;
        changed();
      }
      return holder === id;
    },
    /** Lets go of the slot, if `id` holds it. */
    release(id: string): void {
      if (holder !== id) return;
      holder = null;
      changed();
    },
    subscribe(l: () => void) {
      subs.add(l);
      return () => {
        subs.delete(l);
      };
    },
  };
}

const promptSlot = createPromptSlot();

/**
 * True while the prompt `id` (one per prompt kind and placement, e.g. `invite:shell`) holds the prompt slot. Pass
 * `wants` true while the prompt has something to present; it takes the slot as soon as it is free.
 */
export function usePromptSlot(id: string, wants: boolean): boolean {
  const holder = useSyncExternalStore(promptSlot.subscribe, promptSlot.holder, promptSlot.holder);
  useEffect(() => {
    if (wants) promptSlot.claim(id);
    else promptSlot.release(id);
  }, [id, wants, holder]);
  useEffect(() => () => promptSlot.release(id), [id]);
  return wants && holder === id;
}
