import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CircleAlertIcon, HistoryIcon, LinkIcon, SearchIcon, SearchXIcon, XIcon } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { FriendButtons } from '@/components/rally/friend-button';
import { GameListRow, GameListRowSkeleton } from '@/components/rally/game-card';
import { PersonList, PersonListSkeleton, PersonRow } from '@/components/rally/person-row';
import { SearchPill } from '@/components/rally/search-pill';
import { HeaderAction, SectionHeader } from '@/components/rally/section-header';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useAllGames, type GameCard } from '@/lib/catalog';
import { usePeopleSearch } from '@/lib/friends';
import { formatScore } from '@/lib/progress-format';
import { searchGames } from '@/lib/search';
import {
  describeSocialError,
  isPeopleOnlyQuery,
  PEOPLE_SEARCH_DEBOUNCE_MS,
  peopleQuery,
  rankPeople,
  searchSectionOrder,
  socialErrorKind,
  type PersonResult,
} from '@/lib/social';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { recentSearches, useRecentSearches } from '@/lib/use-recent-searches';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { cn } from '@/lib/utils';

/** Game rows shown before "See all". */
const GAMES_PREVIEW = 5;

/**
 * Search (pushed from the dashboard pill, keyboard up; `?q=` prefills the field, e.g. "@" from Friends' "Find
 * players"): Games (client-side `searchGames` over the catalog) and People (`search_profiles`, debounced 250 ms, from
 * 1 character; "@name" searches people only). Each group has its own skeleton; the groups swap order when the query is
 * exactly someone's username (lib/social.ts `searchSectionOrder`). Tapping a player opens their profile; the row's
 * button sends / accepts requests. With the field empty: the last 8 searches (on this device, clearable). A search
 * is remembered when it is submitted, or when you leave the screen (a result opened, Cancel) while it had results.
 */
export default function SearchScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding(720);
  const { q } = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(typeof q === 'string' ? q : '');
  const recent = useRecentSearches();
  const [allGames, setAllGames] = useState(false);
  const debounced = useDebouncedValue(query, PEOPLE_SEARCH_DEBOUNCE_MS);

  const catalog = useAllGames();
  const people = usePeopleSearch(debounced);

  const trimmed = query.trim();
  const peopleOnly = isPeopleOnlyQuery(query);
  const pq = peopleQuery(query);
  const settledQuery = peopleQuery(debounced);
  const games: GameCard[] = trimmed && !peopleOnly ? searchGames(catalog.data ?? [], trimmed) : [];
  const ranked = pq && people.data ? rankPeople(people.data, debounced) : [];
  // Results on screen belong to an older query while the debounce runs or the next page loads.
  const stale = pq !== settledQuery || people.isPlaceholderData;
  const peopleLoading = pq.length > 0 && !people.data && !people.isError;
  const peopleError = pq.length > 0 && people.isError && !stale ? people.error : null;
  const anonymous = peopleError ? socialErrorKind(peopleError) === 'anonymous' : false;
  const gamesLoading = !!trimmed && !peopleOnly && catalog.isLoading;

  const nothing =
    !!trimmed && !gamesLoading && games.length === 0 && !peopleLoading && !stale && !peopleError && ranked.length === 0;
  const order = searchSectionOrder(query, games, ranked);

  // The query worth remembering when the screen loses focus: one that showed results (kept current after each render).
  const remember = useRef('');
  const hasResults = games.length > 0 || (!stale && ranked.length > 0);
  useEffect(() => {
    remember.current = hasResults ? trimmed : '';
  }, [hasResults, trimmed]);
  useFocusEffect(
    useCallback(
      () => () => {
        if (remember.current) recentSearches.add(remember.current);
      },
      [],
    ),
  );

  const gamesSection =
    !trimmed || peopleOnly || (!gamesLoading && games.length === 0 && !catalog.isError) ? null : (
      <View key="games" className="gap-3">
        <SectionHeader
          title="Games"
          detail={gamesLoading ? undefined : formatScore(games.length)}
          className="px-0"
          accessory={
            games.length > GAMES_PREVIEW ? (
              <HeaderAction label={allGames ? 'Show less' : 'See all'} onPress={() => setAllGames((v) => !v)} />
            ) : undefined
          }
        />
        {gamesLoading ? (
          <View className="bg-card border-border overflow-hidden rounded-2xl border">
            {[0, 1, 2].map((i) => (
              <View key={i}>
                {i > 0 && <Separator className="ml-[80px]" />}
                <GameListRowSkeleton index={i} />
              </View>
            ))}
          </View>
        ) : catalog.isError ? (
          <EmptyState
            compact
            icon={CircleAlertIcon}
            title="Couldn't load games"
            body="Check your connection and try again."
            action={<RetryButton compact onPress={() => void catalog.refetch()} />}
          />
        ) : (
          <View className="bg-card border-border overflow-hidden rounded-2xl border">
            {(allGames ? games : games.slice(0, GAMES_PREVIEW)).map((g, i) => (
              <View key={g.id}>
                {i > 0 && <Separator className="ml-[80px]" />}
                <GameListRow game={g} />
              </View>
            ))}
          </View>
        )}
      </View>
    );

  const peopleSection = !pq ? null : anonymous ? (
    <EmptyState
      key="people"
      icon={LinkIcon}
      title="Link your account to find players"
      body="People search and friends need a linked account. Finish signing up with Apple, Google or email, then search again."
    />
  ) : peopleError ? (
    <View key="people" className="gap-3">
      <SectionHeader title="People" className="px-0" />
      <EmptyState
        compact
        icon={CircleAlertIcon}
        title="Couldn't search players"
        body={describeSocialError(peopleError)}
        action={<RetryButton compact onPress={() => void people.refetch()} />}
      />
    </View>
  ) : peopleLoading ? (
    <View key="people" className="gap-3">
      <SectionHeader title="People" className="px-0" />
      <PersonListSkeleton count={3} accessory />
    </View>
  ) : ranked.length === 0 ? (
    stale || nothing ? null : (
      <View key="people" className="gap-3">
        <SectionHeader title="People" className="px-0" />
        <EmptyState compact icon={SearchXIcon} title="No players found" body={`Nobody goes by “${pq}”.`} />
      </View>
    )
  ) : (
    <View key="people" className="gap-3">
      <SectionHeader title="People" detail={formatScore(ranked.length)} className="px-0" />
      <PersonList
        className={cn(stale && 'opacity-60')}
        items={ranked}
        keyOf={(p) => p.userId}
        render={(p) => <PersonResultRow person={p} />}
      />
    </View>
  );

  return (
    <View className="bg-background flex-1">
      <View className="flex-row items-center gap-3 pb-3" style={[column, { paddingTop: insets.top + 8 }]}>
        <View className="flex-1">
          <SearchPill
            value={query}
            onChangeText={setQuery}
            placeholder="Games and players"
            autoFocus
            onSubmitEditing={() => recentSearches.add(query)}
          />
        </View>
        <TapPressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          hitSlop={8}
          className="active:opacity-70"
        >
          <Text className="text-[16px] font-semibold">Cancel</Text>
        </TapPressable>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-7 pt-2"
        contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {!trimmed ? (
          recent.length > 0 ? (
            <RecentSearches items={recent} onPick={setQuery} />
          ) : (
            <EmptyState
              icon={SearchIcon}
              title="Find games and players"
              body="Search games by title or genre, and players by name or @username."
            />
          )
        ) : peopleOnly && !pq ? (
          // Just the "@" (Friends' "Find players" opens search with it): people only, nothing typed yet.
          <EmptyState icon={SearchIcon} title="Find players" body="Type a name or @username to find someone to add." />
        ) : nothing ? (
          <EmptyState
            icon={SearchXIcon}
            title={`No results for “${trimmed}”`}
            body="Try a game title, a genre like puzzle, or a player's @username."
          />
        ) : (
          order.map((section) => (section === 'games' ? gamesSection : peopleSection))
        )}
      </ScrollView>
    </View>
  );
}

function PersonResultRow({ person: p }: { person: PersonResult }) {
  const self = p.friendship === 'self';
  return (
    <PersonRow
      person={p}
      self={self}
      accessory={self ? undefined : <FriendButtons userId={p.userId} name={`@${p.username}`} status={p.friendship} mode="compact" />}
    />
  );
}

/** The last searches (newest first): tap one to search it again, × removes it, Clear forgets them all. */
function RecentSearches({ items, onPick }: { items: string[]; onPick: (query: string) => void }) {
  return (
    <View className="gap-3">
      <SectionHeader
        title="Recent"
        className="px-0"
        accessory={<HeaderAction label="Clear" accessibilityLabel="Clear recent searches" onPress={recentSearches.clear} />}
      />
      <View className="bg-card border-border overflow-hidden rounded-2xl border">
        {items.map((item, i) => (
          <View key={item}>
            {i > 0 && <Separator className="ml-[52px]" />}
            <View className="flex-row items-center">
              <TapPressable
                onPress={() => onPick(item)}
                accessibilityRole="button"
                accessibilityLabel={`Search ${item}`}
                className="active:bg-accent min-h-12 shrink grow flex-row items-center gap-3.5 py-3 pl-4 pr-2"
              >
                <Icon as={HistoryIcon} className="text-muted-foreground size-[18px]" />
                <Text className="shrink text-[15px]" numberOfLines={1}>
                  {item}
                </Text>
              </TapPressable>
              <TapPressable
                onPress={() => recentSearches.remove(item)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item} from recent searches`}
                hitSlop={8}
                className="size-12 items-center justify-center active:opacity-70"
              >
                <Icon as={XIcon} className="text-muted-foreground size-4" />
              </TapPressable>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
