import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { successHaptic } from '@/lib/haptics';
import { nextCelebrationKey, pushCelebration } from '@/lib/level-toast';
import { prefs } from '@/lib/prefs';
import {
  applyStreakEvent,
  parseStreak,
  parseStreakEvent,
  streakCelebration,
  streakGrew,
  type Streak,
} from '@/lib/streak-model';
import { supabase } from '@/lib/supabase';

/**
 * The daily play streak (20261102000400_streaks.sql; docs/progress.md): consecutive UTC days with a counted game,
 * counted and paid by the database. The app reads it with `my_streak()` and hears it grow on the `user:<uid>` channel,
 * event `streak` (lib/social-realtime.ts → `handleStreakBroadcast`): the card updates at once and a new day shows the
 * streak celebration (`CelebrationToast`, like a level-up) unless Settings → Coin popups is off. Its coins arrive as a
 * `coins` event with reason `streak`, which the coin toast leaves to the celebration.
 */
export const streakKeys = {
  mine: (uid: string | null) => ['streak', uid] as const,
};

/** The streak of `uid` (after an event, or coming back online). */
export function invalidateStreak(qc: QueryClient, uid: string | null) {
  void qc.invalidateQueries({ queryKey: streakKeys.mine(uid) });
}

/**
 * A `streak` broadcast: the cached streak takes the new day at once (never backwards), the bonus preview is refetched
 * (the next day's amounts moved on), and a day the cache had not seen is celebrated.
 */
export function handleStreakBroadcast(qc: QueryClient, uid: string, payload: unknown): void {
  const e = parseStreakEvent(payload);
  if (!e) return;
  const before = qc.getQueryData<Streak>(streakKeys.mine(uid));
  qc.setQueryData<Streak>(streakKeys.mine(uid), (cur) => applyStreakEvent(cur, e));
  invalidateStreak(qc, uid);
  if (streakGrew(before, e) && prefs.get().coinPopups) {
    pushCelebration(streakCelebration(e, nextCelebrationKey()));
    successHaptic();
  }
}

/** `my_streak()`: the signed-in player's streak, longest, latest day and the next bonus. Linked accounts only. */
export function useMyStreak() {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: streakKeys.mine(userId),
    enabled: !!userId && signedIn,
    staleTime: 30_000,
    queryFn: async (): Promise<Streak> => {
      const { data, error } = await supabase.rpc('my_streak');
      if (error) throw error;
      return parseStreak(data);
    },
  });
}
