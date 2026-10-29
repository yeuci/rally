import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export type FieldTone = 'muted' | 'error' | 'success';

/** Label + control + one line of helper text. */
export function FormField({
  id,
  label,
  hint,
  tone = 'muted',
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string | null;
  tone?: FieldTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <View className={cn('gap-1.5', className)}>
      <Label nativeID={id}>{label}</Label>
      {children}
      {hint ? (
        <Text
          className={cn(
            'text-xs',
            tone === 'error' && 'text-destructive',
            tone === 'success' && 'text-emerald-500',
            tone === 'muted' && 'text-muted-foreground',
          )}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <View className="border-destructive/30 bg-destructive/10 rounded-lg border px-3 py-2.5" accessibilityLiveRegion="polite">
      <Text className="text-destructive text-sm">{children}</Text>
    </View>
  );
}
