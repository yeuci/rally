import { memo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { BRAND } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { useSvgId } from './logo';

/**
 * A soft radial light: a barely-there white haze for depth on the dark theme (it vanishes on light backgrounds).
 * Absolutely positioned, ignores touches; place with className.
 */
export const Glow = memo(function Glow({
  size,
  color = BRAND.white,
  opacity = 0.08,
  className,
  style,
}: {
  size: number;
  color?: string;
  opacity?: number;
  className?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const id = useSvgId('glow');
  const r = size / 2;
  return (
    <View pointerEvents="none" className={cn('absolute', className)} style={[{ width: size, height: size }, style]}>
      {/* Keyed on size: a resized glow (rotation) is redrawn, never stretched from its old bitmap. */}
      <Svg key={size} width={size} height={size}>
        <Defs>
          <RadialGradient id={id} gradientUnits="userSpaceOnUse" cx={r} cy={r} r={r}>
            <Stop offset={0} stopColor={color} stopOpacity={opacity} />
            <Stop offset={0.55} stopColor={color} stopOpacity={opacity * 0.35} />
            <Stop offset={1} stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
});
