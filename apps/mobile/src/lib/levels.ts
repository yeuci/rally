import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/session';
import { coinKeys, invalidateCoins } from '@/lib/coins';
import type { WalletSummary } from '@/lib/coins-model';
import { successHaptic } from '@/lib/haptics';
import { nextCelebrationKey, pushCelebration } from '@/lib/level-toast';
import {
  applyChallengeEvent,
  applyLevelEvent,
  celebrationFor,
  claimErrorKind,
  claimErrorText,
  markClaimed,
  parseClaimResult,
  parseLevelProgress,
  parseMyProgress,
  parseProgressEvent,
  toChallenges,
  type Challenge,
  type LevelProgress,
  type MyProgress,
} from '@/lib/levels-model';
import { prefs } from '@/lib/prefs';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';

/**
 * Account progress (20261101000100_progress.sql; docs/progress.md): the caller's level (`my_progress`), other players'
 * levels on their profiles (`public_progress`, privacy-checked), the daily challenges (`my_daily_challenges`, picked
 * by the server on the first call of the UTC day) and claiming them (`claim_daily_challenge`). XP is only ever earned
 * server-side. Changes arrive in real time on the `user:<uid>` channel, event `progress` (lib/social-realtime.ts →
 * `handleProgressBroadcast`): XP awards move the ring, a level-up or a finished challenge shows a celebration.
 */
export const levelKeys = {
  all: (uid: string | null) => ['levels', uid] as const,
  mine: (uid: string | null) => ['levels', uid, 'mine'] as const,
  challenges: (uid: string | null) => ['levels', uid, 'challenges'] as const,
  /** Another player's level as `viewer` may see it (privacy, blocks). */
  player: (viewer: string | null, userId: string) => ['player-level', viewer, userId] as const,
};

/** Level and challenges of `uid` (after a claim, or coming back online). */
export function invalidateLevels(qc: QueryClient, uid: string | null) {
  void qc.invalidateQueries({ queryKey: levelKeys.all(uid) });
}

/**
 * A `progress` broadcast: XP awards update the cached level at once (the event carries the new total), challenge
 * events update the card, and a level-up or a just-finished challenge shows its celebration unless Settings → Coin
 * popups is off.
 */
export function handleProgressBroadcast(qc: QueryClient, uid: string, payload: unknown): void {
  const e = parseProgressEvent(payload);
  if (!e) return;
  if (e.type === 'xp' || e.type === 'level') {
    qc.setQueryData<MyProgress>(levelKeys.mine(uid), (cur) => applyLevelEvent(cur, e));
    if (e.type === 'level') {
      // next_level_coins moved on; the profile's public view of me too.
      void qc.invalidateQueries({ queryKey: levelKeys.mine(uid) });
      void qc.invalidateQueries({ queryKey: levelKeys.player(uid, uid) });
    }
  } else {
    const list = qc.getQueryData<Challenge[]>(levelKeys.challenges(uid));
    const before = list?.find((c) => c.id === e.id);
    const next = list ? applyChallengeEvent(list, e) : null;
    if (next?.known) qc.setQueryData<Challenge[]>(levelKeys.challenges(uid), next.list);
    else void qc.invalidateQueries({ queryKey: levelKeys.challenges(uid) });
    const c = celebrationFor(e, before, 0);
    if (c && prefs.get().coinPopups) pushCelebration({ ...c, key: nextCelebrationKey() });
    return;
  }
  const c = celebrationFor(e, undefined, 0);
  if (c && prefs.get().coinPopups) {
    pushCelebration({ ...c, key: nextCelebrationKey() });
    successHaptic();
  }
}

/** `my_progress()`: the signed-in player's level, XP into it and the next level's coins. */
export function useMyProgress() {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: levelKeys.mine(userId),
    enabled: !!userId && signedIn,
    staleTime: 30_000,
    queryFn: async (): Promise<MyProgress> => {
      const { data, error } = await supabase.rpc('my_progress');
      if (error) throw error;
      return parseMyProgress(data);
    },
  });
}

/**
 * Another player's level for their profile (`public_progress`): null when their privacy (games) or a block hides it.
 * Pass the signed-in user's own id and you get `my_progress` instead (live, from the same cache as the ring).
 */
export function usePlayerLevel(userId: string | null | undefined): {
  data: LevelProgress | null | undefined;
  refetch: () => Promise<unknown>;
} {
  const { userId: viewer, signedIn } = useSession();
  const own = !!userId && userId === viewer;
  const mine = useMyProgress();
  const other = useQuery({
    queryKey: levelKeys.player(viewer, userId ?? ''),
    enabled: !!userId && !own,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<LevelProgress | null> => {
      const { data, error } = await supabase.rpc('public_progress', { p_user_id: userId! });
      if (error) throw error;
      return parseLevelProgress(data);
    },
  });
  if (own) return { data: signedIn ? mine.data : undefined, refetch: mine.refetch };
  return { data: other.data, refetch: other.refetch };
}

/** `my_daily_challenges()`: today's three plus yesterday's unclaimed finished ones. Linked accounts only. */
export function useDailyChallenges() {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: levelKeys.challenges(userId),
    enabled: !!userId && signedIn,
    staleTime: 30_000,
    queryFn: async (): Promise<Challenge[]> => {
      const { data, error } = await supabase.rpc('my_daily_challenges');
      if (error) throw error;
      return toChallenges(data);
    },
  });
}

/**
 * `claim_daily_challenge(id)`: on success the card marks it claimed, and the level and balance update from the answer
 * (the coins toast comes through Realtime). A refusal says why in a toast (an already-claimed one just refreshes).
 */
export function useClaimChallenge() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('claim_daily_challenge', { p_id: id });
      if (error) throw error;
      return parseClaimResult(data);
    },
    onSuccess: (r, id) => {
      successHaptic();
      qc.setQueryData<Challenge[]>(levelKeys.challenges(userId), (list) => (list ? markClaimed(list, id) : list));
      if (r.progress) {
        const progress = r.progress;
        qc.setQueryData<MyProgress>(levelKeys.mine(userId), (cur) =>
          cur && cur.total_xp >= progress.total_xp
            ? cur
            : { ...progress, next_level_coins: cur?.next_level_coins ?? 0 },
        );
      }
      if (r.balance !== null) {
        const balance = r.balance;
        qc.setQueryData<WalletSummary>(coinKeys.wallet(userId), (w) =>
          w ? { ...w, balance: Math.max(w.balance, balance) } : w,
        );
      }
    },
    onError: (err) => {
      const text = claimErrorText(claimErrorKind(err));
      if (text) showToast(text);
    },
    onSettled: () => {
      invalidateLevels(qc, userId);
      invalidateCoins(qc, userId);
    },
  });
}
