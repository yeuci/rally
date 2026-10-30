import { useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  HeartIcon,
  LayoutListIcon,
  LockIcon,
  PlayIcon,
  RectangleHorizontalIcon,
  RectangleVerticalIcon,
  RotateCwIcon,
  SearchXIcon,
  Share2Icon,
  ShareIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ScrollViewInstance,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { useUniwind } from 'uniwind';
import { AchievementsSection, AchievementsSectionSkeleton } from '@/components/rally/achievements';
import { LaunchConsentDialog } from '@/components/rally/consent-dialog';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { CoverScrim, GameCover } from '@/components/rally/game-cover';
import { Image } from '@/components/rally/image';
import { JoinCodeSheet } from '@/components/rally/join-code-sheet';
import { LeaderboardSection, LeaderboardSectionSkeleton } from '@/components/rally/leaderboard';
import { PageDots } from '@/components/rally/page-dots';
import { SectionHeader } from '@/components/rally/section-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import { playersLabel, useFavorites, useGame, useToggleFavorite, type Game } from '@/lib/catalog';
import { coverUriFor, heroScreenshots } from '@/lib/game-art';
import { progressKeys, useGameAchievements, useGameBoards, useMyRank } from '@/lib/game-progress';
import type { JoinKind } from '@/lib/join-target';
import { toggleHaptic } from '@/lib/haptics';
import { useLaunchPlan } from '@/lib/launch';
import { GUTTER, gameCoverColumnWidth, gameHeroHeight, pageIndex, titleBarRange } from '@/lib/layout';
import { formatScore, orderBoards } from '@/lib/progress-format';
import { gameShareContent } from '@/lib/share';
import { noticeFor, useLaunchGame } from '@/lib/use-launch-game';
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

/** Glass round buttons over the hero: 44 pt each, 8 pt apart (Share and the heart share the right corner). */
const ROUND = 44;
const ROUND_GAP = 8;

/**
 * Game page (deep link `/game/:id`): cover hero, details, Share (title + the web catalog link when the build knows
 * it), favorite (spring + haptic), and Play → consent → full-screen host (`useLaunchGame`). "Best" scrolls to the
 * leaderboard and flashes your row. Multiplayer games (`manifest.server`, m3-phase2 §1) get Quick play
 * (`join=quick`), Rooms (`browser` mode: the server browser) and Private (`private` mode: Create room →
 * `join=create`, the game shows the code; Join with code → the code sheet → `join=room&room=<id>&code=<code>`)
 * instead of Play.
 */
export default function GamePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Live window + insets on every render: rotation re-renders and every size below is recomputed.
  const { width, height, insets, landscape, pad } = useLayout();
  const palette = usePalette();
  const { theme } = useUniwind();
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const qc = useQueryClient();
  const { userId } = useSession();

  const game = useGame(id);
  const plan = useLaunchPlan(id); // prefetch so Play is instant
  const favorites = useFavorites();
  const toggleFavorite = useToggleFavorite();
  const launcher = useLaunchGame();
  const boardsQuery = useGameBoards(id);
  const achievements = useGameAchievements(id);

  const [codeOpen, setCodeOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped to spring the heart / flash your leaderboard row.
  const [favoritePop, setFavoritePop] = useState(0);
  const [highlightMe, setHighlightMe] = useState(0);
  // "Best" → the leaderboard: where the board sits in the scroll content (portrait: the content column's top plus the
  // board's top inside it; landscape: the board's top in the right column). Written by onLayout, read on press.
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const landscapeScrollRef = useRef<ScrollViewInstance>(null);
  const boardOffset = useRef({ column: 0, board: 0 });

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
  // Light theme, portrait: light status-bar text while the art (with its dark top shade) is under it, dark once the
  // solid title bar has slid in (the dashboard does the same).
  const [overArt, setOverArt] = useState(true);
  useAnimatedReaction(
    () => barProgress.value < 0.5,
    (now, before) => {
      if (now !== before) scheduleOnRN(setOverArt, now);
    },
  );

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

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
          icon={game.isError ? CircleAlertIcon : SearchXIcon}
          title={game.isError ? "Couldn't load this game" : 'Game not found'}
          body={game.isError ? 'Check your connection and try again.' : 'It may have been removed.'}
          className="w-full max-w-md self-center"
          action={
            <View className="flex-row gap-2">
              {game.isError ? <RetryButton onPress={() => void game.refetch()} /> : null}
              <Button variant="secondary" size="sm" className="rounded-full px-4" onPress={back}>
                <Text>Back</Text>
              </Button>
            </View>
          }
        />
      </View>
    );
  }

  const version = plan.data?.status === 'ready' ? plan.data.version : null;
  // Solo games only: multiplayer results come from the room, so a personal best is not the headline there.
  const solo = plan.data?.status === 'ready' ? !plan.data.room : g.max_players <= 1;
  const bestLabel = solo && best.data ? formatScore(best.data.score) : null;
  const showBoard = boardsQuery.isLoading || boardsQuery.isError || boards.length > 0;
  const onBoardLayout = (e: LayoutChangeEvent) => {
    boardOffset.current.board = e.nativeEvent.layout.y;
  };
  /** "Best" → scroll the leaderboard's header just under the title bar (portrait) / the top edge, and flash your row. */
  const showLeaderboard = () => {
    const animated = !reducedMotion;
    if (landscape) {
      landscapeScrollRef.current?.scrollTo({ y: Math.max(0, boardOffset.current.board - 12), animated });
    } else {
      const y = Math.max(0, boardOffset.current.column + boardOffset.current.board - barHeight - 12);
      scheduleOnUI(() => {
        'worklet';
        scrollTo(scrollRef, 0, y, animated);
      });
    }
    setHighlightMe((n) => n + 1);
  };
  const progress = (
    <>
      {showBoard ? (
        <View onLayout={onBoardLayout}>
          <LeaderboardSection
            gameId={g.id}
            boards={boards}
            loading={boardsQuery.isLoading}
            error={boardsQuery.isError}
            highlightMe={highlightMe}
            onRetry={() => void boardsQuery.refetch()}
          />
        </View>
      ) : null}
      <AchievementsSection
        tiles={achievements.data}
        loading={achievements.isLoading}
        error={achievements.isError}
        onRetry={() => void achievements.refetch()}
      />
    </>
  );
  const server = manifest?.server ?? null;
  const modes: readonly string[] = manifest?.modes ?? g.modes;
  const playDisabled = !!launcher.pending || plan.data?.status === 'unavailable';
  const openPrivate = () => {
    const create = () => launcher.launch(g, { join: 'create' });
    const join = () => setCodeOpen(true);
    const message = 'Create a room and share its code, or enter the code a friend gave you.';
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Private room', message, options: ['Create room', 'Join with code', 'Cancel'], cancelButtonIndex: 2 },
        (i) => (i === 0 ? create() : i === 1 ? join() : undefined),
      );
    } else {
      Alert.alert('Private room', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Join with code', onPress: join },
        { text: 'Create room', onPress: create },
      ]);
    }
  };
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
  const share = () => {
    // The native sheet; dismissing it (or a platform without one) is not an error worth showing.
    const content = gameShareContent(g, config.webOrigin, Platform.OS);
    Share.share(content, { dialogTitle: `Share ${g.title}`, subject: g.title }).catch(() => {});
  };
  const favorite = () => {
    toggleHaptic();
    setFavoritePop((n) => n + 1);
    toggleFavorite.mutate({ game: g, favorite: !isFavorite });
  };
  // In landscape the buttons sit over the cover column and never turn into bar buttons.
  const controls = (overBar: SharedValue<number> | null) => (
    <>
      <RoundButton label="Back" onPress={back} icon={ChevronLeftIcon} iconClassName="size-6" progress={overBar} />
      <View className="flex-row" style={{ gap: ROUND_GAP }} pointerEvents="box-none">
        <RoundButton
          label={`Share ${g.title}`}
          onPress={share}
          icon={Platform.OS === 'ios' ? ShareIcon : Share2Icon}
          iconClassName="size-5"
          progress={overBar}
        />
        <RoundButton
          label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          selected={isFavorite}
          onPress={favorite}
          haptic={false}
          pop={favoritePop}
          icon={HeartIcon}
          iconClassName="size-5"
          progress={overBar}
        />
      </View>
    </>
  );
  const gallery = heroScreenshots(g).length > 1;
  const secondary = !solo && (modes.includes('browser') || modes.includes('private'));
  const playButton = (
    <PlayActions
      multiplayer={!solo}
      rooms={!solo && modes.includes('browser')}
      privateRooms={!solo && modes.includes('private')}
      pending={launcher.pending?.gameId === g.id ? launcher.pending.join : null}
      disabled={playDisabled}
      // The code sheet and Create room need the room type from the resolved manifest.
      serverReady={!!server}
      notice={noticeFor(launcher, g.id)}
      spinnerColor={palette.primaryForeground}
      secondarySpinnerColor={palette.foreground}
      onPlay={() => launcher.launch(g, solo ? undefined : { join: 'quick' })}
      onRooms={() => router.push({ pathname: '/game/[id]/rooms', params: { id: g.id } })}
      onPrivate={openPrivate}
    />
  );
  const consent = (
    <>
      <LaunchConsentDialog launcher={launcher} />
      {server ? (
        <JoinCodeSheet
          open={codeOpen}
          onClose={() => setCodeOpen(false)}
          gameTitle={g.title}
          roomName={server.room}
          onJoin={(target) => {
            setCodeOpen(false);
            launcher.launch(g, target);
          }}
        />
      ) : null}
    </>
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
          ref={landscapeScrollRef}
          className="flex-1"
          contentContainerClassName="gap-6"
          contentContainerStyle={{ paddingTop: edgeTop + 4, paddingBottom: edgeBottom + 24, paddingLeft: 24, paddingRight: GUTTER }}
          refreshControl={refreshControl}
        >
          <TitleBlock game={g} orientation={orientation} />
          {playButton}
          <About game={g} orientation={orientation} version={version} best={bestLabel} onBestPress={showLeaderboard} />
          {progress}
        </ScrollView>
        {consent}
      </View>
    );
  }

  return (
    <View className="bg-background flex-1">
      <Animated.ScrollView
        ref={scrollRef}
        // Clear of the sticky actions: Play (or Quick play), plus the Rooms / Private row for multiplayer games.
        contentContainerStyle={{ paddingBottom: insets.bottom + (secondary ? 176 : 120) }}
        refreshControl={refreshControl}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={{ height: heroHeight }}>
          {/* Gallery dots sit on the hero's bottom edge; the title then starts below the hero instead of over it. */}
          <HeroMedia game={g} scrim="fade" scrimColor={palette.background} dotsClassName="bottom-2" />
        </View>
        <View
          className={cn('gap-6', gallery ? 'mt-3' : '-mt-10')}
          style={{ paddingLeft: pad.left, paddingRight: pad.right }}
          onLayout={(e) => {
            boardOffset.current.column = e.nativeEvent.layout.y;
          }}
        >
          <TitleBlock game={g} orientation={orientation} />
          <About game={g} orientation={orientation} version={version} best={bestLabel} onBestPress={showLeaderboard} />
          {progress}
        </View>
      </Animated.ScrollView>

      <TitleBar
        title={g.title}
        height={barHeight}
        topInset={insets.top}
        // Clear of the buttons on both sides (two on the right), so the centred title never runs under them.
        sideInset={Math.max(pad.left, pad.right) + ROUND * 2 + ROUND_GAP + 8}
        progress={barProgress}
      />

      {/* Floating controls over the hero (then over the title bar), inside the safe area on both sides */}
      <View
        className="absolute left-0 right-0 flex-row justify-between"
        style={{ top: insets.top + 8, paddingLeft: pad.left, paddingRight: pad.right }}
        pointerEvents="box-none"
      >
        {controls(barProgress)}
      </View>

      {/* Sticky Play (or the multiplayer actions) above the home indicator: the page fades out under it instead of a
          hard border. `page`: the page colour from alpha 0 to 1 and nothing else (lib/gradient.ts); no hairline. */}
      <View className="absolute bottom-0 left-0 right-0" pointerEvents="box-none">
        <View className="h-8" pointerEvents="none">
          <CoverScrim kind="page" color={palette.background} />
        </View>
        <View className="bg-background pt-1" style={{ paddingBottom: insets.bottom + 12, paddingLeft: pad.left, paddingRight: pad.right }}>
          {playButton}
        </View>
      </View>

      {consent}
      {focused && overArt && theme === 'light' ? <StatusBar style="light" /> : null}
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
        <View className={cn('absolute w-full flex-row justify-center', dotsClassName)} pointerEvents="none">
          <PageDots
            count={shots.length}
            index={page}
            accessible
            accessibilityLabel={`Screenshot ${page + 1} of ${shots.length}`}
          />
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
  onBestPress,
}: {
  game: Game;
  orientation: { label: string };
  version: string | null;
  /** Formatted personal best on the primary board (solo games with a score). */
  best: string | null;
  /** "Best" opens the leaderboard (scrolls to it). */
  onBestPress: () => void;
}) {
  return (
    <>
      {g.description ? <Text className="text-secondary-foreground text-base leading-[25px]">{g.description}</Text> : null}
      <View className="gap-3">
        <SectionHeader title="Details" className="px-0" />
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
              <InfoRow label="Best" value={best} onPress={onBestPress} hint="Shows the leaderboard" />
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

/**
 * Play for solo games. Multiplayer games: Quick play, then a row with Rooms (`browser` mode) and Private (`private`
 * mode: the Create room / Join with code action sheet). The pressed action shows the spinner while the launch
 * resolves.
 */
function PlayActions({
  multiplayer,
  rooms,
  privateRooms,
  pending,
  disabled,
  serverReady,
  notice,
  spinnerColor,
  secondarySpinnerColor,
  onPlay,
  onRooms,
  onPrivate,
}: {
  multiplayer: boolean;
  rooms: boolean;
  privateRooms: boolean;
  /** The join kind being launched for this game (Quick play / Play → `quick`, Create room → `create`). */
  pending: JoinKind | null;
  disabled: boolean;
  serverReady: boolean;
  notice: string | null;
  spinnerColor: string;
  /** On the secondary (Private) button. */
  secondarySpinnerColor: string;
  onPlay: () => void;
  onRooms: () => void;
  onPrivate: () => void;
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
      <Button size="lg" className="h-14 rounded-2xl" disabled={disabled} onPress={onPlay}>
        {pending === 'quick' ? (
          <ActivityIndicator color={spinnerColor} />
        ) : (
          <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-5" />
        )}
        <Text className="text-[17px] font-bold">{multiplayer ? 'Quick play' : 'Play'}</Text>
      </Button>
      {rooms || privateRooms ? (
        <View className="flex-row gap-2">
          {rooms && (
            <Button
              variant="secondary"
              className="h-12 flex-1 rounded-2xl"
              onPress={onRooms}
              accessibilityHint="Lists open rooms"
            >
              <Icon as={LayoutListIcon} className="text-secondary-foreground size-[18px]" />
              <Text>Rooms</Text>
            </Button>
          )}
          {privateRooms && (
            <Button
              variant="secondary"
              className="h-12 flex-1 rounded-2xl"
              disabled={disabled || !serverReady}
              onPress={onPrivate}
              accessibilityHint="Create a private room or join one with a code"
            >
              {pending === 'create' ? (
                <ActivityIndicator color={secondarySpinnerColor} />
              ) : (
                <Icon as={LockIcon} className="text-secondary-foreground size-[18px]" />
              )}
              <Text>Private</Text>
            </Button>
          )}
        </View>
      ) : null}
    </View>
  );
}

function InfoRow({ label, value, onPress, hint }: { label: string; value: string; onPress?: () => void; hint?: string }) {
  const body = (
    <>
      <Text variant="muted" className="leading-5">
        {label}
      </Text>
      <View className="shrink flex-row items-center gap-1">
        <Text className="shrink text-right text-sm font-semibold leading-5">{value}</Text>
        {onPress ? <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" /> : null}
      </View>
    </>
  );
  return onPress ? (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      accessibilityHint={hint}
      hitSlop={6}
      className="flex-row justify-between gap-4 active:opacity-70"
    >
      {body}
    </TapPressable>
  ) : (
    <View className="flex-row justify-between gap-4">{body}</View>
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
 * Round button over the hero: glass (dark translucent, white icon: it sits on the art, so static colours in both
 * themes) over the art; with `progress` it cross-fades to a plain foreground icon as the title bar slides in under it.
 * `selected` fills it with the primary colour (favorited) in both states. `pop` changing springs it (the heart);
 * Reduce Motion skips the spring.
 */
function RoundButton({
  label,
  onPress,
  selected,
  icon,
  iconClassName,
  progress,
  pop = 0,
  haptic = true,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  icon: LucideIcon;
  iconClassName: string;
  progress: SharedValue<number> | null;
  pop?: number;
  haptic?: boolean;
}) {
  const glass = useAnimatedStyle(() => ({ opacity: progress ? 1 - progress.value : 1 }));
  const plain = useAnimatedStyle(() => ({ opacity: progress ? progress.value : 0 }));
  const scale = useSharedValue(1);
  useEffect(() => {
    if (pop === 0) return;
    scale.set(withSequence(withTiming(0.8, { duration: 90 }), withSpring(1, { damping: 9, stiffness: 320, mass: 0.6 })));
  }, [pop, scale]);
  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      haptic={haptic}
      hitSlop={6}
      className="active:opacity-70"
      style={{ width: ROUND, height: ROUND }}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, popStyle]}
        className={cn('items-center justify-center rounded-full', selected && 'bg-primary')}
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
      </Animated.View>
    </TapPressable>
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
        <View className="flex-row" style={{ gap: ROUND_GAP }}>
          <View className="size-11 rounded-full border border-white/15 bg-black/35" />
          <View className="size-11 rounded-full border border-white/15 bg-black/35" />
        </View>
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
