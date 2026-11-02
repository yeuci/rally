import { router, useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { HeartIcon, SparklesIcon, WifiOffIcon } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useUniwind } from 'uniwind';
import { ActivityFeed } from '@/components/rally/activity-feed';
import { BrowseAllRow, CategoryRow } from '@/components/rally/category-card';
import { LaunchConsentDialog } from '@/components/rally/consent-dialog';
import { DailyChallenges } from '@/components/rally/daily-challenges';
import { DashboardHero, DashboardHeroSkeleton } from '@/components/rally/dashboard-hero';
import { DashboardTopBar, TOP_BAR_ROW } from '@/components/rally/dashboard-top-bar';
import { EmptyState } from '@/components/rally/empty-state';
import { FriendsPlayingRow } from '@/components/rally/friends-playing-row';
import { Glow } from '@/components/rally/glow';
import { SearchPillButton } from '@/components/rally/search-pill';
import { StreakCard } from '@/components/rally/streak-card';
import { TileRow, TileRowSkeleton } from '@/components/rally/tile-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  useAllGames,
  useFavorites,
  useTrendingGames,
  useLiveCounts,
  useNewGames,
  useRecentlyPlayed,
  type GameCard,
} from '@/lib/catalog';
import { browseParams } from '@/lib/browse';
import {
  GENRE_ROW_GAMES_MAX,
  GENRE_ROWS_MAX,
  categoryCardWidth,
  categoryCoverGames,
  dashboardHeroHeight,
  groupByGenre,
  liveCountLabel,
  type GenreGroup,
} from '@/lib/dashboard';
import { timeAgo } from '@/lib/format';
import { useFriendRequests } from '@/lib/friends';
import { rowTileWidth, titleBarRange } from '@/lib/layout';
import { useProfile } from '@/lib/profile';
import { countBadge } from '@/lib/social';
import { useAppDrawer } from '@/lib/use-app-drawer';
import { useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { useLaunchGame } from '@/lib/use-launch-game';

const GENRE_SKELETON_ROWS = [0, 1];

/**
 * Dashboard: a full-bleed trending hero (the games launched most this week, paged, auto-advancing) under a floating top bar (menu → drawer, greeting,
 * avatar), the search pill, then rows of square tiles (Continue playing, New on Rally, Favorites), "Browse by
 * category" (wide genre cards, then "Browse all games") and one row per genre with "See all": the cards and every
 * "See all" push Browse on that genre (`/browse?genre=`). Multiplayer games with players right now show "12 playing" on
 * their tiles and hero page (`game_live_counts`, every 30 s while the dashboard is in front). Every section has its
 * own skeleton; pull to refresh refetches everything.
 */
export default function Dashboard() {
  // Every size below is recomputed from the live window on each render; rotation re-renders through useLayout.
  const { width, height, insets, wide, pad } = useLayout();
  const palette = usePalette();
  const { theme } = useUniwind();
  const focused = useIsFocused();
  const drawer = useAppDrawer();
  const launcher = useLaunchGame();

  const profile = useProfile();
  const requests = useFriendRequests();
  const trending = useTrendingGames();
  const newest = useNewGames();
  const recent = useRecentlyPlayed();
  const favorites = useFavorites();
  const catalog = useAllGames();
  // "12 playing" on multiplayer tiles and the hero: polled every 30 s only while the dashboard is in front.
  const liveCounts = useLiveCounts(focused);

  // Only the pull gesture shows the spinner: background refetches (focus, reconnect, a finished play invalidating
  // "Continue playing") would otherwise pop it up and shift the content.
  const [refreshing, setRefreshing] = useState(false);

  const failed = trending.isError && newest.isError;
  const heroGames = trending.data ?? [];
  const showHero = !failed && (trending.isLoading || heroGames.length > 0);
  // Art under the top bar and the status bar: only once the hero has games. Over its skeleton (a light grey block on
  // the light theme) the bar is solid with dark type, like a page without a hero.
  const overHeroArt = showHero && heroGames.length > 0;
  const heroHeight = dashboardHeroHeight({ width, height }, wide);
  const barHeight = insets.top + TOP_BAR_ROW;
  const tileWidth = rowTileWidth(width, pad.left, wide);
  const cardWidth = categoryCardWidth(width, pad.left, wide);
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  const lastPlayed = new Map(recent.data?.map((g) => [g.id, g.last_played_at]));
  const genres = groupByGenre(catalog.data ?? []);
  const covers = categoryCoverGames(genres);
  const name = profile.data ? profile.data.display_name || profile.data.username : null;
  const openCategory = (group: GenreGroup<GameCard>) =>
    router.push({ pathname: '/browse', params: browseParams({ genre: group.key }) });
  const glow = Math.max(width, 360) * 1.4;
  const playFeatured = (game: GameCard) => launcher.launch(game, { join: 'quick' });
  const counts = liveCounts.data;
  const liveFor = (game: GameCard) => liveCountLabel(game, counts);

  // The top bar turns solid once the hero has scrolled behind it (UI thread); without hero art it is solid from the start.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const [barStart, barEnd] = titleBarRange(heroHeight, barHeight);
  const barProgress = useDerivedValue(() =>
    overHeroArt ? interpolate(scrollY.value, [barStart, barEnd], [0, 1], Extrapolation.CLAMP) : 1,
  );
  // Light theme: light status-bar text while the art (with its dark top shade) is under it.
  const [overArt, setOverArt] = useState(true);
  useAnimatedReaction(
    () => barProgress.value < 0.5,
    (now, before) => {
      if (now !== before) scheduleOnRN(setOverArt, now);
    },
  );

  async function refresh() {
    setRefreshing(true);
    try {
      // refetch() resolves, never throws.
      await Promise.all([
        trending.refetch(),
        newest.refetch(),
        recent.refetch(),
        favorites.refetch(),
        catalog.refetch(),
        requests.refetch(),
        profile.refetch(),
        liveCounts.refetch(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View className="bg-background flex-1">
      <Animated.ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            // The list starts under the status bar and the floating top bar: push the spinner below both. RN 0.88
            // applies this on both platforms (Android SwipeRefreshLayout offset; iOS shifts the UIRefreshControl).
            progressViewOffset={barHeight}
            // iOS: draw the spinner above the content rather than behind it (layer zPosition).
            style={REFRESH_ABOVE_CONTENT}
            tintColor={palette.foreground}
            colors={[palette.foreground]}
            progressBackgroundColor={palette.card}
          />
        }
      >
        {showHero ? (
          trending.isLoading ? (
            <DashboardHeroSkeleton width={width} height={heroHeight} wide={wide} pad={pad} />
          ) : (
            <DashboardHero
              games={heroGames}
              width={width}
              height={heroHeight}
              wide={wide}
              pad={pad}
              // Quick play for multiplayer games (the play route ignores the target for solo ones), like the game
              // page's Quick play; spelled out rather than relying on the route's default.
              onPlay={playFeatured}
              resolvingId={launcher.resolvingId}
              notice={launcher.notice}
              liveFor={liveFor}
            />
          )
        ) : (
          <View style={{ height: barHeight + 8 }}>
            <Glow size={glow} style={{ top: -glow * 0.6, left: -glow * 0.32 }} />
          </View>
        )}

        <View className="gap-8 pt-4">
          <View style={padStyle}>
            <SearchPillButton onPress={() => router.push('/search')} />
          </View>

          {failed ? (
            <View style={padStyle}>
              <EmptyState
                icon={WifiOffIcon}
                title="Couldn't load games"
                body="Check your connection and try again."
                action={
                  <Button variant="secondary" onPress={() => void refresh()}>
                    <Text>Retry</Text>
                  </Button>
                }
              />
            </View>
          ) : (
            <>
              <FriendsPlayingRow pad={pad} width={width} launcher={launcher} live={focused} />
              <TileRow
                title="Continue playing"
                games={recent.data}
                loading={recent.isLoading}
                tileWidth={tileWidth}
                pad={pad}
                liveFor={liveFor}
                subtitleFor={(g) => timeAgo(lastPlayed.get(g.id))}
              />
              <StreakCard inset />
              <DailyChallenges inset />
              <ActivityFeed pad={pad} width={width} live={focused} refreshing={refreshing} />
              <TileRow
                title="New on Rally"
                games={newest.data}
                loading={newest.isLoading}
                tileWidth={tileWidth}
                pad={pad}
                liveFor={liveFor}
                empty={
                  <EmptyState
                    icon={SparklesIcon}
                    title="No games yet"
                    body="New games land here as soon as they're published."
                  />
                }
              />
              <TileRow
                title="Favorites"
                games={favorites.data}
                loading={favorites.isLoading}
                tileWidth={tileWidth}
                pad={pad}
                liveFor={liveFor}
                empty={
                  <EmptyState
                    compact
                    icon={HeartIcon}
                    title="No favorites yet"
                    body="Tap the heart on any game to keep it here."
                  />
                }
              />
              <View className="gap-4">
                <CategoryRow
                  groups={genres}
                  covers={covers}
                  loading={catalog.isLoading}
                  cardWidth={cardWidth}
                  pad={pad}
                  onOpen={openCategory}
                />
                {catalog.data && catalog.data.length > 0 ? (
                  <View style={padStyle}>
                    <BrowseAllRow count={catalog.data.length} onPress={() => router.push('/browse')} />
                  </View>
                ) : null}
              </View>
              {catalog.isLoading
                ? GENRE_SKELETON_ROWS.map((i) => <TileRowSkeleton key={i} tileWidth={tileWidth} pad={pad} />)
                : genres
                    .slice(0, GENRE_ROWS_MAX)
                    .map((group) => (
                      <TileRow
                        key={group.key}
                        title={group.label}
                        games={group.games.slice(0, GENRE_ROW_GAMES_MAX)}
                        loading={false}
                        tileWidth={tileWidth}
                        pad={pad}
                        liveFor={liveFor}
                        onSeeAll={() => openCategory(group)}
                      />
                    ))}
            </>
          )}
        </View>
      </Animated.ScrollView>

      <DashboardTopBar
        progress={barProgress}
        topInset={insets.top}
        pad={pad}
        name={name}
        loading={profile.isLoading}
        profile={profile.data}
        badge={countBadge(requests.data?.incoming.length)}
        onMenu={drawer.openDrawer}
      />

      <LaunchConsentDialog launcher={launcher} />
      {focused && overHeroArt && overArt && theme === 'light' ? <StatusBar style="light" /> : null}
    </View>
  );
}

const REFRESH_ABOVE_CONTENT = { zIndex: 10 } as const;
