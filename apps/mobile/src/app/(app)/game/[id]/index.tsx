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
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { useProfile } from '@/lib/profile';
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

const heroHeightFor = (width: number, height: number) => Math.round(Math.min(width * 1.05, height * 0.58));

/** Game page (deep link `/game/:id`): cover hero, details, favorite, and Play → consent → full-screen host. */
export default function GamePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const palette = usePalette();
  const qc = useQueryClient();
  const { userId } = useSession();

  const game = useGame(id);
  const plan = useLaunchPlan(id); // prefetch so Play is instant
  const profile = useProfile();
  const favorites = useFavorites();
  const toggleFavorite = useToggleFavorite();
  const grantConsent = useGrantConsent();

  const [page, setPage] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);

  const g = game.data;
  const isFavorite = !!g && !!favorites.data?.some((f) => f.id === g.id);
  const heroHeight = heroHeightFor(width, height);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const openHost = () => router.push({ pathname: '/game/[id]/play', params: { id } });

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

  if (game.isLoading) return <GamePageSkeleton heroHeight={heroHeight} bottomInset={insets.bottom} />;

  if (!g) {
    return (
      <View className="bg-background flex-1 justify-center p-6">
        <EmptyState
          icon={SearchXIcon}
          title="Game not found"
          body={game.isError ? "Couldn't load this game." : 'It may have been removed.'}
          action={
            <Button variant="secondary" onPress={back}>
              <Text>Back</Text>
            </Button>
          }
        />
      </View>
    );
  }

  const shots = g.screenshots;
  const version = plan.data?.status === 'ready' ? plan.data.version : null;
  const playDisabled = resolving || plan.data?.status === 'unavailable';
  const orientation = ORIENTATION[g.orientation];

  return (
    <View className="bg-background flex-1">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>
        <View style={{ height: heroHeight }}>
          {shots.length > 0 ? (
            <>
              <ScrollView
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
              >
                {shots.map((uri) => (
                  <Image key={uri} source={{ uri }} style={{ width, height: heroHeight }} contentFit="cover" transition={200} />
                ))}
              </ScrollView>
              <CoverScrim kind="fade" photo color={palette.background} />
            </>
          ) : (
            <GameCover id={g.id} title={g.title} variant="hero" scrim="fade" scrimColor={palette.background} className="flex-1" />
          )}
          {shots.length > 1 && (
            <View className="absolute bottom-16 w-full flex-row justify-center gap-1.5" pointerEvents="none">
              {shots.map((uri, i) => (
                <View key={uri} className={cn('h-1.5 rounded-full', i === page ? 'bg-foreground w-5' : 'bg-muted-foreground w-1.5')} />
              ))}
            </View>
          )}
        </View>

        <View className="-mt-10 gap-6 px-4">
          <View className="gap-3">
            <Text className="text-[34px] font-extrabold leading-[40px] tracking-tight" role="heading">
              {g.title}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {g.genres.map((genre) => (
                <Badge key={genre} variant="brand">
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
        </View>
      </ScrollView>

      {/* Floating controls over the hero */}
      <View className="absolute left-0 right-0 flex-row justify-between px-4" style={{ top: insets.top + 8 }}>
        <RoundButton label="Back" onPress={back}>
          <Icon as={ChevronLeftIcon} className="size-6 text-white" />
        </RoundButton>
        <RoundButton
          label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          selected={isFavorite}
          onPress={() => toggleFavorite.mutate({ game: g, favorite: !isFavorite })}
        >
          <Icon as={HeartIcon} className={cn('size-5 text-white', isFavorite && 'fill-white')} />
        </RoundButton>
      </View>

      {/* Sticky Play: fades the page out above it instead of a hard border */}
      <View className="absolute bottom-0 left-0 right-0" pointerEvents="box-none">
        <View className="h-6" pointerEvents="none">
          <CoverScrim kind="fade" color={palette.background} />
        </View>
        <View className="bg-background gap-2 px-4 pt-1" style={{ paddingBottom: insets.bottom + 12 }}>
          {notice && (
            <View className="flex-row items-center justify-center gap-1.5 px-2" accessibilityLiveRegion="polite">
              <Icon as={CircleAlertIcon} className="text-muted-foreground size-4" />
              <Text variant="muted" className="shrink text-center">
                {notice}
              </Text>
            </View>
          )}
          <Button
            size="lg"
            className="h-14 rounded-2xl"
            disabled={playDisabled}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              void play();
            }}
          >
            {resolving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-5" />
            )}
            <Text className="text-[17px] font-bold">Play</Text>
          </Button>
        </View>
      </View>

      <ConsentDialog
        open={consentOpen}
        gameTitle={g.title}
        profile={profile.data}
        busy={grantConsent.isPending}
        onAllow={() => void allow()}
        onDecline={() => setConsentOpen(false)}
      />
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

/** Glass button over the hero; `selected` fills it with the accent (favorited). */
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
        selected ? 'bg-brand border-brand' : 'border-white/15 bg-black/35',
      )}
    >
      {children}
    </Pressable>
  );
}

function GamePageSkeleton({ heroHeight, bottomInset }: { heroHeight: number; bottomInset: number }) {
  return (
    <View className="bg-background flex-1">
      <Skeleton className="w-full rounded-none" style={{ height: heroHeight }} />
      <View className="-mt-10 gap-3 px-4">
        <Skeleton className="h-9 w-56 rounded-lg" />
        <View className="flex-row gap-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-12 rounded-full" />
          <Skeleton className="h-6 w-10 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
        </View>
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-4 h-36 w-full rounded-2xl" />
      </View>
      <View className="absolute bottom-0 left-0 right-0 px-4" style={{ paddingBottom: bottomInset + 12 }}>
        <Skeleton className="h-14 w-full rounded-2xl" />
      </View>
    </View>
  );
}
