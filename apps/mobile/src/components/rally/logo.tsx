import { memo, useId } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { Text } from '@/components/ui/text';
import { ACCENT_STOPS, MARK } from '@/lib/brand';
import { cn } from '@/lib/utils';

/** SVG ids must be plain identifiers; React's useId contains colons. */
export function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * The Rally mark (see `MARK` in lib/brand.ts): accent gradient by default, or one flat `color` (monochrome icon,
 * on-photo use). `size` is the full 100×100 box, so the mark itself is ≈ 60 % × 84 % of it.
 */
export const LogoMark = memo(function LogoMark({
  size = 24,
  color,
  style,
}: {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const id = useSvgId('rally-mark');
  const paint = color ?? `url(#${id})`;
  const { x1, y1, x2, y2 } = MARK.gradient;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${MARK.viewBox} ${MARK.viewBox}`} style={style} accessible={false}>
      {!color && (
        <Defs>
          <LinearGradient id={id} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
            {ACCENT_STOPS.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </LinearGradient>
        </Defs>
      )}
      <G stroke={paint} strokeWidth={MARK.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        <Path d={MARK.stem} fill="none" />
        <Path d={MARK.bowl} fill={paint} />
        <Path d={MARK.leg} fill="none" />
      </G>
    </Svg>
  );
});

/** Mark + "Rally" set in heavy type. `size` is the mark's box; the type is sized from it. */
export function Wordmark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <View
      className={cn('flex-row items-center', className)}
      style={{ gap: size * 0.12 }}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Rally"
    >
      <LogoMark size={size} />
      <Text
        className="text-foreground font-extrabold"
        style={{ fontSize: size * 0.78, lineHeight: size, letterSpacing: -size * 0.03 }}
        importantForAccessibility="no"
      >
        Rally
      </Text>
    </View>
  );
}
