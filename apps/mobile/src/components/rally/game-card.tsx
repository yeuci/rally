import { Link } from 'expo-router';
import { ChevronRightIcon, UsersIcon } from 'lucide-react-native';
import { memo } from 'react';
import { View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { playersLabel, type GameCard as GameCardData } from '@/lib/catalog';
import { coverUriFor } from '@/lib/game-art';
import { cn } from '@/lib/utils';
import { GameCover } from './game-cover';
import { PresenceDot } from './presence-dot';

/**
 * Compact tile for the dashboard rows and the Browse grid: box-art cover (game.json `icon`, else `cover`, else the first
 * screenshot) with the title set in, one meta line, and in the Browse grid (`detail` given, even null) a second, quieter
 * line that keeps every tile in a grid row the same height.
 */
export const GameTile = memo(function GameTile({
  game,
  className,
  subtitle,
  live,
  detail,
  width,
}: {
  game: GameCardData;
  className?: string;
  subtitle?: string;
  /** "12 playing" (lib/dashboard.ts `liveCountLabel`): a multiplayer game with players right now; wins the meta line. */
  live?: string | null;
  /**
   * Second line ("12.4K visits" in the Browse grid). `undefined`: no second line (dashboard rows); null or '': the
   * line's space is kept, empty.
   */
  detail?: string | null;
  width: number;
}) {
  const meta = subtitle || (game.genres[0] ? capitalize(game.genres[0]) : playersLabel(game));
  const label = [game.title, meta, live, detail].filter(Boolean).join(', ');
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <TapPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        className={cn('gap-2 active:opacity-70', className)}
        style={{ width }}
      >
        <GameCover
          id={game.id}
          title={game.title}
          uri={coverUriFor(game, 'tile')}
          className="border-border rounded-2xl border"
          style={{ width, height: width }}
        />
        <View className="flex-row items-center gap-1.5 px-1">
          {live ? (
            <PresenceDot />
          ) : (
            !subtitle && game.max_players > 1 && <Icon as={UsersIcon} className="text-muted-foreground size-3" />
          )}
          <Text
            className={cn('shrink text-[13px] leading-[18px]', live ? 'text-foreground font-medium' : 'text-muted-foreground')}
            numberOfLines={1}
          >
            {live || meta}
          </Text>
        </View>
        {detail !== undefined && (
          <Text className="text-muted-foreground -mt-2 px-1 text-[12px] leading-4" numberOfLines={1}>
            {detail || ' '}
          </Text>
        )}
      </TapPressable>
    </Link>
  );
});

/** Same box as GameTile: the square cover, then one 18 pt meta line (and the 16 pt `detail` line with `detail`). */
export function GameTileSkeleton({ width, className, detail }: { width: number; className?: string; detail?: boolean }) {
  return (
    <View className={cn('gap-2', className)} style={{ width }}>
      <Skeleton className="rounded-2xl" style={{ width, height: width }} />
      <SkeletonText lineHeight={18} width={Math.round(width * 0.45)} className="px-1" />
      {detail && <SkeletonText lineHeight={16} width={Math.round(width * 0.35)} className="-mt-2 px-1" />}
    </View>
  );
}

const LIST_ROW = 'flex-row items-center gap-3 px-4 py-2.5';

/** Search result row: 52 pt icon tile (`coverUriFor(game, 'tile')`), title, genre / players, chevron. */
export const GameListRow = memo(function GameListRow({ game }: { game: GameCardData }) {
  const meta = [game.genres[0] && capitalize(game.genres[0]), playersLabel(game)].filter(Boolean).join(' · ');
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <TapPressable accessibilityRole="button" accessibilityLabel={`${game.title}, ${meta}`} className={cn(LIST_ROW, 'active:bg-accent')}>
        <GameCover
          id={game.id}
          title={game.title}
          uri={coverUriFor(game, 'tile')}
          showTitle={false}
          className="border-border size-[52px] rounded-xl border"
        />
        <View className="shrink grow">
          <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
            {game.title}
          </Text>
          <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <Badge variant="outline">
          <Text>{game.age_rating}</Text>
        </Badge>
        <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
      </TapPressable>
    </Link>
  );
});

export function GameListRowSkeleton({ index = 0 }: { index?: number }) {
  return (
    <View className={LIST_ROW}>
      <Skeleton className="size-[52px] rounded-xl" />
      <View className="shrink grow">
        <SkeletonText lineHeight={20} width={index % 2 ? '48%' : '62%'} />
        <SkeletonText lineHeight={18} width="34%" />
      </View>
      <Skeleton className="h-[26px] w-10 rounded-full" />
    </View>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
