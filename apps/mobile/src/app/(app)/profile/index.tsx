import { router } from 'expo-router';
import { ChevronRightIcon, LifeBuoyIcon, LogOutIcon, PencilIcon, Trash2Icon, WrenchIcon, type LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ErrorText } from '@/components/rally/form-field';
import { Glow } from '@/components/rally/glow';
import { LogoMark } from '@/components/rally/logo';
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
import { describeAuthError } from '@/lib/auth/errors';
import { signOut } from '@/lib/auth/providers';
import { useProfile } from '@/lib/profile';
import { useColumnPadding } from '@/lib/use-layout';
import { cn } from '@/lib/utils';

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // Landscape / tablet: a centred column (≤ 600 pt) inside the safe area instead of edge-to-edge rows.
  const column = useColumnPadding();
  const glow = Math.min(width, 700) * 1.1;
  const profile = useProfile();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const p = profile.data;

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut(); // success: the root layout's session gate swaps to the welcome screen
    } catch (err) {
      setSignOutError(describeAuthError(err));
    } finally {
      setSigningOut(false);
    }
  }

  const mail = (subject: string) => {
    const body = p ? `Username: ${p.username}\n\n` : '';
    void Linking.openURL(`mailto:${config.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  };

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-6"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
    >
      {/* Centred on the window from its live width (absolute: measured from the container's edge, not its padding). */}
      <Glow size={glow} style={{ top: -glow / 2, left: width / 2 - glow / 2 }} />

      <View className="items-center gap-4">
        <ProfileAvatar profile={p} size="xl" ring />
        {p ? (
          <View className="items-center gap-1">
            <Text className="text-center text-[26px] font-extrabold leading-8 tracking-tight">{p.display_name || p.username}</Text>
            <Text className="text-muted-foreground text-[15px] font-medium">@{p.username}</Text>
          </View>
        ) : (
          <View className="items-center gap-2">
            <Skeleton className="h-7 w-40 rounded-lg" />
            <Skeleton className="h-4 w-24 rounded-full" />
          </View>
        )}
        {p?.bio ? <Text className="text-secondary-foreground max-w-sm text-center leading-6">{p.bio}</Text> : null}
        <Button variant="outline" size="sm" className="rounded-full px-4" onPress={() => router.push('/profile/edit')} disabled={!p}>
          <Icon as={PencilIcon} className="size-3.5" />
          <Text>Edit profile</Text>
        </Button>
      </View>

      <View className="bg-card border-border overflow-hidden rounded-2xl border">
        {config.devTools && (
          <>
            <Row icon={WrenchIcon} label="Developer" onPress={() => router.push('/dev')} />
            <Separator className="ml-16" />
          </>
        )}
        <Row icon={LifeBuoyIcon} label="Help & support" onPress={() => mail('Rally support')} />
        <Separator className="ml-16" />
        <Row
          icon={LogOutIcon}
          label={signingOut ? 'Signing out…' : 'Sign out'}
          onPress={() => void onSignOut()}
        />
      </View>
      <ErrorText>{signOutError}</ErrorText>

      <View className="bg-card border-border overflow-hidden rounded-2xl border">
        <Row icon={Trash2Icon} label="Delete account" destructive onPress={() => setDeleteOpen(true)} />
      </View>

      <View className="flex-row items-center justify-center gap-1.5 opacity-70">
        <LogoMark size={16} />
        <Text variant="muted" className="text-xs">
          Rally {config.appVersion}
        </Text>
      </View>

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
    <Pressable onPress={onPress} accessibilityRole="button" className="active:bg-accent flex-row items-center gap-3.5 px-4 py-3">
      <View className={cn('size-9 items-center justify-center rounded-xl', destructive ? 'bg-destructive-soft' : 'bg-muted')}>
        <Icon as={icon} className={cn('size-[18px]', destructive ? 'text-destructive' : 'text-secondary-foreground')} />
      </View>
      <Text className={cn('flex-1 text-[15px] font-medium', destructive && 'text-destructive')}>{label}</Text>
      {!destructive && <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />}
    </Pressable>
  );
}
