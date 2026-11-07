import { useEffect, useState, type ReactNode } from 'react';
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
import { Text } from '@/components/ui/text';
import { BANNER_MS, bannerDragOffset, bannerSwipeDismisses, type BannerCountdown } from '@/lib/friend-alerts-model';
import { useScreenToFrame, useViewport } from '@/lib/viewport';
import { ProfileAvatar } from './profile-avatar';

/** How far a swiped-away banner travels before it is dismissed. */
const SWIPE_OUT = -140;

export interface AlertBannerItem {
  /** Identity of what is shown (an invite id, a launch id): the countdown and the dismissal follow it. */
  key: string;
  /** The small grey label ("Party invite"). */
  label: string;
  /** The line under it; `bold` is drawn in semibold at its start ("sloth" + " invited you to their party"). */
  bold: string | null;
  rest: string;
  /** The avatar; null draws none. */
  avatar: { userId: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  /** The inline button ("Join"). */
  actionLabel: string;
  actionAccessibilityLabel: string;
}

/**
 * The invite and "your party started" strips at the top of the screen: the same look and behaviour as
 * FriendRequestBanner (components/rally/friend-request-banner.tsx), with what it shows, its countdown and its
 * dismissal passed in. Dark glass with white type so it reads on any game in both themes; a plain view, not a Modal,
 * so the play route overlays it on the game and touches around it pass through. It leaves after 5 s (a hairline
 * shows the time left, held while a finger is on it) or with a swipe up (`onDismiss`); a tap on it calls `onOpen`
 * (the host expands it into its sheet) when given. Reduced motion: no slide, no hairline, a swipe dismisses at once.
 */
export function AlertBanner({
  item,
  countdown,
  onAction,
  onOpen,
  onDismiss,
  children,
}: {
  /** Null hides the banner (the container stays mounted so the exit animation can run). */
  item: AlertBannerItem | null;
  countdown: BannerCountdown;
  onAction: () => void;
  onOpen?: () => void;
  onDismiss: (key: string) => void;
  children?: ReactNode;
}) {
  const { insets } = useViewport();
  return (
    <View
      className="absolute left-0 right-0 items-center"
      style={{ top: Math.max(insets.top, 8) + 4, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }}
      pointerEvents="box-none"
    >
      {item ? (
        <BannerCard
          key={item.key}
          item={item}
          countdown={countdown}
          onAction={onAction}
          onOpen={onOpen}
          onDismiss={onDismiss}
        />
      ) : null}
      {children}
    </View>
  );
}

function BannerCard({
  item,
  countdown,
  onAction,
  onOpen,
  onDismiss,
}: {
  item: AlertBannerItem;
  countdown: BannerCountdown;
  onAction: () => void;
  onOpen?: () => void;
  onDismiss: (key: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const drag = useSharedValue(0);
  const left = useSharedValue(1);
  const key = item.key;

  useEffect(() => {
    countdown.show(key);
    if (!reducedMotion) left.set(withTiming(0, { duration: BANNER_MS, easing: Easing.linear }));
    return () => {
      countdown.stop(key);
      cancelAnimation(left);
    };
  }, [key, reducedMotion, left, countdown]);

  const hold = () => {
    countdown.pause();
    cancelAnimation(left);
  };
  const release = () => {
    countdown.resume();
    const state = countdown.state();
    if (state.key === key && !state.paused && !reducedMotion) {
      left.set(withTiming(0, { duration: state.remainingMs, easing: Easing.linear }));
    }
  };

  // Swipe up to dismiss; movement arrives in screen axes, "up" is the (possibly turned) game frame's.
  const toFrame = useScreenToFrame();
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        const d = toFrame(g.dx, g.dy);
        return Math.abs(d.dy) > 6 && Math.abs(d.dy) > Math.abs(d.dx);
      },
      onPanResponderGrant: () => hold(),
      onPanResponderMove: (_e, g) => drag.set(bannerDragOffset(toFrame(g.dx, g.dy).dy)),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        if (bannerSwipeDismisses(toFrame(g.dx, g.dy).dy, toFrame(g.vx, g.vy).dy)) {
          countdown.stop(key);
          if (reducedMotion) {
            onDismiss(key);
            return;
          }
          drag.set(withTiming(SWIPE_OUT, { duration: 160, easing: Easing.out(Easing.quad) }));
          setTimeout(() => onDismiss(key), 160);
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
  const line = `${item.bold ?? ''}${item.rest}`;

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
            disabled={!onOpen}
            onPressIn={hold}
            onPressOut={release}
            accessibilityRole={onOpen ? 'button' : 'text'}
            accessibilityLabel={`${item.label}. ${line}`}
            accessibilityHint={onOpen ? 'Opens the invite' : undefined}
            onAccessibilityEscape={() => onDismiss(key)}
            className="min-h-11 shrink grow flex-row items-center gap-3 active:opacity-70"
          >
            {item.avatar ? (
              <ProfileAvatar
                userId={item.avatar.userId}
                profile={{
                  username: item.avatar.username,
                  display_name: item.avatar.displayName,
                  avatar_url: item.avatar.avatarUrl,
                }}
                size="sm"
              />
            ) : null}
            <View className="shrink grow">
              <Text className="text-[12px] font-medium leading-4 text-white/60" numberOfLines={1}>
                {item.label}
              </Text>
              <Text className="text-[14px] leading-[18px] text-white" numberOfLines={2}>
                {item.bold ? (
                  <Text className="text-[14px] font-semibold leading-[18px] text-white">{item.bold}</Text>
                ) : null}
                {item.rest}
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onAction}
            onPressIn={hold}
            onPressOut={release}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={item.actionAccessibilityLabel}
            className="h-8 items-center justify-center rounded-full bg-white px-3.5 active:opacity-70"
          >
            <Text className="text-[13px] font-bold text-black">{item.actionLabel}</Text>
          </Pressable>
        </View>
        {reducedMotion ? null : (
          <Animated.View
            className="absolute bottom-0 left-0 h-[2px] bg-white/40"
            style={hairline}
            pointerEvents="none"
          />
        )}
      </View>
    </Animated.View>
  );
}
