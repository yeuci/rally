import { usePathname } from 'expo-router';
import { WifiOffIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useOffline } from '@/lib/network';
import { isGameScreen } from '@/lib/rejoin';
import { useViewport } from '@/lib/viewport';

/**
 * Where the pill sits below the top of the safe area: under the status bar and the navigation bar (the dashboard's top
 * bar and the Android header are 64 pt, the iOS header 44), like a "new posts" pill, so it never covers a title, the
 * greeting or a header button; content scrolls under it.
 */
const BELOW_TOP_BAR = 64 + 6;

/**
 * "You're offline": a slim pill under the status bar (and the navigation bar), over every screen, while the device has
 * no connection (lib/network.ts: no network, or one without internet, for 1.5 s). Inverted (foreground on background)
 * so it reads on any screen in both themes. Touch-transparent. Not over a running game: the game's own menu shows the
 * connection there. Mounted once, in the root layout.
 */
export function OfflineBanner() {
  const offline = useOffline();
  const pathname = usePathname();
  const show = offline && !isGameScreen(pathname);
  useEffect(() => {
    if (show) AccessibilityInfo.announceForAccessibility("You're offline");
  }, [show]);
  return show ? <OfflinePill /> : null;
}

/** The pill itself (also rendered by the screenshot preview). */
export function OfflinePill() {
  const { insets } = useViewport();
  return (
    <Animated.View
      entering={FadeInUp.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(180).reduceMotion(ReduceMotion.System)}
      className="absolute left-0 right-0 items-center"
      style={{ top: insets.top + BELOW_TOP_BAR, zIndex: 1000, elevation: 1000 }}
      pointerEvents="none"
    >
      <View
        className="bg-foreground h-8 flex-row items-center gap-1.5 rounded-full px-3.5 shadow-md shadow-black/30"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel="You're offline"
      >
        <Icon as={WifiOffIcon} className="text-background size-3.5" />
        <Text className="text-background text-[13px] font-semibold leading-4">You&apos;re offline</Text>
      </View>
    </Animated.View>
  );
}
