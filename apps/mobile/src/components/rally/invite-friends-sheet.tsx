import { router } from 'expo-router';
import { UsersIcon } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useFriendsPresence, useMyFriends } from '@/lib/friends';
import { useInviteToParty, useParty, useSendRoomInvite } from '@/lib/party';
import { INVITE_SENT_MS, inviteCandidates, partyHasRoom } from '@/lib/party-model';
import { presenceRow, type FriendSummary, type PresenceRowModel } from '@/lib/social';
import { usePalette } from '@/lib/use-palette';
import { useViewport } from '@/lib/viewport';
import { SHEET_ORIENTATIONS } from '@/game-host/orientation';
import { BottomSheet, SheetScrollView } from './bottom-sheet';
import { PlayerName } from './cosmetics';
import { EmptyState } from './empty-state';
import { PersonList, PersonListSkeleton } from './person-row';
import { PresenceDot } from './presence-dot';
import { ProfileAvatar } from './profile-avatar';

/** Height kept free around the list: the grabber, title and description above it, the bottom padding below. */
const RESERVED_HEIGHT = 220;

/**
 * What an invite from this sheet does: `party` invites to the caller's party (`invite_to_party`, creating it first
 * when there is none); `room` invites into the running match (`send_room_invite`, the in-game menu's Invite friends
 * and the game's `invite.open`).
 */
export type InviteFriendsMode =
  { kind: 'party' } | { kind: 'room'; gameId: string; roomId: string; code: string | null };

/**
 * **Invite friends** (docs/social-phase.md §5): the caller's friends, online first, each with an **Invite** button that
 * reads "Sent" for ten seconds afterwards (the recipient's pending state is not known to the sender). In `party` mode
 * members of the party are left out and a full party disables the buttons. Rows do not open profiles (PersonRow
 * would navigate, which must not happen from inside a game). Rises over a running game too (SHEET_ORIENTATIONS).
 */
export function InviteFriendsSheet({
  open,
  onClose,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  mode: InviteFriendsMode;
}) {
  const title = mode.kind === 'party' ? 'Invite to your party' : 'Invite friends';
  const description =
    mode.kind === 'party'
      ? 'Friends join your party and play with you from game to game.'
      : 'Friends get an invite to this match.';
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      supportedOrientations={SHEET_ORIENTATIONS}
    >
      {open ? <InviteList mode={mode} inGame={mode.kind === 'room'} /> : null}
    </BottomSheet>
  );
}

function InviteList({ mode, inGame }: { mode: InviteFriendsMode; inGame: boolean }) {
  const { height } = useViewport();
  const palette = usePalette();
  const friends = useMyFriends();
  const presence = useFriendsPresence(true);
  const party = useParty();
  const toParty = useInviteToParty();
  const toRoom = useSendRoomInvite();
  // Who was invited from this sheet, and when; an entry is dropped INVITE_SENT_MS later ("Sent" until then).
  const [sent, setSent] = useState<Record<string, number>>({});
  const oldest = Object.values(sent).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (oldest === undefined) return;
    const timer = setTimeout(
      () => setSent((s) => Object.fromEntries(Object.entries(s).filter(([, at]) => at > Date.now() - INVITE_SENT_MS))),
      Math.max(0, oldest + INVITE_SENT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [oldest]);

  const candidates = inviteCandidates(friends.data, mode.kind === 'party' ? party.data : null, presence.data);
  const full = mode.kind === 'party' && !partyHasRoom(party.data);
  const busyId = toParty.isPending ? toParty.variables : toRoom.isPending ? toRoom.variables?.userId : undefined;

  const invite = (f: FriendSummary) => {
    const done = () => setSent((s) => ({ ...s, [f.userId]: Date.now() }));
    if (mode.kind === 'party') toParty.mutate(f.userId, { onSuccess: done });
    else
      toRoom.mutate(
        { userId: f.userId, gameId: mode.gameId, roomId: mode.roomId, code: mode.code },
        { onSuccess: done },
      );
  };

  if (friends.isLoading) return <PersonListSkeleton count={3} accessory />;
  if (candidates.length === 0) {
    return (
      <EmptyState
        icon={UsersIcon}
        title={friends.data && friends.data.length > 0 ? 'Everyone is already here' : 'No friends to invite yet'}
        body={
          friends.data && friends.data.length > 0
            ? 'All your friends are in the party.'
            : 'Add friends first: they show up here.'
        }
        action={
          inGame ? undefined : (
            <Button variant="secondary" onPress={() => router.push({ pathname: '/search', params: { q: '@' } })}>
              <Text>Find players</Text>
            </Button>
          )
        }
      />
    );
  }
  return (
    <View className="gap-3">
      {full ? (
        <Text variant="muted" className="text-center text-[13px] leading-[18px]" accessibilityLiveRegion="polite">
          Your party is full.
        </Text>
      ) : null}
      <SheetScrollView
        style={{ maxHeight: Math.max(160, height - RESERVED_HEIGHT) }}
        showsVerticalScrollIndicator={false}
      >
        <PersonList
          items={candidates}
          keyOf={(f) => f.userId}
          render={(f) => {
            const row = presenceRow(presence.data?.get(f.userId), `@${f.username}`);
            const wasSent = sent[f.userId] !== undefined;
            const busy = busyId === f.userId;
            return (
              <InviteRow friend={f} presence={row}>
                <Button
                  size="sm"
                  variant={wasSent ? 'outline' : 'default'}
                  className="h-8 min-w-[72px] rounded-full px-3.5"
                  disabled={busy || wasSent || full}
                  onPress={() => invite(f)}
                  accessibilityLabel={wasSent ? `Invite sent to @${f.username}` : `Invite @${f.username}`}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={palette.primaryForeground} />
                  ) : (
                    <Text className="text-[13px]">{wasSent ? 'Sent' : 'Invite'}</Text>
                  )}
                </Button>
              </InviteRow>
            );
          }}
        />
      </SheetScrollView>
    </View>
  );
}

/** A friend's row inside the sheet: avatar, name, "@name · Online" (PersonRow's look without its navigation). */
function InviteRow({
  friend: f,
  presence,
  children,
}: {
  friend: FriendSummary;
  presence: PresenceRowModel | null;
  children: ReactNode;
}) {
  const name = f.displayName || f.username;
  return (
    <View
      className="min-h-16 flex-row items-center gap-3 px-4 py-2.5"
      accessible
      accessibilityLabel={presence ? `${name}, @${f.username}, ${presence.label}` : `${name}, @${f.username}`}
    >
      <ProfileAvatar
        userId={f.userId}
        profile={{ username: f.username, display_name: f.displayName, avatar_url: f.avatarUrl }}
        size="md"
      />
      <View className="shrink grow">
        <PlayerName userId={f.userId} name={name} className="text-[15px] font-semibold leading-5" />
        <View className="flex-row items-center">
          <Text className="text-muted-foreground shrink text-[13px] leading-[18px]" numberOfLines={1}>
            {presence ? `@${f.username} · ` : `@${f.username}`}
          </Text>
          {presence ? (
            <>
              <PresenceDot className="mr-1.5" />
              <Text className="text-foreground shrink text-[13px] font-medium leading-[18px]" numberOfLines={1}>
                {presence.label}
              </Text>
            </>
          ) : null}
        </View>
      </View>
      {children}
    </View>
  );
}
