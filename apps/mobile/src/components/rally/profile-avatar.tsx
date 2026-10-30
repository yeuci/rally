import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
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
  className,
}: {
  profile: Pick<Profile, 'username' | 'display_name' | 'avatar_url'> | null | undefined;
  size?: keyof typeof SIZES;
  ring?: boolean;
  className?: string;
}) {
  const s = SIZES[size];
  const palette = usePalette();
  const disc = (
    <View
      className={cn('bg-subtle items-center justify-center overflow-hidden rounded-full', !ring && className)}
      style={{ width: s.px, height: s.px }}
    >
      {profile?.avatar_url ? (
        <Image source={{ uri: profile.avatar_url }} className="absolute inset-0" contentFit="cover" transition={150} />
      ) : (
        <Text className={cn('text-foreground font-bold', s.text)}>{initialsFor(profile)}</Text>
      )}
    </View>
  );
  if (!ring) return disc;

  const outer = s.px + (s.ring + s.gap) * 2;
  return (
    <View className={cn('items-center justify-center', className)} style={{ width: outer, height: outer }}>
      <Svg width={outer} height={outer} style={{ position: 'absolute' }}>
        <Circle cx={outer / 2} cy={outer / 2} r={(outer - s.ring) / 2} stroke={palette.foreground} strokeWidth={s.ring} fill="none" />
      </Svg>
      {disc}
    </View>
  );
}
