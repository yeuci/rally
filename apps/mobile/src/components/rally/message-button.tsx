import { MessageCircleIcon } from 'lucide-react-native';
import { ActivityIndicator } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useOpenDm } from '@/lib/messages';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/**
 * "Message" for a friend (lib/messages.ts `openDm` → `/messages/[id]`; the server only opens a dm between accepted
 * friends, so callers show it for `friendship === 'friends'`). `profile`: the public profile's full button beside the
 * friendship button. `icon`: the round icon on Friends rows (next to Join when there is one). A spinner while the
 * conversation opens; a refusal is a toast.
 */
export function MessageButton({
  userId,
  name,
  mode,
  className,
}: {
  userId: string;
  name: string;
  mode: 'profile' | 'icon';
  className?: string;
}) {
  const palette = usePalette();
  const { open, pendingFor } = useOpenDm();
  const busy = pendingFor === userId;
  const label = `Message ${name}`;
  if (mode === 'icon') {
    return (
      <TapPressable
        onPress={() => void open(userId)}
        disabled={!!pendingFor}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens the conversation"
        hitSlop={6}
        className={cn(
          'bg-secondary active:bg-accent size-8 items-center justify-center rounded-full',
          !!pendingFor && !busy && 'opacity-50',
          className,
        )}
      >
        {busy ? (
          <ActivityIndicator size="small" color={palette.foreground} />
        ) : (
          <Icon as={MessageCircleIcon} className="text-secondary-foreground size-4" />
        )}
      </TapPressable>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={!!pendingFor}
      accessibilityLabel={label}
      onPress={() => void open(userId)}
      className={cn('h-10 flex-1 rounded-full', className)}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.foreground} />
      ) : (
        <Icon as={MessageCircleIcon} className="text-secondary-foreground size-4" />
      )}
      <Text className="text-[15px]">Message</Text>
    </Button>
  );
}
