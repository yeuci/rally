import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Text } from '@/components/ui/text';
import { coverArt, trianglePath, type CoverShape } from '@/lib/cover-art';
import { cn } from '@/lib/utils';
import { Image } from './image';
import { useSvgId } from './logo';

type Variant = 'tile' | 'feature' | 'hero';

const TITLE_CLASS: Record<Variant, string> = {
  tile: 'text-[15px] leading-[19px]',
  feature: 'text-[28px] leading-[32px] tracking-tight',
  hero: 'text-4xl tracking-tight',
};

/**
 * Game cover. `screenshots[0]` when there is one (expo-image under a scrim), else generated art from the game id
 * (lib/cover-art.ts): same id, same cover. `showTitle` sets the title in the art like box art; `scrim` darkens the
 * bottom for overlaid type, or fades into `scrimColor` (the page background) for the game page hero. Memoised:
 * covers sit in lists.
 */
export const GameCover = memo(function GameCover({
  id,
  title,
  uri,
  variant = 'tile',
  showTitle = variant === 'tile',
  scrim = showTitle ? 'dark' : 'none',
  scrimColor = '#000000',
  className,
  style,
  children,
}: {
  id: string;
  title: string;
  uri?: string | null;
  variant?: Variant;
  showTitle?: boolean;
  scrim?: 'none' | 'dark' | 'fade';
  /** End colour of the `fade` scrim. */
  scrimColor?: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <View className={cn('bg-muted overflow-hidden', className)} style={style}>
      {uri ? (
        <Image source={{ uri }} className="absolute inset-0" contentFit="cover" transition={200} accessibilityIgnoresInvertColors />
      ) : (
        <CoverArtwork id={id} />
      )}
      {scrim !== 'none' && <CoverScrim kind={scrim} photo={!!uri} color={scrimColor} />}
      {showTitle && (
        <View className="absolute bottom-0 left-0 right-0 p-3" pointerEvents="none">
          <Text
            className={cn('font-extrabold text-white', TITLE_CLASS[variant])}
            style={TITLE_SHADOW}
            numberOfLines={2}
          >
            {title}
          </Text>
        </View>
      )}
      {children}
    </View>
  );
});

/** Gradient overlay for type over covers (`dark`) or the fade into the page (`fade`, ends in `color`). */
export const CoverScrim = memo(function CoverScrim({
  kind,
  photo = false,
  color = '#000000',
}: {
  kind: 'dark' | 'fade';
  photo?: boolean;
  color?: string;
}) {
  const id = useSvgId('cover-scrim');
  const stops = kind === 'dark' ? darkScrim(photo) : fadeScrim(color);
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          {stops.map((stop) => (
            <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} stopOpacity={stop.opacity} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
});

type ScrimStop = { offset: number; color: string; opacity: number };
/** Bottom darkening for type over art; photos get a deeper one. */
const darkScrim = (photo: boolean): ScrimStop[] => [
  { offset: photo ? 0.3 : 0.42, color: '#000000', opacity: 0 },
  { offset: 1, color: '#000000', opacity: photo ? 0.72 : 0.55 },
];
/** Hero: a touch of shade under the status bar, then a fade into the page background. */
const fadeScrim = (to: string): ScrimStop[] => [
  { offset: 0, color: '#000000', opacity: 0.28 },
  { offset: 0.22, color: '#000000', opacity: 0 },
  { offset: 0.55, color: to, opacity: 0 },
  { offset: 1, color: to, opacity: 1 },
];

const TITLE_SHADOW = { textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8 };

/** The generated grey gradient + shapes, filling its parent ("slice": cropped to the parent's aspect ratio). */
const CoverArtwork = memo(function CoverArtwork({ id }: { id: string }) {
  const art = useMemo(() => coverArt(id), [id]);
  const bg = useSvgId('cover-bg');
  const glow = useSvgId('cover-glow');
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id={bg} gradientUnits="userSpaceOnUse" x1={art.x1} y1={art.y1} x2={art.x2} y2={art.y2}>
          <Stop offset={0} stopColor={art.from} />
          <Stop offset={1} stopColor={art.to} />
        </LinearGradient>
        <RadialGradient id={glow} gradientUnits="userSpaceOnUse" cx={art.glow.cx} cy={art.glow.cy} r={art.glow.r}>
          <Stop offset={0} stopColor={art.glow.color} stopOpacity={0.25} />
          <Stop offset={1} stopColor={art.glow.color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={-50} y={-50} width={200} height={200} fill={`url(#${bg})`} />
      <Circle cx={art.glow.cx} cy={art.glow.cy} r={art.glow.r} fill={`url(#${glow})`} />
      {art.shapes.map((s, i) => (
        <Shape key={i} shape={s} />
      ))}
    </Svg>
  );
});

function Shape({ shape: s }: { shape: CoverShape }) {
  switch (s.kind) {
    case 'circle':
      return <Circle cx={s.cx} cy={s.cy} r={s.r} fill={s.fill} opacity={s.opacity} />;
    case 'ring':
      return <Circle cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke={s.stroke} strokeWidth={s.width} opacity={s.opacity} />;
    case 'rect':
      return (
        <Rect
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={s.rx}
          fill={s.fill}
          opacity={s.opacity}
          transform={`rotate(${s.rotate} ${s.x + s.w / 2} ${s.y + s.h / 2})`}
        />
      );
    case 'triangle':
      return (
        <Path
          d={trianglePath(s.cx, s.cy, s.size)}
          fill={s.fill}
          stroke={s.fill}
          strokeWidth={s.size * 0.12}
          strokeLinejoin="round"
          opacity={s.opacity}
          transform={`rotate(${s.rotate} ${s.cx} ${s.cy})`}
        />
      );
  }
}
