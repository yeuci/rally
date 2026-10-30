import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Text } from '@/components/ui/text';
import { ACCENT_STOPS } from '@/lib/brand';
import { initialsFor, type Profile } from '@/lib/profile';
import { cn } from '@/lib/utils';
import { Image } from './image';
import { useSvgId } from './logo';

const SIZES = {
  sm: { px: 36, text: 'text-sm', ring: 1.5, gap: 2 },
  md: { px: 44, text: 'text-base', ring: 2, gap: 2 },
  xl: { px: 96, text: 'text-3xl', ring: 3, gap: 4 },
} as const;

/** `avatar_url` through expo-image, else initials on a brand-tinted disc; `ring` adds the accent-gradient ring. */
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
  const id = useSvgId('avatar-ring');
  const disc = (
    <View
      className={cn('bg-brand-soft items-center justify-center overflow-hidden rounded-full', !ring && className)}
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
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            {ACCENT_STOPS.map((stop) => (
              <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
            ))}
          </LinearGradient>
        </Defs>
        <Circle cx={outer / 2} cy={outer / 2} r={(outer - s.ring) / 2} stroke={`url(#${id})`} strokeWidth={s.ring} fill="none" />
      </Svg>
      {disc}
    </View>
  );
}
