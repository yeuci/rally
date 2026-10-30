import { SearchIcon, XIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

/** Pill-shaped search field with a clear button; the focus ring comes from Input. */
export function SearchPill({
  value,
  onChangeText,
  placeholder = 'Search games',
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <View className="justify-center">
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        className="bg-muted dark:bg-muted h-12 rounded-full border-transparent pl-11 pr-11"
        accessibilityLabel={placeholder}
      />
      <Icon as={SearchIcon} className="text-muted-foreground absolute left-4 size-[18px]" pointerEvents="none" />
      {value.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          hitSlop={10}
          className="bg-fill absolute right-3 size-6 items-center justify-center rounded-full active:opacity-70"
        >
          <Icon as={XIcon} className="text-foreground size-3.5" />
        </Pressable>
      )}
    </View>
  );
}
