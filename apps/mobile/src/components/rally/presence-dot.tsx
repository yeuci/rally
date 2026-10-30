import { View } from 'react-native';
import { cn } from '@/lib/utils';

/** The small "live" dot before a status or a count ("Online", "In Sumo", "Playing Sumo", "12 playing"). */
export function PresenceDot({ className }: { className?: string }) {
  return <View className={cn('size-2 rounded-full bg-emerald-500', className)} accessibilityElementsHidden importantForAccessibility="no" />;
}
