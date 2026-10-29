import { Link } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { playersLabel, type GameCard as GameCardData } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { GameCover } from './game-cover';

/** Large card for the featured carousel. */
export function FeaturedGameCard({ game, width }: { game: GameCardData; width: number }) {
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={game.title}
        className="bg-card border-border overflow-hidden rounded-2xl border active:opacity-90"
        style={{ width }}
      >
        <GameCover title={game.title} uri={game.screenshots[0]} className="aspect-video w-full" />
        <View className="gap-1.5 p-4">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="shrink text-lg font-semibold" numberOfLines={1}>
              {game.title}
            </Text>
            <Badge variant="secondary">
              <Text>{game.age_rating}</Text>
            </Badge>
          </View>
          <Text variant="muted" numberOfLines={2}>
            {game.description || [game.genres.join(' · '), playersLabel(game)].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Pressable>
    </Link>
  );
}

/** Compact tile for horizontal rows and the search grid. */
export function GameTile({
  game,
  className,
  subtitle,
  width,
}: {
  game: GameCardData;
  className?: string;
  subtitle?: string;
  width?: number;
}) {
  return (
    <Link href={{ pathname: '/game/[id]', params: { id: game.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={game.title}
        className={cn('w-36 gap-2 active:opacity-80', className)}
        style={width ? { width } : undefined}
      >
        <GameCover title={game.title} uri={game.screenshots[0]} className="border-border aspect-square w-full rounded-xl border" />
        <View className="gap-0.5 px-0.5">
          <Text className="text-sm font-medium" numberOfLines={1}>
            {game.title}
          </Text>
          <Text variant="muted" className="text-xs" numberOfLines={1}>
            {subtitle ?? (game.genres[0] ? capitalize(game.genres[0]) : playersLabel(game))}
          </Text>
        </View>
      </Pressable>
    </Link>
  );
}

export function GameTileSkeleton({ className }: { className?: string }) {
  return (
    <View className={cn('w-36 gap-2', className)}>
      <Skeleton className="aspect-square w-full rounded-xl" />
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="h-3 w-16" />
    </View>
  );
}

export function FeaturedGameSkeleton({ width }: { width: number }) {
  return (
    <View className="border-border overflow-hidden rounded-2xl border" style={{ width }}>
      <Skeleton className="aspect-video w-full rounded-none" />
      <View className="gap-2 p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-56" />
      </View>
    </View>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
