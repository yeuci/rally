import {
  AwardIcon,
  CrownIcon,
  FlameIcon,
  GemIcon,
  GhostIcon,
  HeartIcon,
  MedalIcon,
  RocketIcon,
  SkullIcon,
  SparklesIcon,
  StarIcon,
  TrophyIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { memo } from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useUniwind } from 'uniwind';
import { Text } from '@/components/ui/text';
import { useCosmetics } from '@/lib/coins';
import {
  gradientStops,
  parseCosmeticData,
  themedColor,
  type BadgeStyle,
  type BannerStyle,
  type Cosmetics,
  type FrameStyle,
  type ShopItem,
} from '@/lib/coins-model';
import { cn } from '@/lib/utils';
import { useSvgId } from './logo';

/**
 * Equipped cosmetics, drawn from data (no image assets; shop_items.data, 20261031000400_coins.sql): the avatar frame
 * (a gradient ring, drawn by ProfileAvatar with `AvatarFrameRing`), the name colour and badge (`PlayerName`), the
 * profile banner (`ProfileBanner`, behind ProfileHeader). Every place that shows a player uses these through the
 * shared components, so a look shows on profiles, leaderboards and friends lists alike. Colours are the item's own
 * (`light` variants keep names readable on the light theme).
 */

/** The badge icons the app knows (shop_items.data.icon); an unknown name falls back to a star. */
const BADGE_ICONS: Record<string, LucideIcon> = {
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
};

function useTheme(): 'light' | 'dark' {
  const { theme } = useUniwind();
  return theme === 'light' ? 'light' : 'dark';
}

/** A badge icon in its colour. */
export function CosmeticBadge({ badge, size = 16 }: { badge: BadgeStyle; size?: number }) {
  const theme = useTheme();
  const As = BADGE_ICONS[badge.icon] ?? StarIcon;
  const color = themedColor(badge, theme)!;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      <As color={color} fill={color} fillOpacity={0.22} size={size} strokeWidth={2.25} />
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
  const text = (
    <Text className={cn('shrink', className)} style={[style, color ? { color } : null]} numberOfLines={numberOfLines}>
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
 * in, `width` the stroke. Absolutely positioned; place it over or around the avatar disc.
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
  return (
    <Svg width={size} height={size} style={[{ position: 'absolute' }, style]} pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {stops.map((s, i) => (
            <Stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={1} />
          ))}
        </LinearGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={(size - width) / 2} stroke={`url(#${id})`} strokeWidth={width} fill="none" />
    </Svg>
  );
});

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
    </View>
  );
});

/**
 * A shop item drawn on its own (the shop tiles): a name colour as "Aa", a frame as a ring round an empty disc, a
 * banner as its gradient, a badge as its icon. `size` is the square it fills.
 */
export function CosmeticPreview({ item, size = 64 }: { item: Pick<ShopItem, 'kind' | 'data' | 'name'>; size?: number }) {
  const theme = useTheme();
  switch (item.kind) {
    case 'name_color': {
      const c = parseCosmeticData('name_color', item.data);
      return (
        <View className="items-center justify-center" style={{ width: size, height: size }}>
          <Text className="font-extrabold tracking-tight" style={{ color: themedColor(c ?? undefined, theme), fontSize: size * 0.42 }}>
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
