import { ChevronRightIcon, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { TapPressable, type TapPressableProps } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { SectionHeader } from './section-header';

/**
 * Grouped rows for Settings and Profile: a titled card (`SettingsGroup`) of icon rows that open something
 * (`SettingsRow`) or flip a preference (`ToggleRow`). Rows give the shell's tap haptic (TapPressable).
 */
export function SettingsGroup({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      {title ? <SectionHeader variant="group" title={title} /> : null}
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

/**
 * The pressable part of a grouped row. Its press highlight is a rounded surface inset from the card's edges and from the
 * hairlines between rows: a full-width highlight met the indented hairline under it at a step (a jagged notch below the
 * icon). The insets add up to the rows' usual 16 × 12 padding, so nothing moves.
 */
export function RowPressable({
  className,
  children,
  ...props
}: Omit<TapPressableProps, 'children'> & { className?: string; children: ReactNode }) {
  return (
    <TapPressable {...props} className={cn('px-1.5 py-1', className)}>
      {({ pressed }) => (
        <View className={cn('flex-row items-center gap-3.5 rounded-xl px-2.5 py-2', pressed && 'bg-accent')}>
          {children}
        </View>
      )}
    </TapPressable>
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
    <RowPressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      className={disabled ? 'opacity-60' : undefined}
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
    </RowPressable>
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
    <RowPressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
    >
      <RowIcon icon={icon} />
      <Text className="flex-1 text-[15px] font-medium">{label}</Text>
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Switch checked={value} onCheckedChange={onChange} />
      </View>
    </RowPressable>
  );
}

/** A read-only row: icon, label and the current value (a setting the app follows but does not own, like the OS's). */
export function ValueRow({ icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <View className="flex-row items-center gap-3.5 px-4 py-3" accessible accessibilityLabel={`${label}, ${value}`}>
      <RowIcon icon={icon} />
      <Text className="flex-1 text-[15px] font-medium" numberOfLines={1}>
        {label}
      </Text>
      <Text variant="muted" className="text-[15px]" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}
