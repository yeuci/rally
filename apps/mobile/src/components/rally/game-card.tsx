import { Link } from 'expo-router';
import { PlayIcon, UsersIcon } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { playersLabel, type GameCard as GameCardData } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { GameCover } from './game-cover';

/** Featured card height for a given width (shared with its skeleton). */
export const featuredHeight = (width: number) => Math.round(width * 0.7);

/** Hero card for the featured carousel: full-bleed cover, big title, age chip, Play pill (opens the game page). */
export const FeaturedGameCard = memo(function FeaturedGameCard({ game, width }: { game: GameCardData; width: number }) {
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
          uri={game.screenshots[0]}
          variant="feature"
          showTitle={false}
          scrim="dark"
          className="border-border rounded-3xl border"
          style={{ height: featuredHeight(width) }}
        >
          <View className="absolute left-4 top-4 flex-row gap-2">
            <Badge variant="overlay">
              <Text>Featured</Text>
            </Badge>
          </View>
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
        </GameCover>
      </Pressable>
    </Link>
  );
});

/** Warm "Play" pill (decorative inside a pressable card). */
function PlayPill() {
  return (
    <View className="bg-primary h-10 flex-row items-center gap-1.5 rounded-full pl-3.5 pr-4" importantForAccessibility="no">
      <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-3.5" />
      <Text className="text-primary-foreground text-[15px] font-bold">Play</Text>
    </View>
  );
}

/** Compact tile for horizontal rows and the search grid: box-art cover with the title set in, one meta line. */
export const GameTile = memo(function GameTile({
  game,
  className,
  subtitle,
  width,
}: {
  game: GameCardData;
  className?: string;
  subtitle?: string;
  width: number;
}) {
  const meta = subtitle || (game.genres[0] ? capitalize(game.genres[0]) : playersLabel(game));
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${game.title}, ${meta}`}
        className={cn('gap-2 active:opacity-80', className)}
        style={{ width }}
      >
        <GameCover
          id={game.id}
          title={game.title}
          uri={game.screenshots[0]}
          className="border-border rounded-2xl border"
          style={{ width, height: width }}
        />
        <View className="flex-row items-center gap-1.5 px-1">
          {!subtitle && game.max_players > 1 && <Icon as={UsersIcon} className="text-muted-foreground size-3" />}
          <Text className="text-muted-foreground shrink text-[13px]" numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </Pressable>
    </Link>
  );
});

export function GameTileSkeleton({ width, className }: { width: number; className?: string }) {
  return (
    <View className={cn('gap-2', className)} style={{ width }}>
      <Skeleton className="rounded-2xl" style={{ width, height: width }} />
      <Skeleton className="mx-1 h-3 w-16 rounded-full" />
    </View>
  );
}

export function FeaturedGameSkeleton({ width }: { width: number }) {
  return (
    <View className="bg-muted overflow-hidden rounded-3xl" style={{ width, height: featuredHeight(width) }}>
      <Skeleton className="absolute left-4 top-4 h-6 w-20 rounded-full" />
      <View className="absolute bottom-0 left-0 right-0 gap-3 p-4">
        <Skeleton className="h-7 w-48 rounded-lg" />
        <View className="flex-row items-center justify-between">
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="h-10 w-20 rounded-full" />
        </View>
      </View>
    </View>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
