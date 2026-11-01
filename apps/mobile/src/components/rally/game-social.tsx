import { ThumbsDownIcon, ThumbsUpIcon, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useLiveCounts } from '@/lib/catalog';
import { formatCount } from '@/lib/format';
import { useFriendsPresence, useMyFriends } from '@/lib/friends';
import { friendsPlayingNow, type FriendPlaying, type FriendSummary } from '@/lib/social';
import type { GameLauncher } from '@/lib/use-launch-game';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { useGameVotes, useVoteGame } from '@/lib/votes';
import { likedLabel, likedPercent, votesCountLabel, VOTES_MIN_FOR_PERCENT, type VoteSummary } from '@/lib/votes-model';
import { PlayerName } from './cosmetics';
import { openPerson } from './person-row';
import { PresenceDot } from './presence-dot';
import { ProfileAvatar } from './profile-avatar';
import { SectionHeader } from './section-header';

/**
 * The game page's social layer (20261101000200_social_discovery.sql and m3-phase2 live counts):
 * - `GameLiveLine` under the title: "● 23 playing now" (`game_live_counts`, multiplayer games, polled every 30 s while
 *   the page is in front) and "94% liked · 128 votes" (`game_vote_summary`, hidden under `VOTES_MIN_FOR_PERCENT`);
 * - `GameFriendsHere`: friends in this game right now, each with Join (`join=friend`, like the Friends screen);
 * - `GameRating`: the thumbs up / down card (players who played the game can vote, change or take back their vote).
 */

/** "23 playing now", "1.2K playing now". */
export function playingNowLabel(players: number): string {
  return `${formatCount(players)} playing now`;
}

export function GameLiveLine({ gameId, multiplayer, live }: { gameId: string; multiplayer: boolean; live: boolean }) {
  const counts = useLiveCounts(live && multiplayer);
  const votes = useGameVotes(gameId);
  const players = multiplayer ? (counts.data?.get(gameId)?.players ?? 0) : 0;
  const liked = likedLabel(votes.data);
  if (players <= 0 && !liked) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1.5">
      {players > 0 ? (
        <View className="flex-row items-center gap-1.5" accessible accessibilityLabel={playingNowLabel(players)}>
          <PresenceDot />
          <Text className="text-[15px] font-semibold leading-5">{formatCount(players)}</Text>
          <Text className="text-muted-foreground text-[15px] leading-5">playing now</Text>
        </View>
      ) : null}
      {liked && votes.data ? (
        <View
          className="flex-row items-center gap-1.5"
          accessible
          accessibilityLabel={`${liked}, ${votesCountLabel(votes.data.total)}`}
        >
          <Icon as={ThumbsUpIcon} className="text-foreground size-4" />
          <Text className="text-[15px] font-semibold leading-5">{liked}</Text>
          <Text className="text-muted-foreground text-[15px] leading-5">{`· ${votesCountLabel(votes.data.total)}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

type Here = FriendPlaying<FriendSummary, never>;

/**
 * Friends in this game right now: avatar, name and Join (or Full) per friend, joinable first. Hidden when none. Joins go
 * through the page's launcher (its consent dialog and spinner).
 */
export function GameFriendsHere({ gameId, launcher, live }: { gameId: string; launcher: GameLauncher; live: boolean }) {
  const palette = usePalette();
  const friends = useMyFriends();
  const presence = useFriendsPresence(live);
  const [joining, setJoining] = useState<string | null>(null);
  const here: Here[] = friendsPlayingNow<FriendSummary, never>(friends.data, presence.data, undefined, gameId);
  if (here.length === 0) return null;
  const busy = !!launcher.pending;
  const join = (row: Here) => {
    setJoining(row.friend.userId);
    launcher.launch(
      { id: gameId, title: row.presence.gameTitle ?? 'this game' },
      { join: 'friend', friend: row.friend.userId },
    );
  };
  return (
    <View className="gap-3">
      <SectionHeader
        title="Friends playing now"
        detail={here.length > 1 ? String(here.length) : undefined}
        className="px-0"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="bg-card border-border rounded-2xl border"
        contentContainerClassName="gap-1 px-2 py-3"
      >
        {here.map((row) => {
          const { friend, presence: p } = row;
          const name = friend.displayName || friend.username;
          const spinning = launcher.pending?.join === 'friend' && joining === friend.userId;
          return (
            <View key={friend.userId} className="w-[84px] items-center gap-2">
              <TapPressable
                accessibilityRole="button"
                accessibilityLabel={`${name}, playing now`}
                accessibilityHint="Opens the profile"
                onPress={() => openPerson(friend.username)}
                className="items-center gap-1.5 active:opacity-70"
              >
                <View>
                  <ProfileAvatar
                    userId={friend.userId}
                    profile={{
                      username: friend.username,
                      display_name: friend.displayName,
                      avatar_url: friend.avatarUrl,
                    }}
                    size="md"
                  />
                  <View className="bg-card absolute -bottom-0.5 -right-0.5 rounded-full p-[3px]">
                    <PresenceDot className="size-2.5" />
                  </View>
                </View>
                <PlayerName
                  userId={friend.userId}
                  name={name}
                  className="max-w-[80px] text-center text-[13px] font-medium leading-[18px]"
                />
              </TapPressable>
              {p.joinable ? (
                <Button
                  size="sm"
                  className="h-7 min-w-14 rounded-full px-3"
                  disabled={busy}
                  onPress={() => join(row)}
                  accessibilityLabel={`Join ${name}`}
                >
                  {spinning ? (
                    <ActivityIndicator size="small" color={palette.primaryForeground} />
                  ) : (
                    <Text className="text-[13px]">Join</Text>
                  )}
                </Button>
              ) : (
                <Text variant="muted" className="h-7 text-[13px] leading-7">
                  Full
                </Text>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * "Ratings": the share of thumbs up as a big number with a bar ("94% liked", "128 votes"; under the minimum count:
 * "Not enough votes yet"), and the thumbs for players who played the game (tap the lit one again to take the vote
 * back). Hidden for someone who cannot vote while there is nothing to show yet.
 */
export function GameRating({ gameId }: { gameId: string }) {
  const votes = useGameVotes(gameId);
  const vote = useVoteGame();
  if (votes.isLoading) return <GameRatingSkeleton />;
  const s = votes.data;
  if (!s) return null;
  const pct = likedPercent(s);
  if (pct === null && !s.canVote) return null;
  return <RatingCard summary={s} percent={pct} onVote={(liked) => vote.mutate({ gameId, liked })} />;
}

export function RatingCard({
  summary: s,
  percent,
  onVote,
}: {
  summary: VoteSummary;
  percent: number | null;
  onVote: (liked: boolean | null) => void;
}) {
  return (
    <View className="gap-3">
      <SectionHeader title="Ratings" className="px-0" />
      <View className="bg-card border-border gap-3 rounded-2xl border p-4">
        <View className="flex-row items-center gap-3">
          <View className="shrink grow">
            {percent !== null ? (
              <View className="flex-row items-baseline gap-1.5">
                <Text className="text-[34px] font-extrabold leading-[40px] tracking-tight">{`${percent}%`}</Text>
                <Text className="text-muted-foreground text-[15px]">liked</Text>
              </View>
            ) : (
              <Text className="text-[17px] font-bold leading-[22px]">Not enough votes yet</Text>
            )}
            <Text className="text-muted-foreground text-[13px] leading-[18px]">
              {percent !== null
                ? votesCountLabel(s.total)
                : s.total > 0
                  ? `${votesCountLabel(s.total)} so far · shown from ${VOTES_MIN_FOR_PERCENT}`
                  : 'Be the first to rate it'}
            </Text>
          </View>
          {s.canVote ? (
            <View className="flex-row gap-2">
              <ThumbButton
                icon={ThumbsUpIcon}
                label="Thumbs up"
                count={s.up}
                selected={s.myVote === true}
                onPress={() => onVote(s.myVote === true ? null : true)}
              />
              <ThumbButton
                icon={ThumbsDownIcon}
                label="Thumbs down"
                count={s.down}
                selected={s.myVote === false}
                onPress={() => onVote(s.myVote === false ? null : false)}
              />
            </View>
          ) : null}
        </View>
        {percent !== null ? (
          <View
            className="bg-muted h-1.5 overflow-hidden rounded-full"
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            <View className="bg-foreground h-full rounded-full" style={{ width: `${percent}%` }} />
          </View>
        ) : null}
        {!s.canVote && percent !== null ? (
          <Text variant="muted" className="text-[13px] leading-[18px]">
            Play it to add your vote.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ThumbButton({
  icon,
  label,
  count,
  selected,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={selected ? 'default' : 'outline'}
      size="sm"
      className="h-10 min-w-[60px] gap-1.5 rounded-full px-3"
      onPress={onPress}
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={{ selected }}
      accessibilityHint={selected ? 'Takes your vote back' : undefined}
    >
      <Icon
        as={icon}
        className={cn('size-[18px]', selected ? 'text-primary-foreground fill-primary-foreground' : 'text-foreground')}
      />
      <Text className="text-[13px] tabular-nums">{formatCount(count)}</Text>
    </Button>
  );
}

function GameRatingSkeleton() {
  return (
    <View className="gap-3">
      <SkeletonText lineHeight={22} width={80} />
      <View className="bg-card border-border flex-row items-center gap-3 rounded-2xl border p-4">
        <View className="shrink grow">
          <SkeletonText lineHeight={40} width={120} barClassName="rounded-lg" />
          <SkeletonText lineHeight={18} width={72} />
        </View>
        <Skeleton className="h-10 w-[60px] rounded-full" />
        <Skeleton className="h-10 w-[60px] rounded-full" />
      </View>
    </View>
  );
}
