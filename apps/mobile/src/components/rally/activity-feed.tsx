import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  AwardIcon,
  CircleAlertIcon,
  DoorOpenIcon,
  TargetIcon,
  TrendingUpIcon,
  TrophyIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { memo, useCallback, useEffect } from 'react';
import { FlatList, View, type ListRenderItem } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { activityKeys, useFriendsActivity } from '@/lib/activity';
import {
  ACTIVITY_DASHBOARD_CARDS,
  ACTIVITY_DASHBOARD_DAYS,
  cardA11y,
  cardAction,
  cardSubject,
  groupActivity,
  recentCards,
  type ActivityCard,
  type ActivityKind,
} from '@/lib/activity-model';
import { useSession } from '@/lib/auth/session';
import { timeAgo } from '@/lib/format';
import { useMyFriends } from '@/lib/friends';
import { ROW_GAP, snapInterval } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { PlayerName } from './cosmetics';
import { EmptyState, RetryButton } from './empty-state';
import { GameCover } from './game-cover';
import { openPerson } from './person-row';
import { ProfileAvatar } from './profile-avatar';
import { RowHighlight } from './row-highlight';
import { HeaderAction, SectionHeader } from './section-header';

type Pad = { left: number; right: number };

export const ACTIVITY_TITLE = 'Friend activity';

const KIND_ICONS: Record<ActivityKind, LucideIcon> = {
  level_up: TrendingUpIcon,
  new_best: TargetIcon,
  achievement: AwardIcon,
  match_win: TrophyIcon,
  coop_escape: DoorOpenIcon,
};

/** Card width: about 1.4 cards across a phone, 3+ on a wide window (the Friends playing now cards' rule). */
function cardWidth(pad: Pad, windowWidth: number) {
  const visible = windowWidth >= 700 ? 3.3 : 1.35;
  return Math.max(236, Math.min(300, Math.floor((windowWidth - pad.left - ROW_GAP) / visible)));
}

/** "Find players": the search screen with "@" typed (people only). */
const findPlayers = () => router.push({ pathname: '/search', params: { q: '@' } });

/**
 * Dashboard row "Friend activity": what friends did in the last few days (`friends_activity`, docs/activity.md), newest
 * first, as small cards: "sloth reached level 5", "sloth set a new best in Stack: 216", "sloth unlocked Skyline in
 * Stack", "sloth won a match of Sumo", "sloth and 2 others escaped Northdale". A tap on a card opens the friend's
 * profile, a tap on the art the game page; "See all" opens `/activity` with the whole list. Hidden for anonymous
 * sessions and when friends have been quiet; a player without friends is asked to add some. Refetches when the
 * dashboard comes back in front (`live`, when stale) and with the dashboard's pull to refresh (`refreshing`: the
 * dashboard refetches its own queries, this section follows the gesture).
 */
export function ActivityFeed({
  pad,
  width,
  live,
  refreshing,
}: {
  pad: Pad;
  /** The window width (cards are sized from it). */
  width: number;
  live: boolean;
  refreshing: boolean;
}) {
  const { signedIn, userId } = useSession();
  const qc = useQueryClient();
  const friends = useMyFriends();
  const activity = useFriendsActivity();
  const { refetch } = activity;
  useEffect(() => {
    // Only when stale, and never on top of a fetch already in flight (the first mount), so nothing fetches twice.
    if (live && signedIn) {
      void qc.refetchQueries({ queryKey: activityKeys.feed(userId), stale: true }, { cancelRefetch: false });
    }
  }, [live, signedIn, qc, userId]);
  useEffect(() => {
    if (refreshing && signedIn) void refetch();
  }, [refreshing, signedIn, refetch]);

  if (!signedIn) return null;
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  const w = cardWidth(pad, width);
  const noFriends = friends.data?.length === 0;
  const cards = recentCards(groupActivity(activity.data?.pages.flat() ?? []), ACTIVITY_DASHBOARD_DAYS).slice(
    0,
    ACTIVITY_DASHBOARD_CARDS,
  );

  if (noFriends) {
    return (
      <View className="gap-3">
        <SectionHeader title={ACTIVITY_TITLE} style={padStyle} />
        <View style={padStyle}>
          <EmptyState
            compact
            icon={UsersIcon}
            title="Add friends to see what they're up to"
            body="Their level-ups, new bests and wins show up here."
            action={<FindPlayersButton compact />}
          />
        </View>
      </View>
    );
  }
  if (activity.isLoading || (cards.length === 0 && friends.isLoading))
    return <ActivityFeedSkeleton pad={pad} width={w} />;
  if (activity.isError) {
    return (
      <View className="gap-3">
        <SectionHeader title={ACTIVITY_TITLE} style={padStyle} />
        <View style={padStyle}>
          <EmptyState
            compact
            icon={CircleAlertIcon}
            title="Couldn't load your friends' activity"
            body="Check your connection and try again."
            action={<RetryButton compact onPress={() => void refetch()} />}
          />
        </View>
      </View>
    );
  }
  if (cards.length === 0) return null;
  return <ActivityCards cards={cards} pad={pad} width={w} onSeeAll={() => router.push('/activity')} />;
}

function ActivityCards({
  cards,
  pad,
  width,
  onSeeAll,
}: {
  cards: ActivityCard[];
  pad: Pad;
  width: number;
  onSeeAll: () => void;
}) {
  const renderItem = useCallback<ListRenderItem<ActivityCard>>(
    ({ item }) => <ActivityCardView card={item} width={width} />,
    [width],
  );
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  return (
    <View className="gap-3">
      <SectionHeader
        title={ACTIVITY_TITLE}
        style={padStyle}
        accessory={<HeaderAction label="See all" onPress={onSeeAll} accessibilityLabel="See all friend activity" />}
      />
      <FlatList
        horizontal
        data={cards}
        keyExtractor={(c) => c.key}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={padStyle}
        ItemSeparatorComponent={Gap}
        snapToInterval={snapInterval(width)}
        snapToAlignment="start"
        decelerationRate="fast"
      />
    </View>
  );
}

function Gap() {
  return <View style={{ width: ROW_GAP }} />;
}

/** The empty state's button: opens search with "@" (people only). */
export function FindPlayersButton({ compact = false }: { compact?: boolean }) {
  return (
    <Button
      variant="secondary"
      size={compact ? 'sm' : 'default'}
      className={compact ? 'h-8 rounded-full px-3' : 'rounded-full'}
      onPress={findPlayers}
      accessibilityHint="Opens search"
    >
      <Text className={compact ? 'text-[13px]' : undefined}>Find players</Text>
    </Button>
  );
}

/**
 * One card: the game's art with the friend's avatar on its corner (the avatar alone for a level-up), the friend's name
 * (several names for a shared escape), what they did, and when with the kind's icon. `card`: a bordered card of
 * `width` for the dashboard row; `row`: a list row for the /activity screen (the list draws the separators).
 */
export const ActivityCardView = memo(function ActivityCardView({
  card,
  width,
  variant = 'card',
}: {
  card: ActivityCard;
  width?: number;
  variant?: 'card' | 'row';
}) {
  const lead = card.actors[0]!;
  const game = card.game;
  const avatar = (
    <ProfileAvatar
      userId={lead.userId}
      profile={{ username: lead.username, display_name: lead.displayName, avatar_url: lead.avatarUrl }}
      size={game ? 'sm' : 'md'}
    />
  );
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={cardA11y(card)}
      accessibilityHint="Opens the profile"
      onPress={() => openPerson(lead.username)}
      className={cn(
        'flex-row items-center gap-3',
        variant === 'card' ? 'bg-card border-border active:bg-accent rounded-2xl border p-3' : 'px-4 py-3',
      )}
      style={variant === 'card' && width ? { width } : undefined}
    >
      {({ pressed }) => (
        <>
          {variant === 'row' && <RowHighlight pressed={pressed} />}
          {game ? (
            <TapPressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${game.title}`}
              onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })}
              className="active:opacity-70"
              hitSlop={4}
            >
              <GameCover
                id={game.id}
                title={game.title}
                uri={game.iconUrl}
                showTitle={false}
                className="border-border size-[60px] rounded-xl border"
              />
              <View className="bg-card absolute -bottom-1.5 -right-1.5 rounded-full p-[3px]">{avatar}</View>
            </TapPressable>
          ) : (
            <View className="size-[60px] items-center justify-center">{avatar}</View>
          )}
          <View className="shrink grow gap-0.5 pl-1">
            <PlayerName
              userId={card.actors.length === 1 ? lead.userId : null}
              name={cardSubject(card)}
              className="text-[15px] font-semibold leading-5"
            />
            <Text className="text-[13px] leading-[18px]" numberOfLines={2}>
              {cardAction(card)}
            </Text>
            <View
              className="flex-row items-center gap-1"
              accessible={false}
              importantForAccessibility="no-hide-descendants"
            >
              <Icon as={KIND_ICONS[card.kind]} className="text-muted-foreground size-3" />
              <Text className="text-muted-foreground text-[12px] leading-4" numberOfLines={1}>
                {timeAgo(card.createdAt)}
              </Text>
            </View>
          </View>
        </>
      )}
    </TapPressable>
  );
});

const SKELETON_CARDS = [0, 1, 2];

/** The row while the first page loads: header and two and a bit cards. */
export function ActivityFeedSkeleton({ pad, width }: { pad: Pad; width: number }) {
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  return (
    <View className="gap-3">
      <View style={padStyle}>
        <SkeletonText lineHeight={22} width={132} />
      </View>
      <View className="flex-row" style={[padStyle, { gap: ROW_GAP }]}>
        {SKELETON_CARDS.map((i) => (
          <View
            key={i}
            className="bg-card border-border flex-row items-center gap-3 rounded-2xl border p-3"
            style={{ width }}
          >
            <Skeleton className="size-[60px] rounded-xl" />
            <View className="shrink grow gap-1 pl-1">
              <SkeletonText lineHeight={20} width={i % 2 ? '50%' : '64%'} />
              <SkeletonText lineHeight={18} width="80%" />
              <SkeletonText lineHeight={16} width="36%" />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The /activity list while it loads: `rows` rows in one card. */
export function ActivityListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-[88px]" />}
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Skeleton className="size-[60px] rounded-xl" />
            <View className="shrink grow gap-1 pl-1">
              <SkeletonText lineHeight={20} width={i % 2 ? '40%' : '56%'} />
              <SkeletonText lineHeight={18} width={i % 3 ? '72%' : '58%'} />
              <SkeletonText lineHeight={16} width="30%" />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
