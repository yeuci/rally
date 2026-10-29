import { Link } from 'expo-router';
import { SearchIcon, XIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeaturedGameCard, FeaturedGameSkeleton, GameTile } from '@/components/rally/game-card';
import { GameRow } from '@/components/rally/game-row';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useAllGames, useFavorites, useFeaturedGames, useNewGames, useRecentlyPlayed } from '@/lib/catalog';
import { timeAgo } from '@/lib/format';
import { useProfile } from '@/lib/profile';
import { searchGames } from '@/lib/search';

const GUTTER = 16;

/** Dashboard: search, featured carousel, continue playing, favorites, new. */
export default function Dashboard() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;

  const profile = useProfile();
  const featured = useFeaturedGames();
  const newest = useNewGames();
  const recent = useRecentlyPlayed();
  const favorites = useFavorites();
  const all = useAllGames(searching);

  const cardWidth = Math.min(width - GUTTER * 2 - 24, 520);
  const columns = width >= 600 ? 4 : 3;
  const tileWidth = Math.floor((width - GUTTER * 2 - 12 * (columns - 1)) / columns);
  const lastPlayed = new Map(recent.data?.map((g) => [g.id, g.last_played_at]));
  const results = searching ? searchGames(all.data ?? [], query) : [];
  const refreshing = featured.isRefetching || newest.isRefetching || recent.isRefetching || favorites.isRefetching;
  const failed = featured.isError && newest.isError;

  const refresh = () => {
    void featured.refetch();
    void newest.refetch();
    void recent.refetch();
    void favorites.refetch();
  };

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-7"
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <View className="gap-4 px-4">
        <View className="flex-row items-center justify-between">
          <View className="gap-0.5">
            <Text variant="muted">{profile.data ? `Hey, ${profile.data.display_name || profile.data.username}` : ' '}</Text>
            <Text variant="h3">Play something</Text>
          </View>
          <Link href="/profile" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="Profile" hitSlop={8} className="active:opacity-70">
              <ProfileAvatar profile={profile.data} size="md" />
            </Pressable>
          </Link>
        </View>

        <View className="justify-center">
          <Icon as={SearchIcon} className="text-muted-foreground absolute left-3 z-10 size-4" />
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="Search games"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            className="h-11 rounded-xl pl-9 pr-9"
            accessibilityLabel="Search games"
          />
          {searching && (
            <Pressable accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={10} className="absolute right-3">
              <Icon as={XIcon} className="text-muted-foreground size-4" />
            </Pressable>
          )}
        </View>
      </View>

      {searching ? (
        <View className="gap-3 px-4">
          {all.isLoading ? (
            <Text variant="muted">Searching…</Text>
          ) : results.length === 0 ? (
            <Text variant="muted">No games match “{query.trim()}”.</Text>
          ) : (
            <View className="flex-row flex-wrap" style={{ gap: 12 }}>
              {results.map((g) => (
                <GameTile key={g.id} game={g} width={tileWidth} />
              ))}
            </View>
          )}
        </View>
      ) : failed ? (
        <View className="items-center gap-3 px-4 py-10">
          <Text variant="large">Couldn&apos;t load games</Text>
          <Text variant="muted" className="text-center">
            Check your connection and try again.
          </Text>
          <Button variant="secondary" onPress={refresh}>
            <Text>Retry</Text>
          </Button>
        </View>
      ) : (
        <>
          {(featured.isLoading || (featured.data?.length ?? 0) > 0) && (
            <View className="gap-3">
              <Text className="px-4 text-lg font-semibold">Featured</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                snapToInterval={cardWidth + 12}
                decelerationRate="fast"
                contentContainerClassName="gap-3 px-4"
              >
                {featured.isLoading
                  ? [0, 1].map((i) => <FeaturedGameSkeleton key={i} width={cardWidth} />)
                  : featured.data!.map((g) => <FeaturedGameCard key={g.id} game={g} width={cardWidth} />)}
              </ScrollView>
            </View>
          )}

          <GameRow
            title="Continue playing"
            games={recent.data}
            loading={recent.isLoading}
            subtitleFor={(g) => timeAgo(lastPlayed.get(g.id))}
          />
          <GameRow title="Favorites" games={favorites.data} loading={favorites.isLoading} />
          <GameRow
            title="New on Rally"
            games={newest.data}
            loading={newest.isLoading}
            empty={<Text variant="muted">No games published yet.</Text>}
          />
        </>
      )}
    </ScrollView>
  );
}
