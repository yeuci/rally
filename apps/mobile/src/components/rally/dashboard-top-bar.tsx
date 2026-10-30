import { Link } from 'expo-router';
import { MenuIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import type { Profile } from '@/lib/profile';
import { ProfileAvatar, ProfileAvatarSkeleton } from './profile-avatar';

/** Row under the status bar: 6 pt + the 52 pt ringed avatar + 6 pt. */
export const TOP_BAR_ROW = 64;

/**
 * The dashboard's compact top bar, floating over the hero: menu button (opens the drawer), "Hey, <name>", avatar with
 * the pending-request badge (opens Profile). `progress` 0 = over the art (glass button, white type), 1 = solid page
 * background with a hairline once the hero has scrolled behind it (driven on the UI thread by the scroll offset).
 */
export function DashboardTopBar({
  progress,
  topInset,
  pad,
  name,
  loading,
  profile,
  badge,
  onMenu,
}: {
  progress: SharedValue<number>;
  topInset: number;
  pad: { left: number; right: number };
  name: string | null;
  loading: boolean;
  profile: Profile | null | undefined;
  badge: string | null;
  onMenu: () => void;
}) {
  const solid = useAnimatedStyle(() => ({ opacity: progress.value }));
  const glass = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));
  const greeting = name ? `Hey, ${name}` : 'Welcome back';

  return (
    <View className="absolute left-0 right-0 top-0" style={{ height: topInset + TOP_BAR_ROW }} pointerEvents="box-none">
      <Animated.View
        className="bg-background border-border absolute inset-0 border-b"
        style={solid}
        pointerEvents="none"
      />
      <View
        className="flex-1 flex-row items-center gap-3"
        style={{ paddingTop: topInset, paddingLeft: pad.left, paddingRight: pad.right }}
        pointerEvents="box-none"
      >
        <TapPressable
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel="Menu"
          accessibilityHint="Opens the side menu"
          hitSlop={8}
          className="size-11 items-center justify-center rounded-full active:opacity-70"
        >
          <Animated.View
            style={[StyleSheet.absoluteFill, glass]}
            className="rounded-full border border-white/15 bg-black/35"
          />
          <Animated.View style={glass}>
            <Icon as={MenuIcon} className="size-[22px] text-white" />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, solid]} className="items-center justify-center">
            <Icon as={MenuIcon} className="text-foreground size-[22px]" />
          </Animated.View>
        </TapPressable>

        <View className="shrink grow justify-center" pointerEvents="none">
          {loading ? (
            <SkeletonText lineHeight={22} width={140} />
          ) : (
            <View>
              <Animated.View style={glass}>
                <Text
                  className="text-[17px] font-bold leading-[22px] tracking-tight text-white"
                  style={SHADOW}
                  numberOfLines={1}
                  role="heading"
                >
                  {greeting}
                </Text>
              </Animated.View>
              <Animated.View
                style={[StyleSheet.absoluteFill, solid]}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
              >
                <Text className="text-foreground text-[17px] font-bold leading-[22px] tracking-tight" numberOfLines={1}>
                  {greeting}
                </Text>
              </Animated.View>
            </View>
          )}
        </View>

        <Link href="/profile" asChild>
          <TapPressable
            accessibilityRole="button"
            accessibilityLabel={badge ? `Profile, ${badge} friend requests` : 'Profile'}
            hitSlop={8}
            className="active:opacity-70"
          >
            {loading ? (
              <ProfileAvatarSkeleton size="md" ring />
            ) : (
              <ProfileAvatar profile={profile} size="md" ring badge={badge} />
            )}
          </TapPressable>
        </Link>
      </View>
    </View>
  );
}

const SHADOW = { textShadowColor: 'rgba(0,0,0,0.45)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8 };
