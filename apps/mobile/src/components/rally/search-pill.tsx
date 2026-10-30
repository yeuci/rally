import { SearchIcon, XIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Pill-shaped search field with a clear button. A flex row (magnifier · field · clear), so the icons stay inside
 * the pill at any width; the pill draws the focus ring (same `ring` border / `field-focus` fill as Input).
 */
export function SearchPill({
  value,
  onChangeText,
  placeholder = 'Search games',
  autoFocus = false,
  onSubmitEditing,
  className,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      className={cn(
        'bg-muted h-12 flex-row items-center gap-2.5 rounded-full border pl-4 pr-3',
        focused ? 'border-ring bg-field-focus' : 'border-transparent',
        className,
      )}
    >
      <Icon as={SearchIcon} className="text-muted-foreground size-[18px]" pointerEvents="none" />
      <Input
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        className="h-full flex-1 rounded-none border-0 bg-transparent px-0 focus:border-0 focus:bg-transparent dark:bg-transparent"
        accessibilityLabel={placeholder}
      />
      {value.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          hitSlop={10}
          className="bg-fill size-6 items-center justify-center rounded-full active:opacity-70"
        >
          <Icon as={XIcon} className="text-foreground size-3.5" />
        </Pressable>
      )}
    </View>
  );
}

/**
 * The dashboard's search entry: looks like the pill, opens the search screen (`/search`, keyboard up) on tap.
 */
export function SearchPillButton({ label = 'Search games and players', onPress }: { label?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={label}
      accessibilityHint="Opens search"
      onPress={onPress}
      className="bg-muted h-12 flex-row items-center gap-2.5 rounded-full border border-transparent pl-4 pr-3 active:opacity-80"
    >
      <Icon as={SearchIcon} className="text-muted-foreground size-[18px]" />
      <Text className="text-muted-foreground shrink text-base" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
