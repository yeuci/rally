import { Gamepad2Icon } from 'lucide-react-native';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { Image } from './image';

/** First screenshot as the cover; a quiet monogram tile when a game has none yet. */
export function GameCover({ title, uri, className }: { title: string; uri: string | null | undefined; className?: string }) {
  return (
    <View className={cn('bg-muted overflow-hidden', className)}>
      {uri ? (
        <Image source={{ uri }} className="absolute inset-0" contentFit="cover" transition={200} accessibilityIgnoresInvertColors />
      ) : (
        <View className="flex-1 items-center justify-center gap-2">
          <Icon as={Gamepad2Icon} className="text-muted-foreground size-7" />
          <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-widest" numberOfLines={1}>
            {title}
          </Text>
        </View>
      )}
    </View>
  );
}
