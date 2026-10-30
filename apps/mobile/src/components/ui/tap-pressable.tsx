import { useRef } from 'react';
import { Pressable, type GestureResponderEvent } from 'react-native';
import { DRAWER_EDGE_WIDTH } from '@/lib/drawer';
import { tapHaptic } from '@/lib/haptics';
import { drawerGesture, pressPoint, shouldDropPress, type PressStart } from '@/lib/press-guard';

export type TapPressableProps = React.ComponentProps<typeof Pressable> &
  React.RefAttributes<typeof Pressable> & {
    /** Light tap haptic on a press that goes through (lib/haptics.ts). Default true. */
    haptic?: boolean;
  };

/**
 * React Native's `Pressable` (so Uniwind's `className` / `active:` work unchanged) whose `onPress` is skipped when
 * the touch was really a drawer swipe or a drag (lib/press-guard.ts `shouldDropPress`), with the shell's tap haptic
 * on the presses that go through. Drop-in: same props, works under `<Link asChild>`.
 */
export function TapPressable({ onPressIn, onPress, haptic = true, ...props }: TapPressableProps) {
  const start = useRef<PressStart | null>(null);

  const pressIn = (e: GestureResponderEvent) => {
    const p = pressPoint(e.nativeEvent);
    start.current = p ? { ...p, epoch: drawerGesture.epoch() } : null;
    onPressIn?.(e);
  };

  const press = onPress
    ? (e: GestureResponderEvent) => {
        const began = start.current;
        start.current = null;
        if (
          shouldDropPress({
            start: began,
            end: pressPoint(e.nativeEvent),
            epoch: drawerGesture.epoch(),
            edgeWidth: DRAWER_EDGE_WIDTH,
          })
        ) {
          return;
        }
        if (haptic) tapHaptic();
        onPress(e);
      }
    : undefined;

  return <Pressable {...props} onPressIn={pressIn} onPress={press} />;
}
