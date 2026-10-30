import { Link } from 'expo-router';
import { ChevronRightIcon, PlayIcon, UsersIcon } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { playersLabel, type GameCard as GameCardData } from '@/lib/catalog';
import { coverUriFor } from '@/lib/game-art';
import { featuredCardHeight } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { GameCover } from './game-cover';
import { PresenceDot } from './presence-dot';

/**
 * Hero card for the featured carousel: full-bleed cover (game.json `cover`, else the first screenshot), big title, age
 * chip, Play pill (opens the game page). `banner` (wide windows): a 16:7 banner with the title, meta and Play pill
 * over its left third.
 */
export const FeaturedGameCard = memo(function FeaturedGameCard({
  game,
  width,
  banner = false,
}: {
  game: GameCardData;
  width: number;
  banner?: boolean;
}) {
  const meta = [game.genres[0] && capitalize(game.genres[0]), playersLabel(game)].filter(Boolean).join(' · ');
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${game.title}, ${meta}`}
        accessibilityHint="Opens the game page"
        className="active:opacity-90"
        style={{ width }}
      >
        <GameCover
          id={game.id}
          title={game.title}
          uri={coverUriFor(game, 'feature')}
          variant="feature"
          showTitle={false}
          scrim={banner ? 'side' : 'dark'}
          className="border-border rounded-3xl border"
          style={{ height: featuredCardHeight(width, banner) }}
        >
          <View className={cn('absolute flex-row gap-2', banner ? 'left-5 top-5' : 'left-4 top-4')}>
            <Badge variant="overlay">
              <Text>Featured</Text>
            </Badge>
          </View>
          {banner ? (
            <View className="absolute bottom-0 left-0 gap-3 p-5" style={{ width: Math.max(Math.round(width * 0.4), 280) }}>
              <Text className="text-[32px] font-extrabold leading-[36px] tracking-tight text-white" numberOfLines={2}>
                {game.title}
              </Text>
              <View className="flex-row items-center gap-2">
                <Badge variant="overlay">
                  <Text>{game.age_rating}</Text>
                </Badge>
                <Text className="shrink text-[13px] font-medium text-white/80" numberOfLines={1}>
                  {meta}
                </Text>
              </View>
              <View className="flex-row">
                <PlayPill />
              </View>
            </View>
          ) : (
            <View className="absolute bottom-0 left-0 right-0 gap-3 p-4">
              <Text className="text-[28px] font-extrabold leading-[32px] tracking-tight text-white" numberOfLines={2}>
                {game.title}
              </Text>
              <View className="flex-row items-center justify-between gap-3">
                <View className="shrink flex-row items-center gap-2">
                  <Badge variant="overlay">
                    <Text>{game.age_rating}</Text>
                  </Badge>
                  <Text className="shrink text-[13px] font-medium text-white/80" numberOfLines={1}>
                    {meta}
                  </Text>
                </View>
                <PlayPill />
              </View>
            </View>
          )}
        </GameCover>
      </Pressable>
    </Link>
  );
});

/** Primary "Play" pill (decorative inside a pressable card). */
function PlayPill() {
  return (
    <View className="bg-primary h-10 flex-row items-center gap-1.5 rounded-full pl-3.5 pr-4" importantForAccessibility="no">
      <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-3.5" />
      <Text className="text-primary-foreground text-[15px] font-bold">Play</Text>
    </View>
  );
}

/**
 * Compact tile for horizontal rows and the search grid: box-art cover (game.json `icon`, else `cover`, else the first
 * screenshot) with the title set in, one meta line.
 */
export const GameTile = memo(function GameTile({
  game,
  className,
  subtitle,
  live,
  width,
}: {
  game: GameCardData;
  className?: string;
  subtitle?: string;
  /** "12 playing" (lib/dashboard.ts `liveCountLabel`): a multiplayer game with players right now; wins the meta line. */
  live?: string | null;
  width: number;
}) {
  const meta = subtitle || (game.genres[0] ? capitalize(game.genres[0]) : playersLabel(game));
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <TapPressable
        accessibilityRole="button"
        accessibilityLabel={live ? `${game.title}, ${meta}, ${live}` : `${game.title}, ${meta}`}
        className={cn('gap-2 active:opacity-80', className)}
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
      </TapPressable>
    </Link>
  );
});

/** Same box as GameTile: the square cover, then one 18 pt meta line. */
export function GameTileSkeleton({ width, className }: { width: number; className?: string }) {
  return (
    <View className={cn('gap-2', className)} style={{ width }}>
      <Skeleton className="rounded-2xl" style={{ width, height: width }} />
      <SkeletonText lineHeight={18} width={Math.round(width * 0.45)} className="px-1" />
    </View>
  );
}

/** Same box as FeaturedGameCard (`featuredCardHeight`), with the badge, title and meta / Play pill placeholders. */
export function FeaturedGameSkeleton({ width, banner = false }: { width: number; banner?: boolean }) {
  return (
    <Skeleton className="rounded-3xl" style={{ width, height: featuredCardHeight(width, banner) }}>
      <View className={cn('bg-fill absolute h-[26px] w-20 rounded-full', banner ? 'left-5 top-5' : 'left-4 top-4')} />
      {banner ? (
        <View className="absolute bottom-0 left-0 gap-3 p-5" style={{ width: Math.max(Math.round(width * 0.4), 280) }}>
          <View className="bg-fill h-8 w-56 rounded-lg" />
          <View className="bg-fill h-[26px] w-36 rounded-full" />
          <View className="bg-fill h-10 w-20 rounded-full" />
        </View>
      ) : (
        <View className="absolute bottom-0 left-0 right-0 gap-3 p-4">
          <View className="bg-fill h-8 w-48 rounded-lg" />
          <View className="flex-row items-center justify-between">
            <View className="bg-fill h-[26px] w-32 rounded-full" />
            <View className="bg-fill h-10 w-20 rounded-full" />
          </View>
        </View>
      )}
    </Skeleton>
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
