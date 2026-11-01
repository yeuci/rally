import { usePathname } from 'expo-router';
import { WifiOffIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useOffline } from '@/lib/network';
import { isGameScreen } from '@/lib/rejoin';

/**
 * "You're offline": a slim pill just under the status bar, over every screen, while the device has no connection
 * (lib/network.ts: no network, or one without internet, for 1.5 s). Inverted (foreground on background) so it reads on
 * any screen in both themes. Touch-transparent, so the header buttons under it keep working. Not over a running game:
 * the game's own menu shows the connection there. Mounted once, in the root layout.
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
  const insets = useSafeAreaInsets();
  return (
    <Animated.View
      entering={FadeInUp.duration(220).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(180).reduceMotion(ReduceMotion.System)}
      className="absolute left-0 right-0 items-center"
      style={{ top: insets.top + 4, zIndex: 1000, elevation: 1000 }}
      pointerEvents="none"
    >
      <View
        className="bg-foreground h-7 flex-row items-center gap-1.5 rounded-full px-3"
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
