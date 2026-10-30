import { memo, useId } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { Text } from '@/components/ui/text';
import { MARK } from '@/lib/brand';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/** SVG ids must be plain identifiers; React's useId contains colons. */
export function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * The Rally mark (see `MARK` in lib/brand.ts), in one flat colour: the theme's foreground by default (white in dark,
 * near-black in light), or `color` where the surface is fixed (the intro draws it white on the near-black splash).
 * `size` is the full 100×100 box, so the mark itself is ≈ 60 % × 84 % of it.
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
  const palette = usePalette();
  const paint = color ?? palette.foreground;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${MARK.viewBox} ${MARK.viewBox}`} style={style} accessible={false}>
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
