import { useQueryClient } from '@tanstack/react-query';
import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { CircleAlertIcon, InboxIcon, SearchIcon, SearchXIcon, UserPlusIcon, UsersIcon } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { LaunchConsentDialog } from '@/components/rally/consent-dialog';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { PersonList, PersonListSkeleton, PersonRow } from '@/components/rally/person-row';
import { SearchPill } from '@/components/rally/search-pill';
import { SectionHeader } from '@/components/rally/section-header';
import { Segmented } from '@/components/rally/segmented';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { monthYear, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import {
  FRIENDS_LIST_LIMIT,
  socialKeys,
  useFriendRequests,
  useFriendshipAction,
  useFriendsPresence,
  useMyFriends,
  usePublicFriends,
} from '@/lib/friends';
import { usePublicProfile } from '@/lib/game-progress';
import { useProfile } from '@/lib/profile';
import { formatScore, sameUsername } from '@/lib/progress-format';
import { filterPeople } from '@/lib/search';
import {
  describeSocialError,
  presenceRow,
  sortByPresence,
  type FriendIntent,
  type FriendPresence,
  type FriendRequest,
  type FriendSummary,
} from '@/lib/social';
import { useLaunchGame, type GameLauncher } from '@/lib/use-launch-game';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

type Tab = 'friends' | 'requests';

/** "Find players": the search screen with "@" typed (people only). */
const findPlayers = () => router.push({ pathname: '/search', params: { q: '@' } });

/**
 * Friends (`/friends`): your friends (`my_friends`, with a field that filters them on the device: name or @username)
 * and pending requests (`my_friend_requests`: incoming with Accept / Decline, outgoing with Cancel), from the
 * profile's Friends row and stats strip (`?tab=requests` opens Requests). "Find players" opens search with "@". With
 * `?username=` it lists another player's friends (`public_friends`, the profile's "See all").
 *
 * Your friends show their presence (`friends_presence`, m3-phase2 §2): "Online" or "In Sumo", playing friends first,
 * with **Join** when their room has a free seat (`useLaunchGame` → `join=friend`: the play route asks
 * `friend_join_target` for the room, so the target never comes from the friend's client). Polled every 30 s while
 * this screen is in front, and refreshed when it comes back into focus.
 */
export default function FriendsScreen() {
  const { username, tab } = useLocalSearchParams<{ username?: string; tab?: string }>();
  const me = useProfile();
  const own = !username || sameUsername(username, me.data?.username);
  return own ? <MyFriends initialTab={tab === 'requests' ? 'requests' : 'friends'} /> : <TheirFriends username={username!} />;
}

function MyFriends({ initialTab }: { initialTab: Tab }) {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const [tab, setTab] = useState<Tab>(initialTab);
  const focused = useIsFocused();
  const { userId } = useSession();
  const qc = useQueryClient();
  const friends = useMyFriends();
  const requests = useFriendRequests();
  const presence = useFriendsPresence(focused);
  const launcher = useLaunchGame();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const incoming = requests.data?.incoming ?? [];
  const outgoing = requests.data?.outgoing ?? [];
  const pending = incoming.length + outgoing.length;

  // Back from a game or a profile: presence may have moved on (only when stale, so the first focus does not refetch).
  useFocusEffect(
    useCallback(() => {
      void qc.refetchQueries({ queryKey: socialKeys.presence(userId), stale: true });
    }, [qc, userId]),
  );

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([friends.refetch(), requests.refetch(), presence.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  const findPeople = (
    <Button variant="secondary" onPress={findPlayers}>
      <Text>Find players</Text>
    </Button>
  );
  const shown = friends.data ? filterPeople(friends.data, filter) : [];

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-4"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      // The filter field: a tap on a friend or Join while the keyboard is up goes through, a drag dismisses it.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <Stack.Screen options={{ title: 'Friends' }} />
      <Segmented
        options={[
          { value: 'friends', label: friends.data ? `Friends · ${formatScore(friends.data.length)}` : 'Friends' },
          { value: 'requests', label: incoming.length > 0 ? `Requests · ${formatScore(incoming.length)}` : 'Requests' },
        ]}
        value={tab}
        onChange={setTab}
        accessibilityLabel="Friends or requests"
        className="self-center"
      />

      {tab === 'friends' ? (
        friends.isLoading ? (
          <PersonListSkeleton count={5} />
        ) : friends.isError ? (
          <EmptyState
            icon={CircleAlertIcon}
            title="Couldn't load your friends"
            body={describeSocialError(friends.error)}
            action={<RetryButton onPress={() => void friends.refetch()} />}
          />
        ) : !friends.data || friends.data.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No friends yet" body="Search for players by name or @username and send a request." action={findPeople} />
        ) : (
          <>
            <SearchPill value={filter} onChangeText={setFilter} placeholder="Search your friends" />
            {launcher.notice ? (
              <Text variant="muted" className="text-center leading-5" accessibilityLiveRegion="polite">
                {launcher.notice.message}
              </Text>
            ) : null}
            {shown.length > 0 ? (
              <FriendList friends={shown} presence={presence.data} launcher={launcher} />
            ) : (
              <EmptyState
                icon={SearchXIcon}
                title={`No friends match “${filter.trim()}”`}
                body="Looking for someone new? Search all players."
                action={findPeople}
              />
            )}
          </>
        )
      ) : requests.isLoading ? (
        <View className="gap-3">
          <SectionHeader title="Received" className="px-0" />
          <PersonListSkeleton count={2} accessory />
        </View>
      ) : requests.isError ? (
        <EmptyState
          icon={CircleAlertIcon}
          title="Couldn't load requests"
          body={describeSocialError(requests.error)}
          action={<RetryButton onPress={() => void requests.refetch()} />}
        />
      ) : pending === 0 ? (
        <EmptyState icon={InboxIcon} title="No pending requests" body="Requests you send and receive wait here until they're answered." action={findPeople} />
      ) : (
        <>
          {incoming.length > 0 && (
            <View className="gap-3">
              <SectionHeader title="Received" detail={formatScore(incoming.length)} className="px-0" />
              <PersonList items={incoming} keyOf={(r) => r.userId} render={(r) => <RequestRow request={r} />} />
            </View>
          )}
          {outgoing.length > 0 && (
            <View className="gap-3">
              <SectionHeader title="Sent" detail={formatScore(outgoing.length)} className="px-0" />
              <PersonList items={outgoing} keyOf={(r) => r.userId} render={(r) => <RequestRow request={r} />} />
            </View>
          )}
        </>
      )}
      <LaunchConsentDialog launcher={launcher} />
    </ScrollView>
  );
}

/**
 * Friends with their presence when known (your own list; another player's list has none): playing friends first,
 * "Online" / "In Sumo" in place of "since …", and Join for a joinable room.
 */
function FriendList({
  friends,
  presence,
  launcher,
}: {
  friends: FriendSummary[];
  presence?: ReadonlyMap<string, FriendPresence>;
  launcher?: GameLauncher;
}) {
  const [joining, setJoining] = useState<string | null>(null);
  const ordered = presence ? sortByPresence(friends, presence) : friends;
  const join = (target: { gameId: string; gameTitle: string; friendId: string }) => {
    if (!launcher) return;
    setJoining(target.friendId);
    launcher.launch({ id: target.gameId, title: target.gameTitle }, { join: 'friend', friend: target.friendId });
  };
  return (
    <PersonList
      items={ordered}
      keyOf={(f) => f.userId}
      render={(f) => {
        const row = presenceRow(presence?.get(f.userId), `@${f.username}`);
        return (
          <PersonRow
            person={f}
            presence={row}
            detail={f.since ? `since ${monthYear(f.since)}` : undefined}
            accessory={
              row?.join && launcher ? (
                <JoinButton
                  label={`Join @${f.username} in ${row.join.gameTitle}`}
                  disabled={!!launcher.pending}
                  spinning={launcher.pending?.join === 'friend' && joining === f.userId}
                  onPress={() => row.join && join(row.join)}
                />
              ) : undefined
            }
          />
        );
      }}
    />
  );
}

/** Join a friend's room (`{ id: gameId, join: 'friend', friend }` through the shared launcher: plan, consent, push). */
function JoinButton({
  label,
  disabled,
  spinning,
  onPress,
}: {
  label: string;
  disabled: boolean;
  spinning: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Button size="sm" className="h-8 min-w-16 rounded-full px-3.5" disabled={disabled} onPress={onPress} accessibilityLabel={label}>
      {spinning ? <ActivityIndicator size="small" color={palette.primaryForeground} /> : <Text className="text-[13px]">Join</Text>}
    </Button>
  );
}

/** A pending request: Accept + Decline when incoming, Cancel when outgoing (optimistic, lib/friends.ts). */
function RequestRow({ request: r }: { request: FriendRequest }) {
  const action = useFriendshipAction();
  const busy = action.isPending;
  const run = (intent: FriendIntent) =>
    action.mutate({ userId: r.userId, intent, current: r.direction }); // failures are reported by the hook itself
  return (
    <PersonRow
      person={r}
      detail={timeAgo(r.createdAt)}
      accessory={
        r.direction === 'incoming' ? (
          <View className="flex-row gap-2">
            <Button size="sm" className="h-8 rounded-full px-3.5" disabled={busy} onPress={() => run('accept')} accessibilityLabel={`Accept @${r.username}`}>
              <Text className="text-[13px]">Accept</Text>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-8 rounded-full px-3.5"
              disabled={busy}
              onPress={() => run('decline')}
              accessibilityLabel={`Decline @${r.username}`}
            >
              <Text className="text-[13px]">Decline</Text>
            </Button>
          </View>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-full px-3.5"
            disabled={busy}
            onPress={() => run('cancel')}
            accessibilityLabel={`Cancel the request to @${r.username}`}
          >
            <Text className="text-[13px]">Cancel</Text>
          </Button>
        )
      }
    />
  );
}

function TheirFriends({ username }: { username: string }) {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const profile = usePublicProfile(username);
  const friends = usePublicFriends(profile.data?.id, FRIENDS_LIST_LIMIT);
  const [refreshing, setRefreshing] = useState(false);
  const loading = profile.isLoading || friends.isLoading;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([profile.refetch(), friends.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-4"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <Stack.Screen options={{ title: `@${username}'s friends` }} />
      {loading ? (
        <PersonListSkeleton count={6} />
      ) : profile.isError || friends.isError ? (
        <EmptyState
          icon={CircleAlertIcon}
          title="Couldn't load friends"
          body="Check your connection and try again."
          action={<RetryButton onPress={() => void refresh()} />}
        />
      ) : !profile.data ? (
        <EmptyState icon={SearchIcon} title="Player not found" body={`There's no Rally player called @${username}.`} />
      ) : !friends.data || friends.data.length === 0 ? (
        <EmptyState icon={UserPlusIcon} title="Nothing to show" body={`@${username}'s friends list is empty or private.`} />
      ) : (
        <FriendList friends={friends.data} />
      )}
    </ScrollView>
  );
}
