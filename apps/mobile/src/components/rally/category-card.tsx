import { ChevronRightIcon, LayoutGridIcon } from 'lucide-react-native';
import { memo, useCallback } from 'react';
import { FlatList, View, type ListRenderItem } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import type { GameCard } from '@/lib/catalog';
import { categoryCardHeight, gamesCountLabel, type GenreGroup } from '@/lib/dashboard';
import { coverUriFor } from '@/lib/game-art';
import { ROW_GAP, snapInterval } from '@/lib/layout';
import { GameCover } from './game-cover';
import { SectionHeader } from './section-header';

type Pad = { left: number; right: number };
type Group = GenreGroup<GameCard>;

/** Wide 2:1 category card: a cover from one of its games (lib/dashboard.ts `categoryCoverGames`), genre name and count. */
export const CategoryCard = memo(function CategoryCard({
  group,
  cover,
  width,
  onPress,
}: {
  group: Group;
  cover: GameCard | undefined;
  width: number;
  onPress: (group: Group) => void;
}) {
  const count = gamesCountLabel(group.games.length);
  return (
    <TapPressable
      onPress={() => onPress(group)}
      accessibilityRole="button"
      accessibilityLabel={`${group.label}, ${count}`}
      accessibilityHint="Browses the games in this category"
      className="active:opacity-70"
      style={{ width }}
    >
      <GameCover
        id={cover?.id ?? group.key}
        title={group.label}
        uri={cover ? coverUriFor(cover, 'feature') : null}
        variant="feature"
        showTitle={false}
        scrim="dark"
        className="border-border rounded-2xl border"
        style={{ width, height: categoryCardHeight(width) }}
      >
        <View className="absolute bottom-0 left-0 right-0 gap-0.5 p-3.5" pointerEvents="none">
          <Text className="text-[20px] font-extrabold leading-6 tracking-tight text-white" numberOfLines={1}>
            {group.label}
          </Text>
          <Text className="text-[13px] font-medium leading-[18px] text-white/80">{count}</Text>
        </View>
      </GameCover>
    </TapPressable>
  );
});

/** Same box as CategoryCard, with the name and count bars. */
export function CategoryCardSkeleton({ width }: { width: number }) {
  return (
    <Skeleton className="rounded-2xl" style={{ width, height: categoryCardHeight(width) }}>
      <View className="absolute bottom-0 left-0 gap-1.5 p-3.5">
        <View className="bg-fill h-5 w-24 rounded-md" />
        <View className="bg-fill h-3.5 w-14 rounded-md" />
      </View>
    </Skeleton>
  );
}

const SKELETONS = [0, 1, 2, 3];

/** "Browse by category": every genre in the catalog as a wide card; a card opens Browse on its genre (`/browse?genre=`). */
export function CategoryRow({
  groups,
  covers,
  loading,
  cardWidth,
  pad,
  onOpen,
}: {
  groups: Group[];
  covers: Map<string, GameCard>;
  loading: boolean;
  cardWidth: number;
  pad: Pad;
  onOpen: (group: Group) => void;
}) {
  const interval = snapInterval(cardWidth);
  const renderItem = useCallback<ListRenderItem<Group>>(
    ({ item }) => <CategoryCard group={item} cover={covers.get(item.key)} width={cardWidth} onPress={onOpen} />,
    [covers, cardWidth, onOpen],
  );
  const getItemLayout = useCallback(
    (_: ArrayLike<Group> | null | undefined, index: number) => ({
      length: cardWidth,
      offset: pad.left + interval * index,
      index,
    }),
    [cardWidth, interval, pad.left],
  );
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  if (!loading && groups.length === 0) return null;

  return (
    <View className="gap-3">
      <SectionHeader
        title="Browse by category"
        detail={!loading && groups.length > 3 ? String(groups.length) : undefined}
        style={padStyle}
      />
      {loading ? (
        <View className="flex-row overflow-hidden" style={[padStyle, { gap: ROW_GAP }]}>
          {SKELETONS.map((i) => (
            <CategoryCardSkeleton key={i} width={cardWidth} />
          ))}
        </View>
      ) : (
        <FlatList
          key={`${cardWidth}:${pad.left}:${pad.right}`}
          horizontal
          data={groups}
          keyExtractor={(g) => g.key}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={padStyle}
          ItemSeparatorComponent={RowSeparator}
          snapToInterval={interval}
          snapToAlignment="start"
          decelerationRate="fast"
          initialNumToRender={4}
        />
      )}
    </View>
  );
}

function RowSeparator() {
  return <View style={{ width: ROW_GAP }} />;
}

/**
 * "Browse all games" under the category cards: one full-width row (grid icon, label, catalog size, chevron) that opens
 * Browse with every genre (`/browse`).
 */
export function BrowseAllRow({ count, onPress }: { count: number | undefined; onPress: () => void }) {
  const detail = count !== undefined ? gamesCountLabel(count) : undefined;
  return (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `Browse all games, ${detail}` : 'Browse all games'}
      className="bg-card border-border active:bg-accent min-h-14 flex-row items-center gap-3.5 rounded-2xl border px-4 py-3"
    >
      <View className="bg-subtle border-subtle-line size-9 items-center justify-center rounded-xl border">
        <Icon as={LayoutGridIcon} className="text-foreground size-[18px]" />
      </View>
      <Text className="shrink grow text-[15px] font-semibold" numberOfLines={1}>
        Browse all games
      </Text>
      {detail ? <Text className="text-muted-foreground text-[13px] font-medium">{detail}</Text> : null}
      <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
    </TapPressable>
  );
}
