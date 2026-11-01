import { router } from 'expo-router';
import { memo, useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, View, type ListRenderItem } from 'react-native';
import { Button } from '@/components/ui/button';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useAllGames, type GameCard } from '@/lib/catalog';
import { useFriendsPresence, useMyFriends } from '@/lib/friends';
import { coverUriFor } from '@/lib/game-art';
import { ROW_GAP, snapInterval } from '@/lib/layout';
import { friendsPlayingNow, type FriendPlaying, type FriendSummary } from '@/lib/social';
import type { GameLauncher } from '@/lib/use-launch-game';
import { usePalette } from '@/lib/use-palette';
import { PlayerName } from './cosmetics';
import { GameCover } from './game-cover';
import { openPerson } from './person-row';
import { PresenceDot } from './presence-dot';
import { ProfileAvatar } from './profile-avatar';
import { SectionHeader } from './section-header';

type Pad = { left: number; right: number };
type Row = FriendPlaying<FriendSummary, GameCard>;

/** Card width: about 1.4 cards across a phone, 3+ on a wide window. */
function cardWidth(pad: Pad, windowWidth: number) {
  const visible = windowWidth >= 700 ? 3.3 : 1.35;
  return Math.max(236, Math.min(300, Math.floor((windowWidth - pad.left - ROW_GAP) / visible)));
}

/**
 * Dashboard row "Friends playing now": one card per friend in a game right now (`friends_presence`, the server's
 * mirror confirms the seat): the game's tile art with the friend's avatar on its corner, their name, the game, and
 * **Join** when the room has a free seat (`useLaunchGame` → `join=friend`, the same path as the Friends screen: the
 * play route asks `friend_join_target` for the room). Joinable rooms first. Hidden when nobody is playing. A tap on a
 * card opens the friend's profile, a tap on the art the game page. Presence polls every 30 s while `live`.
 */
export function FriendsPlayingRow({
  pad,
  width,
  launcher,
  live,
}: {
  pad: Pad;
  /** The window width (cards are sized from it). */
  width: number;
  /** The screen's launcher (its consent dialog and pending state). */
  launcher: GameLauncher;
  live: boolean;
}) {
  const friends = useMyFriends();
  const presence = useFriendsPresence(live);
  const catalog = useAllGames();
  const [joining, setJoining] = useState<string | null>(null);
  const rows = friendsPlayingNow(friends.data, presence.data, catalog.data);
  const w = cardWidth(pad, width);
  const busy = !!launcher.pending;
  const pendingFriend = launcher.pending?.join === 'friend' ? joining : null;

  const join = useCallback(
    (row: Row) => {
      setJoining(row.friend.userId);
      launcher.launch(
        { id: row.presence.gameId, title: row.game?.title ?? row.presence.gameTitle ?? 'this game' },
        { join: 'friend', friend: row.friend.userId },
      );
    },
    [launcher],
  );
  const renderItem = useCallback<ListRenderItem<Row>>(
    ({ item }) => (
      <FriendPlayingCard
        row={item}
        width={w}
        disabled={busy}
        spinning={pendingFriend === item.friend.userId}
        onJoin={join}
      />
    ),
    [w, busy, pendingFriend, join],
  );

  if (rows.length === 0) return null;
  const padStyle = { paddingLeft: pad.left, paddingRight: pad.right };
  const notice =
    launcher.notice && rows.some((r) => r.presence.gameId === launcher.notice?.gameId) ? launcher.notice.message : null;
  return (
    <View className="gap-3">
      <SectionHeader
        title="Friends playing now"
        detail={rows.length > 1 ? String(rows.length) : undefined}
        style={padStyle}
      />
      <FlatList
        horizontal
        data={rows}
        keyExtractor={(r) => r.friend.userId}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={padStyle}
        ItemSeparatorComponent={Gap}
        snapToInterval={snapInterval(w)}
        snapToAlignment="start"
        decelerationRate="fast"
      />
      {notice ? (
        <Text variant="muted" className="text-[13px]" style={padStyle} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

function Gap() {
  return <View style={{ width: ROW_GAP }} />;
}

/** Art (with the avatar on its corner), name, "● Sumo", Join / Full. */
export const FriendPlayingCard = memo(function FriendPlayingCard({
  row,
  width,
  disabled,
  spinning,
  onJoin,
}: {
  row: Row;
  width: number;
  disabled: boolean;
  spinning: boolean;
  onJoin: (row: Row) => void;
}) {
  const palette = usePalette();
  const { friend, presence, game } = row;
  const name = friend.displayName || friend.username;
  const title = game?.title ?? presence.gameTitle ?? 'a game';
  return (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, playing ${title}${presence.joinable ? '' : ', room full'}`}
      accessibilityHint="Opens the profile"
      onPress={() => openPerson(friend.username)}
      className="bg-card border-border active:bg-accent flex-row items-center gap-3 rounded-2xl border p-3"
      style={{ width }}
    >
      <TapPressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${title}`}
        onPress={() => router.push({ pathname: '/game/[id]', params: { id: presence.gameId } })}
        className="active:opacity-70"
        hitSlop={4}
      >
        <GameCover
          id={presence.gameId}
          title={title}
          uri={game ? coverUriFor(game, 'tile') : null}
          showTitle={false}
          className="border-border size-[60px] rounded-xl border"
        />
        <View className="bg-card absolute -bottom-1.5 -right-1.5 rounded-full p-[3px]">
          <ProfileAvatar
            userId={friend.userId}
            profile={{ username: friend.username, display_name: friend.displayName, avatar_url: friend.avatarUrl }}
            size="sm"
          />
        </View>
      </TapPressable>
      <View className="shrink grow gap-0.5 pl-1">
        <PlayerName userId={friend.userId} name={name} className="text-[15px] font-semibold leading-5" />
        <View className="flex-row items-center gap-1.5">
          <PresenceDot />
          <Text className="text-muted-foreground shrink text-[13px] leading-[18px]" numberOfLines={1}>
            {title}
          </Text>
        </View>
      </View>
      {presence.joinable ? (
        <Button
          size="sm"
          className="h-8 min-w-16 rounded-full px-3.5"
          disabled={disabled}
          onPress={() => onJoin(row)}
          accessibilityLabel={`Join ${name} in ${title}`}
        >
          {spinning ? (
            <ActivityIndicator size="small" color={palette.primaryForeground} />
          ) : (
            <Text className="text-[13px]">Join</Text>
          )}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 min-w-16 rounded-full px-3.5"
          disabled
          accessibilityLabel="Room full"
        >
          <Text className="text-[13px]">Full</Text>
        </Button>
      )}
    </TapPressable>
  );
});
