import type { Session } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';

/**
 * Module-level session store fed by `onAuthStateChange` (which emits INITIAL_SESSION from storage on subscribe).
 * Components read it through `useSession()`; no provider needed.
 */
export interface SessionState {
  /** False until the persisted session has been read from storage. */
  initialized: boolean;
  session: Session | null;
}

let state: SessionState = { initialized: false, session: null };
const listeners = new Set<() => void>();

supabase.auth.onAuthStateChange((event, session) => {
  const previousUser = state.session?.user.id;
  state = { initialized: true, session };
  // Never let one account's cached rows leak into another's screens.
  if (event === 'SIGNED_OUT' || (previousUser && previousUser !== session?.user.id)) queryClient.clear();
  for (const l of listeners) l();
});

// INITIAL_SESSION waits for supabase-js to recover the stored session, which includes refreshing an expired token
// (with retries) when offline. Don't hold the splash screen for that: show the signed-out UI and let the
// session arrive later.
setTimeout(() => {
  if (state.initialized) return;
  state = { ...state, initialized: true };
  for (const l of listeners) l();
}, 4000);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const getSnapshot = () => state;

export function useSession(): SessionState & { userId: string | null; signedIn: boolean } {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const user = s.session?.user ?? null;
  return {
    ...s,
    userId: user?.id ?? null,
    // Anonymous sessions only exist mid-signup for Apple/Google (see lib/auth/providers.ts); they are not "signed in".
    signedIn: !!user && !user.is_anonymous,
  };
}

/** Non-hook access for event handlers and non-React modules. */
export function currentUserId(): string | null {
  return state.session?.user.id ?? null;
}
