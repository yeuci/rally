import { Link } from 'expo-router';
import { HeartIcon, SearchXIcon, SparklesIcon, WifiOffIcon } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View, useWindowDimensions, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from '@/components/rally/empty-state';
import { FeaturedGameCard, FeaturedGameSkeleton, GameTile } from '@/components/rally/game-card';
import { GameRow, ROW_GAP } from '@/components/rally/game-row';
import { Glow } from '@/components/rally/glow';
import { LogoMark } from '@/components/rally/logo';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { SearchPill } from '@/components/rally/search-pill';
import { SectionHeader } from '@/components/rally/section-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAllGames, useFavorites, useFeaturedGames, useNewGames, useRecentlyPlayed, type GameCard } from '@/lib/catalog';
import { timeAgo } from '@/lib/format';
import { useProfile } from '@/lib/profile';
import { searchGames } from '@/lib/search';
import { usePalette } from '@/lib/use-palette';

const GUTTER = 16;

/** Dashboard: greeting, search, featured hero carousel, then continue playing / new / favorites rows. */
export default function Dashboard() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const palette = usePalette();
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;

  const profile = useProfile();
  const featured = useFeaturedGames();
  const newest = useNewGames();
  const recent = useRecentlyPlayed();
  const favorites = useFavorites();
  const all = useAllGames(searching);

  const featuredCount = featured.data?.length ?? 0;
  // One featured game fills the width; several peek the next card past the edge.
  const cardWidth = Math.min(featuredCount > 1 || featured.isLoading ? width - GUTTER * 2 - 28 : width - GUTTER * 2, 560);
  // Rows show two tiles and part of a third, so it is obvious they scroll.
  const tileWidth = Math.min(Math.floor((width - GUTTER - ROW_GAP * 2) / 2.45), 172);
  const columns = width >= 600 ? 4 : 3;
  const gridTile = Math.floor((width - GUTTER * 2 - ROW_GAP * (columns - 1)) / columns);
  const lastPlayed = new Map(recent.data?.map((g) => [g.id, g.last_played_at]));
  const results = searching ? searchGames(all.data ?? [], query) : [];
  const refreshing = featured.isRefetching || newest.isRefetching || recent.isRefetching || favorites.isRefetching;
  const failed = featured.isError && newest.isError;
  const name = profile.data ? profile.data.display_name || profile.data.username : null;

  const refresh = () => {
    void featured.refetch();
    void newest.refetch();
    void recent.refetch();
    void favorites.refetch();
  };

  const renderFeatured = useCallback<ListRenderItem<GameCard>>(
    ({ item }) => <FeaturedGameCard game={item} width={cardWidth} />,
    [cardWidth],
  );

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-8"
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <Glow size={width * 1.4} style={{ top: -width * 0.85, left: -width * 0.45 }} />

      <View className="gap-5 px-4">
        <View className="flex-row items-center justify-between gap-4">
          <View className="shrink gap-1">
            <View className="flex-row items-center gap-1.5">
              <LogoMark size={20} />
              {profile.isLoading ? (
                <Skeleton className="h-3.5 w-24 rounded-full" />
              ) : (
                <Text className="text-muted-foreground shrink text-[13px] font-semibold" numberOfLines={1}>
                  {name ? `Hey, ${name}` : 'Welcome back'}
                </Text>
              )}
            </View>
            <Text className="text-[28px] font-extrabold leading-[34px] tracking-tight">Let&apos;s play</Text>
          </View>
          <Link href="/profile" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="Profile" hitSlop={8} className="active:opacity-70">
              <ProfileAvatar profile={profile.data} size="md" ring />
            </Pressable>
          </Link>
        </View>

        <SearchPill value={query} onChangeText={setQuery} />
      </View>

      {searching ? (
        <View className="gap-3">
          <SectionHeader title="Results" detail={all.isLoading ? undefined : String(results.length)} />
          <View className="px-4">
            {all.isLoading ? (
              <View className="flex-row flex-wrap" style={{ gap: ROW_GAP }}>
                {Array.from({ length: columns }, (_, i) => (
                  <Skeleton key={i} className="rounded-2xl" style={{ width: gridTile, height: gridTile }} />
                ))}
              </View>
            ) : results.length === 0 ? (
              <EmptyState
                icon={SearchXIcon}
                title={`No games match “${query.trim()}”`}
                body="Try a title, or a genre like puzzle or racing."
              />
            ) : (
              <View className="flex-row flex-wrap" style={{ gap: ROW_GAP }}>
                {results.map((g) => (
                  <GameTile key={g.id} game={g} width={gridTile} />
                ))}
              </View>
            )}
          </View>
        </View>
      ) : failed ? (
        <View className="px-4">
          <EmptyState
            icon={WifiOffIcon}
            title="Couldn't load games"
            body="Check your connection and try again."
            action={
              <Button variant="secondary" onPress={refresh}>
                <Text>Retry</Text>
              </Button>
            }
          />
        </View>
      ) : (
        <>
          {(featured.isLoading || featuredCount > 0) &&
            (featured.isLoading ? (
              <View className="flex-row overflow-hidden px-4" style={{ gap: ROW_GAP }}>
                <FeaturedGameSkeleton width={cardWidth} />
                <FeaturedGameSkeleton width={cardWidth} />
              </View>
            ) : (
              <FlatList
                horizontal
                data={featured.data}
                keyExtractor={(g) => g.id}
                renderItem={renderFeatured}
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="px-4"
                ItemSeparatorComponent={RowSeparator}
                snapToInterval={cardWidth + ROW_GAP}
                snapToAlignment="start"
                decelerationRate="fast"
                initialNumToRender={2}
              />
            ))}

          <GameRow
            title="Continue playing"
            games={recent.data}
            loading={recent.isLoading}
            tileWidth={tileWidth}
            subtitleFor={(g) => timeAgo(lastPlayed.get(g.id))}
          />
          <GameRow
            title="New on Rally"
            games={newest.data}
            loading={newest.isLoading}
            tileWidth={tileWidth}
            empty={
              <EmptyState icon={SparklesIcon} title="No games yet" body="New games land here as soon as they're published." />
            }
          />
          <GameRow
            title="Favorites"
            games={favorites.data}
            loading={favorites.isLoading}
            tileWidth={tileWidth}
            empty={<EmptyState compact icon={HeartIcon} title="No favorites yet" body="Tap the heart on any game to keep it here." />}
          />
        </>
      )}
    </ScrollView>
  );
}

function RowSeparator() {
  return <View style={{ width: ROW_GAP }} />;
}
