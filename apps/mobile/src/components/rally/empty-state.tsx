import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** Designed empty / error state: quiet icon tile, title, one line of help, optional action. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  compact = false,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  /** Row-height variant: icon beside the text instead of above it. */
  compact?: boolean;
  className?: string;
}) {
  const tile = (
    <View className={cn('bg-subtle border-subtle-line items-center justify-center border', compact ? 'size-11 rounded-xl' : 'size-14 rounded-2xl')}>
      <Icon as={icon} className={cn('text-foreground', compact ? 'size-5' : 'size-6')} />
    </View>
  );
  if (compact) {
    return (
      <View className={cn('bg-card border-border flex-row items-center gap-3.5 rounded-2xl border p-4', className)}>
        {tile}
        <View className="shrink gap-0.5">
          <Text className="text-[15px] font-semibold">{title}</Text>
          {body ? <Text className="text-muted-foreground text-[13px] leading-[18px]">{body}</Text> : null}
        </View>
      </View>
    );
  }
  return (
    <View className={cn('bg-card border-border items-center gap-3 rounded-3xl border px-6 py-8', className)}>
      {tile}
      <View className="items-center gap-1">
        <Text className="text-center text-lg font-bold tracking-tight">{title}</Text>
        {body ? <Text className="text-muted-foreground max-w-xs text-center text-sm leading-5">{body}</Text> : null}
      </View>
      {action ? <View className="pt-1">{action}</View> : null}
    </View>
  );
}
