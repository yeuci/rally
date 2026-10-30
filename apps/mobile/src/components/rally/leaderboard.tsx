import { router } from 'expo-router';
import { ChevronRightIcon, CircleAlertIcon, TrophyIcon, UsersIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type TextStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { SectionHeader } from '@/components/rally/section-header';
import { Segmented } from '@/components/rally/segmented';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useLeaderboardTop, useMyRank, type Board, type Scope } from '@/lib/game-progress';
import { useProfile } from '@/lib/profile';
import {
  boardLabel,
  formatScore,
  podiumTint,
  splitLeaderboard,
  type LeaderboardRow,
  type PodiumTint,
} from '@/lib/progress-format';
import { cn } from '@/lib/utils';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

const SCOPES = [
  { value: 'global', label: 'Global' },
  { value: 'friends', label: 'Friends' },
] as const;

/** Rank badge of the top three: the medal tokens (tuned per theme in global.css), static class names for Uniwind. */
const PODIUM_BADGE: Record<PodiumTint, string> = {
  gold: 'bg-gold-soft border-gold-line border',
  silver: 'bg-silver-soft border-silver-line border',
  bronze: 'bg-bronze-soft border-bronze-line border',
};
const PODIUM_TEXT: Record<PodiumTint, string> = { gold: 'text-gold', silver: 'text-silver', bronze: 'text-bronze' };

/** Another player's row opens their public profile. */
function openPlayer(row: { username: string }) {
  router.push({ pathname: '/u/[username]', params: { username: row.username } });
}

/**
 * Game page leaderboard: board picker (when the game has several), Global / Friends, the top 10 with your row
 * tinted, and "Your rank" below them when you are on the board but outside the top 10. The top three get gold /
 * silver / bronze rank badges. Tapping your own row (or `highlightMe` changing: the page's "Best" row) flashes it.
 * Renders nothing once the game turns out to have no boards.
 */
export function LeaderboardSection({
  gameId,
  boards,
  loading,
  error,
  highlightMe = 0,
  onRetry,
}: {
  gameId: string;
  boards: Board[];
  loading: boolean;
  /** The board list failed to load. */
  error: boolean;
  /** Bumped by the caller to flash your row (0 = never asked). */
  highlightMe?: number;
  /** Reloads the board list after `error`. */
  onRetry?: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('global');
  const [tapped, setTapped] = useState(0);
  // Changes whenever either source asks for a flash (both only ever count up).
  const flash = tapped + highlightMe;
  const board = boards.find((b) => b.key === picked) ?? boards[0];

  const top = useLeaderboardTop(gameId, board?.key, scope);
  const mine = useMyRank(gameId, board?.key);
  const me = useProfile().data;

  if (!loading && !board) {
    return error ? (
      <View className="gap-3">
        <SectionHeader title="Leaderboard" className="px-0" />
        <EmptyState
          compact
          icon={CircleAlertIcon}
          title="Couldn't load the leaderboard"
          body="Check your connection and try again."
          action={onRetry ? <RetryButton compact onPress={onRetry} /> : undefined}
        />
      </View>
    ) : null;
  }

  const { top: rows, yourRank } = splitLeaderboard(top.data ?? [], mine.data ?? null);

  return (
    <View className="gap-3">
      <SectionHeader
        title="Leaderboard"
        className="px-0"
        accessory={
          <Segmented
            size="sm"
            options={SCOPES}
            value={scope}
            onChange={setScope}
            accessibilityLabel="Leaderboard scope"
          />
        }
      />
      {boards.length > 1 && (
        <Segmented
          options={boards.map((b) => ({ value: b.key, label: boardLabel(b.key) }))}
          value={board?.key ?? ''}
          onChange={setPicked}
          scrollable
          accessibilityLabel="Leaderboard"
          className="max-w-full"
        />
      )}

      {loading || top.isLoading ? (
        <LeaderboardSkeleton />
      ) : top.isError ? (
        <EmptyState
          compact
          icon={CircleAlertIcon}
          title="Couldn't load the leaderboard"
          body="Check your connection and try again."
          action={<RetryButton compact onPress={() => void top.refetch()} />}
        />
      ) : rows.length === 0 ? (
        scope === 'friends' ? (
          <EmptyState
            compact
            icon={UsersIcon}
            title="No friends on this board yet"
            body="Add friends to see how your scores compare."
          />
        ) : (
          <EmptyState
            compact
            icon={TrophyIcon}
            title="No scores yet — be the first"
            body="Play to put your name on the board."
          />
        )
      ) : (
        <View className="bg-card border-border overflow-hidden rounded-2xl border">
          {rows.map((row, i) => (
            <View key={`${row.rank}-${row.userId}`}>
              {/* Inset like the rest of the list, except next to your tinted row: an inset divider there reads as
                  a step in the tint's edge, so it runs full width and the tint gets one straight edge. */}
              {i > 0 && <Separator className={row.isMe || rows[i - 1]?.isMe ? undefined : 'ml-[60px]'} />}
              <Row row={row} flash={flash} onHighlight={() => setTapped((n) => n + 1)} />
            </View>
          ))}
          {yourRank && me && (
            <>
              <View className="bg-subtle border-border border-t px-4 pb-1 pt-2">
                <Text className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">
                  Your rank
                </Text>
              </View>
              <Row
                row={{
                  rank: yourRank.rank,
                  userId: me.id,
                  username: me.username,
                  avatarUrl: me.avatar_url,
                  score: yourRank.score,
                  isMe: true,
                }}
                flash={flash}
                onHighlight={() => setTapped((n) => n + 1)}
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * One board row: rank badge (medal tint for the top three), avatar, name, score. Another player's row opens their
 * profile; your own row (tinted) flashes when tapped or when `flash` changes, an opacity fade that also runs under
 * Reduce Motion (nothing moves).
 */
function Row({ row, flash, onHighlight }: { row: LeaderboardRow; flash: number; onHighlight: () => void }) {
  const score = formatScore(row.score);
  const tint = podiumTint(row.rank);
  const glow = useSharedValue(0);
  useEffect(() => {
    if (!row.isMe || flash === 0) return;
    glow.set(
      withSequence(
        ReduceMotion.Never,
        withTiming(1, { duration: 160, reduceMotion: ReduceMotion.Never }),
        withDelay(900, withTiming(0, { duration: 480, reduceMotion: ReduceMotion.Never }), ReduceMotion.Never),
      ),
    );
  }, [flash, row.isMe, glow]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={`Rank ${row.rank}, ${row.isMe ? 'you' : row.username}, ${score}`}
      accessibilityHint={row.isMe ? 'Highlights your row' : 'Opens the profile'}
      onPress={() => (row.isMe ? onHighlight() : openPlayer(row))}
      className={cn('active:bg-accent flex-row items-center gap-3 px-4 py-2.5', row.isMe && 'bg-fill')}
    >
      {row.isMe && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, glowStyle]} className="bg-subtle-line" />
      )}
      <View className={cn('h-7 min-w-7 items-center justify-center rounded-full px-1', tint && PODIUM_BADGE[tint])}>
        <Text
          className={cn('text-[13px] font-bold', tint ? PODIUM_TEXT[tint] : 'text-muted-foreground')}
          style={TABULAR}
          numberOfLines={1}
        >
          {row.rank}
        </Text>
      </View>
      <ProfileAvatar profile={{ username: row.username, display_name: null, avatar_url: row.avatarUrl }} size="sm" />
      <View className="shrink grow flex-row items-center gap-2">
        <Text className="shrink text-[15px] font-semibold leading-5" numberOfLines={1}>
          {row.username}
        </Text>
        {row.isMe && (
          <Badge variant="subtle">
            <Text>You</Text>
          </Badge>
        )}
      </View>
      <Text className="text-[15px] font-bold" style={TABULAR}>
        {score}
      </Text>
      {row.isMe ? <View className="size-4" /> : <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />}
    </TapPressable>
  );
}

/** Same rows as the board (rank pill, 36 pt avatar, name, score, chevron; 56 pt tall) with inset separators. */
export function LeaderboardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-[60px]" />}
          <View className="flex-row items-center gap-3 px-4 py-2.5">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="size-9 rounded-full" />
            <View className="shrink grow">
              <SkeletonText lineHeight={20} width={i % 2 ? '42%' : '58%'} />
            </View>
            <Skeleton className="h-4 w-12 rounded-full" />
            <View className="size-4" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The whole section while the page itself loads: heading, the scope control's footprint, the board. */
export function LeaderboardSectionSkeleton() {
  return (
    <View className="gap-3">
      <View className="flex-row items-end justify-between">
        <SkeletonText lineHeight={22} width={112} />
        <Skeleton className="h-[34px] w-[132px] rounded-full" />
      </View>
      <LeaderboardSkeleton />
    </View>
  );
}
