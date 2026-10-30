import { Link, router } from 'expo-router';
import { HeartIcon, SparklesIcon, WifiOffIcon } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View, type ListRenderItem } from 'react-native';
import { EmptyState } from '@/components/rally/empty-state';
import { FeaturedGameCard, FeaturedGameSkeleton } from '@/components/rally/game-card';
import { GameRow } from '@/components/rally/game-row';
import { Glow } from '@/components/rally/glow';
import { LogoMark } from '@/components/rally/logo';
import { ProfileAvatar, ProfileAvatarSkeleton } from '@/components/rally/profile-avatar';
import { SearchPillButton } from '@/components/rally/search-pill';
import { Button } from '@/components/ui/button';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFavorites, useFeaturedGames, useNewGames, useRecentlyPlayed, type GameCard } from '@/lib/catalog';
import { timeAgo } from '@/lib/format';
import { useFriendRequests } from '@/lib/friends';
import { ROW_GAP, contentWidth, featuredCardWidth, pageIndex, rowTileWidth, snapInterval } from '@/lib/layout';
import { useProfile, type Profile } from '@/lib/profile';
import { countBadge } from '@/lib/social';
import { useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/** Dashboard: greeting, search, featured hero carousel, then continue playing / new / favorites rows. */
export default function Dashboard() {
  // Every size below is recomputed from the live window on each render; rotation re-renders through useLayout.
  const { width, insets, wide, pad } = useLayout();
  const palette = usePalette();

  const profile = useProfile();
  const requests = useFriendRequests();
  const featured = useFeaturedGames();
  const newest = useNewGames();
  const recent = useRecentlyPlayed();
  const favorites = useFavorites();

  const featuredCount = featured.data?.length ?? 0;
  const inner = contentWidth(width, insets);
  const cardWidth = featuredCardWidth(inner, featured.isLoading ? 2 : featuredCount, wide);
  const tileWidth = rowTileWidth(width, pad.left, wide);
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  const lastPlayed = new Map(recent.data?.map((g) => [g.id, g.last_played_at]));
  const refreshing = featured.isRefetching || newest.isRefetching || recent.isRefetching || favorites.isRefetching;
  const failed = featured.isError && newest.isError;
  const name = profile.data ? profile.data.display_name || profile.data.username : null;
  const glow = Math.max(width, 360) * 1.4;

  const refresh = () => {
    void featured.refetch();
    void newest.refetch();
    void recent.refetch();
    void favorites.refetch();
    void requests.refetch();
  };

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
          // The header is hidden and the list starts under the status bar: push the spinner below it. RN 0.88
          // applies this on both platforms (Android SwipeRefreshLayout offset; iOS shifts the UIRefreshControl).
          progressViewOffset={insets.top}
          // iOS: draw the spinner above the content rather than behind it (layer zPosition).
          style={REFRESH_ABOVE_CONTENT}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      <Glow size={glow} style={{ top: -glow * 0.6, left: -glow * 0.32 }} />

      <View className="gap-5" style={padStyle}>
        <Greeting
          name={name}
          loading={profile.isLoading}
          inline={wide}
          avatar={profile.data}
          badge={countBadge(requests.data?.incoming.length)}
        />
        <SearchPillButton onPress={() => router.push('/search')} />
      </View>

      {failed ? (
        <View style={padStyle}>
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
          {featured.isLoading ? (
            <View className="flex-row overflow-hidden" style={[padStyle, { gap: ROW_GAP }]}>
              <FeaturedGameSkeleton width={cardWidth} banner={wide} />
              <FeaturedGameSkeleton width={cardWidth} banner={wide} />
            </View>
          ) : featured.data && featuredCount > 0 ? (
            // Keyed on the geometry: rotating remounts the carousel at page 0 with fresh snap offsets.
            <FeaturedCarousel
              key={`${cardWidth}:${pad.left}:${pad.right}:${wide}`}
              games={featured.data}
              cardWidth={cardWidth}
              banner={wide}
              pad={pad}
            />
          ) : null}

          <GameRow
            title="Continue playing"
            games={recent.data}
            loading={recent.isLoading}
            tileWidth={tileWidth}
            pad={pad}
            subtitleFor={(g) => timeAgo(lastPlayed.get(g.id))}
          />
          <GameRow
            title="New on Rally"
            games={newest.data}
            loading={newest.isLoading}
            tileWidth={tileWidth}
            pad={pad}
            empty={
              <EmptyState icon={SparklesIcon} title="No games yet" body="New games land here as soon as they're published." />
            }
          />
          <GameRow
            title="Favorites"
            games={favorites.data}
            loading={favorites.isLoading}
            tileWidth={tileWidth}
            pad={pad}
            empty={<EmptyState compact icon={HeartIcon} title="No favorites yet" body="Tap the heart on any game to keep it here." />}
          />
        </>
      )}
    </ScrollView>
  );
}

const REFRESH_ABOVE_CONTENT = { zIndex: 10 } as const;

/** "Hey, <name>" as the page heading with the mark, "Let's play" under it (beside it in wide windows), avatar right. */
function Greeting({
  name,
  loading,
  inline,
  avatar,
  badge,
}: {
  name: string | null;
  loading: boolean;
  inline: boolean;
  avatar: Profile | null | undefined;
  /** Pending incoming friend requests. */
  badge: string | null;
}) {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <View className={cn('shrink', inline ? 'flex-row items-baseline gap-3' : 'gap-1')}>
        <View className="shrink flex-row items-center gap-2">
          <LogoMark size={30} style={{ marginLeft: -5 }} />
          {loading ? (
            <SkeletonText lineHeight={36} width={176} barClassName="rounded-lg" />
          ) : (
            <Text className="shrink text-[30px] font-semibold leading-9 tracking-tight" role="heading" numberOfLines={1}>
              {name ? `Hey, ${name}` : 'Welcome back'}
            </Text>
          )}
        </View>
        <Text className="text-muted-foreground text-[15px] font-medium" numberOfLines={1}>
          Let&apos;s play
        </Text>
      </View>
      <Link href="/profile" asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={badge ? `Profile, ${badge} friend requests` : 'Profile'}
          hitSlop={8}
          className="active:opacity-70"
        >
          {loading ? <ProfileAvatarSkeleton size="md" ring /> : <ProfileAvatar profile={avatar} size="md" ring badge={badge} />}
        </Pressable>
      </Link>
    </View>
  );
}

/**
 * Featured games, snapping card by card. Narrow: cards with the next one peeking. Wide: full-width 16:7 banners with
 * page dots. The parent keys it on its geometry, so the page index and snap offsets never outlive a rotation.
 */
function FeaturedCarousel({
  games,
  cardWidth,
  banner,
  pad,
}: {
  games: GameCard[];
  cardWidth: number;
  banner: boolean;
  pad: { left: number; right: number };
}) {
  const [page, setPage] = useState(0);
  const interval = snapInterval(cardWidth);
  const renderItem = useCallback<ListRenderItem<GameCard>>(
    ({ item }) => <FeaturedGameCard game={item} width={cardWidth} banner={banner} />,
    [cardWidth, banner],
  );
  const getItemLayout = useCallback(
    (_: ArrayLike<GameCard> | null | undefined, index: number) => ({ length: cardWidth, offset: pad.left + interval * index, index }),
    [cardWidth, interval, pad.left],
  );
  const dots = banner && games.length > 1;
  return (
    <View className="gap-3">
      <FlatList
        horizontal
        data={games}
        keyExtractor={(g) => g.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingLeft: pad.left, paddingRight: pad.right }}
        ItemSeparatorComponent={RowSeparator}
        snapToInterval={interval}
        snapToAlignment="start"
        decelerationRate="fast"
        initialNumToRender={2}
        onMomentumScrollEnd={dots ? (e) => setPage(pageIndex(e.nativeEvent.contentOffset.x, interval, games.length)) : undefined}
      />
      {dots && (
        <View className="flex-row justify-center gap-1.5" pointerEvents="none" importantForAccessibility="no-hide-descendants">
          {games.map((g, i) => (
            <View key={g.id} className={cn('h-1.5 rounded-full', i === page ? 'bg-foreground w-5' : 'bg-muted-foreground w-1.5')} />
          ))}
        </View>
      )}
    </View>
  );
}

function RowSeparator() {
  return <View style={{ width: ROW_GAP }} />;
}
