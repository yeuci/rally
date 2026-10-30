import { useCallback, type ReactNode } from 'react';
import { FlatList, View, type ListRenderItem } from 'react-native';
import { SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import type { GameCard } from '@/lib/catalog';
import { ROW_GAP, snapInterval } from '@/lib/layout';
import { GameTile, GameTileSkeleton } from './game-card';
import { SectionHeader } from './section-header';

const SKELETONS = [0, 1, 2, 3, 4, 5];

type Pad = { left: number; right: number };

/**
 * Dashboard row of square icon tiles (`GameTile`: `coverUriFor(game, 'tile')`), snapping tile by tile and bleeding
 * off the right edge, with an optional header accessory ("See all"). Same geometry as `GameRow`; hidden when empty
 * unless `empty` is given. Re-keyed on its geometry, so nothing from the previous orientation survives a rotation.
 */
export function TileRow({
  title,
  games,
  loading,
  empty,
  tileWidth,
  pad,
  subtitleFor,
  onSeeAll,
}: {
  title: string;
  games: GameCard[] | undefined;
  loading: boolean;
  empty?: ReactNode;
  tileWidth: number;
  pad: Pad;
  subtitleFor?: (game: GameCard) => string | undefined;
  /** Shows "See all" on the right of the header. */
  onSeeAll?: () => void;
}) {
  const renderItem = useCallback<ListRenderItem<GameCard>>(
    ({ item }) => <GameTile game={item} width={tileWidth} subtitle={subtitleFor?.(item)} />,
    [tileWidth, subtitleFor],
  );
  const interval = snapInterval(tileWidth);
  const getItemLayout = useCallback(
    (_: ArrayLike<GameCard> | null | undefined, index: number) => ({
      length: tileWidth,
      offset: pad.left + interval * index,
      index,
    }),
    [tileWidth, interval, pad.left],
  );

  if (loading) return <TileRowSkeleton title={title} tileWidth={tileWidth} pad={pad} />;
  if ((!games || games.length === 0) && !empty) return null;
  const count = games && games.length > 3 ? String(games.length) : undefined;
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };

  return (
    <View className="gap-3">
      <SectionHeader
        title={title}
        detail={count}
        style={padStyle}
        accessory={onSeeAll && games && games.length > 0 ? <SeeAll label={title} onPress={onSeeAll} /> : undefined}
      />
      {!games || games.length === 0 ? (
        <View style={padStyle}>{empty}</View>
      ) : (
        <FlatList
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

/** "See all" header accessory. */
export function SeeAll({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`See all ${label}`}
      hitSlop={8}
      className="active:opacity-70"
    >
      <Text className="text-muted-foreground text-[15px] font-semibold">See all</Text>
    </TapPressable>
  );
}

/**
 * Same box as `TileRow`: the 22 pt header line (its title, or a bar when the title is not known yet, as for genre rows
 * while the catalog loads) and a run of tile skeletons.
 */
export function TileRowSkeleton({ title, tileWidth, pad }: { title?: string; tileWidth: number; pad: Pad }) {
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  return (
    <View className="gap-3">
      {title ? (
        <SectionHeader title={title} style={padStyle} />
      ) : (
        <View style={padStyle}>
          <SkeletonText lineHeight={22} width={128} />
        </View>
      )}
      <View className="flex-row overflow-hidden" style={[padStyle, { gap: ROW_GAP }]}>
        {SKELETONS.map((i) => (
          <GameTileSkeleton key={i} width={tileWidth} />
        ))}
      </View>
    </View>
  );
}

function Separator() {
  return <View style={{ width: ROW_GAP }} />;
}
