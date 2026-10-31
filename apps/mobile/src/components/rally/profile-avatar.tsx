import { resolveAvatarUrl } from '@/lib/profile';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useCosmetics } from '@/lib/coins';
import type { Cosmetics } from '@/lib/coins-model';
import { initialsFor, type Profile } from '@/lib/profile';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { AvatarFrameRing } from './cosmetics';
import { Image } from './image';

const SIZES = {
  sm: { px: 36, text: 'text-sm', ring: 1.5, gap: 2, frame: 2.5 },
  md: { px: 44, text: 'text-base', ring: 2, gap: 2, frame: 3 },
  xl: { px: 96, text: 'text-3xl', ring: 3, gap: 4, frame: 4.5 },
} as const;

/**
 * `avatar_url` through expo-image, else initials on a subtly tinted disc; `ring` adds a thin foreground-coloured ring.
 * The player's equipped avatar frame (coins shop) replaces that ring with a thicker gradient one; without `ring` the
 * frame is drawn on the disc's edge, so the avatar keeps its size in lists either way. The frame follows `userId` (or
 * `profile.id`); `look` overrides it (the shop's previews). No id: no frame.
 */
export function ProfileAvatar({
  profile,
  userId,
  look,
  size = 'md',
  ring = false,
  badge,
  className,
}: {
  profile: (Pick<Profile, 'username' | 'display_name' | 'avatar_url'> & { id?: string }) | null | undefined;
  userId?: string | null;
  look?: Cosmetics;
  size?: keyof typeof SIZES;
  ring?: boolean;
  /** Small count bubble on the top-right edge (pending friend requests); hidden when null. */
  badge?: string | null;
  className?: string;
}) {
  const avatarUri = resolveAvatarUrl(profile?.avatar_url);
  const s = SIZES[size];
  const palette = usePalette();
  const fetched = useCosmetics(look ? null : (userId ?? profile?.id));
  const frame = (look ?? fetched)?.frame;
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
