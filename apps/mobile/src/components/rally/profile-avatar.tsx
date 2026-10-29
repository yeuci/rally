import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { initialsFor, type Profile } from '@/lib/profile';
import { cn } from '@/lib/utils';
import { Image } from './image';

const SIZES = {
  sm: { box: 'size-9', text: 'text-sm' },
  md: { box: 'size-12', text: 'text-base' },
  xl: { box: 'size-24', text: 'text-3xl' },
} as const;

/** `avatar_url` through expo-image, else initials on a muted disc. */
export function ProfileAvatar({
  profile,
  size = 'md',
  className,
}: {
  profile: Pick<Profile, 'username' | 'display_name' | 'avatar_url'> | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <View className={cn('bg-muted items-center justify-center overflow-hidden rounded-full', s.box, className)}>
      {profile?.avatar_url ? (
        <Image source={{ uri: profile.avatar_url }} className="absolute inset-0" contentFit="cover" transition={150} />
      ) : (
        <Text className={cn('text-muted-foreground font-semibold', s.text)}>{initialsFor(profile)}</Text>
      )}
    </View>
  );
}
