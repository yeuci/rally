import { router, Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { CircleAlertIcon, LayoutGridIcon, SearchXIcon, XIcon } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type ListRenderItem,
  type ScrollViewInstance,
} from 'react-native';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { GameTile, GameTileSkeleton } from '@/components/rally/game-card';
import { Segmented } from '@/components/rally/segmented';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import {
  BROWSE_SORT_OPTIONS,
  browseGames,
  browseGrid,
  browseParams,
  browseTitle,
  genreChips,
  parseBrowseParams,
  type BrowseParams,
  type BrowseSort,
  type GenreChip,
} from '@/lib/browse';
import { playersLabel, useAllGames, useLiveCounts, type GameCard } from '@/lib/catalog';
import { gamesCountLabel, liveCountLabel } from '@/lib/dashboard';
import { visitsLabel } from '@/lib/format';
import { ROW_GAP } from '@/lib/layout';
import { useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/** Vertical gap between grid rows (the tile's meta line sits above it). */
const GRID_ROW_GAP = 20;
const SKELETON_ROWS = 3;
const CHIP_SKELETONS = [72, 96, 80, 88];

/**
 * Browse (`/browse?genre=<tag>&sort=popular|new|az&q=<text>`, every param optional): the whole catalog as a grid of
 * tiles. A chip row of the genres present ("All" first) and a Popular / New / A–Z control sit over it; both write
 * their choice back into the route (`router.setParams`), so a deep link or a state restore shows the same page.
 * Opened from the dashboard (genre rows' "See all", category cards, "Browse all games"), the drawer and search's
 * "See all" (which carries its query as `q`). Multiplayer tiles show "12 playing" (`game_live_counts`, every 30 s
 * while in front); other tiles add a second "12.4K visits" line. Popular orders by visits, then live players. Columns follow the dashboard rows' tile size (lib/browse.ts `browseGrid`): 2 on a portrait phone,
 * 3–4 when wide. Skeleton grid while loading, pull to refresh, an empty state per genre / query, Retry on failure.
 */
export default function BrowseScreen() {
  const raw = useLocalSearchParams<{ genre?: string; sort?: string; q?: string }>();
  const params = parseBrowseParams(raw);
  const { width, insets, wide, pad } = useLayout();
  const palette = usePalette();
  const focused = useIsFocused();
  const catalog = useAllGames();
  const liveCounts = useLiveCounts(focused);
  const [refreshing, setRefreshing] = useState(false);

  const all = catalog.data ?? [];
  const chips = genreChips(all, params.genre);
  const selected = chips.find((c) => c.key === params.genre) ?? chips[0]!;
  const games = browseGames(all, params, liveCounts.data);
  const { columns, tileWidth } = browseGrid(width, pad, wide);
  const counts = liveCounts.data;
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  const loading = catalog.isLoading;
  const failed = catalog.isError && !catalog.data;

  const update = (next: Partial<BrowseParams>) => router.setParams(browseParams({ ...params, ...next }));

  async function refresh() {
    setRefreshing(true);
    try {
      // refetch() resolves, never throws.
      await Promise.all([catalog.refetch(), liveCounts.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  // With a genre picked the genre is the same on every tile: show the player count instead.
  const genrePicked = params.genre !== null;
  // Second line: "12.4K visits", unless the tile shows a live count (its space is kept, so grid rows line up).
  const renderItem = useCallback<ListRenderItem<GameCard>>(
    ({ item }) => {
      const live = liveCountLabel(item, counts);
      return (
        <GameTile
          game={item}
          width={tileWidth}
          subtitle={genrePicked ? playersLabel(item) : undefined}
          live={live}
          detail={live ? null : visitsLabel(item.visits)}
        />
      );
    },
    [tileWidth, genrePicked, counts],
  );

  const header = (
    <View className="gap-3 pb-4 pt-2">
      {loading ? (
        <View className="flex-row overflow-hidden" style={[padStyle, { gap: 8 }]}>
          {CHIP_SKELETONS.map((w, i) => (
            <Skeleton key={i} className="h-9 rounded-full" style={{ width: w }} />
          ))}
        </View>
      ) : failed ? null : (
        <GenreChips chips={chips} selected={selected.key} pad={pad} onSelect={(genre) => update({ genre })} />
      )}
      <View className="flex-row items-center justify-between gap-3" style={padStyle}>
        <Text className="text-muted-foreground shrink text-[13px] font-medium" numberOfLines={1}>
          {loading || failed ? ' ' : gamesCountLabel(games.length)}
        </Text>
        <Segmented
          size="sm"
          options={BROWSE_SORT_OPTIONS}
          value={params.sort}
          onChange={(sort: BrowseSort) => update({ sort })}
          accessibilityLabel="Sort games"
        />
      </View>
      {params.q ? (
        <View style={padStyle}>
          <TapPressable
            onPress={() => update({ q: null })}
            accessibilityRole="button"
            accessibilityLabel={`Matching “${params.q}”`}
            accessibilityHint="Clears the search and shows every game"
            className="bg-muted active:opacity-70 h-8 flex-row items-center gap-1.5 self-start rounded-full pl-3 pr-2.5"
          >
            <Text className="text-[13px] font-medium" numberOfLines={1}>
              Matching “{params.q}”
            </Text>
            <Icon as={XIcon} className="text-muted-foreground size-3.5" />
          </TapPressable>
        </View>
      ) : null}
    </View>
  );

  const empty = loading ? (
    <BrowseGridSkeleton columns={columns} tileWidth={tileWidth} pad={pad} />
  ) : failed ? (
    <View style={padStyle}>
      <EmptyState
        icon={CircleAlertIcon}
        title="Couldn't load games"
        body="Check your connection and try again."
        action={<RetryButton onPress={() => void catalog.refetch()} disabled={catalog.isFetching} />}
      />
    </View>
  ) : (
    <View style={padStyle}>
      <EmptyState
        icon={params.q ? SearchXIcon : LayoutGridIcon}
        title={
          params.q
            ? `No ${params.genre ? `${selected.label} ` : ''}games match “${params.q}”`
            : params.genre
              ? `No ${selected.label} games yet`
              : 'No games yet'
        }
        body={
          params.q
            ? 'Try another search, or clear it to see every game.'
            : params.genre
              ? 'Games in this category show up here as soon as they are published.'
              : 'Games show up here as soon as they are published.'
        }
        action={
          params.genre || params.q ? (
            <Button variant="secondary" size="sm" className="rounded-full px-4" onPress={() => update({ genre: null, q: null })}>
              <Text>Show all games</Text>
            </Button>
          ) : undefined
        }
      />
    </View>
  );

  return (
    <View className="bg-background flex-1">
      <Stack.Screen options={{ title: browseTitle(params.genre ? selected.label : null) }} />
      <FlatList
        // numColumns cannot change on a mounted list: a rotation that changes the column count remounts it.
        key={`cols-${columns}`}
        data={loading || failed ? [] : games}
        keyExtractor={(g) => g.id}
        renderItem={renderItem}
        numColumns={columns}
        columnWrapperStyle={[padStyle, { gap: ROW_GAP }]}
        ItemSeparatorComponent={RowGap}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32, flexGrow: 1 }}
        initialNumToRender={columns * 4}
        windowSize={7}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={palette.foreground}
            colors={[palette.foreground]}
            progressBackgroundColor={palette.card}
          />
        }
      />
    </View>
  );
}

function RowGap() {
  return <View style={{ height: GRID_ROW_GAP }} />;
}

/**
 * The genre chips, scrolling sideways from the page padding to the window edges. The selected chip is filled; a deep
 * link to a genre far along the row scrolls it into view once.
 */
function GenreChips({
  chips,
  selected,
  pad,
  onSelect,
}: {
  chips: GenreChip[];
  selected: string | null;
  pad: { left: number; right: number };
  onSelect: (genre: string | null) => void;
}) {
  const scroller = useRef<ScrollViewInstance>(null);
  const revealed = useRef(false);
  const reveal = (e: LayoutChangeEvent) => {
    if (revealed.current) return;
    revealed.current = true;
    const x = e.nativeEvent.layout.x - pad.left - 24;
    if (x > 0) scroller.current?.scrollTo({ x, animated: false });
  };
  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingLeft: pad.left, paddingRight: pad.right, gap: 8 }}
      accessibilityRole="tablist"
      accessibilityLabel="Categories"
    >
      {chips.map((chip) => {
        const active = chip.key === selected;
        return (
          <TapPressable
            key={chip.key ?? 'all'}
            onPress={() => onSelect(chip.key)}
            onLayout={active && chip.key ? reveal : undefined}
            accessibilityRole="tab"
            accessibilityLabel={`${chip.label}, ${gamesCountLabel(chip.count)}`}
            accessibilityState={{ selected: active }}
            className={cn(
              'h-9 flex-row items-center justify-center rounded-full border px-4',
              active ? 'bg-primary border-primary' : 'bg-card border-border active:opacity-70',
            )}
          >
            <Text
              className={cn('text-[14px] font-semibold', active ? 'text-primary-foreground' : 'text-foreground')}
              numberOfLines={1}
            >
              {chip.label}
            </Text>
          </TapPressable>
        );
      })}
    </ScrollView>
  );
}

/** Same boxes as the grid: `columns` tile skeletons per row, a few rows. */
function BrowseGridSkeleton({
  columns,
  tileWidth,
  pad,
}: {
  columns: number;
  tileWidth: number;
  pad: { left: number; right: number };
}) {
  const rows = Array.from({ length: SKELETON_ROWS }, (_, r) => r);
  const cols = Array.from({ length: columns }, (_, c) => c);
  return (
    <View style={{ gap: GRID_ROW_GAP, paddingLeft: pad.left, paddingRight: pad.right }}>
      {rows.map((r) => (
        <View key={r} className="flex-row" style={{ gap: ROW_GAP }}>
          {cols.map((c) => (
            <GameTileSkeleton key={c} width={tileWidth} detail />
          ))}
        </View>
      ))}
    </View>
  );
}
