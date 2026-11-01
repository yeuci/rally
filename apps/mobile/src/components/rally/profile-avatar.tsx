import { resolveAvatarUrl } from '@/lib/profile';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useCosmetics } from '@/lib/coins';
import type { Cosmetics } from '@/lib/coins-model';
import { levelFraction, type LevelProgress } from '@/lib/levels-model';
import { initialsFor, type Profile } from '@/lib/profile';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { AvatarFrameRing } from './cosmetics';
import { Image } from './image';

const SIZES = {
  sm: { px: 36, text: 'text-sm', ring: 1.5, gap: 2, frame: 2.5, level: null },
  md: { px: 44, text: 'text-base', ring: 2, gap: 2, frame: 3, level: { stroke: 3, height: 16, font: 9, pad: 4 } },
  xl: { px: 96, text: 'text-3xl', ring: 3, gap: 4, frame: 4.5, level: { stroke: 4, height: 22, font: 12, pad: 7 } },
} as const;

/**
 * `avatar_url` through expo-image, else initials on a subtly tinted disc; `ring` adds a thin foreground-coloured ring.
 * The player's equipped avatar frame (coins shop) replaces that ring with a thicker gradient one; without `ring` the
 * frame is drawn on the disc's edge, so the avatar keeps its size in lists either way. The frame follows `userId` (or
 * `profile.id`); `look` overrides it (the shop's previews). No id: no frame.
 *
 * `progress` (opt-in, with `ring`, sizes md and xl): the ring becomes the account level's progress ring, a track with
 * the XP into the level drawn clockwise from the top, plus a small level badge at the bottom. Monochrome (the
 * foreground colour); an equipped frame then sits on the disc's edge inside it. `null` (hidden by the player's
 * privacy) draws the plain ring.
 */
export function ProfileAvatar({
  profile,
  userId,
  look,
  size = 'md',
  ring = false,
  progress,
  badge,
  className,
}: {
  profile: (Pick<Profile, 'username' | 'display_name' | 'avatar_url'> & { id?: string }) | null | undefined;
  userId?: string | null;
  look?: Cosmetics;
  size?: keyof typeof SIZES;
  ring?: boolean;
  /** The account level to draw as a progress ring with a level badge (needs `ring`). */
  progress?: LevelProgress | null;
  /** Small count bubble on the top-right edge (pending friend requests); hidden when null. */
  badge?: string | null;
  className?: string;
}) {
  const avatarUri = resolveAvatarUrl(profile?.avatar_url);
  const s = SIZES[size];
  const palette = usePalette();
  const fetched = useCosmetics(look ? null : (userId ?? profile?.id));
  const frame = (look ?? fetched)?.frame;
  const level = ring && progress && s.level ? s.level : null;
  const disc = (
    <View
      className={cn('bg-subtle items-center justify-center overflow-hidden rounded-full', !ring && !frame && className)}
      style={{ width: s.px, height: s.px }}
    >
      {avatarUri ? (
        <Image source={{ uri: avatarUri }} className="absolute inset-0" contentFit="cover" transition={150} placeholderClassName="rounded-full" />
      ) : (
        <Text className={cn('text-foreground font-bold', s.text)}>{initialsFor(profile)}</Text>
      )}
    </View>
  );
  const bubble = badge ? <CountBubble text={badge} /> : null;
  if (!ring) {
    return bubble || frame ? (
      <View className={className} style={{ width: s.px, height: s.px }}>
        {disc}
        {frame ? <AvatarFrameRing frame={frame} size={s.px} width={s.frame} /> : null}
        {bubble}
      </View>
    ) : (
      disc
    );
  }

  const outer = s.px + (s.ring + s.gap) * 2;
  if (level && progress) {
    return (
      <View className={cn('items-center justify-center', className)} style={{ width: outer, height: outer }}>
        <LevelRing size={outer} stroke={level.stroke} fraction={levelFraction(progress)} color={palette.foreground} />
        <View style={{ width: s.px, height: s.px }}>
          {disc}
          {frame ? <AvatarFrameRing frame={frame} size={s.px} width={s.frame} /> : null}
        </View>
        <LevelBadge level={progress.level} height={level.height} font={level.font} pad={level.pad} stroke={level.stroke} />
        {bubble}
      </View>
    );
  }
  return (
    <View className={cn('items-center justify-center', className)} style={{ width: outer, height: outer }}>
      {frame ? (
        // Thicker than the plain ring, eating into the gap rather than growing the avatar.
        <AvatarFrameRing frame={frame} size={outer} width={s.ring + s.gap * 0.75} />
      ) : (
        <Svg width={outer} height={outer} style={{ position: 'absolute' }}>
          <Circle cx={outer / 2} cy={outer / 2} r={(outer - s.ring) / 2} stroke={palette.foreground} strokeWidth={s.ring} fill="none" />
        </Svg>
      )}
      {disc}
      {bubble}
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
// Web (react-native-web) draws the final arc: Reanimated's SVG props are a native feature.
const ANIMATE_RING = Platform.OS !== 'web';

/**
 * The level's progress: a faint full track and the filled arc from 12 o'clock clockwise (round caps). The arc eases
 * to a new value (a few hundred ms; instant with Reduce motion), so XP earned while the profile is open is visible.
 */
function LevelRing({ size, stroke, fraction, color }: { size: number; stroke: number; fraction: number; color: string }) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const shown = useSharedValue(ANIMATE_RING ? 0 : fraction);
  useEffect(() => {
    // .set(): the React Compiler-safe shared value write.
    shown.set(
      ANIMATE_RING
        ? withTiming(fraction, { duration: 700, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System })
        : fraction,
    );
  }, [fraction, shown]);
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - shown.value),
    strokeOpacity: shown.value > 0.001 ? 1 : 0,
  }));
  const c = size / 2;
  return (
    <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }} pointerEvents="none">
      <Circle cx={c} cy={c} r={r} stroke={color} strokeOpacity={0.16} strokeWidth={stroke} fill="none" />
      {ANIMATE_RING ? (
        <AnimatedCircle
          cx={c}
          cy={c}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          fill="none"
          animatedProps={animatedProps}
        />
      ) : fraction > 0 ? (
        <Circle
          cx={c}
          cy={c}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - fraction)}
          fill="none"
        />
      ) : null}
    </Svg>
  );
}

/** The level number on an inverted pill, centred on the ring's bottom edge. */
function LevelBadge({ level, height, font, pad, stroke }: { level: number; height: number; font: number; pad: number; stroke: number }) {
  return (
    <View className="absolute left-0 right-0 items-center" style={{ bottom: -height / 2 + stroke }} pointerEvents="none">
      <View
        className="bg-foreground border-background items-center justify-center rounded-full border-2"
        style={{ height, minWidth: height, paddingHorizontal: pad }}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <Text className="text-background font-extrabold" style={{ fontSize: font, lineHeight: font + 2, fontVariant: ['tabular-nums'] }}>
          {level}
        </Text>
      </View>
    </View>
  );
}

function CountBubble({ text }: { text: string }) {
  return (
    <View
      className="bg-primary border-background absolute -right-1 -top-1 h-5 min-w-5 items-center justify-center rounded-full border-2 px-1"
      pointerEvents="none"
    >
      <Text className="text-primary-foreground text-[10px] font-bold leading-3">{text}</Text>
    </View>
  );
}

/** Placeholder with the exact outer size of `ProfileAvatar` at the same `size` / `ring`. */
export function ProfileAvatarSkeleton({ size = 'md', ring = false, className }: { size?: keyof typeof SIZES; ring?: boolean; className?: string }) {
  const s = SIZES[size];
  const outer = ring ? s.px + (s.ring + s.gap) * 2 : s.px;
  return (
    <View className={cn('items-center justify-center', className)} style={{ width: outer, height: outer }}>
      <Skeleton className="rounded-full" style={{ width: s.px, height: s.px }} />
    </View>
  );
}
