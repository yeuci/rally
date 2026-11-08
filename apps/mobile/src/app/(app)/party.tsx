import { PARTY_MAX_SIZE } from '@rally/db';
import { router, useIsFocused } from 'expo-router';
import {
  CircleAlertIcon,
  CrownIcon,
  EllipsisIcon,
  LogOutIcon,
  MessageCircleIcon,
  PlayIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, View } from 'react-native';
import { ConfirmDialog } from '@/components/rally/confirm-dialog';
import { LaunchConsentDialog } from '@/components/rally/consent-dialog';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { InviteFriendsSheet } from '@/components/rally/invite-friends-sheet';
import { PersonList, PersonListSkeleton, PersonRow, type PersonPresence } from '@/components/rally/person-row';
import { SectionHeader } from '@/components/rally/section-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useAllGames } from '@/lib/catalog';
import { useCreateParty, useKickFromParty, useLeaveParty, useParty, useTransferPartyLead } from '@/lib/party';
import {
  describePartyError,
  isLeader,
  launchLine,
  leaveCopy,
  memberName,
  orderedMembers,
  partyHasRoom,
  type PartyMember,
} from '@/lib/party-model';
import { noticeFor, useLaunchGame } from '@/lib/use-launch-game';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';

/** A member's presence line ("Online", "In Sumo"); offline members show their @username only. */
function memberPresence(m: PartyMember, titleOf: (gameId: string) => string | null): PersonPresence | null {
  if (m.status === 'in_game' && m.game_id) return { label: `In ${titleOf(m.game_id) ?? 'a game'}`, tone: 'in_game' };
  if (m.status === 'online') return { label: 'Online', tone: 'online' };
  return null;
}

/**
 * The party (`/party`, from the party bar; docs/social-phase.md §5): its members (leader first, with a Leader badge,
 * each with their presence; `my_party`, refreshed every 30 s while in front and on every party event), the leader's
 * ⋯ menu on the others (Make leader, Remove from party, confirmed), **Invite friends** (a sheet of friends not in the
 * party, online first, Invite → `invite_to_party`, "Sent" for 10 s), **Party chat** (→ `/messages/[id]` with the
 * party's conversation) and **Leave party** (confirmed; the leader is told who takes over). While the leader's launch
 * is live and the caller is not in it: "Playing Sumo" with **Join** (→ `join=party&launch=<id>`). Not in a party:
 * Start a party.
 */
export default function PartyScreen() {
  const { userId } = useSession();
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const focused = useIsFocused();
  const party = useParty(focused);
  const catalog = useAllGames();
  const launcher = useLaunchGame();
  const create = useCreateParty();
  const leave = useLeaveParty();
  const kick = useKickFromParty();
  const transfer = useTransferPartyLead();
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [kicking, setKicking] = useState<PartyMember | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const p = party.data;
  const me = userId ?? '';
  const leads = isLeader(p, userId);
  const titleOf = (gameId: string) => catalog.data?.find((g) => g.id === gameId)?.title ?? null;

  async function refresh() {
    setRefreshing(true);
    try {
      await party.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  const openMemberMenu = (m: PartyMember) => {
    const name = memberName(m);
    const items = [
      { label: `Make ${name} the leader`, destructive: false, run: () => transfer.mutate(m.user_id) },
      { label: `Remove ${name} from the party`, destructive: true, run: () => setKicking(m) },
    ];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...items.map((it) => it.label), 'Cancel'],
          destructiveButtonIndex: 1,
          cancelButtonIndex: items.length,
        },
        (i) => items[i]?.run(),
      );
    } else {
      Alert.alert(name, undefined, [
        { text: 'Cancel', style: 'cancel' },
        ...items.map((it) => ({
          text: it.label,
          style: it.destructive ? ('destructive' as const) : ('default' as const),
          onPress: it.run,
        })),
      ]);
    }
  };

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      tintColor={palette.foreground}
      colors={[palette.foreground]}
      progressBackgroundColor={palette.card}
    />
  );

  if (party.isLoading) {
    return (
      <View className="bg-background flex-1 pt-4" style={column}>
        <PersonListSkeleton count={3} accessory />
      </View>
    );
  }
  if (party.isError && !p) {
    return (
      <View className="bg-background flex-1 justify-center" style={column}>
        <EmptyState
          icon={CircleAlertIcon}
          title="Couldn't load your party"
          body={describePartyError(party.error)}
          action={<RetryButton onPress={() => void party.refetch()} />}
        />
      </View>
    );
  }
  if (!p) {
    return (
      <ScrollView
        className="bg-background flex-1"
        contentContainerClassName="flex-grow justify-center"
        contentContainerStyle={column}
        refreshControl={refreshControl}
      >
        <EmptyState
          icon={UsersIcon}
          title="You're not in a party"
          body="Start one and invite friends: you play together from game to game."
          action={
            <Button disabled={create.isPending} onPress={() => create.mutate()}>
              {create.isPending ? <ActivityIndicator color={palette.primaryForeground} /> : null}
              <Text>Start a party</Text>
            </Button>
          }
        />
      </ScrollView>
    );
  }

  const members = orderedMembers(p);
  const live = launchLine(p, me);
  const copy = leaveCopy(p, me);
  const pendingJoin = launcher.pending?.join === 'party';

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-4"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={refreshControl}
    >
      {live ? (
        <View
          className="bg-card border-border flex-row items-center gap-3 rounded-2xl border p-4"
          accessible={!live.join}
        >
          <View className="bg-subtle border-subtle-line size-11 items-center justify-center rounded-xl border">
            <Icon as={PlayIcon} className="text-foreground size-5" />
          </View>
          <View className="shrink grow">
            <Text className="text-[15px] font-semibold leading-5">{live.label}</Text>
            <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={2}>
              {noticeFor(launcher, live.join?.gameId) ??
                (live.join ? 'Your party is in a match.' : "You're in this match.")}
            </Text>
          </View>
          {live.join ? (
            <Button
              size="sm"
              className="h-8 min-w-16 rounded-full px-3.5"
              disabled={!!launcher.pending}
              onPress={() =>
                live.join &&
                launcher.launch(
                  { id: live.join.gameId, title: live.join.gameTitle },
                  { join: 'party', launch: live.join.launchId },
                )
              }
              accessibilityLabel={`Join your party in ${live.join.gameTitle}`}
            >
              {pendingJoin ? (
                <ActivityIndicator size="small" color={palette.primaryForeground} />
              ) : (
                <Text className="text-[13px]">Join</Text>
              )}
            </Button>
          ) : null}
        </View>
      ) : null}

      <View className="gap-3">
        <SectionHeader title="Members" detail={`${p.members.length} / ${PARTY_MAX_SIZE}`} className="px-0" />
        <PersonList
          items={members}
          keyOf={(m) => m.user_id}
          render={(m) => {
            const leader = m.user_id === p.leader_id;
            return (
              <PersonRow
                person={{
                  userId: m.user_id,
                  username: m.username,
                  displayName: m.display_name,
                  avatarUrl: m.avatar_url,
                }}
                presence={memberPresence(m, titleOf)}
                self={m.user_id === me}
                accessory={
                  <View className="flex-row items-center gap-2">
                    {leader ? (
                      <Badge variant="subtle" accessibilityLabel="Party leader">
                        <Icon as={CrownIcon} className="text-gold size-3" />
                        <Text>Leader</Text>
                      </Badge>
                    ) : null}
                    {leads && m.user_id !== me ? (
                      <TapPressable
                        onPress={() => openMemberMenu(m)}
                        accessibilityRole="button"
                        accessibilityLabel={`Options for ${memberName(m)}`}
                        hitSlop={8}
                        className="size-8 items-center justify-center rounded-full active:opacity-70"
                      >
                        <Icon as={EllipsisIcon} className="text-muted-foreground size-5" />
                      </TapPressable>
                    ) : null}
                  </View>
                }
              />
            );
          }}
        />
        {leads ? null : (
          <Text variant="muted" className="px-1 text-[13px] leading-[18px]">
            {`${memberName(members[0])} leads the party and starts the games.`}
          </Text>
        )}
      </View>

      <View className="gap-2">
        <Button size="lg" className="h-12 rounded-2xl" disabled={!partyHasRoom(p)} onPress={() => setInviting(true)}>
          <Icon as={UserPlusIcon} className="text-primary-foreground size-[18px]" />
          <Text className="text-[16px] font-bold">{partyHasRoom(p) ? 'Invite friends' : 'The party is full'}</Text>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          className="h-12 rounded-2xl"
          onPress={() => router.push({ pathname: '/messages/[id]', params: { id: p.conversation_id } })}
        >
          <Icon as={MessageCircleIcon} className="text-secondary-foreground size-[18px]" />
          <Text>Party chat</Text>
        </Button>
        <Button
          variant="ghost"
          size="lg"
          className="h-12 rounded-2xl"
          disabled={leave.isPending}
          onPress={() => setLeaving(true)}
        >
          <Icon as={LogOutIcon} className="text-destructive size-[18px]" />
          <Text className="text-destructive">Leave party</Text>
        </Button>
      </View>

      <InviteFriendsSheet open={inviting} onClose={() => setInviting(false)} mode={{ kind: 'party' }} />
      <ConfirmDialog
        open={leaving}
        onOpenChange={(open) => !open && setLeaving(false)}
        title={copy.title}
        body={copy.body}
        action={copy.action}
        destructive
        onConfirm={() => {
          setLeaving(false);
          leave.mutate(undefined, { onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/')) });
        }}
      />
      <ConfirmDialog
        open={!!kicking}
        onOpenChange={(open) => !open && setKicking(null)}
        title={kicking ? `Remove ${memberName(kicking)}?` : 'Remove from the party?'}
        body="They leave the party and its chat. You can invite them again later."
        action="Remove"
        destructive
        onConfirm={() => {
          const target = kicking;
          setKicking(null);
          if (target) kick.mutate(target.user_id);
        }}
      />
      <LaunchConsentDialog launcher={launcher} />
    </ScrollView>
  );
}
