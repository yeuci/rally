import { cn } from '@/lib/utils';
import { usePalette } from '@/lib/use-palette';
import * as React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/** One sweep plus the pause before the next, in ms. */
const PERIOD = 1600;
/** Share of the period the highlight spends crossing the block; the rest is the pause. */
const SWEEP = 0.72;

/**
 * Loading placeholder: a block in the `skeleton` token with a lighter `skeleton-highlight` band sweeping across it
 * (dark and light themes have their own pair). Every skeleton reads the same UI-thread frame clock, so the blocks on
 * a screen shimmer in step instead of each starting when it mounted. Reduced motion: the static block. Children
 * (inner placeholders) are swept too. API unchanged: a View with `className` / `style`.
 */
function Skeleton({
  className,
  children,
  onLayout,
  ...props
}: React.ComponentProps<typeof View> & React.RefAttributes<View>) {
  const reducedMotion = useReducedMotion();
  const palette = usePalette();
  const progress = useSharedValue(0);
  const width = useSharedValue(0);
  const gradientId = `skeleton-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useFrameCallback((frame) => {
    progress.value = (frame.timestamp % PERIOD) / PERIOD;
  }, !reducedMotion);

  const band = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(progress.value, [0, SWEEP], [-width.value, width.value], Extrapolation.CLAMP),
      },
    ],
  }));

  const measure = (e: LayoutChangeEvent) => {
    width.set(e.nativeEvent.layout.width); // .set(): the React Compiler-safe shared value write
    onLayout?.(e);
  };

  return (
    <View
      className={cn('bg-skeleton overflow-hidden rounded-md', className)}
      onLayout={reducedMotion ? onLayout : measure}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      {...props}
    >
      {children}
      {!reducedMotion && (
        <Animated.View style={[StyleSheet.absoluteFill, band]} pointerEvents="none">
          <Svg width="100%" height="100%" viewBox="0 0 1 1" preserveAspectRatio="none">
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                <Stop offset={0} stopColor={palette.skeletonHighlight} stopOpacity={0} />
                <Stop offset={0.5} stopColor={palette.skeletonHighlight} stopOpacity={1} />
                <Stop offset={1} stopColor={palette.skeletonHighlight} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={1} height={1} fill={`url(#${gradientId})`} />
          </Svg>
        </Animated.View>
      )}
    </View>
  );
}

/**
 * A text line's box: a View exactly `lineHeight` tall holding a rounded bar about the cap height of the text, so a
 * skeleton line takes the same vertical space as the line it stands for (no jump when the text arrives).
 */
function SkeletonText({
  lineHeight,
  width,
  className,
  barClassName,
}: {
  lineHeight: number;
  width: number | `${number}%`;
  className?: string;
  barClassName?: string;
}) {
  const bar = Math.max(8, Math.round(lineHeight * 0.62));
  return (
    <View className={cn('justify-center', className)} style={{ height: lineHeight }}>
      <Skeleton className={cn('rounded-full', barClassName)} style={{ height: bar, width }} />
    </View>
  );
}

export { Skeleton, SkeletonText };
