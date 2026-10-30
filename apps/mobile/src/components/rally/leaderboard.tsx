import { router } from 'expo-router';
import { ChevronRightIcon, CircleAlertIcon, TrophyIcon, UsersIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View, type TextStyle } from 'react-native';
import { EmptyState } from '@/components/rally/empty-state';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { SectionHeader } from '@/components/rally/section-header';
import { Segmented } from '@/components/rally/segmented';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useLeaderboardTop, useMyRank, type Board, type Scope } from '@/lib/game-progress';
import { useProfile } from '@/lib/profile';
import { boardLabel, formatScore, splitLeaderboard, type LeaderboardRow } from '@/lib/progress-format';
import { cn } from '@/lib/utils';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

const SCOPES = [
  { value: 'global', label: 'Global' },
  { value: 'friends', label: 'Friends' },
] as const;

/** A row opens that player's public profile (your own row opens your profile). */
function openPlayer(row: { username: string; isMe: boolean }) {
  if (row.isMe) router.push('/profile');
  else router.push({ pathname: '/u/[username]', params: { username: row.username } });
}

/**
 * Game page leaderboard: board picker (when the game has several), Global / Friends, the top 10 with your row
 * highlighted, and "Your rank" below them when you are on the board but outside the top 10. Renders nothing
 * once the game turns out to have no boards.
 */
export function LeaderboardSection({
  gameId,
  boards,
  loading,
  error,
}: {
  gameId: string;
  boards: Board[];
  loading: boolean;
  /** The board list failed to load. */
  error: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('global');
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
          body="Pull down to try again."
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
          body="Pull down to try again."
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
              {i > 0 && <Separator className="ml-[60px]" />}
              <Row row={row} />
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
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}

function Row({ row }: { row: LeaderboardRow }) {
  const score = formatScore(row.score);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Rank ${row.rank}, ${row.isMe ? 'you' : row.username}, ${score}`}
      onPress={() => openPlayer(row)}
      className={cn('flex-row items-center gap-3 px-4 py-2.5 active:opacity-70', row.isMe && 'bg-fill')}
    >
      <View
        className={cn(
          'h-7 min-w-7 items-center justify-center rounded-full px-1',
          row.rank <= 3 && 'bg-subtle border-subtle-line border',
        )}
      >
        <Text
          className={cn('text-[13px] font-bold', row.rank > 3 && 'text-muted-foreground')}
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
      <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
    </Pressable>
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
