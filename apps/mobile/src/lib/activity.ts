import { useInfiniteQuery } from '@tanstack/react-query';
import {
  ACTIVITY_PAGE,
  nextActivityCursor,
  toActivityItems,
  type ActivityCursor,
  type ActivityItem,
} from '@/lib/activity-model';
import { useSession } from '@/lib/auth/session';
import { socialKeys } from '@/lib/friends';
import { supabase } from '@/lib/supabase';

/**
 * The friends activity feed (20261102000500_activity.sql; docs/activity.md): what the signed-in player's friends did
 * lately (level-ups, new bests, achievements, wins, co-op escapes), from `friends_activity`, newest first, a page at a
 * time (keyset on the last row's time and id). The rows are written by database triggers; the server decides who may
 * see whose (accepted friends, no block, the actor's privacy). The dashboard shows the first page's newest cards and
 * `/activity` pages through the rest; both read this one query.
 */
export const activityKeys = {
  /** Under the social prefix: a friendship change (`invalidateSocial`) refetches the feed too. */
  feed: (uid: string | null) => [...socialKeys.all(uid), 'activity'] as const,
};

/** `friends_activity`, paginated. Linked accounts only (anonymous sessions have no friends; the query stays off). */
export function useFriendsActivity(enabled = true) {
  const { userId, signedIn } = useSession();
  return useInfiniteQuery({
    queryKey: activityKeys.feed(userId),
    enabled: enabled && !!userId && signedIn,
    staleTime: 30_000,
    initialPageParam: undefined as ActivityCursor | undefined,
    getNextPageParam: (last: ActivityItem[]) => nextActivityCursor(last),
    queryFn: async ({ pageParam }): Promise<ActivityItem[]> => {
      const { data, error } = await supabase.rpc('friends_activity', {
        p_limit: ACTIVITY_PAGE,
        p_before: pageParam?.before,
        p_before_id: pageParam?.beforeId,
      });
      if (error) throw error;
      return toActivityItems(data);
    },
  });
}
