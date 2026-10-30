import { View } from 'react-native';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Text } from '@/components/ui/text';
import type { Profile } from '@/lib/profile';
import { ProfileAvatar } from './profile-avatar';

/**
 * App Store 4.7.3: explicit consent before a game sees the user's identity. Shown on the first launch of each
 * game; the decision is stored in `game_consents`.
 */
export function ConsentDialog({
  open,
  gameTitle,
  profile,
  busy,
  onAllow,
  onDecline,
}: {
  open: boolean;
  gameTitle: string;
  profile: Profile | null | undefined;
  busy: boolean;
  onAllow: () => void;
  onDecline: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onDecline()}>
      <AlertDialogContent className="w-[22rem] max-w-full">
        <AlertDialogHeader>
          <AlertDialogTitle>Share your Rally username and avatar with {gameTitle}?</AlertDialogTitle>
          <AlertDialogDescription>
            {gameTitle} will see your username and avatar so other players can recognise you. It never sees your email,
            birthday or friends list. You can play only if you allow this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <View className="bg-muted flex-row items-center gap-3 rounded-lg p-3">
          <ProfileAvatar profile={profile} size="sm" />
          <View className="shrink">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {profile?.display_name || profile?.username}
            </Text>
            <Text variant="muted" className="text-xs" numberOfLines={1}>
              @{profile?.username}
            </Text>
          </View>
        </View>
        <AlertDialogFooter>
          <AlertDialogAction onPress={onAllow} disabled={busy}>
            <Text>{busy ? 'Saving…' : 'Allow and play'}</Text>
          </AlertDialogAction>
          <AlertDialogCancel onPress={onDecline} disabled={busy}>
            <Text>Not now</Text>
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
