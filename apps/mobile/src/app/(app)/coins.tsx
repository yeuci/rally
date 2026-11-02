import { router } from 'expo-router';
import {
  AwardIcon,
  CalendarCheckIcon,
  CircleAlertIcon,
  CoinsIcon,
  Gamepad2Icon,
  MedalIcon,
  ShoppingBagIcon,
  SparklesIcon,
  StoreIcon,
  TargetIcon,
  TrendingUpIcon,
  TrophyIcon,
  UserRoundIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View, type TextStyle } from 'react-native';
import { CoinAmount } from '@/components/rally/coins';
import { DailyChallenges } from '@/components/rally/daily-challenges';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { SectionHeader } from '@/components/rally/section-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useCoinHistory, useWallet, type HistoryEntry } from '@/lib/coins';
import { coinsLabel, formatCoins, ledgerTitle, signedCoins, type CoinReason } from '@/lib/coins-model';
import { timeAgo } from '@/lib/format';
import { xpLabel } from '@/lib/levels-model';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { RowHighlight } from '@/components/rally/row-highlight';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

const REASON_ICONS: Record<CoinReason, LucideIcon> = {
  match: Gamepad2Icon,
  win: TrophyIcon,
  podium: MedalIcon,
  achievement: AwardIcon,
  solo: UserRoundIcon,
  daily: CalendarCheckIcon,
  purchase: ShoppingBagIcon,
  adjustment: SparklesIcon,
  level: TrendingUpIcon,
  challenge: TargetIcon,
};

/**
 * Coin history (`/coins`, from the shop and the profile): the balance and lifetime earnings, the Daily challenges card,
 * then every change newest first (`coin_ledger`, own rows only): what it was for ("Win · Sumo", "Purchase · Ember",
 * "Daily bonus", "Level up · Level 5"), when, the signed amount and the XP that came with it ("+10 XP"). 30 rows at a
 * time with "Show more". Rows about a game open its page.
 */
export default function CoinHistoryScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const wallet = useWallet();
  const history = useCoinHistory();
  const [refreshing, setRefreshing] = useState(false);
  const entries = history.data?.pages.flat() ?? [];

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([wallet.refetch(), history.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-6 pt-5"
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
      <View className="flex-row gap-3">
        <Summary label="Balance" amount={wallet.data?.balance} />
        <Summary label="Earned in total" amount={wallet.data?.lifetime_earned} />
      </View>

      <DailyChallenges />

      <View className="gap-3">
        <SectionHeader title="History" className="px-0" />
        {history.isLoading ? (
          <HistorySkeleton />
        ) : history.isError ? (
          <EmptyState
            compact
            icon={CircleAlertIcon}
            title="Couldn't load your coin history"
            body="Check your connection and try again."
            action={<RetryButton compact onPress={() => void history.refetch()} />}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={CoinsIcon}
            title="No coins yet"
            body="Play a match or a solo game: your first game of the day also pays a daily bonus."
            action={
              <Button variant="secondary" className="rounded-full" onPress={() => router.push('/shop')}>
                <Icon as={StoreIcon} className="text-secondary-foreground size-4" />
                <Text>See the shop</Text>
              </Button>
            }
          />
        ) : (
          <>
            <View className="bg-card border-border overflow-hidden rounded-2xl border">
              {entries.map((e, i) => (
                <View key={e.id}>
                  {i > 0 && <Separator className="ml-[64px]" />}
                  <LedgerRow entry={e} />
                </View>
              ))}
            </View>
            {history.hasNextPage ? (
              <Button
                variant="secondary"
                className="self-center rounded-full px-5"
                onPress={() => void history.fetchNextPage()}
                disabled={history.isFetchingNextPage}
              >
                {history.isFetchingNextPage ? <ActivityIndicator color={palette.foreground} /> : null}
                <Text>{history.isFetchingNextPage ? 'Loading…' : 'Show more'}</Text>
              </Button>
            ) : (
              <Text variant="muted" className="text-center text-[13px]">
                That&apos;s everything from the last 12 months.
              </Text>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

function Summary({ label, amount }: { label: string; amount: number | undefined }) {
  return (
    <View className="bg-card border-border flex-1 gap-1 rounded-2xl border px-4 py-3" accessible accessibilityLabel={amount === undefined ? label : `${label}: ${coinsLabel(amount)}`}>
      <Text variant="muted" className="text-[13px] leading-[18px]" numberOfLines={1}>
        {label}
      </Text>
      {amount === undefined ? (
        <SkeletonText lineHeight={28} width={72} barClassName="rounded-lg" />
      ) : (
        <CoinAmount amount={amount} iconClassName="size-5" textClassName="text-[22px] font-extrabold leading-7" />
      )}
    </View>
  );
}

/**
 * Icon tile, "Win" over "Sumo · 2 h ago", the signed amount (gold for awards) with the XP of the same award under it.
 * Rows tied to a game open it.
 */
function LedgerRow({ entry: e }: { entry: HistoryEntry }) {
  const { title, detail } = ledgerTitle(e);
  const when = timeAgo(e.createdAt);
  const meta = [detail, when].filter(Boolean).join(' · ');
  const amount = signedCoins(e.amount);
  const body = (
    <>
      <View className="bg-muted size-9 items-center justify-center rounded-xl">
        <Icon as={REASON_ICONS[e.reason]} className="text-secondary-foreground size-[18px]" />
      </View>
      <View className="shrink grow">
        <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
          {title}
        </Text>
        {meta ? (
          <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text className={cn('text-[15px] font-bold leading-5', e.amount > 0 ? 'text-gold' : 'text-foreground')} style={TABULAR}>
          {amount}
        </Text>
        {e.xp ? (
          <Text className="text-muted-foreground text-[12px] font-semibold leading-4" style={TABULAR}>
            {xpLabel(e.xp)}
          </Text>
        ) : null}
      </View>
    </>
  );
  const a11y = `${title}${detail ? `, ${detail}` : ''}, ${e.amount > 0 ? 'plus' : 'minus'} ${coinsLabel(Math.abs(e.amount))}${e.xp ? ` and ${e.xp} XP` : ''}${when ? `, ${when}` : ''}, balance ${formatCoins(e.balanceAfter)}`;
  return e.gameId ? (
    <TapPressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint="Opens the game"
      onPress={() => router.push({ pathname: '/game/[id]', params: { id: e.gameId! } })}
      className="flex-row items-center gap-3 px-4 py-3"
    >
      {({ pressed }) => (
        <>
          <RowHighlight pressed={pressed} />
          {body}
        </>
      )}
    </TapPressable>
  ) : (
    <View className="flex-row items-center gap-3 px-4 py-3" accessible accessibilityLabel={a11y}>
      {body}
    </View>
  );
}

function HistorySkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-[64px]" />}
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Skeleton className="size-9 rounded-xl" />
            <View className="shrink grow">
              <SkeletonText lineHeight={20} width={i % 2 ? '40%' : '52%'} />
              <SkeletonText lineHeight={18} width="32%" />
            </View>
            <Skeleton className="h-4 w-10 rounded-full" />
          </View>
        </View>
      ))}
    </View>
  );
}
