import { router } from 'expo-router';
import { ChevronRightIcon, LifeBuoyIcon, LogOutIcon, PencilIcon, Trash2Icon, WrenchIcon, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
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
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { signOut } from '@/lib/auth/providers';
import { useProfile } from '@/lib/profile';
import { cn } from '@/lib/utils';

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const p = profile.data;

  const mail = (subject: string) => {
    const body = p ? `Username: ${p.username}\n\n` : '';
    void Linking.openURL(`mailto:${config.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  };

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 px-4 pt-4"
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      <View className="items-center gap-3">
        <ProfileAvatar profile={p} size="xl" />
        {p ? (
          <View className="items-center gap-1">
            <Text variant="h3">{p.display_name || p.username}</Text>
            <Text variant="muted">@{p.username}</Text>
          </View>
        ) : (
          <View className="items-center gap-2">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-24" />
          </View>
        )}
        {p?.bio ? <Text className="max-w-sm text-center leading-6">{p.bio}</Text> : null}
        <Button variant="outline" size="sm" className="mt-1" onPress={() => router.push('/profile/edit')} disabled={!p}>
          <Icon as={PencilIcon} className="size-4" />
          <Text>Edit profile</Text>
        </Button>
      </View>

      <View className="bg-card border-border overflow-hidden rounded-xl border">
        {config.devTools && (
          <>
            <Row icon={WrenchIcon} label="Developer" onPress={() => router.push('/dev')} />
            <Separator />
          </>
        )}
        <Row icon={LifeBuoyIcon} label="Help & support" onPress={() => mail('Rally support')} />
        <Separator />
        <Row
          icon={LogOutIcon}
          label={signingOut ? 'Signing out…' : 'Sign out'}
          onPress={() => {
            setSigningOut(true);
            void signOut().finally(() => setSigningOut(false));
          }}
        />
      </View>

      <View className="bg-card border-border overflow-hidden rounded-xl border">
        <Row icon={Trash2Icon} label="Delete account" destructive onPress={() => setDeleteOpen(true)} />
      </View>

      <Text variant="muted" className="text-center text-xs">
        Rally {config.appVersion}
      </Text>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="w-[22rem] max-w-full">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              Email us from the address on your account and we&apos;ll permanently delete your profile, saves and play
              history. In-app deletion is coming soon.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onPress={() => mail('Delete my Rally account')}>
              <Text>Email {config.supportEmail}</Text>
            </AlertDialogAction>
            <AlertDialogCancel>
              <Text>Cancel</Text>
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollView>
  );
}

function Row({ icon, label, onPress, destructive }: { icon: LucideIcon; label: string; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="active:bg-accent flex-row items-center gap-3 px-4 py-3.5">
      <Icon as={icon} className={cn('size-5', destructive ? 'text-destructive' : 'text-muted-foreground')} />
      <Text className={cn('flex-1', destructive && 'text-destructive')}>{label}</Text>
      {!destructive && <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />}
    </Pressable>
  );
}
