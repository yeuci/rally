import { CircleAlertIcon, SparklesIcon, UsersIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { ACTIVITY_RETENTION_DAYS } from '@rally/db';
import { ActivityCardView, ActivityListSkeleton, FindPlayersButton } from '@/components/rally/activity-feed';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { useFriendsActivity } from '@/lib/activity';
import { groupActivity } from '@/lib/activity-model';
import { useMyFriends } from '@/lib/friends';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

/**
 * Friend activity (`/activity`, the dashboard row's "See all"): everything the database kept of what your friends did
 * (`friends_activity`, the last 30 days), newest first, 30 rows at a time with "Show more". Rows open the friend's
 * profile, their art the game. Empty states: no friends yet (Find players), friends but nothing yet, and the usual
 * "Couldn't load" with Retry.
 */
export default function ActivityScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const friends = useMyFriends();
  const activity = useFriendsActivity();
  const [refreshing, setRefreshing] = useState(false);
  const cards = groupActivity(activity.data?.pages.flat() ?? []);

  async function refresh() {
    setRefreshing(true);
    try {
      // refetch() resolves, never throws.
      await Promise.all([friends.refetch(), activity.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-4 pt-4"
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
      {activity.isLoading ? (
        <ActivityListSkeleton />
      ) : activity.isError ? (
        <EmptyState
          icon={CircleAlertIcon}
          title="Couldn't load your friends' activity"
          body="Check your connection and try again."
          action={<RetryButton onPress={() => void activity.refetch()} />}
        />
      ) : friends.data?.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="Add friends to see what they're up to"
          body="Their level-ups, new bests, achievements and wins land here."
          action={<FindPlayersButton />}
        />
      ) : cards.length === 0 ? (
        <EmptyState
          icon={SparklesIcon}
          title="Nothing yet"
          body="When a friend levels up, sets a new best, unlocks an achievement or wins a match, it shows up here."
        />
      ) : (
        <>
          <View className="bg-card border-border overflow-hidden rounded-2xl border">
            {cards.map((card, i) => (
              <View key={card.key}>
                {i > 0 && <Separator className="ml-[88px]" />}
                <ActivityCardView card={card} variant="row" />
              </View>
            ))}
          </View>
          {activity.hasNextPage ? (
            <Button
              variant="secondary"
              className="self-center rounded-full px-5"
              onPress={() => void activity.fetchNextPage()}
              disabled={activity.isFetchingNextPage}
            >
              {activity.isFetchingNextPage ? <ActivityIndicator color={palette.foreground} /> : null}
              <Text>{activity.isFetchingNextPage ? 'Loading…' : 'Show more'}</Text>
            </Button>
          ) : (
            <Text variant="muted" className="text-center text-[13px]">
              That&apos;s everything from the last {ACTIVITY_RETENTION_DAYS} days.
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}
