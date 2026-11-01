import { View, type ViewProps } from 'react-native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { cn } from '@/lib/utils';

/** The active bar stretching / the old one shrinking as the page changes (skipped under Reduce Motion). */
const DOT_TRANSITION = LinearTransition.duration(180).reduceMotion(ReduceMotion.System);

/**
 * Page dots for galleries over art (the dashboard hero, the game page's screenshots): white dots on a small dark
 * glass pill with a light hairline, so they read on any picture, bright or dark, in both themes (static colours on
 * purpose: they sit on the art, not on the page). Active = a 20 pt bar, the others dimmed; the bar slides between dots
 * as the page changes. Purely visual (`pointerEvents="none"`); the caller owns accessibility (the hero's and the
 * gallery's adjustable wrappers).
 */
export function PageDots({
  count,
  index,
  className,
  ...props
}: { count: number; index: number; className?: string } & Omit<ViewProps, 'children'>) {
  if (count < 2) return null;
  return (
    <View
      className={cn(
        'flex-row items-center gap-1.5 rounded-full border border-white/20 bg-black/45 px-2.5 py-[7px]',
        className,
      )}
      pointerEvents="none"
      {...props}
    >
      {Array.from({ length: count }, (_, i) => (
        <Animated.View
          key={i}
          layout={DOT_TRANSITION}
          className={cn('h-1.5 rounded-full', i === index ? 'w-5 bg-white' : 'w-1.5 bg-white/50')}
        />
      ))}
    </View>
  );
}
