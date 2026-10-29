import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import type { GameCard } from '@/lib/catalog';
import { GameTile, GameTileSkeleton } from './game-card';

/** Titled horizontal row of game tiles with skeletons while loading. Hidden when empty unless `empty` is given. */
export function GameRow({
  title,
  games,
  loading,
  empty,
  subtitleFor,
}: {
  title: string;
  games: GameCard[] | undefined;
  loading: boolean;
  empty?: ReactNode;
  subtitleFor?: (game: GameCard) => string | undefined;
}) {
  if (!loading && (!games || games.length === 0) && !empty) return null;
  return (
    <View className="gap-3">
      <Text className="px-4 text-lg font-semibold">{title}</Text>
      {!loading && games && games.length === 0 ? (
        <View className="px-4">{empty}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-3 px-4">
          {loading
            ? [0, 1, 2, 3].map((i) => <GameTileSkeleton key={i} />)
            : games!.map((g) => <GameTile key={g.id} game={g} subtitle={subtitleFor?.(g)} />)}
        </ScrollView>
      )}
    </View>
  );
}
