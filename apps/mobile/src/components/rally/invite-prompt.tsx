import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useGame } from '@/lib/catalog';
import { useAlertStyle } from '@/lib/friend-alerts';
import { alertPresentation } from '@/lib/friend-alerts-model';
import { socialKeys } from '@/lib/friends';
import { tapHaptic } from '@/lib/haptics';
import { inviteDetail, inviteLine, inviteTitle, type InviterProfile, type QueuedInvite } from '@/lib/invite-model';
import { useOtherSheetOpen, usePromptSlot } from '@/lib/open-sheets';
import { inviteBannerCountdown, inviteQueue, useInviteQueue, useRespondInvite } from '@/lib/party';
import { isGameScreen } from '@/lib/rejoin';
import { fetchRequestProfile } from '@/lib/social-realtime';
import { showToast } from '@/lib/toast';
import { useLaunchGame } from '@/lib/use-launch-game';
import { SHEET_ORIENTATIONS } from '@/game-host/orientation';
import { AlertBanner } from './alert-banner';
import { BottomSheet } from './bottom-sheet';
import { LaunchConsentDialog } from './consent-dialog';
import { PlayerName } from './cosmetics';
import { useSettled } from './friend-request-sheet';
import { ProfileAvatar } from './profile-avatar';

/** Queued invites are checked for expiry this often (they live ten minutes). */
const EXPIRY_TICK_MS = 15_000;

/**
 * "sloth invited you to their party" / "sloth invited you to Sumo": the sender's card, **Join** and **Not now**.
 * Presentational; InvitePrompt owns the queue and the answer.
 */
export function InviteSheet({
  invite,
  profile,
  gameTitle,
  busy,
  onJoin,
  onNotNow,
}: {
  invite: QueuedInvite | null;
  profile: InviterProfile | null;
  gameTitle: string | null;
  busy: boolean;
  onJoin: () => void;
  onNotNow: () => void;
}) {
  const shown = invite ? { ...invite, gameTitle: invite.gameTitle ?? gameTitle } : null;
  const detail = shown ? inviteDetail(shown) : null;
  return (
    <BottomSheet
      open={!!invite}
      onClose={onNotNow}
      title={invite ? inviteTitle(invite.kind) : 'Invite'}
      description={shown ? inviteLine(shown, profile?.username) : undefined}
      supportedOrientations={SHEET_ORIENTATIONS}
      register={false}
    >
      <View className="gap-4">
        <View
          className="bg-card border-border min-h-16 flex-row items-center gap-3 rounded-2xl border px-4 py-2.5"
          accessible
          accessibilityLabel={
            profile ? `${profile.displayName || profile.username}, @${profile.username}` : 'Loading the player'
          }
        >
          {profile ? (
            <>
              <ProfileAvatar
                userId={profile.userId}
                profile={{
                  username: profile.username,
                  display_name: profile.displayName,
                  avatar_url: profile.avatarUrl,
                }}
                size="md"
              />
              <View className="shrink grow">
                <PlayerName
                  userId={profile.userId}
                  name={profile.displayName || profile.username}
                  className="text-[15px] font-semibold leading-5"
                />
                <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
                  {detail ? `@${profile.username} · ${detail}` : `@${profile.username}`}
                </Text>
              </View>
            </>
          ) : (
            <>
              <Skeleton className="size-11 rounded-full" />
              <View className="shrink grow">
                <SkeletonText lineHeight={20} width="55%" />
                <SkeletonText lineHeight={18} width="35%" />
              </View>
            </>
          )}
        </View>
        <View className="flex-row gap-2">
          <Button
            variant="ghost"
            size="lg"
            className="h-12 flex-1 rounded-2xl"
            disabled={busy}
            onPress={onNotNow}
            accessibilityHint="Declines the invite"
          >
            <Text>Not now</Text>
          </Button>
          <Button size="lg" className="h-12 flex-1 rounded-2xl" disabled={busy} onPress={onJoin}>
            <Text className="text-[16px] font-bold">Join</Text>
          </Button>
        </View>
      </View>
    </BottomSheet>
  );
}

/**
 * The head of the invite queue (lib/party.ts `inviteQueue`: party and room invites from the `invite` broadcast and the
 * `my_invites()` catch-up), presented per Settings → Notifications exactly like friend requests
 * (FriendRequestPrompt, components/rally/friend-request-sheet.tsx: the same two placements, the same one-active-host
 * rule, the same settle waits): as this sheet, as a banner at the top (a tap expands it), or not at all (Off: consumed
 * silently; the invite stays pending on the server until it expires).
 *
 * - **Join** → `respond_invite(id, true)`. A party invite needs nothing more (the cached party changes and
 *   lib/party.ts `usePartyChannel` joins its topic); a room invite launches `join=room` with the room and code the
 *   answer carries (over a running game the play route is replaced).
 * - **Not now** (and the sheet's backdrop) → `respond_invite(id, false)`: the sender may invite again. A banner that
 *   times out or is swiped away only leaves the queue (still pending; catch-up does not bring it back in this run).
 * - `invite_closed` (accepted elsewhere, cancelled) dismisses it wherever it shows; expired invites drop off.
 */
export function InvitePrompt({ placement }: { placement: 'shell' | 'game' }) {
  const inGame = placement === 'game';
  const { userId } = useSession();
  const queue = useInviteQueue();
  const style = useAlertStyle(inGame);
  const gameOpen = isGameScreen(usePathname());
  const otherSheet = useOtherSheetOpen();
  const shellReady = useSettled(!gameOpen && !otherSheet, true);
  const gameReady = useSettled(true, false);
  const active = inGame ? gameReady : shellReady;
  const head = active ? (queue[0] ?? null) : null;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const presentation = head ? alertPresentation(style, expandedId === head.inviteId) : null;
  const invite = presentation && presentation !== 'silent' ? head : null;
  const respond = useRespondInvite();
  const launcher = useLaunchGame();

  // A room invite's launch that cannot start (unpublished, update required, offline) has no page to explain it on.
  const notice = launcher.notice?.message ?? null;
  useEffect(() => {
    if (notice) showToast(notice);
  }, [notice]);

  // Invites live ten minutes: an expired one leaves the queue (and the screen).
  useEffect(() => {
    if (queue.length === 0) return;
    const timer = setInterval(() => inviteQueue.expire(), EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, [queue.length]);

  // Off: nothing on screen; the invite is consumed (still pending on the server until it expires).
  const silentId = presentation === 'silent' && head ? head.inviteId : null;
  useEffect(() => {
    if (silentId) inviteQueue.dismiss(silentId);
  }, [silentId]);

  const needsProfile = !!invite && !invite.profile;
  const fetched = useQuery({
    queryKey: socialKeys.requestProfile(userId, invite?.fromId ?? ''),
    enabled: !!userId && needsProfile,
    staleTime: 5 * 60_000,
    queryFn: () => fetchRequestProfile(invite!.fromId),
  });
  const profile: InviterProfile | null = invite?.profile ?? fetched.data ?? null;
  const game = useGame(invite?.kind === 'room' && !invite.gameTitle ? (invite.gameId ?? undefined) : undefined);
  const gameTitle = invite?.gameTitle ?? game.data?.title ?? null;

  // The sender is gone (deleted account): nothing to show.
  const goneId = needsProfile && fetched.isSuccess && fetched.data === null ? invite.inviteId : null;
  useEffect(() => {
    if (goneId) inviteQueue.dismiss(goneId);
  }, [goneId]);

  const sheetCandidate = invite && !goneId && presentation === 'sheet' ? invite : null;
  const bannerCandidate =
    invite && !goneId && presentation === 'banner' && (profile || fetched.isError) ? invite : null;
  // One self-opening prompt at a time (lib/open-sheets.ts): the invite waits while a request or follow shows.
  const slot = usePromptSlot(`invite:${placement}`, !!(sheetCandidate ?? bannerCandidate));
  const sheetInvite = slot ? sheetCandidate : null;
  const bannerInvite = slot ? bannerCandidate : null;
  const shownId = (sheetInvite ?? bannerInvite)?.inviteId ?? null;
  const line = invite ? inviteLine({ ...invite, gameTitle }, profile?.username) : null;
  const spoken = bannerInvite ? line : null;
  useEffect(() => {
    if (!shownId || !inviteQueue.markShown(shownId)) return;
    tapHaptic();
    if (spoken) AccessibilityInfo.announceForAccessibility(`${spoken}`);
  }, [shownId, spoken]);

  const join = () => {
    if (!invite) return;
    const inv = invite;
    inviteQueue.dismiss(inv.inviteId);
    respond.mutate(
      { inviteId: inv.inviteId, accept: true },
      {
        onSuccess: (answer) => {
          if (answer.kind !== 'room') return;
          const target = answer.code
            ? { join: 'room' as const, room: answer.roomId, code: answer.code }
            : { join: 'room' as const, room: answer.roomId };
          launcher.launch({ id: answer.gameId, title: gameTitle ?? 'this game' }, target, { replace: inGame });
        },
      },
    );
  };
  const notNow = () => {
    if (!invite) return;
    inviteQueue.dismiss(invite.inviteId);
    // Declined quietly: the sender can invite again (a pending invite would be reused without a new broadcast).
    respond.mutate({ inviteId: invite.inviteId, accept: false });
  };

  const bannerItem =
    bannerInvite && line
      ? {
          key: bannerInvite.inviteId,
          label: inviteTitle(bannerInvite.kind),
          bold: profile?.username ?? null,
          rest: profile?.username ? line.slice(profile.username.length) : line,
          avatar: profile,
          actionLabel: 'Join',
          actionAccessibilityLabel: line ? `Join: ${line}` : 'Join',
        }
      : null;

  return (
    <>
      <AlertBanner
        item={bannerItem}
        countdown={inviteBannerCountdown}
        onAction={join}
        onOpen={() => bannerInvite && setExpandedId(bannerInvite.inviteId)}
        onDismiss={(id) => inviteQueue.dismiss(id)}
      />
      <InviteSheet
        invite={sheetInvite}
        profile={profile}
        gameTitle={gameTitle}
        busy={respond.isPending}
        onJoin={join}
        onNotNow={notNow}
      />
      {/* A room invite launches a game: its consent (4.7.3) is asked here, over whichever screen is showing. */}
      <LaunchConsentDialog launcher={launcher} />
    </>
  );
}
