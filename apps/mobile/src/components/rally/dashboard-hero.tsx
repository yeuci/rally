import { router, useIsFocused } from 'expo-router';
import { InfoIcon, PlayIcon, TrendingUpIcon, UsersIcon } from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type ListRenderItem,
} from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { playersLabel, type GameCard } from '@/lib/catalog';
import {
  genreLabel,
  HERO_AUTO_ADVANCE_MS,
  HERO_SLIDE_MS,
  heroAutoAdvances,
  heroLanding,
  heroLoop,
  heroLoopIndex,
  nextHeroPage,
} from '@/lib/dashboard';
import { DRAWER_EDGE_WIDTH } from '@/lib/drawer';
import { visitsLabel, weekVisitsLabel } from '@/lib/format';
import { dashboardHeroFade, dashboardHeroFadeWide, dashboardHeroSide } from '@/lib/gradient';
import { coverUriFor } from '@/lib/game-art';
import { pageIndex } from '@/lib/layout';
import { useAppDrawer } from '@/lib/use-app-drawer';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { GameCover } from './game-cover';
import { useSvgId } from './logo';
import { PageDots } from './page-dots';
import { PresenceDot } from './presence-dot';

type Pad = { left: number; right: number };

/** Space under the content for the page dots (a 20 pt pill 8 pt above the hero's bottom edge). */
const CONTENT_BOTTOM = 16;

/** Content column width over a wide hero: the left ≈ 48 % (the side scrim fades the art there). */
function wideColumn(width: number) {
  return Math.max(Math.round(width * 0.48), 320);
}

/**
 * The dashboard's full-bleed trending hero (lib/catalog.ts `useTrendingGames`): the window's full width, from the top
 * of the window (under the status bar and the floating top bar). Only the art pages: a horizontal pager of key art
 * (`coverUriFor`: the tall feature art on a phone, the wide cover on a wide window, else generated art) under one
 * static scrim that shades the top
 * for the bar and fades into the page background. The text block (Trending chip, title, meta chips with the page dots
 * at their end, a quiet "1.2K visits this week" line or the all-time count, Play / Details) stays put over the art.
 * As the page changes (mid-swipe once the next page is more than half across, and as the auto-advance starts its
 * slide) only the game's own lines cross-fade to the next game's; the chip and the buttons, the same for every game,
 * stay as they are.
 *
 * Several games advance on their own every `HERO_AUTO_ADVANCE_MS` (lib/dashboard.ts `heroAutoAdvances`: not under
 * reduced motion or a screen reader, not while touched, not while the dashboard is covered or the drawer is open). The
 * pager loops (`heroLoop`): copies of the last and first pages sit at the ends, so advancing or swiping past either end
 * slides into a copy and the pager then jumps silently to the real page; the slide is always one page forward, never a
 * rewind across them all. Every page is rendered up front, so a slide never reveals a blank page. The list is keyed on
 * its size, so a rotation re-lays it out at the same page.
 *
 * The drawer's edge swipe owns the left `DRAWER_EDGE_WIDTH` points: a strip over the art there (a sibling above the
 * pager, so the pager's native scroll never sees touches that start in it) keeps the pager from fighting the swipe;
 * a tap on it still opens the game. It stops at the text block (measured) so Play and the title keep their whole hit
 * area.
 */
export function DashboardHero({
  games,
  width,
  height,
  wide,
  pad,
  onPlay,
  resolvingId,
  notice,
  liveFor,
}: {
  games: HeroGame[];
  width: number;
  height: number;
  wide: boolean;
  pad: Pad;
  onPlay: (game: GameCard) => void;
  resolvingId: string | null;
  notice: { gameId: string; message: string } | null;
  /** "12 playing" for a multiplayer game with players right now (a chip beside the players count), else null. */
  liveFor?: (game: GameCard) => string | null;
}) {
  const palette = usePalette();
  const listRef = useRef<FlatList<HeroGame>>(null);
  const [page, setPage] = useState(0);
  const [touching, setTouching] = useState(false);
  // Top of the text block (from its layout), so the edge strip covers only the art above it.
  const [contentTop, setContentTop] = useState<number | null>(null);
  const screenReader = useScreenReaderEnabled();
  const reducedMotion = useReducedMotion();
  const focused = useIsFocused();
  const drawer = useAppDrawer();
  const count = games.length;
  const current = Math.min(page, Math.max(0, count - 1));
  const pages = useMemo(() => heroLoop(games), [games]);
  /** A pager index to jump to without animation once a slide onto a copy has landed (`heroLanding`). */
  const [jumpTo, setJumpTo] = useState<number | null>(null);

  const auto = heroAutoAdvances({ count, reducedMotion, screenReader, touching, focused, drawerOpen: drawer.isOpen });
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => {
      const next = nextHeroPage(current, count);
      // One page forward in the loop: from the last page that is the copy of the first, after which the pager jumps
      // to the real first page (below, once the slide has landed; the momentum handler does the same if it fires).
      const index = heroLoopIndex(current, count) + 1;
      listRef.current?.scrollToOffset({ offset: index * width, animated: true });
      setPage(next);
      if (next === 0 && count > 1) setJumpTo(heroLoopIndex(0, count));
    }, HERO_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [auto, current, count, width]);

  useEffect(() => {
    if (jumpTo === null) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToOffset({ offset: jumpTo * width, animated: false });
      setJumpTo(null);
    }, HERO_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [jumpTo, width]);

  const goTo = (target: number) => {
    const next = ((target % count) + count) % count;
    listRef.current?.scrollToOffset({ offset: heroLoopIndex(next, count) * width, animated: !reducedMotion });
    setPage(next);
  };

  const renderItem = useCallback<ListRenderItem<HeroGame>>(
    ({ item }) => <HeroArt game={item} width={width} height={height} wide={wide} />,
    [width, height, wide],
  );
  const currentGame = games[current];
  // Until the text block is measured: the top half, always clear of it.
  const stripHeight = Math.max(0, Math.round(contentTop ?? height * 0.5));
  const getItemLayout = useCallback(
    (_: ArrayLike<HeroGame> | null | undefined, index: number) => ({ length: width, offset: width * index, index }),
    [width],
  );

  return (
    <View style={{ width, height }}>
      <FlatList
        // Re-keyed on the hero's size: a rotation remounts the pager at the same page with fresh page offsets.
        key={`${width}x${height}`}
        ref={listRef}
        horizontal
        pagingEnabled
        data={pages}
        // The copies share a game with a real page: the key carries the position.
        keyExtractor={(g, i) => `${g.id}:${i}`}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialScrollIndex={heroLoopIndex(current, count)}
        initialNumToRender={pages.length}
        windowSize={Math.max(3, pages.length)}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onTouchStart={() => setTouching(true)}
        onTouchEnd={() => setTouching(false)}
        onTouchCancel={() => setTouching(false)}
        onScrollBeginDrag={() => setTouching(true)}
        // The text block follows the nearest page while the art moves (a swipe past half-way cross-fades it); the
        // silent jump off a copy waits for the scroll to settle.
        scrollEventThrottle={32}
        onScroll={(e) => {
          setPage(heroLanding(pageIndex(e.nativeEvent.contentOffset.x, width, pages.length), count).page);
        }}
        onMomentumScrollEnd={(e) => {
          setTouching(false);
          const landing = heroLanding(pageIndex(e.nativeEvent.contentOffset.x, width, pages.length), count);
          setPage(landing.page);
          if (landing.jumpTo !== null) {
            listRef.current?.scrollToOffset({ offset: landing.jumpTo * width, animated: false });
            setJumpTo(null);
          }
        }}
      />
      <HeroScrim width={width} height={height} wide={wide} color={palette.background} />
      {currentGame && stripHeight > 0 ? (
        <TapPressable
          onPress={() => router.push({ pathname: '/game/[id]', params: { id: currentGame.id } })}
          className="absolute left-0 top-0"
          style={{ width: DRAWER_EDGE_WIDTH, height: stripHeight }}
          accessible={false}
          importantForAccessibility="no"
        />
      ) : null}
      {currentGame ? (
        <View
          className="absolute bottom-0 left-0 right-0"
          style={{ paddingLeft: pad.left, paddingRight: pad.right, paddingBottom: CONTENT_BOTTOM }}
          pointerEvents="box-none"
          onLayout={(e: LayoutChangeEvent) => setContentTop(e.nativeEvent.layout.y)}
        >
          <View
            className="gap-3"
            style={wide ? { width: wideColumn(width) - pad.left } : undefined}
            pointerEvents="box-none"
          >
            <View className="flex-row" pointerEvents="none">
              <Badge variant="subtle" accessibilityLabel="Trending">
                <Icon as={TrendingUpIcon} className="text-foreground size-3" />
                <Text>Trending</Text>
              </Badge>
            </View>
            {/* Only what differs between games is keyed on the game, so the old text fades out where it was while
                the new fades in. The Trending chip above and the buttons below are the same for every game: they
                stay mounted and never blink (the buttons act on whichever game is showing). */}
            <Animated.View
              key={currentGame.id}
              entering={INFO_IN}
              exiting={INFO_OUT}
              className="gap-3"
              pointerEvents="none"
            >
              <HeroInfo
                game={currentGame}
                wide={wide}
                count={count}
                page={current}
                live={liveFor?.(currentGame) ?? null}
              />
            </Animated.View>
            <HeroActions
              game={currentGame}
              onPlay={onPlay}
              resolving={resolvingId === currentGame.id}
              notice={notice?.gameId === currentGame.id ? notice.message : null}
              spinnerColor={palette.primaryForeground}
            />
          </View>
        </View>
      ) : null}
      {/* The pager's screen-reader control (the dots themselves sit in the meta row, decoratively). */}
      {count > 1 && (
        <View
          className="absolute bottom-0 left-0 right-0 h-px"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Trending games"
          accessibilityValue={{ text: `${current + 1} of ${count}` }}
          accessibilityActions={ADJUST_ACTIONS}
          onAccessibilityAction={(e: AccessibilityActionEvent) =>
            goTo(e.nativeEvent.actionName === 'increment' ? current + 1 : current - 1)
          }
          pointerEvents="none"
        />
      )}
    </View>
  );
}

const ADJUST_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }] as const;
/** The text block's cross-fade between games (skipped under Reduce Motion: the block just changes). */
const INFO_IN = FadeIn.duration(220).reduceMotion(ReduceMotion.System);
const INFO_OUT = FadeOut.duration(160).reduceMotion(ReduceMotion.System);

/** A hero page's game: a card, plus its launches over the trending window when the catalog knows them. */
export type HeroGame = GameCard & { recent_visits?: number };

/**
 * One page of art: the tall feature art on a phone, the wide cover on a wide window (lib/game-art.ts). Tapping it
 * opens the game page, like Details.
 */
const HeroArt = memo(function HeroArt({
  game,
  width,
  height,
  wide,
}: {
  game: HeroGame;
  width: number;
  height: number;
  wide: boolean;
}) {
  return (
    <View style={{ width, height }}>
      <GameCover
        id={game.id}
        title={game.title}
        uri={coverUriFor(game, wide ? 'banner' : 'feature')}
        variant="feature"
        showTitle={false}
        scrim="none"
        className="absolute left-0 top-0"
        style={{ width, height }}
      />
      <TapPressable
        onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })}
        style={StyleSheet.absoluteFill}
        accessible={false}
        importantForAccessibility="no"
      />
    </View>
  );
});

/** The part of the text block that changes with the game: title, meta chips with the page dots, the visits line. */
const HeroInfo = memo(function HeroInfo({
  game,
  wide,
  count,
  page,
  live,
}: {
  game: HeroGame;
  wide: boolean;
  /** Pages in the hero and the one showing now: the dots at the end of the meta row (none with a single page). */
  count: number;
  page: number;
  live: string | null;
}) {
  const genre = game.genres[0];
  const recent = game.recent_visits ?? 0;
  return (
    <>
      <Text
        className={cn(
          'text-foreground font-extrabold tracking-tight',
          wide ? 'text-[30px] leading-[36px]' : 'text-[34px] leading-[40px]',
        )}
        role="heading"
        numberOfLines={2}
      >
        {game.title}
      </Text>
      <View className="flex-row flex-wrap items-center gap-2" pointerEvents="none">
        {genre ? (
          <Badge variant="subtle">
            <Text>{genreLabel(genre)}</Text>
          </Badge>
        ) : null}
        <Badge variant="secondary" accessibilityLabel={playersLabel(game)}>
          <Icon as={UsersIcon} className="text-secondary-foreground size-3" />
          <Text>{playersLabel(game)}</Text>
        </Badge>
        <Badge variant="outline">
          <Text>{game.age_rating}</Text>
        </Badge>
        {live ? (
          <Badge variant="subtle" accessibilityLabel={live}>
            <PresenceDot />
            <Text>{live}</Text>
          </Badge>
        ) : null}
        {count > 1 ? (
          <PageDots
            count={count}
            index={page}
            className="ml-auto"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}
      </View>
      {recent > 0 || game.visits > 0 ? (
        <Text className="text-muted-foreground -mt-1 text-[13px] font-medium leading-[18px]" numberOfLines={1}>
          {recent > 0 ? weekVisitsLabel(recent) : visitsLabel(game.visits)}
        </Text>
      ) : null}
    </>
  );
});

/** Play / Details for the game showing, and the launch notice under them. Stays mounted across pages. */
const HeroActions = memo(function HeroActions({
  game,
  onPlay,
  resolving,
  notice,
  spinnerColor,
}: {
  game: HeroGame;
  onPlay: (game: GameCard) => void;
  resolving: boolean;
  notice: string | null;
  spinnerColor: string;
}) {
  const details = () => router.push({ pathname: '/game/[id]', params: { id: game.id } });
  return (
    <>
      <View className="flex-row items-center gap-2.5 pt-1">
        <Button
          className="h-11 min-w-28 rounded-full px-5"
          onPress={() => onPlay(game)}
          disabled={resolving}
          accessibilityLabel={`Play ${game.title}`}
        >
          {resolving ? (
            <ActivityIndicator size="small" color={spinnerColor} />
          ) : (
            <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-4" />
          )}
          <Text className="font-bold">Play</Text>
        </Button>
        <Button
          variant="secondary"
          className="h-11 rounded-full px-5"
          onPress={details}
          accessibilityLabel={`${game.title} details`}
        >
          <Icon as={InfoIcon} className="text-secondary-foreground size-4" />
          <Text className="font-semibold">Details</Text>
        </Button>
      </View>
      {notice ? (
        <Text
          className="text-muted-foreground text-[13px] leading-[18px]"
          numberOfLines={2}
          accessibilityLiveRegion="polite"
        >
          {notice}
        </Text>
      ) : null}
    </>
  );
});

/**
 * Hero scrim at explicit numbers (keyed on the size, so a rotation redraws instead of stretching an old bitmap):
 * shade under the status bar and top bar, then a fade that reaches the page background before the text block. Wide:
 * the bottom fade plus a fade from the left edge under the left-hand column.
 */
const HeroScrim = memo(function HeroScrim({
  width,
  height,
  wide,
  color,
}: {
  width: number;
  height: number;
  wide: boolean;
  color: string;
}) {
  const down = useSvgId('hero-down');
  const side = useSvgId('hero-side');
  // Black shade on the art at the top, then the page colour from alpha 0 (lib/gradient.ts): never a blend through grey.
  const stops = wide ? dashboardHeroFadeWide(color) : dashboardHeroFade(color);
  return (
    <Svg key={`${width}x${height}`} style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
      <Defs>
        <LinearGradient id={down} x1="0" y1="0" x2="0" y2="1">
          {stops.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </LinearGradient>
        {wide && (
          <LinearGradient id={side} x1="0" y1="0" x2="1" y2="0">
            {dashboardHeroSide(color).map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
            ))}
          </LinearGradient>
        )}
      </Defs>
      {wide && <Rect x={0} y={0} width={width} height={height} fill={`url(#${side})`} />}
      <Rect x={0} y={0} width={width} height={height} fill={`url(#${down})`} />
    </Svg>
  );
});

/**
 * Same box as the hero while the trending games load: a full-bleed block for the art, then the chip, title, meta
 * chips with the dots at their end and the two buttons at their real places (bottom-aligned, same paddings).
 */
export function DashboardHeroSkeleton({
  width,
  height,
  wide,
  pad,
}: {
  width: number;
  height: number;
  wide: boolean;
  pad: Pad;
}) {
  return (
    <View style={{ width, height }}>
      <Skeleton
        className="absolute left-0 right-0 top-0 rounded-none"
        style={{ height: Math.round(height * (wide ? 0.62 : 0.5)) }}
      />
      <View
        className="absolute bottom-0 left-0 right-0"
        style={{ paddingLeft: pad.left, paddingRight: pad.right, paddingBottom: CONTENT_BOTTOM }}
      >
        <View className="gap-3">
          <Skeleton className="h-[26px] w-20 rounded-full" />
          <Skeleton className="h-9 w-56 rounded-lg" />
          <View className="flex-row items-center gap-2">
            <Skeleton className="h-[26px] w-16 rounded-full" />
            <Skeleton className="h-[26px] w-24 rounded-full" />
            <Skeleton className="h-[26px] w-10 rounded-full" />
            <Skeleton className="ml-auto h-[26px] w-16 rounded-full" />
          </View>
          <View className="flex-row gap-2.5 pt-1">
            <Skeleton className="h-11 w-28 rounded-full" />
            <Skeleton className="h-11 w-28 rounded-full" />
          </View>
        </View>
      </View>
    </View>
  );
}

/** Whether a screen reader is on, kept current (the hero does not move under VoiceOver / TalkBack focus). */
function useScreenReaderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) setEnabled(on);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setEnabled);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return enabled;
}
