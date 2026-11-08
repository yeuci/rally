import { CheckIcon, PartyPopperIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { useSession } from '@/lib/auth/session';
import { useInviteToParty, useParty } from '@/lib/party';
import { INVITE_SENT_MS, memberOf } from '@/lib/party-model';
import { showToast } from '@/lib/toast';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

/**
 * **Invite to party** as the round icon on Friends rows (beside Join and Message): `invite_to_party`, creating the party
 * first when the caller has none (lib/party.ts `useInviteToParty`). A check for ten seconds afterwards and a toast;
 * nothing for a friend who is already in the party. A failure is the hook's alert.
 */
export function InviteToPartyButton({ userId, name, className }: { userId: string; name: string; className?: string }) {
  const palette = usePalette();
  const { userId: me } = useSession();
  const party = useParty();
  const invite = useInviteToParty();
  const [sentAt, setSentAt] = useState<number | null>(null);
  useEffect(() => {
    if (sentAt === null) return;
    const timer = setTimeout(() => setSentAt(null), INVITE_SENT_MS);
    return () => clearTimeout(timer);
  }, [sentAt]);
  if (!me || memberOf(party.data, userId)) return null;
  const busy = invite.isPending && invite.variables === userId;
  const sent = sentAt !== null;
  return (
    <TapPressable
      onPress={() =>
        invite.mutate(userId, {
          onSuccess: () => {
            setSentAt(Date.now());
            showToast(`Party invite sent to ${name}`);
          },
        })
      }
      disabled={invite.isPending || sent}
      accessibilityRole="button"
      accessibilityLabel={sent ? `Party invite sent to ${name}` : `Invite ${name} to your party`}
      hitSlop={6}
      className={cn('bg-secondary active:bg-accent size-8 items-center justify-center rounded-full', className)}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.foreground} />
      ) : (
        <Icon as={sent ? CheckIcon : PartyPopperIcon} className="text-secondary-foreground size-4" />
      )}
    </TapPressable>
  );
}
