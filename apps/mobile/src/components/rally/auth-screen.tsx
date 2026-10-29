import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';

/** Shared shell for the signed-out screens: keyboard-aware scroll, safe areas, title + lede. */
export function AuthScreen({ title, lede, children, footer }: { title?: string; lede?: string; children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView className="bg-background flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="grow gap-6 px-6"
        contentContainerStyle={{ paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {(title || lede) && (
          <View className="gap-2">
            {title && <Text variant="h3">{title}</Text>}
            {lede && <Text variant="muted" className="text-base leading-6">{lede}</Text>}
          </View>
        )}
        <View className="gap-4">{children}</View>
        {footer && <View className="mt-auto gap-2 pt-4">{footer}</View>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
