import { ChevronRightIcon, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Grouped rows for Settings and Profile: a titled card (`SettingsGroup`) of icon rows that open something
 * (`SettingsRow`) or flip a preference (`ToggleRow`). Rows give the shell's tap haptic (TapPressable).
 */
export function SettingsGroup({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      {title ? (
        <Text
          variant="muted"
          className="px-1 text-[13px] font-semibold uppercase leading-[18px] tracking-wide"
          role="heading"
        >
          {title}
        </Text>
      ) : null}
      <View className="bg-card border-border overflow-hidden rounded-2xl border">{children}</View>
      {footer ? (
        <Text variant="muted" className="px-1 text-[13px] leading-[18px]">
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

function RowIcon({ icon, destructive }: { icon: LucideIcon; destructive?: boolean }) {
  return (
    <View
      className={cn('size-9 items-center justify-center rounded-xl', destructive ? 'bg-destructive-soft' : 'bg-muted')}
    >
      <Icon as={icon} className={cn('size-[18px]', destructive ? 'text-destructive' : 'text-secondary-foreground')} />
    </View>
  );
}

/** A row that opens something: icon, label, optional value, chevron (none for destructive / `chevron={false}`). */
export function SettingsRow({
  icon,
  label,
  value,
  hint,
  onPress,
  destructive,
  disabled,
  chevron = !destructive,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  hint?: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  chevron?: boolean;
}) {
  return (
    <TapPressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      className={cn('active:bg-accent flex-row items-center gap-3.5 px-4 py-3', disabled && 'opacity-60')}
    >
      <RowIcon icon={icon} destructive={destructive} />
      <Text className={cn('flex-1 text-[15px] font-medium', destructive && 'text-destructive')} numberOfLines={1}>
        {label}
      </Text>
      {value ? (
        <Text variant="muted" className="shrink text-[15px]" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {chevron && <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />}
    </TapPressable>
  );
}

/**
 * A preference switch: the whole row toggles (one accessible switch; the drawn Switch is decoration and does not take
 * touches of its own, so every flip goes through the row and gives the same haptic).
 */
export function ToggleRow({
  icon,
  label,
  value,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <TapPressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      className="active:bg-accent flex-row items-center gap-3.5 px-4 py-3"
    >
      <RowIcon icon={icon} />
      <Text className="flex-1 text-[15px] font-medium">{label}</Text>
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Switch checked={value} onCheckedChange={onChange} />
      </View>
    </TapPressable>
  );
}
