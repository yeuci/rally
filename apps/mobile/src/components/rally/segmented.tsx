import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Pill segmented control (monochrome: the selected segment is the card colour on a muted track). With `scrollable`
 * the options scroll horizontally when they do not fit, so long board lists stay usable in a narrow column.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  scrollable = false,
  className,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  scrollable?: boolean;
  className?: string;
  accessibilityLabel?: string;
}) {
  const segments = options.map((o) => {
    const selected = o.value === value;
    return (
      <Pressable
        key={o.value}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        onPress={() => onChange(o.value)}
        hitSlop={4}
        className={cn(
          'items-center justify-center rounded-full border',
          size === 'sm' ? 'h-7 px-3' : 'h-8 px-4',
          selected ? 'bg-card border-subtle-line' : 'border-transparent active:opacity-70',
        )}
      >
        <Text
          className={cn(
            'font-semibold',
            size === 'sm' ? 'text-xs' : 'text-[13px]',
            selected ? 'text-foreground' : 'text-muted-foreground',
          )}
          numberOfLines={1}
        >
          {o.label}
        </Text>
      </Pressable>
    );
  });
  return (
    <View
      className={cn('bg-muted flex-row self-start rounded-full p-[3px]', className)}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      {scrollable ? (
        // A horizontal ScrollView grows by default (flexGrow 1): in a column it stretched the track into a tall slab
        // under the boards. In this row it only shrinks to the track's width (max-w-full), and never grows.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerClassName="flex-row"
        >
          {segments}
        </ScrollView>
      ) : (
        <View className="flex-row">{segments}</View>
      )}
    </View>
  );
}
