import { useCallback, type ReactNode } from 'react';
import { FlatList, View, type ListRenderItem } from 'react-native';
import type { GameCard } from '@/lib/catalog';
import { GUTTER, ROW_GAP, snapInterval } from '@/lib/layout';
import { GameTile, GameTileSkeleton } from './game-card';
import { SectionHeader } from './section-header';

export { ROW_GAP };
const SKELETONS = [0, 1, 2, 3, 4, 5];
const DEFAULT_PAD = { left: GUTTER, right: GUTTER };

/**
 * Titled horizontal row of game tiles that peek past the right edge and snap tile by tile, with matching skeletons
 * while loading. Hidden when empty unless `empty` is given. `pad` is the page's horizontal padding (gutter plus the
 * safe-area inset on each side); the list itself bleeds to the window edges.
 */
export function GameRow({
  title,
  games,
  loading,
  empty,
  tileWidth,
  pad = DEFAULT_PAD,
  subtitleFor,
}: {
  title: string;
  games: GameCard[] | undefined;
  loading: boolean;
  empty?: ReactNode;
  tileWidth: number;
  pad?: { left: number; right: number };
  subtitleFor?: (game: GameCard) => string | undefined;
}) {
  const renderItem = useCallback<ListRenderItem<GameCard>>(
    ({ item }) => <GameTile game={item} width={tileWidth} subtitle={subtitleFor?.(item)} />,
    [tileWidth, subtitleFor],
  );
  const interval = snapInterval(tileWidth);
  // Cells sit after the content container's left padding, one snap interval (tile + separator) apart.
  const getItemLayout = useCallback(
    (_: ArrayLike<GameCard> | null | undefined, index: number) => ({ length: tileWidth, offset: pad.left + interval * index, index }),
    [tileWidth, interval, pad.left],
  );

  if (!loading && (!games || games.length === 0) && !empty) return null;
  const count = !loading && games && games.length > 3 ? String(games.length) : undefined;
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };

  return (
    <View className="gap-3">
      <SectionHeader title={title} detail={count} style={padStyle} />
      {loading ? (
        <View className="flex-row overflow-hidden" style={[padStyle, { gap: ROW_GAP }]}>
          {SKELETONS.map((i) => (
            <GameTileSkeleton key={i} width={tileWidth} />
          ))}
        </View>
      ) : !games || games.length === 0 ? (
        <View style={padStyle}>{empty}</View>
      ) : (
        <FlatList
          // Re-keyed on the tile width and padding: a rotation remounts the list, so no snap offset, measured cell or scroll
          // position from the old orientation survives.
          key={`${tileWidth}:${pad.left}:${pad.right}`}
          horizontal
          data={games}
          keyExtractor={(g) => g.id}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={padStyle}
          ItemSeparatorComponent={Separator}
          snapToInterval={interval}
          snapToAlignment="start"
          decelerationRate="fast"
          initialNumToRender={6}
          windowSize={5}
        />
      )}
    </View>
  );
}

function Separator() {
  return <View style={{ width: ROW_GAP }} />;
}
