import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { useSession } from '@/lib/auth/session';
import { coinKeys } from '@/lib/coins';
import { progressKeys } from '@/lib/game-progress';
import { selectionHaptic } from '@/lib/haptics';
import {
  describeSocialError,
  nextFriendship,
  parseFriendship,
  parsePublicPresence,
  PEOPLE_SEARCH_LIMIT,
  peopleQuery,
  socialErrorKind,
  splitRequests,
  toFriends,
  toFriendsPresence,
  toPersonResults,
  toPlayedGames,
  toRecentPlayers,
  type FriendIntent,
  type FriendPresence,
  type FriendRequest,
  type Friendship,
  type PersonResult,
  type PublicPresence,
  type RecentPlayer,
} from '@/lib/social';
import { supabase } from '@/lib/supabase';

/**
 * Friends, requests, people search and the friend/game sections of public profiles (architecture §4: every
 * cross-user write is a security-definer RPC). Everything social sits under `['social', viewerId]` because what the
 * server returns depends on who asks (friendship state, privacy 'friends'); a friendship mutation invalidates that
 * whole prefix plus the two players' stats and every friends-scope leaderboard.
 */
export const socialKeys = {
  all: (uid: string | null) => ['social', uid] as const,
  searchAll: (uid: string | null) => ['social', uid, 'search'] as const,
  search: (uid: string | null, query: string) => ['social', uid, 'search', query.toLowerCase()] as const,
  friendship: (uid: string | null, otherId: string) => ['social', uid, 'friendship', otherId] as const,
  friends: (uid: string | null) => ['social', uid, 'friends'] as const,
  requests: (uid: string | null) => ['social', uid, 'requests'] as const,
  publicFriends: (uid: string | null, userId: string, limit: number) => ['social', uid, 'public-friends', userId, limit] as const,
  publicGames: (uid: string | null, userId: string) => ['social', uid, 'public-games', userId] as const,
  presence: (uid: string | null) => ['social', uid, 'presence'] as const,
  publicPresence: (uid: string | null, userId: string) => ['social', uid, 'public-presence', userId] as const,
  /** A requester's card for the friend-request sheet / accepted toast (lib/social-realtime.ts `fetchRequestProfile`). */
  requestProfile: (uid: string | null, userId: string) => ['social', uid, 'request-profile', userId] as const,
  /** People you shared counted matches with in the last 14 days (`recently_played_with`). */
  recentPlayers: (uid: string | null) => ['social', uid, 'recent-players'] as const,
};

/** How often friends' presence refreshes while a screen showing it is in front (m3-phase2 §2; realtime is M4). */
export const PRESENCE_REFRESH_MS = 30_000;

/** Rows fetched for the profile's friends row (it shows as many as fit, "See all" opens the full list). */
export const FRIENDS_ROW_LIMIT = 24;
/** Rows fetched for a full friends list. */
export const FRIENDS_LIST_LIMIT = 200;

/** Don't retry what retrying cannot fix (anonymous session, rate limit, blocked, bad input). */
function retryable(failures: number, err: unknown): boolean {
  const kind = socialErrorKind(err);
  return failures < 1 && (kind === 'network' || kind === 'other');
}

/** `search_profiles` for an already-debounced query (≥ 1 character after dropping a leading "@"). */
export function usePeopleSearch(query: string, enabled = true) {
  const { userId } = useSession();
  const q = peopleQuery(query);
  return useQuery({
    queryKey: socialKeys.search(userId, q),
    enabled: enabled && !!userId && q.length >= 1,
    // Keep the previous results on screen while the next query loads (no flash between keystrokes).
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: retryable,
    queryFn: async (): Promise<PersonResult[]> => {
      const { data, error } = await supabase.rpc('search_profiles', { p_query: q, p_limit: PEOPLE_SEARCH_LIMIT });
      if (error) throw error;
      return toPersonResults(data);
    },
  });
}

/** `friendship_with`: the caller's relationship with `otherId`. */
export function useFriendship(otherId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: socialKeys.friendship(userId, otherId ?? ''),
    enabled: !!userId && !!otherId,
    retry: retryable,
    queryFn: async (): Promise<Friendship> => {
      const { data, error } = await supabase.rpc('friendship_with', { p_user_id: otherId! });
      if (error) throw error;
      return parseFriendship(data);
    },
  });
}

/** The signed-in user's friends (`my_friends`). */
export function useMyFriends() {
  const { userId } = useSession();
  return useQuery({
    queryKey: socialKeys.friends(userId),
    enabled: !!userId,
    retry: retryable,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_friends', { p_limit: FRIENDS_LIST_LIMIT });
      if (error) throw error;
      return toFriends(data);
    },
  });
}

/** `my_friend_requests`, split into incoming and outgoing (newest first). */
export async function fetchFriendRequests(): Promise<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }> {
  const { data, error } = await supabase.rpc('my_friend_requests');
  if (error) throw error;
  return splitRequests(data);
}

/** Pending requests (`my_friend_requests`), split into incoming and outgoing. */
export function useFriendRequests() {
  const { userId } = useSession();
  return useQuery({
    queryKey: socialKeys.requests(userId),
    enabled: !!userId,
    retry: retryable,
    queryFn: fetchFriendRequests,
  });
}

/** Another player's friends (`public_friends`); [] when their privacy hides the list from the caller. */
export function usePublicFriends(userId: string | undefined, limit = FRIENDS_ROW_LIMIT) {
  const { userId: viewer } = useSession();
  return useQuery({
    queryKey: socialKeys.publicFriends(viewer, userId ?? '', limit),
    enabled: !!viewer && !!userId,
    retry: retryable,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('public_friends', { p_user_id: userId!, p_limit: limit });
      if (error) throw error;
      return toFriends(data);
    },
  });
}

/** Games a player has played (`public_profile_games`); [] when their privacy hides them from the caller. */
export function usePublicGames(userId: string | undefined) {
  const { userId: viewer } = useSession();
  return useQuery({
    queryKey: socialKeys.publicGames(viewer, userId ?? ''),
    enabled: !!viewer && !!userId,
    retry: retryable,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('public_profile_games', { p_user_id: userId!, p_limit: 50 });
      if (error) throw error;
      return toPlayedGames(data);
    },
  });
}

/**
 * Friends who are online or in a game (`friends_presence`), by user id; offline friends are absent. Polls every 30 s
 * while `live` (the screen is in front; React Query also pauses in the background) and refetches on focus.
 */
export function useFriendsPresence(live = true) {
  const { userId } = useSession();
  return useQuery({
    queryKey: socialKeys.presence(userId),
    enabled: !!userId,
    retry: retryable,
    staleTime: 10_000,
    refetchInterval: live ? PRESENCE_REFRESH_MS : false,
    queryFn: async (): Promise<Map<string, FriendPresence>> => {
      const { data, error } = await supabase.rpc('friends_presence');
      if (error) throw error;
      return toFriendsPresence(data);
    },
  });
}

/** Rows fetched for the Friends screen's "Recently played with". */
export const RECENT_PLAYERS_LIMIT = 20;

/**
 * People the signed-in user shared counted multiplayer matches with in the last 14 days (`recently_played_with`), most
 * recent first, with the game, when, and the friendship state for the Add button. Under the social prefix, so every
 * friendship change refetches it (and `writeFriendship` patches it optimistically).
 */
export function useRecentlyPlayedWith(enabled = true) {
  const { userId } = useSession();
  return useQuery({
    queryKey: socialKeys.recentPlayers(userId),
    enabled: enabled && !!userId,
    retry: retryable,
    staleTime: 60_000,
    queryFn: async (): Promise<RecentPlayer[]> => {
      const { data, error } = await supabase.rpc('recently_played_with', { p_limit: RECENT_PLAYERS_LIMIT });
      if (error) throw error;
      return toRecentPlayers(data);
    },
  });
}

/** A player's status line (`public_presence`): null when offline or hidden from the viewer (their privacy, blocks). */
export function usePublicPresence(userId: string | undefined, live = true) {
  const { userId: viewer } = useSession();
  return useQuery({
    queryKey: socialKeys.publicPresence(viewer, userId ?? ''),
    enabled: !!viewer && !!userId,
    retry: retryable,
    staleTime: 10_000,
    refetchInterval: live ? PRESENCE_REFRESH_MS : false,
    queryFn: async (): Promise<PublicPresence | null> => {
      const { data, error } = await supabase.rpc('public_presence', { p_user_id: userId! });
      if (error) throw error;
      return parsePublicPresence(data);
    },
  });
}

async function runIntent(intent: FriendIntent, otherId: string): Promise<unknown> {
  const p_user_id = otherId;
  switch (intent) {
    case 'send': {
      const { data, error } = await supabase.rpc('send_friend_request', { p_user_id });
      if (error) throw error;
      return data;
    }
    case 'accept':
    case 'decline': {
      const { data, error } = await supabase.rpc('respond_friend_request', { p_user_id, p_accept: intent === 'accept' });
      if (error) throw error;
      return data;
    }
    // Cancelling an outgoing request removes the pending pair, like unfriending an accepted one.
    case 'cancel':
    case 'remove': {
      const { error } = await supabase.rpc('remove_friend', { p_user_id });
      if (error) throw error;
      return undefined;
    }
    case 'block': {
      const { error } = await supabase.rpc('block_user', { p_user_id });
      if (error) throw error;
      return undefined;
    }
    case 'unblock': {
      const { error } = await supabase.rpc('unblock_user', { p_user_id });
      if (error) throw error;
      return undefined;
    }
  }
}

/**
 * Write `status` for `otherId` into every cache that shows it (friendship query, search rows, "Recently played with",
 * request lists).
 */
function writeFriendship(qc: QueryClient, uid: string | null, otherId: string, status: Friendship) {
  qc.setQueryData<Friendship>(socialKeys.friendship(uid, otherId), status);
  qc.setQueriesData<PersonResult[]>({ queryKey: socialKeys.searchAll(uid) }, (rows) =>
    rows?.map((r) => (r.userId === otherId ? { ...r, friendship: status } : r)),
  );
  qc.setQueryData<RecentPlayer[]>(socialKeys.recentPlayers(uid), (rows) =>
    rows?.map((r) => (r.userId === otherId ? { ...r, friendship: status } : r)),
  );
  if (status !== 'incoming' && status !== 'outgoing') {
    qc.setQueryData<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>(socialKeys.requests(uid), (r) =>
      r ? { incoming: r.incoming.filter((x) => x.userId !== otherId), outgoing: r.outgoing.filter((x) => x.userId !== otherId) } : r,
    );
  }
}

/**
 * Invalidation after any friendship change with `otherId`: the viewer's whole social prefix (friendship, search,
 * friends, requests, public friends/games of anyone, since visibility may depend on being friends), both players'
 * `public_profile_stats` (friends count), friends-scope leaderboards, and the other player's achievements (blocking
 * hides them).
 */
export function invalidateSocial(qc: QueryClient, uid: string | null, otherId: string) {
  void qc.invalidateQueries({ queryKey: socialKeys.all(uid) });
  void qc.invalidateQueries({ queryKey: progressKeys.userStats(otherId) });
  if (uid) void qc.invalidateQueries({ queryKey: progressKeys.userStats(uid) });
  void qc.invalidateQueries({ queryKey: progressKeys.userAchievements(otherId) });
  // A block hides equipped cosmetics both ways (public_cosmetics); an unblock shows them again.
  void qc.invalidateQueries({ queryKey: coinKeys.cosmetics(uid, otherId) });
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'progress' && q.queryKey[3] === 'top' && q.queryKey[5] === 'friends',
  });
}

export interface FriendshipVars {
  userId: string;
  intent: FriendIntent;
  /** The relationship as the UI showed it (for the optimistic update). */
  current: Friendship;
}

/**
 * One mutation for every friendship button: optimistic status everywhere it is shown, the server's answer when it
 * returns one (`send_friend_request` may come back 'friends'), rollback on error, then `invalidateSocial`.
 */
export function useFriendshipAction() {
  const { userId: uid } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, intent, current }: FriendshipVars): Promise<Friendship> =>
      nextFriendship(current, intent, await runIntent(intent, userId)),
    onMutate: async ({ userId, intent, current }) => {
      selectionHaptic();
      // Every social query may hold this relationship (search rows, request lists): stop in-flight refetches
      // so none of them lands on top of the optimistic state; onSettled refetches them all.
      await qc.cancelQueries({ queryKey: socialKeys.all(uid) });
      const snapshot = qc.getQueriesData({ queryKey: socialKeys.all(uid) });
      writeFriendship(qc, uid, userId, nextFriendship(current, intent));
      return { snapshot };
    },
    onSuccess: (status, { userId }) => writeFriendship(qc, uid, userId, status),
    // Reported here, not in the callers' mutate(): the optimistic update removes a request row before the
    // server answers, and callbacks passed to mutate() never fire once their component has unmounted.
    onError: (err, { intent }, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      Alert.alert("Couldn't update", describeSocialError(err, intent));
    },
    onSettled: (_data, _err, { userId }) => invalidateSocial(qc, uid, userId),
  });
}
