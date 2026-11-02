import { router, usePathname } from 'expo-router';
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  CoinsIcon,
  Gamepad2Icon,
  PlayIcon,
  SearchXIcon,
  StoreIcon,
  UserXIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import Animated, { FadeIn, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useFeaturedGames, type GameCard } from '@/lib/catalog';
import { usePeopleSearch } from '@/lib/friends';
import { useProfile } from '@/lib/profile';
import { isGameScreen } from '@/lib/rejoin';
import {
  describeSocialError,
  PEOPLE_SEARCH_DEBOUNCE_MS,
  peopleQuery,
  rankPeople,
  type PersonResult,
} from '@/lib/social';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useColumnPadding } from '@/lib/use-layout';
import { cn } from '@/lib/utils';
import { useViewport } from '@/lib/viewport';
import { useWelcomed, welcomeOpened } from '@/lib/welcome';
import {
  HOW_RALLY_WORKS,
  WELCOME_COPY,
  WELCOME_STEPS,
  featuredForWelcome,
  nextWelcomeStep,
  previousWelcomeStep,
  shouldShowWelcome,
  welcomeStepLabel,
  welcomeTopPadding,
  type HowRallyWorksKey,
  type WelcomeEnd,
  type WelcomeStep,
} from '@/lib/welcome-model';
import { AvatarPicker, AvatarPickerSkeleton } from './avatar-picker';
import { EmptyState, RetryButton } from './empty-state';
import { FriendButtons } from './friend-button';
import { LogoMark } from './logo';
import { PersonList, PersonListSkeleton, PersonRow } from './person-row';
import { SearchPill } from './search-pill';
import { HeaderAction } from './section-header';

/** A step's content fades in as it replaces the previous one (nothing moves under Reduce Motion). */
const STEP_FADE = FadeIn.duration(220).reduceMotion(ReduceMotion.System);
/** The active dot stretching into a bar, like PageDots. */
const DOT_TRANSITION = LinearTransition.duration(180).reduceMotion(ReduceMotion.System);

const HOW_ICONS: Record<HowRallyWorksKey, LucideIcon> = { play: Gamepad2Icon, earn: CoinsIcon, spend: StoreIcon };

/**
 * The first-run welcome, three full-screen steps in the auth screens' look (lib/welcome-model.ts has the copy and the
 * order): the avatar picker Edit profile uses (changes apply at once), the three lines of "How Rally works", and a
 * people search with Add buttons plus "Play something". Skip (top right) is always there; Back returns a step. The
 * caller owns what happens at the end (`onEnd`: the flag, navigation): the `/get-started` route and the Developer
 * page's preview. `sheet`: presented as an iOS sheet, where the window's top inset does not apply.
 */
export function WelcomeTour({ sheet, onEnd }: { sheet: boolean; onEnd: (how: WelcomeEnd, game?: GameCard) => void }) {
  const { insets } = useViewport();
  const column = useColumnPadding(560);
  const [step, setStep] = useState<WelcomeStep>('look');
  // Steps entered after the first fade in; the first one arrives with the screen itself.
  const [moves, setMoves] = useState(0);
  const featured = useFeaturedGames();
  const game = featuredForWelcome(featured.data);
  const copy = WELCOME_COPY[step];
  const next = nextWelcomeStep(step);
  const previous = previousWelcomeStep(step);

  const go = (to: WelcomeStep) => {
    setStep(to);
    setMoves((n) => n + 1);
  };

  return (
    <KeyboardAvoidingView className="bg-background flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View className="flex-row items-center" style={[column, { paddingTop: welcomeTopPadding(sheet, insets.top) }]}>
        <View className="w-20 flex-row">
          {previous ? (
            <TapPressable
              onPress={() => go(previous)}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={8}
              className="-ml-2 size-9 items-center justify-center rounded-full active:opacity-70"
            >
              <Icon as={ChevronLeftIcon} className="text-foreground size-6" />
            </TapPressable>
          ) : null}
        </View>
        <View className="flex-1 items-center">
          <StepDots step={step} />
        </View>
        <View className="w-20 flex-row justify-end">
          <HeaderAction label="Skip" accessibilityLabel="Skip the welcome" onPress={() => onEnd('skipped')} />
        </View>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="grow gap-7 pt-5"
        contentContainerStyle={[column, { paddingBottom: 16 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Animated.View key={step} entering={moves > 0 ? STEP_FADE : undefined} className="gap-7">
          <View className="gap-3">
            <LogoMark size={36} style={{ marginLeft: -7 }} />
            <View className="gap-2">
              <Text className="text-[28px] font-extrabold leading-[34px] tracking-tight" role="heading">
                {copy.title}
              </Text>
              <Text className="text-muted-foreground text-base leading-6">{copy.lede}</Text>
            </View>
          </View>
          {step === 'look' ? <LookStep /> : step === 'how' ? <HowStep /> : <PeopleStep />}
        </Animated.View>
      </ScrollView>
      <View className="gap-2.5 pt-3" style={[column, { paddingBottom: insets.bottom + 16 }]}>
        {next ? (
          <Button size="lg" className="rounded-2xl" onPress={() => go(next)}>
            <Text>Next</Text>
          </Button>
        ) : (
          <>
            {/* Hidden only once the catalog has answered without a featured game; disabled while it loads. */}
            {game || featured.isLoading ? (
              <Button
                size="lg"
                className="rounded-2xl"
                disabled={!game}
                onPress={() => game && onEnd('play', game)}
                accessibilityLabel={game ? `Play something: opens ${game.title}` : 'Play something'}
              >
                <Icon as={PlayIcon} className="text-primary-foreground fill-primary-foreground size-4" />
                <Text>Play something</Text>
              </Button>
            ) : null}
            <Button
              variant={game || featured.isLoading ? 'secondary' : 'default'}
              size="lg"
              className="rounded-2xl"
              onPress={() => onEnd('done')}
            >
              <Text>Done</Text>
            </Button>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** Three dots on the page (the active one a short bar), with the step read out to screen readers. */
function StepDots({ step }: { step: WelcomeStep }) {
  return (
    <View
      className="flex-row items-center gap-1.5"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={welcomeStepLabel(step)}
    >
      {WELCOME_STEPS.map((s) => (
        <Animated.View
          key={s}
          layout={DOT_TRANSITION}
          className={cn('h-1.5 rounded-full', s === step ? 'bg-foreground w-5' : 'bg-fill w-1.5')}
        />
      ))}
    </View>
  );
}

/** Step 1: Edit profile's avatar block; a change is saved at once, so there is nothing to confirm here. */
function LookStep() {
  const profile = useProfile();
  if (profile.data) return <AvatarPicker profile={profile.data} preview={profile.data} />;
  if (profile.isError || profile.isSuccess) {
    return (
      <EmptyState
        compact
        icon={UserXIcon}
        title="Couldn't load your profile"
        body="Check your connection and try again."
        action={<RetryButton compact onPress={() => void profile.refetch()} />}
      />
    );
  }
  return <AvatarPickerSkeleton />;
}

/** Step 2: the three lines, as a card of rows. */
function HowStep() {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {HOW_RALLY_WORKS.map((line, i) => (
        <View key={line.key}>
          {i > 0 && <Separator className="ml-[78px]" />}
          <View className="flex-row items-center gap-3.5 px-4 py-4">
            <View className="bg-subtle border-subtle-line size-12 items-center justify-center rounded-xl border">
              <Icon as={HOW_ICONS[line.key]} className="text-foreground size-6" />
            </View>
            <View className="shrink grow gap-0.5">
              <Text className="text-[16px] font-semibold leading-[22px]">{line.title}</Text>
              <Text className="text-muted-foreground text-[13px] leading-[18px]">{line.body}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Step 3: the search screen's people search (`search_profiles`, debounced), each row with the compact friendship
 * button (Add / Requested / Accept); a row opens the profile. Nothing typed: just the field.
 */
function PeopleStep() {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, PEOPLE_SEARCH_DEBOUNCE_MS);
  const people = usePeopleSearch(debounced);
  const pq = peopleQuery(query);
  const ranked = pq && people.data ? rankPeople(people.data, debounced) : [];
  // Results on screen belong to an older query while the debounce runs or the next page loads.
  const stale = pq !== peopleQuery(debounced) || people.isPlaceholderData;
  const loading = pq.length > 0 && !people.data && !people.isError;
  const error = pq.length > 0 && people.isError && !stale ? people.error : null;
  return (
    <View className="gap-4">
      <SearchPill value={query} onChangeText={setQuery} placeholder="Search players by @username" />
      {!pq ? null : error ? (
        <EmptyState
          compact
          icon={CircleAlertIcon}
          title="Couldn't search players"
          body={describeSocialError(error)}
          action={<RetryButton compact onPress={() => void people.refetch()} />}
        />
      ) : loading ? (
        <PersonListSkeleton count={3} accessory />
      ) : ranked.length === 0 ? (
        stale ? null : (
          <EmptyState compact icon={SearchXIcon} title="No players found" body={`Nobody goes by “${pq}”.`} />
        )
      ) : (
        <PersonList
          className={cn(stale && 'opacity-60')}
          items={ranked}
          keyOf={(p) => p.userId}
          render={(p) => <PersonResultRow person={p} />}
        />
      )}
    </View>
  );
}

function PersonResultRow({ person: p }: { person: PersonResult }) {
  const self = p.friendship === 'self';
  return (
    <PersonRow
      person={p}
      self={self}
      accessory={
        self ? undefined : (
          <FriendButtons userId={p.userId} name={`@${p.username}`} status={p.friendship} mode="compact" />
        )
      }
    />
  );
}

/**
 * Decides whether to open the welcome, as `(app)/_layout.tsx` mounts it: once the profile has loaded and the device's
 * flag has been read (lib/welcome.ts), a signed-in account created within the last ten minutes that has not been
 * welcomed on this device gets `/get-started` pushed over the stack, once per run and never over a game
 * (lib/welcome-model.ts `shouldShowWelcome`). The route marks the flag when it closes.
 */
export function WelcomePrompt() {
  const { userId, signedIn } = useSession();
  const profile = useProfile();
  const gameOpen = isGameScreen(usePathname());
  const welcomed = useWelcomed(userId);
  const createdAt = profile.data?.created_at ?? null;

  useEffect(() => {
    if (!userId) return;
    const show = shouldShowWelcome({
      signedIn,
      createdAt,
      welcomed,
      now: Date.now(),
      gameOpen,
      openedThisRun: welcomeOpened.has(userId),
    });
    if (!show) return;
    welcomeOpened.add(userId);
    router.push('/get-started');
  }, [userId, signedIn, createdAt, welcomed, gameOpen]);

  return null;
}
