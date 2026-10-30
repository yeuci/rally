import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export type FieldTone = 'muted' | 'error' | 'success';

/** Label + control + one line of helper text (with an icon when it is an error or a success). */
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
    <View className={cn('gap-2', className)}>
      <Label nativeID={id} className="text-secondary-foreground text-[13px] font-semibold">
        {label}
      </Label>
      {children}
      {hint ? (
        <View className="flex-row items-center gap-1.5 px-1" accessibilityLiveRegion={tone === 'muted' ? 'none' : 'polite'}>
          {tone === 'error' && <Icon as={CircleAlertIcon} className="text-destructive size-3.5" />}
          {tone === 'success' && <Icon as={CircleCheckIcon} className="text-success size-3.5" />}
          <Text
            className={cn(
              'shrink text-xs leading-4',
              tone === 'error' && 'text-destructive font-medium',
              tone === 'success' && 'text-success font-medium',
              tone === 'muted' && 'text-muted-foreground',
            )}
          >
            {hint}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <View
      className="border-destructive-line bg-destructive-soft flex-row items-start gap-2.5 rounded-xl border px-3.5 py-3"
      accessibilityLiveRegion="polite"
    >
      <Icon as={CircleAlertIcon} className="text-destructive mt-px size-4" />
      <Text className="text-destructive shrink text-sm font-medium leading-5">{children}</Text>
    </View>
  );
}
