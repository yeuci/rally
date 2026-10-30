import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'expo-router';
import { CheckIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View, type ModalProps } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { socialKeys, useFriendshipAction } from '@/lib/friends';
import { tapHaptic } from '@/lib/haptics';
import { useOtherSheetOpen } from '@/lib/open-sheets';
import { isGameScreen } from '@/lib/rejoin';
import { fetchRequestProfile, friendRequestQueue, markRequestSeen, useFriendRequestQueue } from '@/lib/social-realtime';
import { requestLine, type QueuedRequest, type RequestProfile } from '@/lib/social-realtime-model';
import { BottomSheet } from './bottom-sheet';
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
                profile={{ username: profile.username, display_name: profile.displayName, avatar_url: profile.avatarUrl }}
                size="md"
              />
              <View className="shrink grow">
                <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
                  {name}
                </Text>
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
 * The head of the incoming-request queue (lib/social-realtime.ts) as a sheet. Mounted twice, and exactly one of
 * them presents at any time:
 *
 * - `shell` in `(app)/_layout.tsx`, while no game is open;
 * - `game` in the play route, over the running game.
 *
 * Why two: on iOS a React Native `Modal` presents from the nearest view controller above it
 * (`[reactViewController presentViewController:]`), not from the top-most one. The play route is a native
 * `fullScreenModal`, so a Modal mounted in the shell (or in the root layout, whose controller is just as low) would
 * be asked to present from a controller that is already presenting the game, which UIKit refuses. Mounted inside
 * the play screen, its controller is the top-most one. Each host waits SETTLE_MS after the game opens or closes so
 * it never presents during the game screen's own transition; the shell host also waits for the shell's other sheets
 * (rejoin, join code: lib/open-sheets.ts), since one controller presents one Modal at a time. On Android a Modal is a dialog window over the whole
 * activity; the same rule (one host at a time) keeps it single there.
 *
 * Shown → a light haptic (Settings → Haptics) and the request is marked seen (no catch-up repeats it). Accept /
 * Decline go through `useFriendshipAction` (optimistic; its own alert on failure); Later and the backdrop keep the
 * request pending in Friends. A cancelled request leaves the queue (and the sheet) as its event arrives.
 */
export function FriendRequestPrompt({ placement }: { placement: 'shell' | 'game' }) {
  const { userId } = useSession();
  const queue = useFriendRequestQueue();
  const gameOpen = isGameScreen(usePathname());
  // The shell's other sheets (rejoin, join code) present from the same controller: wait for them to close.
  const otherSheet = useOtherSheetOpen();
  const shellReady = useSettled(!gameOpen && !otherSheet, true);
  const gameReady = useSettled(true, false);
  const active = placement === 'game' ? gameReady : shellReady;
  const request = active ? (queue[0] ?? null) : null;
  const action = useFriendshipAction();

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

  const shownKey = request && !gone ? request.key : null;
  useEffect(() => {
    if (!shownKey || !friendRequestQueue.markShown(shownKey)) return;
    tapHaptic();
    markRequestSeen(shownKey);
  }, [shownKey]);

  const answer = (intent: 'accept' | 'decline') => {
    if (!request) return;
    friendRequestQueue.drop(request.userId);
    action.mutate({ userId: request.userId, intent, current: 'incoming' });
  };

  return (
    <FriendRequestSheet
      request={gone ? null : request}
      profile={profile}
      onAccept={() => answer('accept')}
      onDecline={() => answer('decline')}
      onLater={() => request && friendRequestQueue.drop(request.userId)}
    />
  );
}
