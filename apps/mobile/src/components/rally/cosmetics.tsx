import {
  AnchorIcon,
  AwardIcon,
  CloverIcon,
  CompassIcon,
  CrownIcon,
  FeatherIcon,
  FlameIcon,
  Gamepad2Icon,
  GemIcon,
  GhostIcon,
  HeartIcon,
  InfinityIcon,
  LeafIcon,
  MedalIcon,
  MoonIcon,
  MountainIcon,
  MusicIcon,
  PuzzleIcon,
  RocketIcon,
  ShieldIcon,
  SkullIcon,
  SnowflakeIcon,
  SparklesIcon,
  StarIcon,
  SunIcon,
  SwordsIcon,
  TargetIcon,
  TrophyIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { memo, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, G, Line, LinearGradient, Pattern, Rect, Stop } from 'react-native-svg';
import { useUniwind } from 'uniwind';
import { Text } from '@/components/ui/text';
import { useCosmetics } from '@/lib/coins';
import {
  beadDashes,
  gradientStops,
  nameGlow,
  parseCosmeticData,
  themedColor,
  type BadgeIconName,
  type BadgeStyle,
  type BannerPattern,
  type BannerStyle,
  type Cosmetics,
  type FrameStyle,
  type ShopItem,
} from '@/lib/coins-model';
import { cn } from '@/lib/utils';
import { useSvgId } from './logo';

/**
 * Equipped cosmetics, drawn from data (no image assets; shop_items.data, 20261031000400_coins.sql and
 * 20261102000300_more_content.sql): the avatar frame (a gradient ring, drawn by ProfileAvatar with `AvatarFrameRing`),
 * the name colour and badge (`PlayerName`), the profile banner (`ProfileBanner`, behind ProfileHeader). Every place
 * that shows a player uses these through the shared components, so a look shows on profiles, leaderboards and friends
 * lists alike. Colours are the item's own (`light` variants keep names readable on the light theme).
 *
 * Optional extras (lib/coins-model.ts parses them only when an item's data asks, so the v1 items draw exactly as
 * before): a name `glow` (a text-shadow halo), a frame that `spin`s (one shared UI-thread clock, so every turning ring
 * on screen turns in step) or is `dotted` (beads), a banner `pattern` (a faint white texture) and `shine` (a sheen
 * sweeping across), and a badge `fill` (two-tone). Motion holds still under Reduce Motion.
 */

/** The badge icons the app knows (shop_items.data.icon, BADGE_ICON_NAMES); an unknown name falls back to a star. */
const BADGE_ICONS: Record<BadgeIconName, LucideIcon> = {
  star: StarIcon,
  flame: FlameIcon,
  crown: CrownIcon,
  zap: ZapIcon,
  gem: GemIcon,
  heart: HeartIcon,
  rocket: RocketIcon,
  ghost: GhostIcon,
  skull: SkullIcon,
  trophy: TrophyIcon,
  sparkles: SparklesIcon,
  medal: MedalIcon,
  award: AwardIcon,
  leaf: LeafIcon,
  moon: MoonIcon,
  shield: ShieldIcon,
  swords: SwordsIcon,
  sun: SunIcon,
  snowflake: SnowflakeIcon,
  feather: FeatherIcon,
  anchor: AnchorIcon,
  mountain: MountainIcon,
  target: TargetIcon,
  infinity: InfinityIcon,
  clover: CloverIcon,
  music: MusicIcon,
  compass: CompassIcon,
  puzzle: PuzzleIcon,
  'gamepad-2': Gamepad2Icon,
};

function useTheme(): 'light' | 'dark' {
  const { theme } = useUniwind();
  return theme === 'light' ? 'light' : 'dark';
}

/** A glow name's halo as a text shadow. */
function glowStyle(glow: { color: string; radius: number }): TextStyle {
  return { textShadowColor: glow.color, textShadowRadius: glow.radius, textShadowOffset: { width: 0, height: 0 } };
}

/** A badge icon in its colour (faintly filled with it, or with its `fill` colour for a two-tone badge). */
export function CosmeticBadge({ badge, size = 16 }: { badge: BadgeStyle; size?: number }) {
  const theme = useTheme();
  const As = (BADGE_ICONS as Partial<Record<string, LucideIcon>>)[badge.icon] ?? StarIcon;
  const color = themedColor(badge, theme)!;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      <As color={color} fill={badge.fill ?? color} fillOpacity={badge.fill ? 0.5 : 0.22} size={size} strokeWidth={2.25} />
    </View>
  );
}

/**
 * A player's name in their equipped name colour, followed by their badge. `look` overrides the lookup (the shop's
 * previews); otherwise it follows `userId` (no id: plain text). Layout like a Text that may shrink: the badge stays
 * visible when the name is truncated.
 */
export function PlayerName({
  userId,
  name,
  look,
  className,
  style,
  numberOfLines = 1,
  badgeSize,
  containerClassName,
}: {
  userId?: string | null;
  name: string;
  look?: Cosmetics;
  className?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Defaults to about the text's cap height for 15 pt text. */
  badgeSize?: number;
  containerClassName?: string;
}) {
  const theme = useTheme();
  const fetched = useCosmetics(look ? null : userId);
  const c = look ?? fetched;
  const color = themedColor(c?.nameColor, theme);
  const glow = nameGlow(c?.nameColor, theme);
  const text = (
    <Text
      className={cn('shrink', className)}
      style={[style, color ? { color } : null, glow ? glowStyle(glow) : null]}
      numberOfLines={numberOfLines}
    >
      {name}
    </Text>
  );
  if (!c?.badge) return text;
  return (
    <View className={cn('shrink flex-row items-center gap-1', containerClassName)}>
      {text}
      <CosmeticBadge badge={c.badge} size={badgeSize ?? 15} />
    </View>
  );
}

/**
 * The frame's ring: a circle stroke through the frame's colours (diagonal gradient), `size` the square it is drawn
 * in, `width` the stroke. Absolutely positioned; place it over or around the avatar disc. A `dotted` frame strokes
 * beads instead of a solid line; a `spin` frame turns slowly.
 */
export const AvatarFrameRing = memo(function AvatarFrameRing({
  frame,
  size,
  width,
  style,
}: {
  frame: FrameStyle;
  size: number;
  width: number;
  style?: StyleProp<ViewStyle>;
}) {
  const id = useSvgId('frame');
  const stops = gradientStops(frame.colors);
  const r = (size - width) / 2;
  const ring = (
    <Svg width={size} height={size} style={frame.spin ? undefined : [{ position: 'absolute' }, style]} pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {stops.map((s, i) => (
            <Stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={1} />
          ))}
        </LinearGradient>
      </Defs>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={`url(#${id})`}
        strokeWidth={width}
        fill="none"
        {...(frame.dotted ? { strokeDasharray: beadDashes(r, width), strokeLinecap: 'round' as const } : {})}
      />
    </Svg>
  );
  return frame.spin ? (
    <Spinning size={size} style={style}>
      {ring}
    </Spinning>
  ) : (
    ring
  );
});

/** One full turn of a spinning frame, in ms. */
const SPIN_MS = 9000;

/** Turns its content around its centre, one turn per SPIN_MS on the shared frame clock; still under Reduce Motion. */
function Spinning({ size, style, children }: { size: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  const turn = useSharedValue(0);
  useFrameCallback((frame) => {
    turn.value = (frame.timestamp % SPIN_MS) / SPIN_MS;
  }, !reducedMotion);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size }, style, spin]}>
      {children}
    </Animated.View>
  );
}

/** A banner's gradient filling its box (left to right, slightly diagonal), with rounded corners from `radius`. */
export const ProfileBanner = memo(function ProfileBanner({
  banner,
  radius = 24,
  className,
  style,
}: {
  banner: BannerStyle;
  radius?: number;
  className?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const id = useSvgId('banner');
  const stops = gradientStops(banner.colors);
  return (
    <View className={cn('overflow-hidden', className)} style={[{ borderRadius: radius }, style]} pointerEvents="none">
      <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0.2" x2="1" y2="0.8">
            {stops.map((s, i) => (
              <Stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={1} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={100} height={100} fill={`url(#${id})`} />
      </Svg>
      {banner.pattern ? <BannerTexture pattern={banner.pattern} /> : null}
      {banner.shine ? <BannerShine /> : null}
    </View>
  );
});

const INK = '#FFFFFF';

/**
 * The banner textures: one tile each, repeated in screen points (not stretched with the banner), in faint white so
 * they read on any gradient.
 */
const TEXTURES: Record<BannerPattern, { size: number; tile: ReactNode }> = {
  // Diagonal pinstripes; the corner stubs keep the lines unbroken across tiles.
  stripes: {
    size: 10,
    tile: (
      <G stroke={INK} strokeOpacity={0.12} strokeWidth={1.5}>
        <Line x1={0} y1={10} x2={10} y2={0} />
        <Line x1={-1} y1={1} x2={1} y2={-1} />
        <Line x1={9} y1={11} x2={11} y2={9} />
      </G>
    ),
  },
  // Staggered polka dots.
  dots: {
    size: 16,
    tile: (
      <G fill={INK} fillOpacity={0.3}>
        <Circle cx={4} cy={4} r={1.6} />
        <Circle cx={12} cy={12} r={1.6} />
      </G>
    ),
  },
  // A fine drafting grid.
  grid: {
    size: 14,
    tile: (
      <G fill={INK} fillOpacity={0.16}>
        <Rect x={0} y={0} width={14} height={0.75} />
        <Rect x={0} y={0} width={0.75} height={14} />
      </G>
    ),
  },
  // A scattered star field: specks of a few sizes and brightnesses.
  stars: {
    size: 48,
    tile: (
      <G fill={INK}>
        <Circle cx={5} cy={7} r={0.9} fillOpacity={0.85} />
        <Circle cx={21} cy={3} r={0.55} fillOpacity={0.55} />
        <Circle cx={33} cy={14} r={1.25} fillOpacity={0.9} />
        <Circle cx={44} cy={6} r={0.5} fillOpacity={0.45} />
        <Circle cx={13} cy={22} r={0.6} fillOpacity={0.6} />
        <Circle cx={26} cy={29} r={0.8} fillOpacity={0.75} />
        <Circle cx={41} cy={33} r={0.55} fillOpacity={0.5} />
        <Circle cx={7} cy={38} r={1.1} fillOpacity={0.8} />
        <Circle cx={19} cy={44} r={0.5} fillOpacity={0.4} />
        <Circle cx={36} cy={43} r={0.75} fillOpacity={0.65} />
      </G>
    ),
  },
};

function BannerTexture({ pattern }: { pattern: BannerPattern }) {
  const id = useSvgId('texture');
  const t = TEXTURES[pattern];
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id={id} patternUnits="userSpaceOnUse" x={0} y={0} width={t.size} height={t.size}>
          {t.tile}
        </Pattern>
      </Defs>
      <Rect x={0} y={0} width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/** One sheen pass plus the pause before the next, in ms, and the share of it the sheen spends crossing. */
const SHINE_MS = 5200;
const SHINE_SWEEP = 0.3;

/**
 * A soft white band gliding across the banner, then a pause (the skeleton's sweep, slower and fainter). Every banner on
 * screen reads the same frame clock. Nothing under Reduce Motion.
 */
function BannerShine() {
  const reducedMotion = useReducedMotion();
  const id = useSvgId('shine');
  const progress = useSharedValue(0);
  const width = useSharedValue(0);
  useFrameCallback((frame) => {
    progress.value = (frame.timestamp % SHINE_MS) / SHINE_MS;
  }, !reducedMotion);
  const band = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(progress.value, [0, SHINE_SWEEP], [-width.value, width.value], Extrapolation.CLAMP) },
    ],
  }));
  // .set(): the React Compiler-safe shared value write.
  const measure = (e: LayoutChangeEvent) => width.set(e.nativeEvent.layout.width);
  if (reducedMotion) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, band]} pointerEvents="none" onLayout={measure}>
      <Svg width="100%" height="100%" viewBox="0 0 1 1" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0.5">
            <Stop offset={0.35} stopColor={INK} stopOpacity={0} />
            <Stop offset={0.5} stopColor={INK} stopOpacity={0.28} />
            <Stop offset={0.65} stopColor={INK} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={1} height={1} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

/**
 * A shop item drawn on its own (the shop tiles): a name colour as "Aa", a frame as a ring round an empty disc, a
 * banner as its gradient, a badge as its icon. `size` is the square it fills. Extras (glow, spin, beads, texture,
 * shine, two-tone) show here too.
 */
export function CosmeticPreview({ item, size = 64 }: { item: Pick<ShopItem, 'kind' | 'data' | 'name'>; size?: number }) {
  const theme = useTheme();
  switch (item.kind) {
    case 'name_color': {
      const c = parseCosmeticData('name_color', item.data);
      const glow = nameGlow(c ?? undefined, theme);
      return (
        <View className="items-center justify-center" style={{ width: size, height: size }}>
          <Text
            className="font-extrabold tracking-tight"
            style={[{ color: themedColor(c ?? undefined, theme), fontSize: size * 0.42 }, glow ? glowStyle(glow) : null]}
          >
            Aa
          </Text>
        </View>
      );
    }
    case 'avatar_frame': {
      const f = parseCosmeticData('avatar_frame', item.data);
      const disc = size * 0.66;
      return (
        <View className="items-center justify-center" style={{ width: size, height: size }}>
          {f ? <AvatarFrameRing frame={f} size={size * 0.86} width={Math.max(3, size * 0.07)} /> : null}
          <View className="bg-subtle border-subtle-line rounded-full border" style={{ width: disc, height: disc }} />
        </View>
      );
    }
    case 'profile_banner': {
      const b = parseCosmeticData('profile_banner', item.data);
      return b ? <ProfileBanner banner={b} radius={14} style={{ width: size * 1.25, height: size * 0.78 }} /> : null;
    }
    case 'badge': {
      const b = parseCosmeticData('badge', item.data);
      return (
        <View className="items-center justify-center" style={{ width: size, height: size }}>
          {b ? <CosmeticBadge badge={b} size={size * 0.5} /> : null}
        </View>
      );
    }
    default:
      return null;
  }
}
