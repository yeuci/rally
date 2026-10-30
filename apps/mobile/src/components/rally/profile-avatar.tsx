import { resolveAvatarUrl } from '@/lib/profile';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { initialsFor, type Profile } from '@/lib/profile';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { Image } from './image';

const SIZES = {
  sm: { px: 36, text: 'text-sm', ring: 1.5, gap: 2 },
  md: { px: 44, text: 'text-base', ring: 2, gap: 2 },
  xl: { px: 96, text: 'text-3xl', ring: 3, gap: 4 },
} as const;

/** `avatar_url` through expo-image, else initials on a subtly tinted disc; `ring` adds a thin foreground-coloured ring. */
export function ProfileAvatar({
  profile,
  size = 'md',
  ring = false,
  badge,
  className,
}: {
  profile: Pick<Profile, 'username' | 'display_name' | 'avatar_url'> | null | undefined;
  size?: keyof typeof SIZES;
  ring?: boolean;
  /** Small count bubble on the top-right edge (pending friend requests); hidden when null. */
  badge?: string | null;
  className?: string;
}) {
  const avatarUri = resolveAvatarUrl(profile?.avatar_url);
  const s = SIZES[size];
  const palette = usePalette();
  const disc = (
    <View
      className={cn('bg-subtle items-center justify-center overflow-hidden rounded-full', !ring && className)}
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
    return bubble ? (
      <View className={className} style={{ width: s.px, height: s.px }}>
        {disc}
        {bubble}
      </View>
    ) : (
      disc
    );
  }

  const outer = s.px + (s.ring + s.gap) * 2;
  return (
    <View className={cn('items-center justify-center', className)} style={{ width: outer, height: outer }}>
      <Svg width={outer} height={outer} style={{ position: 'absolute' }}>
        <Circle cx={outer / 2} cy={outer / 2} r={(outer - s.ring) / 2} stroke={palette.foreground} strokeWidth={s.ring} fill="none" />
      </Svg>
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
