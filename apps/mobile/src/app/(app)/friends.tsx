import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CircleAlertIcon, InboxIcon, SearchIcon, UserPlusIcon, UsersIcon } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { EmptyState } from '@/components/rally/empty-state';
import { PersonList, PersonListSkeleton, PersonRow } from '@/components/rally/person-row';
import { SectionHeader } from '@/components/rally/section-header';
import { Segmented } from '@/components/rally/segmented';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { monthYear, timeAgo } from '@/lib/format';
import { FRIENDS_LIST_LIMIT, useFriendRequests, useFriendshipAction, useMyFriends, usePublicFriends } from '@/lib/friends';
import { usePublicProfile } from '@/lib/game-progress';
import { useProfile } from '@/lib/profile';
import { formatScore, sameUsername } from '@/lib/progress-format';
import { describeSocialError, type FriendIntent, type FriendRequest, type FriendSummary } from '@/lib/social';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

type Tab = 'friends' | 'requests';

/**
 * Friends (`/friends`): your friends (`my_friends`) and pending requests (`my_friend_requests`: incoming with Accept /
 * Decline, outgoing with Cancel), from the profile's Friends row and stats strip (`?tab=requests` opens Requests).
 * With `?username=` it lists another player's friends (`public_friends`, the profile's "See all").
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
  const friends = useMyFriends();
  const requests = useFriendRequests();
  const [refreshing, setRefreshing] = useState(false);
  const incoming = requests.data?.incoming ?? [];
  const outgoing = requests.data?.outgoing ?? [];
  const pending = incoming.length + outgoing.length;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([friends.refetch(), requests.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  const findPeople = (
    <Button variant="secondary" onPress={() => router.push('/search')}>
      <Text>Find players</Text>
    </Button>
  );

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
          <EmptyState icon={CircleAlertIcon} title="Couldn't load your friends" body={describeSocialError(friends.error)} />
        ) : !friends.data || friends.data.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No friends yet" body="Search for players by name or @username and send a request." action={findPeople} />
        ) : (
          <FriendList friends={friends.data} />
        )
      ) : requests.isLoading ? (
        <View className="gap-3">
          <SectionHeader title="Received" className="px-0" />
          <PersonListSkeleton count={2} accessory />
        </View>
      ) : requests.isError ? (
        <EmptyState icon={CircleAlertIcon} title="Couldn't load requests" body={describeSocialError(requests.error)} />
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
    </ScrollView>
  );
}

function FriendList({ friends }: { friends: FriendSummary[] }) {
  return (
    <PersonList
      items={friends}
      keyOf={(f) => f.userId}
      render={(f) => <PersonRow person={f} detail={f.since ? `since ${monthYear(f.since)}` : undefined} />}
    />
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
        <EmptyState icon={CircleAlertIcon} title="Couldn't load friends" body="Pull down to try again." />
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
