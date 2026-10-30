import { useCallback, type ReactNode } from 'react';
import { FlatList, View, type ListRenderItem } from 'react-native';
import type { GameCard } from '@/lib/catalog';
import { GameTile, GameTileSkeleton } from './game-card';
import { SectionHeader } from './section-header';

export const ROW_GAP = 12;
const SKELETONS = [0, 1, 2, 3];

/**
 * Titled horizontal row of game tiles that peek past the right edge and snap tile by tile, with matching skeletons
 * while loading. Hidden when empty unless `empty` is given.
 */
export function GameRow({
  title,
  games,
  loading,
  empty,
  tileWidth,
  subtitleFor,
}: {
  title: string;
  games: GameCard[] | undefined;
  loading: boolean;
  empty?: ReactNode;
  tileWidth: number;
  subtitleFor?: (game: GameCard) => string | undefined;
}) {
  const renderItem = useCallback<ListRenderItem<GameCard>>(
    ({ item }) => <GameTile game={item} width={tileWidth} subtitle={subtitleFor?.(item)} />,
    [tileWidth, subtitleFor],
  );

  if (!loading && (!games || games.length === 0) && !empty) return null;
  const count = !loading && games && games.length > 3 ? String(games.length) : undefined;

  return (
    <View className="gap-3">
      <SectionHeader title={title} detail={count} />
      {loading ? (
        <View className="flex-row overflow-hidden px-4" style={{ gap: ROW_GAP }}>
          {SKELETONS.map((i) => (
            <GameTileSkeleton key={i} width={tileWidth} />
          ))}
        </View>
      ) : !games || games.length === 0 ? (
        <View className="px-4">{empty}</View>
      ) : (
        <FlatList
          horizontal
          data={games}
          keyExtractor={(g) => g.id}
          renderItem={renderItem}
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="px-4"
          ItemSeparatorComponent={Separator}
          snapToInterval={tileWidth + ROW_GAP}
          snapToAlignment="start"
          decelerationRate="fast"
          initialNumToRender={4}
          windowSize={5}
        />
      )}
    </View>
  );
}

function Separator() {
  return <View style={{ width: ROW_GAP }} />;
}
