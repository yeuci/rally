import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'expo-router';
import { CheckIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, View, type ModalProps } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useAlertStyle, useGameScreenMarker } from '@/lib/friend-alerts';
import { alertPresentation } from '@/lib/friend-alerts-model';
import { socialKeys, useFriendshipAction } from '@/lib/friends';
import { tapHaptic } from '@/lib/haptics';
import { useOtherSheetOpen } from '@/lib/open-sheets';
import { isGameScreen } from '@/lib/rejoin';
import { fetchRequestProfile, friendRequestQueue, markRequestSeen, useFriendRequestQueue } from '@/lib/social-realtime';
import { requestLine, type QueuedRequest, type RequestProfile } from '@/lib/social-realtime-model';
import { BottomSheet } from './bottom-sheet';
import { PlayerName } from './cosmetics';
import { FriendRequestBanner } from './friend-request-banner';
import { ProfileAvatar } from './profile-avatar';

/** Every orientation: the sheet can rise over a landscape-locked game (iOS would otherwise force portrait). */
const ALL_ORIENTATIONS: ModalProps['supportedOrientations'] = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'];

/**
 * Wait after a native modal transition before presenting (UIKit refuses to present from a controller that is still
 * presenting or dismissing the game screen).
 */
const SETTLE_MS = 700;

/**
 * "sloth wants to be your friend": the requester's card and Accept / Decline / Later. Presentational; the queue,
 * the profile and the actions are the caller's (FriendRequestPrompt).
 */
export function FriendRequestSheet({
  request,
  profile,
  onAccept,
  onDecline,
  onLater,
}: {
  request: QueuedRequest | null;
  /** null while loading (or unavailable: the buttons still work, they act on the requester's id). */
  profile: RequestProfile | null;
  onAccept: () => void;
  onDecline: () => void;
  onLater: () => void;
}) {
  const name = profile ? profile.displayName || profile.username : null;
  return (
    <BottomSheet
      open={!!request}
      onClose={onLater}
      title="Friend request"
      description={profile ? requestLine(profile.username) : 'Someone wants to be your friend'}
      supportedOrientations={ALL_ORIENTATIONS}
      register={false}
    >
      <View className="gap-4">
        <View
          className="bg-card border-border min-h-16 flex-row items-center gap-3 rounded-2xl border px-4 py-2.5"
          accessible
          accessibilityLabel={profile ? `${name}, @${profile.username}` : 'Loading the player'}
        >
          {profile ? (
            <>
              <ProfileAvatar
                userId={profile.userId}
                profile={{ username: profile.username, display_name: profile.displayName, avatar_url: profile.avatarUrl }}
                size="md"
              />
              <View className="shrink grow">
                <PlayerName
                  userId={profile.userId}
                  name={profile.displayName || profile.username}
                  className="text-[15px] font-semibold leading-5"
                />
                <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
                  {`@${profile.username}`}
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
        <View className="gap-2">
          <Button
            size="lg"
            className="h-12 rounded-2xl"
            onPress={onAccept}
            accessibilityLabel={name ? `Accept ${name}'s friend request` : 'Accept the friend request'}
          >
            <Icon as={CheckIcon} className="text-primary-foreground size-4" />
            <Text className="text-[16px] font-bold">Accept</Text>
          </Button>
          <View className="flex-row gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="h-11 flex-1 rounded-2xl"
              onPress={onDecline}
              accessibilityLabel={name ? `Decline ${name}'s friend request` : 'Decline the friend request'}
            >
              <Text>Decline</Text>
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="h-11 flex-1 rounded-2xl"
              onPress={onLater}
              accessibilityHint="Keeps the request in Friends"
            >
              <Text>Later</Text>
            </Button>
          </View>
        </View>
      </View>
    </BottomSheet>
  );
}

/** True once `value` has held for SETTLE_MS (or from the start, with `settledAtMount`). */
function useSettled(value: boolean, settledAtMount: boolean): boolean {
  const [settled, setSettled] = useState(value && settledAtMount);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setSettled(false);
  }
  useEffect(() => {
    if (!value || settled) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value, settled]);
  return value && settled;
}

/**
 * The head of the incoming-request queue (lib/social-realtime.ts), presented per Settings → Notifications
 * (lib/friend-alerts.ts: `friendAlertsInGame` in the play route, `friendAlerts` elsewhere): as this sheet, as a
 * banner at the top of the screen (FriendRequestBanner; a tap on it expands it into the sheet), or not at all (Off:
 * consumed silently, still pending in Friends and on the badge). Mounted twice, and exactly one of them is active at
 * any time:
 *
 * - `shell` in `(app)/_layout.tsx`, while no game is open;
 * - `game` in the play route, over the running game.
 *
 * Why two: on iOS a React Native `Modal` presents from the nearest view controller above it
 * (`[reactViewController presentViewController:]`), not from the top-most one. The play route is a native
 * `fullScreenModal`, so a Modal mounted in the shell (or in the root layout, whose controller is just as low) would
 * be asked to present from a controller that is already presenting the game, which UIKit refuses. Mounted inside
 * the play screen, its controller is the top-most one (and the banner, a plain view, is simply overlaid on the
 * game). Each host waits SETTLE_MS after the game opens or closes so it never presents during the game screen's own
 * transition; the shell host also waits for the shell's other sheets (rejoin, join code: lib/open-sheets.ts), since
 * one controller presents one Modal at a time (and a banner would sit under them). On Android a Modal is a dialog
 * window over the whole activity; the same rule (one host at a time) keeps it single there.
 *
 * Shown (sheet, or banner once its profile is known) → a light haptic (Settings → Haptics) and the request is marked
 * seen (no catch-up repeats it). Accept / Decline go through `useFriendshipAction` (optimistic; its own alert on
 * failure); Later, the backdrop, a banner's timeout or swipe keep the request pending in Friends. A cancelled request
 * leaves the queue (and the sheet or banner) as its event arrives.
 */
export function FriendRequestPrompt({ placement }: { placement: 'shell' | 'game' }) {
  const inGame = placement === 'game';
  // "A game screen is open" for the Realtime router (the accepted toast follows the in-game choice).
  useGameScreenMarker(inGame);
  const { userId } = useSession();
  const queue = useFriendRequestQueue();
  const style = useAlertStyle(inGame);
  const gameOpen = isGameScreen(usePathname());
  // The shell's other sheets (rejoin, join code) present from the same controller: wait for them to close.
  const otherSheet = useOtherSheetOpen();
  const shellReady = useSettled(!gameOpen && !otherSheet, true);
  const gameReady = useSettled(true, false);
  const active = inGame ? gameReady : shellReady;
  const head = active ? (queue[0] ?? null) : null;
  // A banner the user tapped becomes the sheet (per request: the next one is a banner again).
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const presentation = head ? alertPresentation(style, expandedKey === head.key) : null;
  const request = presentation && presentation !== 'silent' ? head : null;
  const action = useFriendshipAction();

  // Off: nothing on screen. Marked seen (catch-up does not bring it back) and out of the queue; Friends keeps it.
  const silentKey = presentation === 'silent' && head ? head.key : null;
  useEffect(() => {
    if (!silentKey) return;
    friendRequestQueue.markShown(silentKey);
    markRequestSeen(silentKey);
    friendRequestQueue.dismiss(silentKey);
  }, [silentKey]);

  const needsProfile = !!request && !request.profile;
  const fetched = useQuery({
    queryKey: socialKeys.requestProfile(userId, request?.userId ?? ''),
    enabled: !!userId && needsProfile,
    staleTime: 5 * 60_000,
    queryFn: () => fetchRequestProfile(request!.userId),
  });
  const profile = request?.profile ?? fetched.data ?? null;

  // The requester is gone (deleted account): nothing to show.
  const gone = needsProfile && fetched.isSuccess && fetched.data === null;
  const goneId = gone ? request.userId : null;
  useEffect(() => {
    if (goneId) friendRequestQueue.drop(goneId);
  }, [goneId]);

  const sheetRequest = request && !gone && presentation === 'sheet' ? request : null;
  // The banner waits for the name (no skeleton strip over a game); if the profile cannot be read, a generic line.
  const bannerRequest = request && !gone && presentation === 'banner' && (profile || fetched.isError) ? request : null;
  const shownKey = (sheetRequest ?? bannerRequest)?.key ?? null;
  const spoken = bannerRequest ? (profile ? requestLine(profile.username) : 'Someone wants to be your friend') : null;
  useEffect(() => {
    if (!shownKey || !friendRequestQueue.markShown(shownKey)) return;
    tapHaptic();
    markRequestSeen(shownKey);
    // The sheet is announced as a modal; the banner is not focused, so it is read out.
    if (spoken) AccessibilityInfo.announceForAccessibility(`Friend request. ${spoken}`);
  }, [shownKey, spoken]);

  const answer = (intent: 'accept' | 'decline') => {
    if (!request) return;
    friendRequestQueue.drop(request.userId);
    action.mutate({ userId: request.userId, intent, current: 'incoming' });
  };

  return (
    <>
      <FriendRequestBanner
        request={bannerRequest}
        profile={profile}
        onAccept={() => answer('accept')}
        onOpen={() => bannerRequest && setExpandedKey(bannerRequest.key)}
      />
      <FriendRequestSheet
        request={sheetRequest}
        profile={profile}
        onAccept={() => answer('accept')}
        onDecline={() => answer('decline')}
        onLater={() => request && friendRequestQueue.drop(request.userId)}
      />
    </>
  );
}
