import { useQuery } from '@tanstack/react-query';
import { Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import {
  ChevronRightIcon,
  CircleAlertIcon,
  ServerCrashIcon,
  UsersIcon,
  WifiOffIcon,
  ZapIcon,
} from 'lucide-react-native';
import { useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { LaunchConsentDialog } from '@/components/rally/consent-dialog';
import { EmptyState } from '@/components/rally/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { listRooms, RoomLookupError } from '@/game-host/matchmake';
import { useGame } from '@/lib/catalog';
import { useLaunchPlan } from '@/lib/launch';
import { openRoomsLabel, roomRows, roomsKeys, type RoomRow } from '@/lib/rooms';
import { noticeFor, useLaunchGame } from '@/lib/use-launch-game';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/** How often the open list refreshes while the screen is in front (m3-phase2 §1). */
const ROOMS_REFRESH_MS = 5000;

/**
 * Server browser (`/game/:id/rooms`, multiplayer games with the `browser` mode): the game's public rooms from
 * `GET /rooms/<manifest.server.room>`, refreshed every 5 s while in front and on pull. Rooms on a server older than
 * `manifest.server.minVersion` are hidden; full rooms stay listed, dimmed. A tap joins that room by id
 * (`join=room&room=<id>` through `useLaunchGame`). Empty: "No open rooms. Quick play starts one."
 */
export default function RoomsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const focused = useIsFocused();
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const game = useGame(id);
  const plan = useLaunchPlan(id);
  const launcher = useLaunchGame();
  const [refreshing, setRefreshing] = useState(false);
  const [tapped, setTapped] = useState<string | null>(null);

  const server = plan.data?.status === 'ready' ? (plan.data.manifest.server ?? null) : null;
  const rooms = useQuery({
    queryKey: roomsKeys.list(config.colyseusUrl, server?.room ?? ''),
    enabled: !!server,
    queryFn: ({ signal }) => listRooms(config.colyseusUrl, server!.room, { signal }),
    // Only while this screen is in front (not under the game it launched); React Query also pauses in the background.
    refetchInterval: focused ? ROOMS_REFRESH_MS : false,
    retry: 1,
  });

  const g = game.data;
  const title = g?.title ?? 'this game';
  const rows = rooms.data ? roomRows(rooms.data, server?.minVersion ?? 0) : [];
  const notice = noticeFor(launcher, id);
  const errorCode = rooms.error instanceof RoomLookupError ? rooms.error.code : null;
  const offline = errorCode === 'UNREACHABLE';

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([plan.refetch(), server ? rooms.refetch() : null]);
    } finally {
      setRefreshing(false);
    }
  }

  const join = (row: RoomRow) => {
    if (!row.joinable || !id) return;
    setTapped(row.roomId);
    launcher.launch({ id, title }, { join: 'room', room: row.roomId });
  };
  const quickPlay = () => id && launcher.launch({ id, title }, { join: 'quick' });
  const quickPlayButton = (
    <Button onPress={quickPlay} disabled={!!launcher.pending}>
      {launcher.pending?.join === 'quick' ? (
        <ActivityIndicator color={palette.primaryForeground} />
      ) : (
        <Icon as={ZapIcon} className="text-primary-foreground size-4" />
      )}
      <Text>Quick play</Text>
    </Button>
  );

  const header = <Stack.Screen options={{ title: g ? `${g.title} rooms` : 'Rooms' }} />;

  // Before the first list: the plan, then the rooms.
  const loading = plan.isLoading || (!!server && rooms.isLoading);
  let empty: ReactElement | undefined;
  if (plan.data && plan.data.status !== 'ready') {
    empty = (
      <EmptyState
        icon={CircleAlertIcon}
        title="Rooms aren't available"
        body={
          plan.data.status === 'unavailable'
            ? plan.data.message
            : `Update Rally to version ${plan.data.minAppVersion} or later to play this game.`
        }
      />
    );
  } else if (plan.isError || (plan.data && !server)) {
    empty = (
      <EmptyState
        icon={CircleAlertIcon}
        title="Rooms aren't available"
        body={plan.isError ? "Couldn't load this game. Pull to try again." : `${title} has no rooms to browse.`}
      />
    );
  } else if (rooms.isError && !rooms.data) {
    empty = (
      <EmptyState
        icon={offline ? WifiOffIcon : ServerCrashIcon}
        title={offline ? "Can't reach the game server" : "Couldn't load rooms"}
        body={
          errorCode === 'RATE_LIMITED'
            ? 'Too many requests. Wait a minute and try again.'
            : offline
              ? 'Check your connection. The list retries every few seconds.'
              : 'Something went wrong on the game server. Try again in a moment.'
        }
        action={
          <Button variant="secondary" onPress={() => void refresh()}>
            <Text>Try again</Text>
          </Button>
        }
      />
    );
  } else if (rooms.data) {
    empty = (
      <EmptyState icon={UsersIcon} title="No open rooms." body="Quick play starts one." action={quickPlayButton} />
    );
  }

  return (
    <>
      {header}
      <FlatList
        className="bg-background flex-1"
        data={loading ? [] : rows}
        keyExtractor={(r) => r.roomId}
        contentContainerClassName="pt-4"
        contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={palette.foreground}
            colors={[palette.foreground]}
            progressBackgroundColor={palette.card}
          />
        }
        ListHeaderComponent={
          <View className="gap-3 pb-3">
            {notice ? <Notice text={notice} /> : null}
            {rooms.isError && rooms.data ? (
              <Notice
                text={offline ? "Can't reach the game server. Showing the last list." : "Couldn't refresh the list."}
              />
            ) : null}
            {!loading && rows.length > 0 ? (
              <View className="flex-row items-center justify-between gap-3">
                <Text variant="muted" accessibilityLiveRegion="polite">
                  {openRoomsLabel(rows)}
                </Text>
                {quickPlayButton}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={loading ? <RoomListSkeleton /> : empty}
        renderItem={({ item, index }) => (
          <View>
            {index > 0 && <Separator className="ml-4" />}
            <RoomListRow
              row={item}
              first={index === 0}
              last={index === rows.length - 1}
              joining={!!launcher.pending && tapped === item.roomId}
              disabled={!!launcher.pending}
              spinnerColor={palette.foreground}
              onPress={() => join(item)}
            />
          </View>
        )}
      />
      <LaunchConsentDialog launcher={launcher} />
    </>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <View className="flex-row items-center gap-1.5 px-1" accessibilityLiveRegion="polite">
      <Icon as={CircleAlertIcon} className="text-muted-foreground size-4" />
      <Text variant="muted" className="shrink">
        {text}
      </Text>
    </View>
  );
}

/** One room: name, "3/8" and the phase badge; a full room is dimmed and not pressable. Rows form one card. */
function RoomListRow({
  row,
  first,
  last,
  joining,
  disabled,
  spinnerColor,
  onPress,
}: {
  row: RoomRow;
  first: boolean;
  last: boolean;
  joining: boolean;
  disabled: boolean;
  spinnerColor: string;
  onPress: () => void;
}) {
  return (
    <TapPressable
      onPress={onPress}
      disabled={disabled || !row.joinable}
      accessibilityRole="button"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityHint={row.joinable ? 'Joins this room' : undefined}
      accessibilityState={{ disabled: disabled || !row.joinable, busy: joining }}
      className={cn(
        'bg-card border-border active:bg-accent flex-row items-center gap-3 border-x px-4 py-3.5',
        first && 'rounded-t-2xl border-t',
        last && 'rounded-b-2xl border-b',
      )}
    >
      <View className={cn('shrink grow gap-1', !row.joinable && 'opacity-50')}>
        <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
          {row.name}
        </Text>
        <View className="flex-row items-center gap-2">
          <Icon as={UsersIcon} className="text-muted-foreground size-3.5" />
          <Text className="text-muted-foreground text-[13px] tabular-nums leading-[18px]">
            {row.playersLabel}
            {row.joinable ? '' : ' · Full'}
          </Text>
          <Badge variant={row.phase === 'waiting' ? 'subtle' : 'outline'}>
            <Text>{row.phaseLabel}</Text>
          </Badge>
        </View>
      </View>
      {joining ? (
        <ActivityIndicator color={spinnerColor} />
      ) : row.joinable ? (
        <View className="flex-row items-center gap-1">
          <Text className="text-[15px] font-semibold">Join</Text>
          <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
        </View>
      ) : null}
    </TapPressable>
  );
}

function RoomListSkeleton() {
  return (
    <View className="bg-card border-border rounded-2xl border" accessibilityLabel="Loading rooms">
      {[0, 1, 2].map((i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-4" />}
          <View className="flex-row items-center gap-3 px-4 py-3.5">
            <View className="grow gap-1">
              <SkeletonText lineHeight={20} width={i === 1 ? 96 : 140} />
              <View className="flex-row items-center gap-2">
                <SkeletonText lineHeight={18} width={40} />
                <Skeleton className="h-[22px] w-16 rounded-full" />
              </View>
            </View>
            <SkeletonText lineHeight={20} width={36} />
          </View>
        </View>
      ))}
    </View>
  );
}
