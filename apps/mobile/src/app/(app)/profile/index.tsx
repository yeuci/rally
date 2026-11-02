import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  HistoryIcon,
  LifeBuoyIcon,
  LogOutIcon,
  PencilIcon,
  SettingsIcon,
  StoreIcon,
  UsersIcon,
  WrenchIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { CoinBalancePill } from '@/components/rally/coins';
import { ErrorText } from '@/components/rally/form-field';
import { Glow } from '@/components/rally/glow';
import { LogoMark } from '@/components/rally/logo';
import { LinkRow, PlayedGamesSection, ProfileHeader, StatsStrip } from '@/components/rally/profile-sections';
import { SettingsGroup, SettingsRow } from '@/components/rally/settings-rows';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { coinKeys, useWallet } from '@/lib/coins';
import { formatCoins } from '@/lib/coins-model';
import { useFriendRequests, usePublicGames } from '@/lib/friends';
import { usePublicStats } from '@/lib/game-progress';
import { useMyProgress } from '@/lib/levels';
import { useProfile } from '@/lib/profile';
import { formatScore } from '@/lib/progress-format';
import { countBadge } from '@/lib/social';
import { openSupportMail } from '@/lib/support';
import { usePalette } from '@/lib/use-palette';
import { useColumnPadding } from '@/lib/use-layout';
import { useSignOut } from '@/lib/use-sign-out';
import { useViewport } from '@/lib/viewport';

export default function ProfileScreen() {
  const { width, insets } = useViewport();
  // Landscape / tablet: a centred column (≤ 600 pt) inside the safe area instead of edge-to-edge rows.
  const column = useColumnPadding();
  const glow = Math.min(width, 700) * 1.1;
  const profile = useProfile();
  const { signingOut, error: signOutError, signOut } = useSignOut();
  const p = profile.data;
  const palette = usePalette();
  const stats = usePublicStats(p?.id);
  const games = usePublicGames(p?.id);
  const requests = useFriendRequests();
  const incoming = countBadge(requests.data?.incoming.length);
  const wallet = useWallet();
  const balance = wallet.data?.balance;
  const level = useMyProgress();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        profile.refetch(),
        stats.refetch(),
        games.refetch(),
        requests.refetch(),
        wallet.refetch(),
        level.refetch(),
        qc.invalidateQueries({ queryKey: coinKeys.cosmeticsAll() }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }
  const openFriends = (tab?: 'requests') => router.push({ pathname: '/friends', params: tab ? { tab } : {} });
  const mail = (subject: string) => openSupportMail(subject, p?.username);

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-6"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={palette.foreground}
          colors={[palette.foreground]}
          progressBackgroundColor={palette.card}
        />
      }
    >
      {/* Centred on the window from its live width (absolute: measured from the container's edge, not its padding). */}
      <Glow size={glow} style={{ top: -glow / 2, left: width / 2 - glow / 2 }} />

      <ProfileHeader profile={p} progress={p ? level.data : undefined}>
        <View className="flex-row items-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full px-4" onPress={() => router.push('/profile/edit')} disabled={!p}>
            <Icon as={PencilIcon} className="size-3.5" />
            <Text>Edit profile</Text>
          </Button>
          <CoinBalancePill balance={p ? balance : undefined} onPress={() => router.push('/shop')} />
        </View>
        <StatsStrip stats={stats.data} loading={!p || stats.isLoading} onFriendsPress={() => openFriends()} />
      </ProfileHeader>

      <View className="bg-card border-border overflow-hidden rounded-2xl border">
        <LinkRow
          icon={UsersIcon}
          label="Friends"
          value={stats.data ? formatScore(stats.data.friends) : undefined}
          badge={incoming}
          onPress={() => openFriends(incoming ? 'requests' : undefined)}
        />
        <Separator className="ml-16" />
        <LinkRow icon={StoreIcon} label="Shop" onPress={() => router.push('/shop')} />
        <Separator className="ml-16" />
        <LinkRow
          icon={HistoryIcon}
          label="Coin history"
          value={balance !== undefined ? formatCoins(balance) : undefined}
          onPress={() => router.push('/coins')}
        />
      </View>

      <PlayedGamesSection
        games={games.data}
        loading={!p || games.isLoading}
        error={games.isError}
        onRetry={() => void games.refetch()}
        own
      />

      <SettingsGroup>
        {/* Appearance, Show FPS in games and the privacy shortcut live on the Settings screen. */}
        <SettingsRow icon={SettingsIcon} label="Settings" onPress={() => router.push('/settings')} />
        <Separator className="ml-16" />
        {config.devTools && (
          <>
            <SettingsRow icon={WrenchIcon} label="Developer" onPress={() => router.push('/dev')} />
            <Separator className="ml-16" />
          </>
        )}
        <SettingsRow icon={LifeBuoyIcon} label="Help & support" onPress={() => mail('Rally support')} />
        <Separator className="ml-16" />
        <SettingsRow
          icon={LogOutIcon}
          label={signingOut ? 'Signing out…' : 'Sign out'}
          onPress={signOut}
          disabled={signingOut}
          chevron={false}
        />
      </SettingsGroup>
      <ErrorText>{signOutError}</ErrorText>

      <View className="flex-row items-center justify-center gap-1.5 opacity-70">
        <LogoMark size={16} />
        <Text variant="muted" className="text-xs">
          Rally {config.appVersion}
        </Text>
      </View>
    </ScrollView>
  );
}
