import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSession } from '@/lib/auth/session';
import {
  createHeartbeatScheduler,
  parseBeatAnswer,
  type Beat,
  type BeatAnswer,
  type PresenceState,
} from '@/lib/presence-scheduler';
import { socialErrorKind } from '@/lib/social';
import { supabase } from '@/lib/supabase';

/**
 * The shell's presence (m3-phase2 §2 "Shell"): one heartbeat scheduler for the app (rules in
 * lib/presence-scheduler.ts), fed by `usePresenceHeartbeat()` in `(app)/_layout.tsx` (the linked account and
 * `AppState`), by the play route (`setInGame` from the host's `onJoined`, `setOnline` on exit) and by sign-out
 * (`signOutPresence`, before the session is dropped). Friends read it back through `friends_presence` and
 * `public_presence` (lib/friends.ts); `in_game` shows only while the game server's mirror confirms the seat.
 */

/** `heartbeat(p_status, p_game_id, p_room_id)`. Auth and input errors stop the scheduler; network ones are retried. */
async function sendBeat(beat: Beat): Promise<BeatAnswer> {
  const { data, error } = await supabase.rpc('heartbeat', {
    p_status: beat.status,
    ...(beat.gameId ? { p_game_id: beat.gameId } : {}),
    ...(beat.roomId ? { p_room_id: beat.roomId } : {}),
  });
  if (error) {
    const kind = socialErrorKind(error);
    if (kind === 'network' || kind === 'other') throw error;
    return { ok: false };
  }
  return parseBeatAnswer(data);
}

const scheduler = createHeartbeatScheduler({
  send: sendBeat,
  timers: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});

/** What the shell is doing; beats right away when it changed. */
export function setPresence(state: PresenceState): void {
  scheduler.setPresence(state);
}

/** A multiplayer game joined room `roomId` (the host's `onJoined`). */
export function setInGame(gameId: string, roomId: string | null): void {
  scheduler.setPresence(roomId ? { status: 'in_game', gameId, roomId } : { status: 'in_game', gameId });
}

/** Back in the shell (the play route closed). */
export function setOnline(): void {
  scheduler.setPresence({ status: 'online' });
}

/** Longest a sign-out waits for `heartbeat('offline')` (offline, the 90 s TTL ages the row out anyway). */
const SIGN_OUT_WAIT_MS = 3000;

/** `heartbeat('offline')` while the session still authenticates it, then no more beats. Never throws. */
export async function signOutPresence(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.signOut(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SIGN_OUT_WAIT_MS);
      }),
    ]);
  } catch {
    // Best effort.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mounted once, in `(app)/_layout.tsx`: beats for a linked account only (`signedIn` is false for anonymous
 * sessions), while `AppState` is active.
 */
export function usePresenceHeartbeat(): void {
  const { signedIn, userId } = useSession();
  const account = signedIn ? userId : null;

  useEffect(() => {
    scheduler.setAccount(account);
  }, [account]);

  useEffect(() => {
    scheduler.setActive(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (state) => scheduler.setActive(state === 'active'));
    return () => sub.remove();
  }, []);
}
