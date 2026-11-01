import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { columnPadding } from '@/lib/layout';
import { LogoMark } from './logo';
import { useViewport } from '@/lib/viewport';

/**
 * Shared shell for the signed-out screens: keyboard-aware scroll, safe areas, the mark, title + lede. The header
 * above is transparent (back button only), so content starts below its row (44 pt; 32 pt in landscape on a phone).
 * Landscape / tablet: a centred column of at most 560 pt inside the safe area, so forms never run edge to edge.
 */
export function AuthScreen({ title, lede, children, footer }: { title?: string; lede?: string; children: ReactNode; footer?: ReactNode }) {
  const { width, height, insets } = useViewport();
  const column = columnPadding(width, insets, 560, 24);
  const header = width > height ? 44 : 60;
  return (
    <KeyboardAvoidingView className="bg-background flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="grow gap-7"
        contentContainerStyle={[column, { paddingTop: insets.top + header, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {(title || lede) && (
          <View className="gap-3">
            <LogoMark size={36} style={{ marginLeft: -7 }} />
            <View className="gap-2">
              {title && (
                <Text className="text-[28px] font-extrabold leading-[34px] tracking-tight" role="heading">
                  {title}
                </Text>
              )}
              {lede && <Text className="text-muted-foreground text-base leading-6">{lede}</Text>}
            </View>
          </View>
        )}
        <View className="gap-5">{children}</View>
        {footer && <View className="mt-auto gap-3 pt-4">{footer}</View>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
