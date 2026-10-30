import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { SearchXIcon, TrophyIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { AchievementBadge } from '@/components/rally/achievements';
import { EmptyState } from '@/components/rally/empty-state';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { SectionHeader } from '@/components/rally/section-header';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { timeAgo } from '@/lib/format';
import { usePublicProfile, usePublicStats, useUserAchievements, type UnlockedAchievement } from '@/lib/game-progress';
import { GUTTER } from '@/lib/layout';
import { useProfile, type Profile } from '@/lib/profile';
import { formatScore, sameUsername } from '@/lib/progress-format';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

/**
 * Public profile (`/u/:username`, the architecture's deep link): avatar, names, bio, two stats
 * (`public_profile_stats`) and what the player has unlocked across games. Your own username redirects to `/profile`.
 * Portrait: one centred column. Landscape: identity on the left, the achievements list scrolling on the right.
 */
export default function PublicProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { userId } = useSession();
  const { landscape, insets, width } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const me = useProfile();
  const profile = usePublicProfile(username);
  const p = profile.data;
  const stats = usePublicStats(p?.id);
  const unlocked = useUserAchievements(p?.id);
  const [refreshing, setRefreshing] = useState(false);

  if (sameUsername(username, me.data?.username) || (p && p.id === userId)) return <Redirect href="/profile" />;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([profile.refetch(), stats.refetch(), unlocked.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  const title = <Stack.Screen options={{ title: p ? `@${p.username}` : 'Player' }} />;
  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      tintColor={palette.foreground}
      colors={[palette.foreground]}
      progressBackgroundColor={palette.card}
    />
  );

  if (!profile.isLoading && !p) {
    return (
      <View className="bg-background flex-1 justify-center" style={column}>
        {title}
        <EmptyState
          icon={SearchXIcon}
          title={profile.isError ? "Couldn't load this player" : 'Player not found'}
          body={
            profile.isError
              ? 'Check your connection and try again.'
              : `There's no Rally player called @${username ?? ''}.`
          }
          className="w-full"
          action={
            <Button variant="secondary" onPress={() => (profile.isError ? void profile.refetch() : router.back())}>
              <Text>{profile.isError ? 'Try again' : 'Back'}</Text>
            </Button>
          }
        />
      </View>
    );
  }

  const identity = <Identity profile={p} stats={stats.data} statsLoading={stats.isLoading} />;
  const list = (
    <Unlocked items={unlocked.data} loading={profile.isLoading || unlocked.isLoading} error={unlocked.isError} />
  );

  if (landscape) {
    const left = Math.round((width - insets.left - insets.right) * 0.4);
    return (
      <View className="bg-background flex-1 flex-row" style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
        {title}
        <ScrollView
          style={{ width: left, flexGrow: 0 }}
          contentContainerClassName="gap-5 pt-4"
          contentContainerStyle={{ paddingLeft: GUTTER, paddingRight: 12, paddingBottom: insets.bottom + 24 }}
        >
          {identity}
        </ScrollView>
        <ScrollView
          className="flex-1"
          contentContainerClassName="pt-4"
          contentContainerStyle={{ paddingLeft: 12, paddingRight: GUTTER, paddingBottom: insets.bottom + 24 }}
          refreshControl={refreshControl}
        >
          {list}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-4"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={refreshControl}
    >
      {title}
      {identity}
      {list}
    </ScrollView>
  );
}

function Identity({
  profile: p,
  stats,
  statsLoading,
}: {
  profile: Profile | null | undefined;
  stats: { achievements: number; gamesPlayed: number } | undefined;
  statsLoading: boolean;
}) {
  return (
    <View className="items-center gap-4">
      <ProfileAvatar profile={p} size="xl" ring />
      {p ? (
        <View className="items-center gap-1">
          <Text className="text-center text-[26px] font-extrabold leading-8 tracking-tight">
            {p.display_name || p.username}
          </Text>
          <Text className="text-muted-foreground text-[15px] font-medium">@{p.username}</Text>
        </View>
      ) : (
        <View className="items-center gap-2">
          <Skeleton className="h-7 w-40 rounded-lg" />
          <Skeleton className="h-4 w-24 rounded-full" />
        </View>
      )}
      {p?.bio ? <Text className="text-secondary-foreground max-w-sm text-center leading-6">{p.bio}</Text> : null}
      <View className="w-full max-w-sm flex-row gap-3">
        <Stat label="Achievements" value={stats?.achievements} loading={!p || statsLoading} />
        <Stat label="Games played" value={stats?.gamesPlayed} loading={!p || statsLoading} />
      </View>
    </View>
  );
}

function Stat({ label, value, loading }: { label: string; value: number | undefined; loading: boolean }) {
  return (
    <View className="bg-card border-border flex-1 items-center gap-1 rounded-2xl border px-3 py-3">
      {loading ? (
        <Skeleton className="h-7 w-10 rounded-lg" />
      ) : (
        <Text className="text-[22px] font-extrabold">{formatScore(value ?? 0)}</Text>
      )}
      <Text variant="muted" className="text-[13px]">
        {label}
      </Text>
    </View>
  );
}

function Unlocked({
  items,
  loading,
  error,
}: {
  items: UnlockedAchievement[] | undefined;
  loading: boolean;
  error: boolean;
}) {
  return (
    <View className="gap-3">
      <SectionHeader
        title="Achievements"
        detail={items && items.length > 0 ? formatScore(items.length) : undefined}
        className="px-0"
      />
      {loading ? (
        <View className="bg-card border-border gap-3 rounded-2xl border p-4">
          {[0, 1, 2].map((i) => (
            <View key={i} className="flex-row items-center gap-3">
              <Skeleton className="size-10 rounded-xl" />
              <View className="flex-1 gap-1.5">
                <Skeleton className="h-4 w-2/3 rounded-full" />
                <Skeleton className="h-3 w-1/3 rounded-full" />
              </View>
            </View>
          ))}
        </View>
      ) : error ? (
        <EmptyState compact icon={TrophyIcon} title="Couldn't load achievements" body="Pull down to try again." />
      ) : !items || items.length === 0 ? (
        <EmptyState
          compact
          icon={TrophyIcon}
          title="No achievements yet"
          body="Unlocked achievements from every game show up here."
        />
      ) : (
        <View className="bg-card border-border overflow-hidden rounded-2xl border">
          {items.map((a, i) => (
            <View key={a.id}>
              {i > 0 && <Separator className="ml-[68px]" />}
              <Pressable
                disabled={!a.game}
                onPress={() => a.game && router.push({ pathname: '/game/[id]', params: { id: a.game.id } })}
                accessibilityRole={a.game ? 'button' : undefined}
                className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
              >
                <AchievementBadge icon={a.icon} locked={false} size={40} />
                <View className="shrink grow gap-0.5">
                  <Text className="text-[15px] font-semibold" numberOfLines={1}>
                    {a.title}
                  </Text>
                  <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
                    {[a.game?.title, timeAgo(a.unlockedAt)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
