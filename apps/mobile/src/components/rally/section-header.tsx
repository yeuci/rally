import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** Compact row title: bold label, optional muted detail (a count, "2 new") or an accessory on the right. */
export function SectionHeader({
  title,
  detail,
  accessory,
  className,
}: {
  title: string;
  detail?: string;
  accessory?: ReactNode;
  className?: string;
}) {
  return (
    <View className={cn('flex-row items-end justify-between gap-3 px-4', className)}>
      <View className="shrink flex-row items-baseline gap-2">
        <Text className="text-[17px] font-bold tracking-tight" role="heading" numberOfLines={1}>
          {title}
        </Text>
        {detail ? <Text className="text-muted-foreground text-[13px] font-medium">{detail}</Text> : null}
      </View>
      {accessory}
    </View>
  );
}
