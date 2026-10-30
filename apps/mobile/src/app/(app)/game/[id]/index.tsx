import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  HeartIcon,
  PlayIcon,
  RectangleHorizontalIcon,
  RectangleVerticalIcon,
  RotateCwIcon,
  SearchXIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { AchievementsSection, AchievementsSectionSkeleton } from '@/components/rally/achievements';
import { ConsentDialog } from '@/components/rally/consent-dialog';
import { EmptyState } from '@/components/rally/empty-state';
import { CoverScrim, GameCover } from '@/components/rally/game-cover';
import { Image } from '@/components/rally/image';
import { LeaderboardSection, LeaderboardSectionSkeleton } from '@/components/rally/leaderboard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { playersLabel, useFavorites, useGame, useToggleFavorite, type Game } from '@/lib/catalog';
import { coverUriFor, heroScreenshots } from '@/lib/game-art';
import { progressKeys, useGameAchievements, useGameBoards, useMyRank } from '@/lib/game-progress';
import { fetchConsent, fetchLaunchPlan, launchKeys, useGrantConsent, useLaunchPlan } from '@/lib/launch';
import { GUTTER, gameCoverColumnWidth, gameHeroHeight, pageIndex, titleBarRange } from '@/lib/layout';
import { useProfile } from '@/lib/profile';
import { formatScore, orderBoards } from '@/lib/progress-format';
import { useBoxSize, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

const MODE_LABEL: Record<string, string> = {
  solo: 'Solo',
  quick: 'Quick play',
  browser: 'Server browser',
  private: 'Private rooms',
  party: 'Party',
};

const ORIENTATION: Record<Game['orientation'], { label: string; icon: LucideIcon }> = {
  portrait: { label: 'Portrait', icon: RectangleVerticalIcon },
  landscape: { label: 'Landscape', icon: RectangleHorizontalIcon },
  any: { label: 'Any orientation', icon: RotateCwIcon },
};

/** "2–8", "4" or "Solo" for the players chip (the full label is the accessibility label). */
function playersShort(g: Pick<Game, 'min_players' | 'max_players'>): string {
  if (g.max_players <= 1) return 'Solo';
  if (g.min_players === g.max_players) return String(g.min_players);
  return `${g.min_players}–${g.max_players}`;
}

/** Game page (deep link `/game/:id`): cover hero, details, favorite, and Play → consent → full-screen host. */
export default function GamePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Live window + insets on every render: rotation re-renders and every size below is recomputed.
  const { width, height, insets, landscape, pad } = useLayout();
  const palette = usePalette();
  const qc = useQueryClient();
  const { userId } = useSession();

  const game = useGame(id);
  const plan = useLaunchPlan(id); // prefetch so Play is instant
  const profile = useProfile();
  const favorites = useFavorites();
  const toggleFavorite = useToggleFavorite();
  const grantConsent = useGrantConsent();
  const boardsQuery = useGameBoards(id);
  const achievements = useGameAchievements(id);

  const [resolving, setResolving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Portrait: the scroll offset drives the title bar that slides in once the hero has scrolled away (UI thread).
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  // The scroll view remounts at offset 0 when the layout flips between portrait and landscape; the shared value
  // would otherwise keep the old offset and show the title bar over the hero until the first scroll event.
  useEffect(() => {
    scrollY.set(0);
  }, [landscape, scrollY]);

  const g = game.data;
  const manifest = plan.data?.status === 'ready' ? plan.data.manifest : null;
  // Manifest order first: its first board is the primary one ("Best" in Details).
  const boards = orderBoards(boardsQuery.data ?? [], manifest?.leaderboards.map((b) => b.id));
  const best = useMyRank(id, boards[0]?.key);
  const isFavorite = !!g && !!favorites.data?.some((f) => f.id === g.id);
  const heroHeight = gameHeroHeight({ width, height }, insets.top);
  const coverWidth = gameCoverColumnWidth(width, insets);
  // Landscape keeps clear of the home indicator / camera housing even where the inset is 0.
  const edgeTop = Math.max(insets.top, 12);
  const edgeBottom = Math.max(insets.bottom, 12);
  // The bar covers the status bar plus a 60 pt row centred on the floating buttons (top + 8, 44 pt).
  const barHeight = insets.top + 60;
  const [barStart, barEnd] = titleBarRange(heroHeight, barHeight);
  const barProgress = useDerivedValue(() =>
    interpolate(scrollY.value, [barStart, barEnd], [0, 1], Extrapolation.CLAMP),
  );

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const openHost = () => router.push({ pathname: '/game/[id]/play', params: { id } });

  async function refresh() {
    setRefreshing(true);
    try {
      // The game, its version plan (Play / version row), the favorite state, leaderboards and achievements;
      // refetch() / invalidateQueries() resolve, never throw.
      await Promise.all([
        game.refetch(),
        plan.refetch(),
        favorites.refetch(),
        qc.invalidateQueries({ queryKey: progressKeys.game(userId, id) }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  async function play() {
    if (!id || !userId || resolving) return;
    setNotice(null);
    setResolving(true);
    try {
      const resolved = await qc.fetchQuery({ queryKey: launchKeys.plan(id), queryFn: () => fetchLaunchPlan(id), staleTime: 10_000 });
      if (resolved.status === 'unavailable') return setNotice(resolved.message);
      if (resolved.status === 'update-required') {
        return setNotice(`Update Rally to version ${resolved.minAppVersion} or later to play this game.`);
      }
      const consented = await qc.fetchQuery({ queryKey: launchKeys.consent(userId, id), queryFn: () => fetchConsent(userId, id) });
      if (consented) openHost();
      else setConsentOpen(true);
    } catch {
      setNotice("Couldn't start the game. Check your connection and try again.");
    } finally {
      setResolving(false);
    }
  }

  async function allow() {
    try {
      await grantConsent.mutateAsync(id);
      setConsentOpen(false);
      openHost();
    } catch {
      setConsentOpen(false);
      setNotice("Couldn't save your choice. Try again.");
    }
  }

  if (game.isLoading) {
    return landscape ? (
      <GamePageSkeletonLandscape coverWidth={coverWidth} insets={insets} edgeTop={edgeTop} edgeBottom={edgeBottom} />
    ) : (
      <GamePageSkeleton heroHeight={heroHeight} bottomInset={insets.bottom} pad={pad} topInset={insets.top} />
    );
  }

  if (!g) {
    return (
      <View className="bg-background flex-1 justify-center p-6" style={{ paddingLeft: pad.left + 8, paddingRight: pad.right + 8 }}>
        <EmptyState
          icon={SearchXIcon}
          title="Game not found"
          body={game.isError ? "Couldn't load this game." : 'It may have been removed.'}
          className="w-full max-w-md self-center"
          action={
            <Button variant="secondary" onPress={back}>
              <Text>Back</Text>
            </Button>
          }
        />
      </View>
    );
  }

  const version = plan.data?.status === 'ready' ? plan.data.version : null;
  // Solo games only: multiplayer results come from the room, so a personal best is not the headline there.
  const solo = plan.data?.status === 'ready' ? !plan.data.room : g.max_players <= 1;
  const bestLabel = solo && best.data ? formatScore(best.data.score) : null;
  const progress = (
    <>
      <LeaderboardSection gameId={g.id} boards={boards} loading={boardsQuery.isLoading} error={boardsQuery.isError} />
      <AchievementsSection tiles={achievements.data} loading={achievements.isLoading} error={achievements.isError} />
    </>
  );
  const playDisabled = resolving || plan.data?.status === 'unavailable';
  const orientation = ORIENTATION[g.orientation];

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      // Below the status bar (Android offset; iOS shifts the UIRefreshControl in RN 0.88) and drawn above the hero.
      progressViewOffset={insets.top}
      style={REFRESH_ABOVE_CONTENT}
      tintColor={palette.foreground}
      colors={[palette.foreground]}
      progressBackgroundColor={palette.card}
    />
  );
  // In landscape the buttons sit over the cover column and never turn into bar buttons.
  const controls = (overBar: SharedValue<number> | null) => (
    <>
      <RoundButton label="Back" onPress={back} icon={ChevronLeftIcon} iconClassName="size-6" progress={overBar} />
      <RoundButton
        label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        selected={isFavorite}
        onPress={() => toggleFavorite.mutate({ game: g, favorite: !isFavorite })}
        icon={HeartIcon}
        iconClassName="size-5"
        progress={overBar}
      />
    </>
  );
  const gallery = heroScreenshots(g).length > 1;
  const playButton = (
    <PlayButton
      resolving={resolving}
      disabled={playDisabled}
      notice={notice}
      spinnerColor={palette.primaryForeground}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        void play();
      }}
    />
  );
  const consent = (
    <ConsentDialog
      open={consentOpen}
      gameTitle={g.title}
      profile={profile.data}
      busy={grantConsent.isPending}
      onAllow={() => void allow()}
      onDecline={() => setConsentOpen(false)}
    />
  );

  if (landscape) {
    // Two columns: the cover fills the left ≈45 % (inside the safe area, rounded, controls over its corners); the
    // right column scrolls with the title, chips and Play near the top, then the description and details.
    return (
      <View className="bg-background flex-1 flex-row" style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
        <View style={{ width: coverWidth, paddingTop: edgeTop, paddingBottom: edgeBottom, paddingLeft: GUTTER }}>
          <View className="border-border flex-1 overflow-hidden rounded-3xl border">
            <HeroMedia game={g} scrim="none" dotsClassName="bottom-4" />
            <View className="absolute left-3 right-3 top-3 flex-row justify-between">{controls(null)}</View>
          </View>
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6"
          contentContainerStyle={{ paddingTop: edgeTop + 4, paddingBottom: edgeBottom + 24, paddingLeft: 24, paddingRight: GUTTER }}
          refreshControl={refreshControl}
        >
          <TitleBlock game={g} orientation={orientation} />
          {playButton}
          <About game={g} orientation={orientation} version={version} best={bestLabel} />
          {progress}
        </ScrollView>
        {consent}
      </View>
    );
  }

  return (
    <View className="bg-background flex-1">
      <Animated.ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
        refreshControl={refreshControl}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={{ height: heroHeight }}>
          {/* Gallery dots sit on the hero's bottom edge; the title then starts below the hero instead of over it. */}
          <HeroMedia game={g} scrim="fade" scrimColor={palette.background} dotsClassName="bottom-2" />
        </View>
        <View className={cn('gap-6', gallery ? 'mt-3' : '-mt-10')} style={{ paddingLeft: pad.left, paddingRight: pad.right }}>
          <TitleBlock game={g} orientation={orientation} />
          <About game={g} orientation={orientation} version={version} best={bestLabel} />
          {progress}
        </View>
      </Animated.ScrollView>

      <TitleBar title={g.title} height={barHeight} topInset={insets.top} sideInset={Math.max(pad.left, pad.right) + 56} progress={barProgress} />

      {/* Floating controls over the hero (then over the title bar), inside the safe area on both sides */}
      <View
        className="absolute left-0 right-0 flex-row justify-between"
        style={{ top: insets.top + 8, paddingLeft: pad.left, paddingRight: pad.right }}
        pointerEvents="box-none"
      >
        {controls(barProgress)}
      </View>

      {/* Sticky Play above the home indicator: fades the page out above it instead of a hard border */}
      <View className="absolute bottom-0 left-0 right-0" pointerEvents="box-none">
        <View className="h-6" pointerEvents="none">
          <CoverScrim kind="fade" color={palette.background} />
        </View>
        <View className="bg-background pt-1" style={{ paddingBottom: insets.bottom + 12, paddingLeft: pad.left, paddingRight: pad.right }}>
          {playButton}
        </View>
      </View>

      {consent}
    </View>
  );
}

const REFRESH_ABOVE_CONTENT = { zIndex: 10 } as const;

/**
 * The hero's media, filling its parent: screenshots in a paged gallery (with dots), else the cover art (game.json
 * `cover`), else the generated cover (lib/game-art.ts). The cover is not added to the gallery: it is for the
 * dashboard, the screenshots are what the game page shows. Measures
 * its own box and keys the gallery on it, so after a rotation the pages are re-laid out at the new size and the
 * gallery restarts at page 1 instead of resting on a stale offset.
 */
function HeroMedia({
  game: g,
  scrim,
  scrimColor,
  dotsClassName,
}: {
  game: Game;
  scrim: 'none' | 'fade';
  scrimColor?: string;
  dotsClassName: string;
}) {
  const box = useBoxSize();
  const shots = heroScreenshots(g);
  return (
    <View className="flex-1" onLayout={box.onLayout}>
      {shots.length === 0 ? (
        <GameCover
          id={g.id}
          title={g.title}
          uri={coverUriFor(g, 'hero')}
          variant="hero"
          scrim={scrim}
          scrimColor={scrimColor}
          className="flex-1"
        />
      ) : box.size ? (
        <Gallery key={box.key} shots={shots} width={box.size.width} height={box.size.height} dotsClassName={dotsClassName} />
      ) : (
        <Skeleton className="flex-1 rounded-none" />
      )}
      {shots.length > 0 && scrim === 'fade' && <CoverScrim kind="fade" photo color={scrimColor} />}
    </View>
  );
}

function Gallery({ shots, width, height, dotsClassName }: { shots: string[]; width: number; height: number; dotsClassName: string }) {
  const [page, setPage] = useState(0);
  return (
    <>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(pageIndex(e.nativeEvent.contentOffset.x, width, shots.length))}
      >
        {shots.map((uri) => (
          <Image key={uri} source={{ uri }} style={{ width, height }} contentFit="cover" transition={200} />
        ))}
      </ScrollView>
      {shots.length > 1 && (
        <View className={cn('absolute w-full flex-row justify-center gap-1.5', dotsClassName)} pointerEvents="none">
          {shots.map((uri, i) => (
            <View key={uri} className={cn('h-1.5 rounded-full', i === page ? 'bg-foreground w-5' : 'bg-muted-foreground w-1.5')} />
          ))}
        </View>
      )}
    </>
  );
}

function TitleBlock({ game: g, orientation }: { game: Game; orientation: { label: string; icon: LucideIcon } }) {
  return (
    <View className="gap-3">
      <Text className="text-[34px] font-extrabold leading-[40px] tracking-tight" role="heading">
        {g.title}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {g.genres.map((genre) => (
          <Badge key={genre} variant="subtle">
            <Text className="capitalize">{genre}</Text>
          </Badge>
        ))}
        <Badge variant="secondary" accessibilityLabel={playersLabel(g)}>
          <Icon as={UsersIcon} className="text-secondary-foreground size-3" />
          <Text>{playersShort(g)}</Text>
        </Badge>
        <Badge variant="outline">
          <Text>{g.age_rating}</Text>
        </Badge>
        <Badge variant="secondary">
          <Icon as={orientation.icon} className="text-secondary-foreground size-3" />
          <Text>{orientation.label}</Text>
        </Badge>
      </View>
    </View>
  );
}

function About({
  game: g,
  orientation,
  version,
  best,
}: {
  game: Game;
  orientation: { label: string };
  version: string | null;
  /** Formatted personal best on the primary board (solo games with a score). */
  best: string | null;
}) {
  return (
    <>
      {g.description ? <Text className="text-secondary-foreground text-base leading-[25px]">{g.description}</Text> : null}
      <View className="gap-3">
        <Text className="text-[17px] font-bold leading-[22px] tracking-tight" role="heading">
          Details
        </Text>
        <View className="bg-card border-border gap-3 rounded-2xl border p-4">
          <InfoRow label="Players" value={playersLabel(g)} />
          <Separator />
          <InfoRow label="Modes" value={g.modes.map((m) => MODE_LABEL[m] ?? m).join(', ')} />
          <Separator />
          <InfoRow label="Age rating" value={g.age_rating} />
          <Separator />
          <InfoRow label="Orientation" value={orientation.label} />
          {best && (
            <>
              <Separator />
              <InfoRow label="Best" value={best} />
            </>
          )}
          {version && (
            <>
              <Separator />
              <InfoRow label="Version" value={version} />
            </>
          )}
        </View>
      </View>
    </>
  );
}

function PlayButton({
  resolving,
  disabled,
  notice,
  spinnerColor,
  onPress,
}: {
  resolving: boolean;
  disabled: boolean;
  notice: string | null;
  spinnerColor: string;
  onPress: () => void;
}) {
  return (
    <View className="gap-2">
      {notice && (
        <View className="flex-row items-center justify-center gap-1.5 px-2" accessibilityLiveRegion="polite">
          <Icon as={CircleAlertIcon} className="text-muted-foreground size-4" />
          <Text variant="muted" className="shrink text-center">
            {notice}
          </Text>
        </View>
      )}
      <Button size="lg" className="h-14 rounded-2xl" disabled={disabled} onPress={onPress}>
        {resolving ? (
          <ActivityIndicator color={spinnerColor} />
        ) : (
          <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-5" />
        )}
        <Text className="text-[17px] font-bold">Play</Text>
      </Button>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-4">
      <Text variant="muted" className="leading-5">
        {label}
      </Text>
      <Text className="shrink text-right text-sm font-semibold leading-5">{value}</Text>
    </View>
  );
}

/**
 * Solid bar (page background, hairline) with the game's title that slides down and fades in once the hero has
 * scrolled away, App-Store style; the floating buttons stay on top of it. Driven on the UI thread by `progress`
 * (0 hidden … 1 shown, from the scroll offset). Touch-transparent: the buttons over it are separate.
 */
function TitleBar({
  title,
  height,
  topInset,
  sideInset,
  progress,
}: {
  title: string;
  height: number;
  topInset: number;
  sideInset: number;
  progress: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (progress.value - 1) * height * 0.6 }],
  }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.6, 1], [0, 1], Extrapolation.CLAMP),
  }));
  return (
    <Animated.View
      className="bg-background border-border absolute left-0 right-0 top-0 border-b"
      style={[{ height, paddingTop: topInset, paddingLeft: sideInset, paddingRight: sideInset }, style]}
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <View className="flex-1 items-center justify-center">
        <Animated.View style={titleStyle}>
          <Text className="text-[17px] font-bold leading-[22px]" numberOfLines={1}>
            {title}
          </Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/**
 * Round button over the hero: glass (dark translucent, white icon) over the art; with `progress` it cross-fades to a
 * plain foreground icon as the title bar slides in under it. `selected` fills it with the primary colour (favorited)
 * in both states.
 */
function RoundButton({
  label,
  onPress,
  selected,
  icon,
  iconClassName,
  progress,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  icon: LucideIcon;
  iconClassName: string;
  progress: SharedValue<number> | null;
}) {
  const glass = useAnimatedStyle(() => ({ opacity: progress ? 1 - progress.value : 1 }));
  const plain = useAnimatedStyle(() => ({ opacity: progress ? progress.value : 0 }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={8}
      className={cn('size-11 items-center justify-center rounded-full active:opacity-70', selected && 'bg-primary')}
    >
      {selected ? (
        <Icon as={icon} className={cn('text-primary-foreground fill-primary-foreground', iconClassName)} />
      ) : (
        <>
          <Animated.View style={[StyleSheet.absoluteFill, glass]} className="rounded-full border border-white/15 bg-black/35" />
          <Animated.View style={glass}>
            <Icon as={icon} className={cn('text-white', iconClassName)} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, plain]} className="items-center justify-center">
            <Icon as={icon} className={cn('text-foreground', iconClassName)} />
          </Animated.View>
        </>
      )}
    </Pressable>
  );
}

/** Portrait page while the game loads: hero, title, chips, description, Details, leaderboard, achievements, Play. */
function GamePageSkeleton({
  heroHeight,
  bottomInset,
  topInset,
  pad,
}: {
  heroHeight: number;
  bottomInset: number;
  topInset: number;
  pad: { left: number; right: number };
}) {
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  return (
    <View className="bg-background flex-1">
      <ScrollView scrollEnabled={false} contentContainerStyle={{ paddingBottom: bottomInset + 120 }}>
        <Skeleton className="w-full rounded-none" style={{ height: heroHeight }} />
        <View className="-mt-10 gap-6" style={padStyle}>
          <TitleBlockSkeleton />
          <AboutSkeleton />
          <LeaderboardSectionSkeleton />
          <AchievementsSectionSkeleton />
        </View>
      </ScrollView>
      <View
        className="absolute left-0 right-0 flex-row justify-between"
        style={{ top: topInset + 8, paddingLeft: pad.left, paddingRight: pad.right }}
        pointerEvents="none"
      >
        <View className="size-11 rounded-full border border-white/15 bg-black/35" />
        <View className="size-11 rounded-full border border-white/15 bg-black/35" />
      </View>
      <View className="bg-background absolute bottom-0 left-0 right-0 pt-1" style={[padStyle, { paddingBottom: bottomInset + 12 }]}>
        <Skeleton className="h-14 w-full rounded-2xl" />
      </View>
    </View>
  );
}

function GamePageSkeletonLandscape({
  coverWidth,
  insets,
  edgeTop,
  edgeBottom,
}: {
  coverWidth: number;
  insets: { left: number; right: number };
  edgeTop: number;
  edgeBottom: number;
}) {
  return (
    <View className="bg-background flex-1 flex-row" style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
      <View style={{ width: coverWidth, paddingTop: edgeTop, paddingBottom: edgeBottom, paddingLeft: GUTTER }}>
        <Skeleton className="flex-1 rounded-3xl" />
      </View>
      <ScrollView
        scrollEnabled={false}
        className="flex-1"
        contentContainerClassName="gap-6"
        contentContainerStyle={{ paddingTop: edgeTop + 4, paddingBottom: edgeBottom + 24, paddingLeft: 24, paddingRight: GUTTER }}
      >
        <TitleBlockSkeleton />
        <Skeleton className="h-14 w-full rounded-2xl" />
        <AboutSkeleton />
      </ScrollView>
    </View>
  );
}

/** TitleBlock's footprint: one 40 pt title line and a row of 26 pt chips. */
function TitleBlockSkeleton() {
  return (
    <View className="gap-3">
      <SkeletonText lineHeight={40} width={224} barClassName="rounded-lg" />
      <View className="flex-row gap-2">
        {[64, 52, 40, 96].map((w, i) => (
          <Skeleton key={i} className="h-[26px] rounded-full" style={{ width: w }} />
        ))}
      </View>
    </View>
  );
}

/** About's footprint: three 25 pt description lines, then Details with the same rows and separators as InfoRow. */
function AboutSkeleton() {
  return (
    <>
      <View>
        <SkeletonText lineHeight={25} width="100%" />
        <SkeletonText lineHeight={25} width="92%" />
        <SkeletonText lineHeight={25} width="64%" />
      </View>
      <View className="gap-3">
        <SkeletonText lineHeight={22} width={72} />
        <View className="bg-card border-border gap-3 rounded-2xl border p-4">
          {[0, 1, 2, 3].map((i) => (
            <View key={i} className="gap-3">
              {i > 0 && <Separator />}
              <View className="flex-row justify-between gap-4">
                <SkeletonText lineHeight={20} width={72} />
                <SkeletonText lineHeight={20} width={i === 1 ? 140 : 88} />
              </View>
            </View>
          ))}
        </View>
      </View>
    </>
  );
}
