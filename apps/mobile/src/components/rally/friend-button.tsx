import { CheckIcon, ClockIcon, UserPlusIcon, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFriendshipAction } from '@/lib/friends';
import { confirmCopy, describeSocialError, friendButtons, type FriendIntent, type Friendship } from '@/lib/social';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './confirm-dialog';

const ICON: Partial<Record<FriendIntent, LucideIcon>> = {
  send: UserPlusIcon,
  cancel: ClockIcon,
  accept: CheckIcon,
  remove: CheckIcon,
};

/**
 * Friendship button(s) for a player, driven by lib/social.ts `friendButtons`: `profile` (public profile: Add friend /
 * Requested (tap to cancel) / Accept + Decline / Friends (tap to remove, confirmed)) or `compact` (one small button in
 * list rows). Optimistic through `useFriendshipAction`; a failure is reported in a native alert.
 */
export function FriendButtons({
  userId,
  name,
  status,
  mode,
  className,
}: {
  userId: string;
  /** "@username", used in labels and the confirmation. */
  name: string;
  status: Friendship;
  mode: 'profile' | 'compact';
  className?: string;
}) {
  const action = useFriendshipAction();
  const [confirming, setConfirming] = useState<FriendIntent | null>(null);
  const specs = friendButtons(status, mode, name);
  if (specs.length === 0) return null;

  const busy = action.isPending && action.variables?.userId === userId;
  const run = (intent: FriendIntent) =>
    action.mutate(
      { userId, intent, current: status },
      { onError: (err) => Alert.alert("Couldn't update", describeSocialError(err)) },
    );
  const copy = confirming ? confirmCopy(confirming, name) : null;
  const compact = mode === 'compact';

  return (
    <View className={cn('flex-row gap-2', !compact && 'w-full max-w-sm', className)}>
      {specs.map((spec) => {
        const icon = ICON[spec.intent];
        return (
          <Button
            key={spec.intent}
            variant={spec.variant}
            size="sm"
            disabled={busy}
            accessibilityLabel={spec.accessibilityLabel}
            onPress={() => (spec.confirm ? setConfirming(spec.intent) : run(spec.intent))}
            className={cn('rounded-full', compact ? 'h-8 px-3.5' : 'h-10 flex-1')}
          >
            {icon && !compact && <Icon as={icon} className={cn('size-4', spec.variant === 'default' && 'text-primary-foreground')} />}
            <Text className={compact ? 'text-[13px]' : 'text-[15px]'}>{spec.label}</Text>
          </Button>
        );
      })}
      {copy && (
        <ConfirmDialog
          open={!!confirming}
          onOpenChange={(open) => !open && setConfirming(null)}
          title={copy.title}
          body={copy.body}
          action={copy.action}
          destructive
          onConfirm={() => {
            const intent = confirming;
            setConfirming(null);
            if (intent) run(intent);
          }}
        />
      )}
    </View>
  );
}

/** Same footprint as the profile's friendship button row while `friendship_with` loads. */
export function FriendButtonsSkeleton({ mode }: { mode: 'profile' | 'compact' }) {
  return mode === 'compact' ? (
    <Skeleton className="h-8 w-[68px] rounded-full" />
  ) : (
    <View className="w-full max-w-sm flex-row">
      <Skeleton className="h-10 flex-1 rounded-full" />
    </View>
  );
}
