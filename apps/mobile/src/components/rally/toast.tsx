import { CircleAlertIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { hideToast, useToast } from '@/lib/toast';

/** How long a toast stays up. */
const TOAST_MS = 3500;

/** The shell and the play route each mount a host (the game is a native modal over the shell): announce once. */
let announcedId = 0;

/**
 * The app's lightweight toast (lib/toast.ts): a card pill under the status bar, announced to screen readers,
 * dismissed by a tap or after 3.5 s. Touches outside it pass through. Mounted in `(app)/_layout.tsx` and in the play
 * route (a native full-screen modal that covers the shell's host).
 */
export function ToastHost() {
  const toast = useToast();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!toast) return;
    if (announcedId !== toast.id) {
      announcedId = toast.id;
      AccessibilityInfo.announceForAccessibility(toast.message);
    }
    const timer = setTimeout(() => hideToast(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // The container stays mounted so the pill's exit animation can run.
  return (
    <View
      className="absolute left-0 right-0 items-center px-4"
      style={{ top: insets.top + 8 }}
      pointerEvents="box-none"
    >
      {toast ? (
        <Animated.View
          key={toast.id}
          entering={FadeInUp.duration(220).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutUp.duration(180).reduceMotion(ReduceMotion.System)}
          className="max-w-md"
        >
          <Pressable
            onPress={() => hideToast(toast.id)}
            accessibilityRole="alert"
            accessibilityHint="Dismisses the message"
            className="bg-card border-border flex-row items-center gap-2.5 rounded-2xl border px-4 py-3 shadow-lg shadow-black/20 active:opacity-70"
          >
            <Icon as={CircleAlertIcon} className="text-foreground size-[18px]" />
            <Text className="shrink text-[15px] font-semibold leading-5">{toast.message}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}
