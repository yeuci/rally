import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeftIcon, HeartIcon, PlayIcon, UsersIcon } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConsentDialog } from '@/components/rally/consent-dialog';
import { GameCover } from '@/components/rally/game-cover';
import { Image } from '@/components/rally/image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { playersLabel, useFavorites, useGame, useToggleFavorite } from '@/lib/catalog';
import { fetchConsent, fetchLaunchPlan, launchKeys, useGrantConsent, useLaunchPlan } from '@/lib/launch';
import { useProfile } from '@/lib/profile';
import { cn } from '@/lib/utils';

const MODE_LABEL: Record<string, string> = {
  solo: 'Solo',
  quick: 'Quick play',
  browser: 'Server browser',
  private: 'Private rooms',
  party: 'Party',
};

/** Game page (deep link `/game/:id`): screenshots, details, favorite, and Play → consent → full-screen host. */
export default function GamePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
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
  const heroHeight = Math.round((width * 9) / 16);

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

  if (game.isLoading) return <GamePageSkeleton heroHeight={heroHeight} />;

  if (!g) {
    return (
      <View className="bg-background flex-1 items-center justify-center gap-3 p-6">
        <Text variant="h4">Game not found</Text>
        <Text variant="muted" className="text-center">
          {game.isError ? "Couldn't load this game." : 'It may have been removed.'}
        </Text>
        <Button variant="secondary" onPress={back}>
          <Text>Back</Text>
        </Button>
      </View>
    );
  }

  const shots = g.screenshots;
  const version = plan.data?.status === 'ready' ? plan.data.version : null;
  const playDisabled = resolving || plan.data?.status === 'unavailable';

  return (
    <View className="bg-background flex-1">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 104 }}>
        <View style={{ height: heroHeight }}>
          {shots.length > 0 ? (
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
          ) : (
            <GameCover title={g.title} uri={null} className="flex-1" />
          )}
          {shots.length > 1 && (
            <View className="absolute bottom-3 w-full flex-row justify-center gap-1.5">
              {shots.map((uri, i) => (
                <View key={uri} className={cn('h-1.5 rounded-full', i === page ? 'w-4 bg-white' : 'w-1.5 bg-white/50')} />
              ))}
            </View>
          )}
        </View>

        <View className="gap-5 px-4 pt-5">
          <View className="gap-3">
            <Text className="text-3xl font-bold tracking-tight">{g.title}</Text>
            <View className="flex-row flex-wrap gap-2">
              <Badge variant="outline">
                <Text>{g.age_rating}</Text>
              </Badge>
              <Badge variant="secondary">
                <Icon as={UsersIcon} className="text-secondary-foreground size-3" />
                <Text>{playersLabel(g)}</Text>
              </Badge>
              {g.genres.map((genre) => (
                <Badge key={genre} variant="secondary">
                  <Text className="capitalize">{genre}</Text>
                </Badge>
              ))}
            </View>
          </View>

          {g.description ? <Text className="text-base leading-6">{g.description}</Text> : null}

          <View className="bg-card border-border gap-3 rounded-xl border p-4">
            <InfoRow label="Players" value={playersLabel(g)} />
            <Separator />
            <InfoRow label="Modes" value={g.modes.map((m) => MODE_LABEL[m] ?? m).join(', ')} />
            <Separator />
            <InfoRow label="Age rating" value={g.age_rating} />
            {version && (
              <>
                <Separator />
                <InfoRow label="Version" value={version} />
              </>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Floating controls over the hero */}
      <View className="absolute left-0 right-0 flex-row justify-between px-4" style={{ top: insets.top + 8 }}>
        <RoundButton label="Back" onPress={back}>
          <Icon as={ChevronLeftIcon} className="size-5" />
        </RoundButton>
        <RoundButton
          label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onPress={() => toggleFavorite.mutate({ game: g, favorite: !isFavorite })}
        >
          <Icon as={HeartIcon} className={cn('size-5', isFavorite && 'fill-red-500 text-red-500')} />
        </RoundButton>
      </View>

      {/* Sticky Play */}
      <View
        className="bg-background/95 border-border absolute bottom-0 left-0 right-0 gap-2 border-t px-4 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        {notice && (
          <Text variant="muted" className="text-center">
            {notice}
          </Text>
        )}
        <Button size="lg" className="h-12 rounded-xl" disabled={playDisabled} onPress={() => void play()}>
          {resolving ? <ActivityIndicator /> : <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-4" />}
          <Text className="text-base font-semibold">Play</Text>
        </Button>
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
      <Text className="shrink text-right text-sm font-medium">{value}</Text>
    </View>
  );
}

function RoundButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      className="bg-background/80 size-10 items-center justify-center rounded-full active:opacity-70"
    >
      {children}
    </Pressable>
  );
}

function GamePageSkeleton({ heroHeight }: { heroHeight: number }) {
  return (
    <View className="bg-background flex-1">
      <Skeleton className="w-full rounded-none" style={{ height: heroHeight }} />
      <View className="gap-3 p-4">
        <Skeleton className="h-8 w-56" />
        <View className="flex-row gap-2">
          <Skeleton className="h-5 w-10 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </View>
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
      </View>
    </View>
  );
}
