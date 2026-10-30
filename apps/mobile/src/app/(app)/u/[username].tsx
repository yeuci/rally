import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { BanIcon, EllipsisIcon, SearchXIcon, TrophyIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { AchievementBadge } from '@/components/rally/achievements';
import { ConfirmDialog } from '@/components/rally/confirm-dialog';
import { EmptyState } from '@/components/rally/empty-state';
import { FriendButtons, FriendButtonsSkeleton } from '@/components/rally/friend-button';
import { FriendsRowSection, PlayedGamesSection, ProfileHeader, StatsStrip } from '@/components/rally/profile-sections';
import { SectionHeader } from '@/components/rally/section-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { timeAgo } from '@/lib/format';
import { useFriendship, useFriendshipAction, usePublicFriends, usePublicGames } from '@/lib/friends';
import { usePublicProfile, usePublicStats, useUserAchievements, type UnlockedAchievement } from '@/lib/game-progress';
import { GUTTER } from '@/lib/layout';
import { useProfile } from '@/lib/profile';
import { formatScore, sameUsername } from '@/lib/progress-format';
import { blockAction, confirmCopy, describeSocialError } from '@/lib/social';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

/**
 * Public profile (`/u/:username`, the architecture's deep link): avatar, names, bio, member since; the friendship
 * button(s) from `friendship_with`; Games played · Achievements · Friends (`public_profile_stats`); "Games played"
 * (`public_profile_games`) and "Friends" (`public_friends`), each shown only when the owner's privacy lets the viewer
 * see a non-empty list; unlocked achievements. Block / Unblock sit in the header's overflow menu. Your own username
 * redirects to `/profile`. Portrait: one centred column. Landscape: identity on the left, the lists on the right.
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
  const friendship = useFriendship(p?.id);
  const games = usePublicGames(p?.id);
  const friends = usePublicFriends(p?.id);
  const unlocked = useUserAchievements(p?.id);
  const action = useFriendshipAction();
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState<'block' | 'unblock' | null>(null);

  if (sameUsername(username, me.data?.username) || (p && p.id === userId)) return <Redirect href="/profile" />;

  const status = friendship.data;
  const blocked = status === 'blocked';
  const handle = p ? `@${p.username}` : 'this player';
  const menuAction = status ? blockAction(status) : null;

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([profile.refetch(), stats.refetch(), friendship.refetch(), games.refetch(), friends.refetch(), unlocked.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  function openMenu() {
    if (!menuAction) return;
    const label = menuAction === 'block' ? `Block ${handle}` : `Unblock ${handle}`;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [label, 'Cancel'], destructiveButtonIndex: menuAction === 'block' ? 0 : undefined, cancelButtonIndex: 1 },
        (i) => i === 0 && setConfirming(menuAction),
      );
    } else {
      Alert.alert(handle, undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: label, style: menuAction === 'block' ? 'destructive' : 'default', onPress: () => setConfirming(menuAction) },
      ]);
    }
  }

  const header = (
    <Stack.Screen
      options={{
        title: p ? `@${p.username}` : 'Player',
        headerRight: menuAction
          ? () => (
              <Pressable onPress={openMenu} accessibilityRole="button" accessibilityLabel="More" hitSlop={10} className="active:opacity-70">
                <Icon as={EllipsisIcon} className="text-foreground size-6" />
              </Pressable>
            )
          : undefined,
      }}
    />
  );
  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      tintColor={palette.foreground}
      colors={[palette.foreground]}
      progressBackgroundColor={palette.card}
    />
  );
  const copy = confirming && p ? confirmCopy(confirming, handle) : null;
  const confirm = copy && p && (
    <ConfirmDialog
      open={!!confirming}
      onOpenChange={(open) => !open && setConfirming(null)}
      title={copy.title}
      body={copy.body}
      action={copy.action}
      destructive={confirming === 'block'}
      onConfirm={() => {
        const intent = confirming;
        setConfirming(null);
        if (intent && status) {
          action.mutate(
            { userId: p.id, intent, current: status },
            { onError: (err) => Alert.alert("Couldn't update", describeSocialError(err)) },
          );
        }
      }}
    />
  );

  if (!profile.isLoading && !p) {
    return (
      <View className="bg-background flex-1 justify-center" style={column}>
        {header}
        <EmptyState
          icon={SearchXIcon}
          title={profile.isError ? "Couldn't load this player" : 'Player not found'}
          body={profile.isError ? 'Check your connection and try again.' : `There's no Rally player called @${username ?? ''}.`}
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

  const seeAllFriends = () => p && router.push({ pathname: '/friends', params: { username: p.username } });
  const identity = (
    <ProfileHeader profile={p}>
      {!p || friendship.isLoading ? (
        <FriendButtonsSkeleton mode="profile" />
      ) : status && !blocked ? (
        <FriendButtons userId={p.id} name={handle} status={status} mode="profile" />
      ) : null}
      <StatsStrip
        stats={stats.data}
        loading={!p || stats.isLoading}
        onFriendsPress={friends.data && friends.data.length > 0 ? seeAllFriends : undefined}
      />
    </ProfileHeader>
  );
  const lists = blocked ? (
    <EmptyState
      compact
      icon={BanIcon}
      title={`You blocked ${handle}`}
      body="Unblock them from the ⋯ menu to see their games and send requests again."
    />
  ) : (
    <>
      <PlayedGamesSection games={games.data} loading={!p || games.isLoading} error={games.isError} />
      <FriendsRowSection friends={friends.data} total={stats.data?.friends} loading={!p || friends.isLoading} onSeeAll={seeAllFriends} />
      <Unlocked items={unlocked.data} loading={!p || unlocked.isLoading} error={unlocked.isError} />
    </>
  );

  if (landscape) {
    const left = Math.round((width - insets.left - insets.right) * 0.4);
    return (
      <View className="bg-background flex-1 flex-row" style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
        {header}
        <ScrollView
          style={{ width: left, flexGrow: 0 }}
          contentContainerClassName="gap-5 pt-4"
          contentContainerStyle={{ paddingLeft: GUTTER, paddingRight: 12, paddingBottom: insets.bottom + 24 }}
        >
          {identity}
        </ScrollView>
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6 pt-4"
          contentContainerStyle={{ paddingLeft: 12, paddingRight: GUTTER, paddingBottom: insets.bottom + 24 }}
          refreshControl={refreshControl}
        >
          {lists}
        </ScrollView>
        {confirm}
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
      {header}
      {identity}
      {lists}
      {confirm}
    </ScrollView>
  );
}

/** Unlocked achievements across games, newest first; rows open the game. */
function Unlocked({ items, loading, error }: { items: UnlockedAchievement[] | undefined; loading: boolean; error: boolean }) {
  return (
    <View className="gap-3">
      <SectionHeader title="Achievements" detail={items && items.length > 0 ? formatScore(items.length) : undefined} className="px-0" />
      {loading ? (
        <View className="bg-card border-border overflow-hidden rounded-2xl border">
          {[0, 1, 2].map((i) => (
            <View key={i}>
              {i > 0 && <Separator className="ml-[68px]" />}
              <View className="flex-row items-center gap-3 px-4 py-3">
                <Skeleton className="size-10 rounded-xl" />
                <View className="flex-1">
                  <SkeletonText lineHeight={20} width={i % 2 ? '50%' : '66%'} />
                  <SkeletonText lineHeight={18} width="36%" />
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : error ? (
        <EmptyState compact icon={TrophyIcon} title="Couldn't load achievements" body="Pull down to try again." />
      ) : !items || items.length === 0 ? (
        <EmptyState compact icon={TrophyIcon} title="No achievements yet" body="Unlocked achievements from every game show up here." />
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
                <View className="shrink grow">
                  <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
                    {a.title}
                  </Text>
                  <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
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
