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
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { ConsentDialog } from '@/components/rally/consent-dialog';
import { EmptyState } from '@/components/rally/empty-state';
import { CoverScrim, GameCover } from '@/components/rally/game-cover';
import { Image } from '@/components/rally/image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { playersLabel, useFavorites, useGame, useToggleFavorite, type Game } from '@/lib/catalog';
import { fetchConsent, fetchLaunchPlan, launchKeys, useGrantConsent, useLaunchPlan } from '@/lib/launch';
import { GUTTER, gameCoverColumnWidth, gameHeroHeight, pageIndex } from '@/lib/layout';
import { useProfile } from '@/lib/profile';
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

  const [resolving, setResolving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const g = game.data;
  const isFavorite = !!g && !!favorites.data?.some((f) => f.id === g.id);
  const heroHeight = gameHeroHeight({ width, height }, insets.top);
  const coverWidth = gameCoverColumnWidth(width, insets);
  // Landscape keeps clear of the home indicator / camera housing even where the inset is 0.
  const edgeTop = Math.max(insets.top, 12);
  const edgeBottom = Math.max(insets.bottom, 12);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const openHost = () => router.push({ pathname: '/game/[id]/play', params: { id } });

  async function refresh() {
    setRefreshing(true);
    try {
      // The game, its version plan (Play / version row) and the favorite state; refetch() resolves, never throws.
      await Promise.all([game.refetch(), plan.refetch(), favorites.refetch()]);
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
      <GamePageSkeleton heroHeight={heroHeight} bottomInset={insets.bottom} pad={pad} />
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
  const controls = (
    <>
      <RoundButton label="Back" onPress={back}>
        <Icon as={ChevronLeftIcon} className="size-6 text-white" />
      </RoundButton>
      <RoundButton
        label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        selected={isFavorite}
        onPress={() => toggleFavorite.mutate({ game: g, favorite: !isFavorite })}
      >
        <Icon as={HeartIcon} className={cn('size-5', isFavorite ? 'text-primary-foreground fill-primary-foreground' : 'text-white')} />
      </RoundButton>
    </>
  );
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
            <View className="absolute left-3 right-3 top-3 flex-row justify-between">{controls}</View>
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
          <About game={g} orientation={orientation} version={version} />
        </ScrollView>
        {consent}
      </View>
    );
  }

  return (
    <View className="bg-background flex-1">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120 }} refreshControl={refreshControl}>
        <View style={{ height: heroHeight }}>
          <HeroMedia game={g} scrim="fade" scrimColor={palette.background} dotsClassName="bottom-16" />
        </View>
        <View className="-mt-10 gap-6" style={{ paddingLeft: pad.left, paddingRight: pad.right }}>
          <TitleBlock game={g} orientation={orientation} />
          <About game={g} orientation={orientation} version={version} />
        </View>
      </ScrollView>

      {/* Floating controls over the hero, inside the safe area on both sides */}
      <View
        className="absolute left-0 right-0 flex-row justify-between"
        style={{ top: insets.top + 8, paddingLeft: pad.left, paddingRight: pad.right }}
        pointerEvents="box-none"
      >
        {controls}
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
 * The hero's media, filling its parent: screenshots in a paged gallery (with dots) or the generated cover. Measures
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
  const shots = g.screenshots;
  return (
    <View className="flex-1" onLayout={box.onLayout}>
      {shots.length === 0 ? (
        <GameCover id={g.id} title={g.title} variant="hero" scrim={scrim} scrimColor={scrimColor} className="flex-1" />
      ) : box.size ? (
        <Gallery key={box.key} shots={shots} width={box.size.width} height={box.size.height} dotsClassName={dotsClassName} />
      ) : (
        <View className="bg-muted flex-1" />
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

function About({ game: g, orientation, version }: { game: Game; orientation: { label: string }; version: string | null }) {
  return (
    <>
      {g.description ? <Text className="text-secondary-foreground text-base leading-[25px]">{g.description}</Text> : null}
      <View className="gap-3">
        <Text className="text-[17px] font-bold tracking-tight" role="heading">
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
      <Text variant="muted">{label}</Text>
      <Text className="shrink text-right text-sm font-semibold">{value}</Text>
    </View>
  );
}

/** Glass button over the hero; `selected` fills it with the primary (foreground) colour (favorited). */
function RoundButton({
  label,
  onPress,
  selected,
  children,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={8}
      className={cn(
        'size-11 items-center justify-center rounded-full border active:opacity-70',
        selected ? 'bg-primary border-primary' : 'border-white/15 bg-black/35',
      )}
    >
      {children}
    </Pressable>
  );
}

function GamePageSkeleton({ heroHeight, bottomInset, pad }: { heroHeight: number; bottomInset: number; pad: { left: number; right: number } }) {
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  return (
    <View className="bg-background flex-1">
      <Skeleton className="w-full rounded-none" style={{ height: heroHeight }} />
      <View className="-mt-10 gap-3" style={padStyle}>
        <Skeleton className="h-9 w-56 rounded-lg" />
        <ChipSkeletons />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-4 h-36 w-full rounded-2xl" />
      </View>
      <View className="absolute bottom-0 left-0 right-0" style={[padStyle, { paddingBottom: bottomInset + 12 }]}>
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
      <View className="flex-1 gap-3" style={{ paddingTop: edgeTop + 4, paddingLeft: 24, paddingRight: GUTTER }}>
        <Skeleton className="h-9 w-56 rounded-lg" />
        <ChipSkeletons />
        <Skeleton className="mt-3 h-14 w-full rounded-2xl" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </View>
    </View>
  );
}

function ChipSkeletons() {
  return (
    <View className="flex-row gap-2">
      <Skeleton className="h-6 w-16 rounded-full" />
      <Skeleton className="h-6 w-12 rounded-full" />
      <Skeleton className="h-6 w-10 rounded-full" />
      <Skeleton className="h-6 w-24 rounded-full" />
    </View>
  );
}
