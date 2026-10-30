import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The app's one section header. `title` (default): bold label, optional muted detail (a count, "3 / 5") and an
 * accessory on the right (See all, a segmented control). `group`: the small muted caps label over a settings-style
 * card (Settings, Profile).
 */
export function SectionHeader({
  title,
  detail,
  accessory,
  variant = 'title',
  className,
  style,
}: {
  title: string;
  detail?: string;
  accessory?: ReactNode;
  variant?: 'title' | 'group';
  className?: string;
  /** Overrides the default 16 pt side padding (e.g. with the safe-area insets in landscape). */
  style?: StyleProp<ViewStyle>;
}) {
  if (variant === 'group') {
    return (
      <View className={cn('flex-row items-end justify-between gap-3 px-1', className)} style={style}>
        <Text
          variant="muted"
          className="shrink text-[13px] font-semibold uppercase leading-[18px] tracking-wide"
          role="heading"
          numberOfLines={1}
        >
          {title}
        </Text>
        {accessory}
      </View>
    );
  }
  return (
    <View className={cn('flex-row items-end justify-between gap-3 px-4', className)} style={style}>
      <View className="shrink flex-row items-baseline gap-2">
        <Text className="text-[17px] font-bold leading-[22px] tracking-tight" role="heading" numberOfLines={1}>
          {title}
        </Text>
        {detail ? <Text className="text-muted-foreground text-[13px] font-medium">{detail}</Text> : null}
      </View>
      {accessory}
    </View>
  );
}

/** A SectionHeader's text action ("See all", "Show less", "Clear"): one size, one pressed state, the tap haptic. */
export function HeaderAction({
  label,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      className="active:opacity-70"
    >
      <Text className="text-[15px] font-semibold">{label}</Text>
    </TapPressable>
  );
}
