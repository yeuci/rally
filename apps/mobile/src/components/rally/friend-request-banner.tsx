import { useEffect, useState } from 'react';
import { PanResponder, Pressable, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  FadeInUp,
  FadeOutUp,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { BANNER_MS, bannerDragOffset, bannerSwipeDismisses } from '@/lib/friend-alerts-model';
import { bannerCountdown, friendRequestQueue } from '@/lib/social-realtime';
import { requestLine, type QueuedRequest, type RequestProfile } from '@/lib/social-realtime-model';
import { ProfileAvatar } from './profile-avatar';

/** How far a swiped-away banner travels before it leaves the queue. */
const SWIPE_OUT = -140;

/**
 * "sloth wants to be your friend" as a strip at the top of the screen (Settings → Notifications → Banner): the
 * requester's avatar, the line and an inline Accept; a tap anywhere else calls `onOpen` (the host expands it into
 * the full sheet). Leaves by itself after 5 s (`bannerCountdown` in lib/social-realtime.ts; a thin hairline shows
 * the time left, held while a finger is on it), or with a swipe up; either way the request stays pending in Friends.
 *
 * Dark glass with white type (like PageDots and the room-code pill): it often sits on a running game, so it must
 * read on any picture in both themes. A plain view, not a Modal: the play route overlays it at the top of the game
 * (no presentation, no wait for native transitions); touches around it pass through. Reduced motion: no slide, no
 * hairline, a swipe dismisses at once.
 */
export function FriendRequestBanner({
  request,
  profile,
  onAccept,
  onOpen,
}: {
  /** The request to show; null hides the banner (the container stays mounted so the exit animation can run). */
  request: QueuedRequest | null;
  profile: RequestProfile | null;
  onAccept: () => void;
  onOpen: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="absolute left-0 right-0 items-center"
      style={{ top: Math.max(insets.top, 8) + 4, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }}
      pointerEvents="box-none"
    >
      {request ? (
        <BannerCard key={request.key} requestKey={request.key} profile={profile} onAccept={onAccept} onOpen={onOpen} />
      ) : null}
    </View>
  );
}

function BannerCard({
  requestKey,
  profile,
  onAccept,
  onOpen,
}: {
  requestKey: string;
  profile: RequestProfile | null;
  onAccept: () => void;
  onOpen: () => void;
}) {
  const reducedMotion = useReducedMotion();
  /** Vertical drag offset (pt). */
  const drag = useSharedValue(0);
  /** Share of the countdown left, 1 → 0 (the hairline). */
  const left = useSharedValue(1);

  // On screen: the countdown starts (and stops if the card goes first: accepted, expanded, host inactive).
  useEffect(() => {
    bannerCountdown.show(requestKey);
    if (!reducedMotion) left.set(withTiming(0, { duration: BANNER_MS, easing: Easing.linear }));
    return () => {
      bannerCountdown.stop(requestKey);
      cancelAnimation(left);
    };
  }, [requestKey, reducedMotion, left]);

  // A finger on the banner holds the countdown; lifting it continues with the time that was left.
  const hold = () => {
    bannerCountdown.pause();
    cancelAnimation(left);
  };
  const release = () => {
    bannerCountdown.resume();
    const { key, remainingMs, paused } = bannerCountdown.state();
    if (key === requestKey && !paused && !reducedMotion) {
      left.set(withTiming(0, { duration: remainingMs, easing: Easing.linear }));
    }
  };

  // Swipe up to dismiss. Capture on a clear vertical move, so a drag never ends as a tap on the card or Accept.
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => hold(),
      onPanResponderMove: (_e, g) => drag.set(bannerDragOffset(g.dy)),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        if (bannerSwipeDismisses(g.dy, g.vy)) {
          bannerCountdown.stop(requestKey);
          if (reducedMotion) {
            friendRequestQueue.dismiss(requestKey);
            return;
          }
          drag.set(withTiming(SWIPE_OUT, { duration: 160, easing: Easing.out(Easing.quad) }));
          setTimeout(() => friendRequestQueue.dismiss(requestKey), 160);
          return;
        }
        drag.set(reducedMotion ? 0 : withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) }));
        release();
      },
      onPanResponderTerminate: () => {
        drag.set(0);
        release();
      },
    }),
  );

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.get() }],
    opacity: interpolate(drag.get(), [-90, 0], [0, 1], Extrapolation.CLAMP),
  }));
  const hairline = useAnimatedStyle(() => ({ width: `${left.get() * 100}%` }));

  const username = profile?.username ?? null;
  const line = username ? requestLine(username) : 'Someone wants to be your friend';

  return (
    <Animated.View
      entering={FadeInUp.duration(240).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(200).reduceMotion(ReduceMotion.System)}
      className="w-full max-w-md"
      style={cardStyle}
      {...pan.panHandlers}
    >
      <View className="overflow-hidden rounded-2xl border border-white/20 bg-black/75 shadow-lg shadow-black/30">
        <View className="flex-row items-center gap-2 py-2 pl-2.5 pr-2">
          <Pressable
            onPress={onOpen}
            onPressIn={hold}
            onPressOut={release}
            accessibilityRole="button"
            accessibilityLabel={`Friend request. ${line}`}
            accessibilityHint="Opens the request"
            onAccessibilityEscape={() => friendRequestQueue.dismiss(requestKey)}
            className="min-h-11 shrink grow flex-row items-center gap-3 active:opacity-70"
          >
            <ProfileAvatar
              profile={profile ? { username: profile.username, display_name: profile.displayName, avatar_url: profile.avatarUrl } : null}
              size="sm"
            />
            <View className="shrink grow">
              <Text className="text-[12px] font-medium leading-4 text-white/60" numberOfLines={1}>
                Friend request
              </Text>
              <Text className="text-[14px] leading-[18px] text-white" numberOfLines={2}>
                {username ? (
                  <>
                    <Text className="text-[14px] font-semibold leading-[18px] text-white">{username}</Text>
                    {' wants to be your friend'}
                  </>
                ) : (
                  line
                )}
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onAccept}
            onPressIn={hold}
            onPressOut={release}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={username ? `Accept ${username}'s friend request` : 'Accept the friend request'}
            className="h-8 items-center justify-center rounded-full bg-white px-3.5 active:opacity-70"
          >
            <Text className="text-[13px] font-bold text-black">Accept</Text>
          </Pressable>
        </View>
        {reducedMotion ? null : (
          <Animated.View className="absolute bottom-0 left-0 h-[2px] bg-white/40" style={hairline} pointerEvents="none" />
        )}
      </View>
    </Animated.View>
  );
}
