import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { BRAND } from '@/lib/brand';
import { Glow } from './glow';

/**
 * Slowly breathing accent light (violet core, cyan drifting the other way) to sit behind the wordmark. Two
 * transforms on the UI thread; holds still under Reduce Motion.
 */
export function PulseGlow({ size }: { size: number }) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.set(withRepeat(withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }), -1, true, undefined, ReduceMotion.System));
  }, [t]);

  const violet = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0.75, 1]),
    transform: [{ scale: interpolate(t.value, [0, 1], [0.92, 1.06]) }],
  }));
  const cyan = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0.9, 0.55]),
    transform: [
      { translateX: interpolate(t.value, [0, 1], [size * 0.12, size * 0.04]) },
      { translateY: interpolate(t.value, [0, 1], [size * 0.06, size * 0.12]) },
      { scale: interpolate(t.value, [0, 1], [1, 0.9]) },
    ],
  }));

  return (
    <View pointerEvents="none" className="absolute items-center justify-center" style={{ width: size, height: size }}>
      <Animated.View className="absolute" style={[{ width: size, height: size }, violet]}>
        <Glow size={size} opacity={0.42} />
      </Animated.View>
      <Animated.View className="absolute" style={[{ width: size * 0.7, height: size * 0.7 }, cyan]}>
        <Glow size={size * 0.7} color={BRAND.cyan} opacity={0.22} />
      </Animated.View>
    </View>
  );
}
