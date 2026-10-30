import { router } from 'expo-router';
import { ChevronRightIcon } from 'lucide-react-native';
import { memo, useCallback } from 'react';
import { FlatList, ScrollView, View, type ListRenderItem } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { playersLabel, type GameCard } from '@/lib/catalog';
import { categoryCardHeight, gamesCountLabel, type GenreGroup } from '@/lib/dashboard';
import { coverUriFor } from '@/lib/game-art';
import { ROW_GAP, snapInterval } from '@/lib/layout';
import { useLayout } from '@/lib/use-layout';
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
      accessibilityHint="Lists the games in this category"
      className="active:opacity-80"
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

/** "Browse by category": every genre in the catalog as a wide card; a card opens its `CategorySheet`. */
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
 * Every game in one genre, as a list in a dialog ("See all" on a genre row, or a category card). The search screen
 * has no genre filter to open instead. Rows close the sheet and open the game page.
 */
export function CategorySheet({ group, open, onClose }: { group: Group | null; open: boolean; onClose: () => void }) {
  const { height } = useLayout();
  return (
    <Dialog open={open && !!group} onOpenChange={(o) => !o && onClose()}>
      {group ? (
        <DialogContent className="w-[26rem] max-w-full gap-0 overflow-hidden p-0">
          <DialogHeader className="gap-1 pb-3 pl-5 pr-12 pt-5">
            <DialogTitle className="text-left text-xl font-bold leading-7">{group.label}</DialogTitle>
            <DialogDescription className="text-left">{gamesCountLabel(group.games.length)}</DialogDescription>
          </DialogHeader>
          <Separator />
          <ScrollView style={{ maxHeight: Math.round(height * 0.62) }} contentContainerClassName="py-1">
            {group.games.map((g, i) => (
              <View key={g.id}>
                {i > 0 && <Separator className="ml-[80px]" />}
                <SheetGameRow
                  game={g}
                  onPress={() => {
                    onClose();
                    router.push({ pathname: '/game/[id]', params: { id: g.id } });
                  }}
                />
              </View>
            ))}
          </ScrollView>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Same row as the search results' `GameListRow`, pressable instead of a link so the sheet can close first. */
function SheetGameRow({ game, onPress }: { game: GameCard; onPress: () => void }) {
  const genre = game.genres[0];
  const meta = [genre && genre.charAt(0).toUpperCase() + genre.slice(1), playersLabel(game)]
    .filter(Boolean)
    .join(' · ');
  return (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${game.title}, ${meta}`}
      className="active:bg-accent flex-row items-center gap-3 px-4 py-2.5"
    >
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
  );
}
