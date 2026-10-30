import { router, usePathname } from 'expo-router';
import {
  HouseIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
import { Drawer } from 'react-native-drawer-layout';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { describeAuthError } from '@/lib/auth/errors';
import { signOut } from '@/lib/auth/providers';
import { drawerItems, drawerSwipeEnabled, drawerWidth, type DrawerItemKey } from '@/lib/drawer';
import { useFriendRequests } from '@/lib/friends';
import { useProfile } from '@/lib/profile';
import { countBadge } from '@/lib/social';
import { AppDrawerContext } from '@/lib/use-app-drawer';
import { useLayout } from '@/lib/use-layout';
import { cn } from '@/lib/utils';
import { LogoMark } from './logo';
import { ProfileAvatar, ProfileAvatarSkeleton } from './profile-avatar';

const ICONS: Record<DrawerItemKey, LucideIcon> = {
  home: HouseIcon,
  search: SearchIcon,
  friends: UsersIcon,
  profile: UserIcon,
  settings: SettingsIcon,
  developer: WrenchIcon,
};

/** Path each item opens (its row is highlighted while that path is showing). */
const PATHS: Record<DrawerItemKey, string> = {
  home: '/',
  search: '/search',
  friends: '/friends',
  profile: '/profile',
  settings: '/profile',
  developer: '/dev',
};

/**
 * The app's left drawer, wrapped around the `(app)` stack (react-native-drawer-layout, the component expo-router's
 * own Drawer navigator renders; used directly so the stack keeps its push / back semantics). Opens from the
 * dashboard's menu button (`useAppDrawer().openDrawer`) or an edge swipe on the dashboard only (lib/drawer.ts
 * `drawerSwipeEnabled`: never on pushed screens, never over a running game). Android back closes it first.
 */
export function AppDrawer({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { width } = useLayout();
  const [open, setOpen] = useState(false);
  const swipe = drawerSwipeEnabled(pathname);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const controls = { isOpen: open, openDrawer: () => setOpen(true), closeDrawer: () => setOpen(false) };

  return (
    <AppDrawerContext.Provider value={controls}>
      <Drawer
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        drawerType="front"
        // Swiping it shut always works; swiping it open only where lib/drawer.ts allows.
        swipeEnabled={swipe || open}
        swipeEdgeWidth={28}
        drawerStyle={{ width: drawerWidth(width), backgroundColor: 'transparent' }}
        overlayStyle={OVERLAY}
        overlayAccessibilityLabel="Close menu"
        renderDrawerContent={() => <DrawerPanel pathname={pathname} onClose={() => setOpen(false)} />}
      >
        {children}
      </Drawer>
    </AppDrawerContext.Provider>
  );
}

const OVERLAY = { backgroundColor: 'rgba(0, 0, 0, 0.5)' } as const;

/** Header (avatar, display name, @username → Profile), the items, then Sign out and the app version at the bottom. */
function DrawerPanel({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  const { insets } = useLayout();
  const profile = useProfile();
  const requests = useFriendRequests();
  const incoming = countBadge(requests.data?.incoming.length);
  const items = drawerItems({ devTools: config.devTools, incomingRequests: incoming });
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const p = profile.data;

  function open(key: DrawerItemKey) {
    onClose();
    switch (key) {
      case 'home':
        if (pathname !== '/') router.dismissTo('/');
        return;
      case 'search':
        router.push('/search');
        return;
      case 'friends':
        router.push({ pathname: '/friends', params: incoming ? { tab: 'requests' } : {} });
        return;
      case 'profile':
      case 'settings':
        router.push('/profile');
        return;
      case 'developer':
        router.push('/dev');
        return;
    }
  }

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut(); // success: the session gate in (app)/_layout.tsx swaps to the welcome screen
    } catch (err) {
      setSignOutError(describeAuthError(err));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <View className="bg-sidebar border-sidebar-border flex-1 border-r">
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 16,
          paddingLeft: insets.left + 12,
          paddingRight: 12,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          onPress={() => open('profile')}
          accessibilityRole="button"
          accessibilityLabel={p ? `${p.display_name || p.username}, @${p.username}` : 'Profile'}
          accessibilityHint="Opens your profile"
          className="active:bg-sidebar-accent flex-row items-center gap-3 rounded-2xl px-2 py-2"
        >
          {p ? <ProfileAvatar profile={p} size="md" ring /> : <ProfileAvatarSkeleton size="md" ring />}
          <View className="shrink grow">
            {p ? (
              <>
                <Text className="text-sidebar-foreground text-[17px] font-bold leading-[22px]" numberOfLines={1}>
                  {p.display_name || p.username}
                </Text>
                <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
                  @{p.username}
                </Text>
              </>
            ) : (
              <>
                <SkeletonText lineHeight={22} width={120} />
                <SkeletonText lineHeight={18} width={84} />
              </>
            )}
          </View>
        </Pressable>

        <Separator className="bg-sidebar-border my-4" />

        <View className="gap-1" accessibilityRole="menu">
          {items.map((item) => (
            <DrawerRow
              key={item.key}
              icon={ICONS[item.key]}
              label={item.label}
              badge={item.badge}
              hint={item.hint}
              active={item.key !== 'settings' && PATHS[item.key] === pathname}
              onPress={() => open(item.key)}
            />
          ))}
        </View>

        <View className="min-h-6 flex-1" />

        <Separator className="bg-sidebar-border mb-3" />
        <DrawerRow
          icon={LogOutIcon}
          label={signingOut ? 'Signing out…' : 'Sign out'}
          onPress={() => void onSignOut()}
          disabled={signingOut}
        />
        {signOutError ? <Text className="text-destructive px-3 pt-1 text-[13px]">{signOutError}</Text> : null}
        <View className="flex-row items-center gap-1.5 px-3 pt-4 opacity-70">
          <LogoMark size={16} />
          <Text variant="muted" className="text-xs">
            Rally {config.appVersion}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function DrawerRow({
  icon,
  label,
  badge,
  hint,
  active = false,
  disabled = false,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  badge?: string | null;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="menuitem"
      accessibilityLabel={badge ? `${label}, ${badge} new` : label}
      accessibilityHint={hint}
      accessibilityState={{ selected: active, disabled }}
      className={cn(
        'active:bg-sidebar-accent h-12 flex-row items-center gap-3.5 rounded-xl px-3',
        active && 'bg-sidebar-accent',
        disabled && 'opacity-60',
      )}
    >
      <Icon as={icon} className={cn('size-5', active ? 'text-sidebar-foreground' : 'text-muted-foreground')} />
      <Text
        className={cn('text-sidebar-foreground flex-1 text-[15px]', active ? 'font-semibold' : 'font-medium')}
        numberOfLines={1}
      >
        {label}
      </Text>
      {badge ? (
        <View className="bg-primary h-5 min-w-5 items-center justify-center rounded-full px-1.5">
          <Text className="text-primary-foreground text-[11px] font-bold leading-3">{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
