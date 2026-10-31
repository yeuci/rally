import { router } from 'expo-router';
import { CheckIcon, CircleAlertIcon, HistoryIcon, LockIcon, StoreIcon } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, ScrollView, View, type TextStyle } from 'react-native';
import { BottomSheet } from '@/components/rally/bottom-sheet';
import { CoinAmount, CoinIcon } from '@/components/rally/coins';
import { CosmeticPreview, PlayerName, ProfileBanner } from '@/components/rally/cosmetics';
import { EmptyState, RetryButton } from '@/components/rally/empty-state';
import { ErrorText } from '@/components/rally/form-field';
import { ProfileAvatar } from '@/components/rally/profile-avatar';
import { SectionHeader } from '@/components/rally/section-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { useBuyItem, useCoinRules, useEquipItem, useShop, useWallet, type ShopData } from '@/lib/coins';
import {
  coinsLabel,
  earnLines,
  formatCoins,
  itemState,
  KIND_NAMES,
  lookOf,
  shopColumns,
  shopErrorKind,
  shopErrorText,
  shopSections,
  shopTileWidth,
  shortfall,
  type ItemState,
  type ShopItem,
  type WalletSummary,
} from '@/lib/coins-model';
import { toggleHaptic } from '@/lib/haptics';
import { useProfile, type Profile } from '@/lib/profile';
import { useBoxSize, useColumnPadding, useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };
const GAP = 12;

/**
 * The coin shop (`/shop`, from the drawer, the profile's balance pill and its Shop row): your balance with today's
 * progress (daily bonus, solo and match caps from `my_wallet`), then the cosmetics grouped by kind (name colours, avatar
 * frames, profile banners, badges), each tile drawn from the item's data with its price, or Owned / Equipped. A tile
 * opens the item sheet: a preview of you wearing it, then Buy (the confirmation; disabled with "You need N more
 * coins" when short), Equip or Unequip. "How to earn" lists the live rules (`coin_rules`). Purchases go through
 * `buy_item` (idempotent, checked under the wallet lock), equipping through `equip_item`.
 */
export default function ShopScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const palette = usePalette();
  const shop = useShop();
  const wallet = useWallet();
  const rules = useCoinRules();
  const me = useProfile().data;
  const box = useBoxSize();
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const balance = wallet.data?.balance ?? 0;
  const data = shop.data;
  const sections = data ? shopSections(data.items, data.owned, data.equipped, balance) : [];
  const open = data?.items.find((i) => i.id === openId) ?? null;
  const contentW = box.size?.width ?? 0;
  const cols = shopColumns(contentW);
  const tileW = shopTileWidth(contentW, cols, GAP);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([shop.refetch(), wallet.refetch(), rules.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <ScrollView
        className="bg-background flex-1"
        contentContainerClassName="gap-7 pt-5"
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
        <BalanceCard wallet={wallet.data} />

        <View onLayout={box.onLayout} className="gap-7">
          {shop.isLoading || !box.size ? (
            <ShopSkeleton tileW={tileW || 160} />
          ) : shop.isError || !data ? (
            <EmptyState
              icon={CircleAlertIcon}
              title="Couldn't load the shop"
              body="Check your connection and try again."
              action={<RetryButton onPress={() => void shop.refetch()} />}
            />
          ) : sections.length === 0 ? (
            <EmptyState icon={StoreIcon} title="The shop is empty" body="New items are on their way. Keep earning coins." />
          ) : (
            sections.map((section) => (
              <View key={section.kind} className="gap-3">
                <SectionHeader title={section.title} detail={formatCoins(section.items.length)} className="px-0" />
                <View className="flex-row flex-wrap" style={{ gap: GAP }}>
                  {section.items.map(({ item, state }) => (
                    <ItemTile key={item.id} item={item} state={state} width={tileW} onPress={() => setOpenId(item.id)} />
                  ))}
                </View>
              </View>
            ))
          )}
        </View>

        <HowToEarn lines={rules.data ? earnLines(rules.data) : []} />
      </ScrollView>

      {open && data ? (
        <ItemSheet
          key={open.id}
          item={open}
          data={data}
          balance={balance}
          me={me ?? null}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}

/** Balance, the history link, and today's progress toward the daily bonus and caps. */
function BalanceCard({ wallet }: { wallet: WalletSummary | undefined }) {
  return (
    <View className="bg-card border-border gap-4 rounded-3xl border p-5">
      <View className="flex-row items-center justify-between gap-3">
        <View className="gap-1">
          <Text variant="muted" className="text-[13px] font-semibold uppercase leading-[18px] tracking-wide">
            Your coins
          </Text>
          {wallet ? (
            <CoinAmount amount={wallet.balance} iconClassName="size-7" textClassName="text-[34px] font-extrabold leading-10" className="gap-2" />
          ) : (
            <SkeletonText lineHeight={40} width={140} barClassName="rounded-lg" />
          )}
        </View>
        <Button variant="secondary" size="sm" className="rounded-full px-4" onPress={() => router.push('/coins')}>
          <Icon as={HistoryIcon} className="text-secondary-foreground size-3.5" />
          <Text>History</Text>
        </Button>
      </View>
      <Separator />
      <View className="flex-row gap-2">
        <Today label="Daily bonus" value={wallet ? (wallet.daily_claimed ? 'Claimed' : 'Waiting') : undefined} done={wallet?.daily_claimed} />
        <Today label="Solo today" value={wallet ? `${formatCoins(wallet.solo_today)} / ${formatCoins(wallet.solo_cap)}` : undefined} done={!!wallet && wallet.solo_cap > 0 && wallet.solo_today >= wallet.solo_cap} />
        <Today label="Matches today" value={wallet ? `${formatCoins(wallet.match_today)} / ${formatCoins(wallet.match_cap)}` : undefined} done={!!wallet && wallet.match_cap > 0 && wallet.match_today >= wallet.match_cap} />
      </View>
    </View>
  );
}

function Today({ label, value, done }: { label: string; value: string | undefined; done?: boolean }) {
  return (
    <View className="bg-subtle flex-1 gap-0.5 rounded-xl px-2.5 py-2" accessible accessibilityLabel={value ? `${label}: ${value}` : label}>
      <Text variant="muted" className="text-[11px] font-semibold uppercase leading-4 tracking-wide" numberOfLines={1}>
        {label}
      </Text>
      {value === undefined ? (
        <SkeletonText lineHeight={20} width={48} />
      ) : (
        <View className="flex-row items-center gap-1">
          {done ? <Icon as={CheckIcon} className="text-gold size-3.5" /> : null}
          <Text className="text-[14px] font-bold leading-5" style={TABULAR} numberOfLines={1}>
            {value}
          </Text>
        </View>
      )}
    </View>
  );
}

/** One item: its drawing, its name, then the price (dimmed with a lock when short) or Owned / Equipped. */
function ItemTile({ item, state, width, onPress }: { item: ShopItem; state: ItemState; width: number; onPress: () => void }) {
  const status = state === 'equipped' ? 'Equipped' : state === 'owned' ? 'Owned' : coinsLabel(item.price);
  return (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${KIND_NAMES[item.kind]}, ${status}`}
      accessibilityHint="Opens the item"
      className={cn('bg-card border-border gap-2.5 rounded-2xl border p-2.5 active:opacity-70', state === 'equipped' && 'border-gold-line')}
      style={{ width }}
    >
      <View className="bg-subtle h-[84px] items-center justify-center rounded-xl">
        <CosmeticPreview item={item} size={60} />
      </View>
      <View className="gap-0.5 px-1">
        <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
          {item.name}
        </Text>
        {state === 'equipped' || state === 'owned' ? (
          <View className="flex-row items-center gap-1">
            {state === 'equipped' ? <Icon as={CheckIcon} className="text-gold size-3.5" /> : null}
            <Text className={cn('text-[13px] font-semibold leading-[18px]', state === 'equipped' ? 'text-gold' : 'text-muted-foreground')}>
              {status}
            </Text>
          </View>
        ) : (
          <View className={cn('flex-row items-center gap-1', state === 'short' && 'opacity-60')}>
            {state === 'short' ? <Icon as={LockIcon} className="text-muted-foreground size-3" /> : null}
            <CoinIcon className="size-3.5" />
            <Text className="text-[13px] font-bold leading-[18px]" style={TABULAR}>
              {formatCoins(item.price)}
            </Text>
          </View>
        )}
      </View>
    </TapPressable>
  );
}

/**
 * The item sheet: a preview of you with the item on (on top of what you already wear), then the one action its state
 * allows. Buying is the confirmation here (the sheet names the item and the price). A failure shows under the button.
 */
function ItemSheet({
  item,
  data,
  balance,
  me,
  onClose,
}: {
  item: ShopItem;
  data: ShopData;
  balance: number;
  me: Profile | null;
  onClose: () => void;
}) {
  const buy = useBuyItem();
  const equip = useEquipItem();
  const [error, setError] = useState<string | null>(null);
  const state = itemState(item, data.owned, data.equipped, balance);
  const look = lookOf(data.items, { ...data.equipped, [item.kind]: item.id });
  const busy = buy.isPending || equip.isPending;
  const missing = shortfall(item.price, balance);

  function onBuy() {
    setError(null);
    buy.mutate(item.id, {
      onSuccess: () => toggleHaptic(),
      onError: (e) => setError(shopErrorText(shopErrorKind(e))),
    });
  }
  function onEquip(itemId: string | null) {
    setError(null);
    equip.mutate(
      { kind: item.kind, itemId },
      { onSuccess: () => toggleHaptic(), onError: (e) => setError(shopErrorText(shopErrorKind(e))) },
    );
  }

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={item.name}
      description={[KIND_NAMES[item.kind], item.description].filter(Boolean).join(' · ')}
    >
      <View className="gap-4">
        <PreviewCard me={me} look={look} />

        {state === 'buyable' || state === 'short' ? (
          <View className="flex-row items-center justify-between px-1">
            <Text variant="muted" className="text-[15px]">
              Price
            </Text>
            <CoinAmount amount={item.price} />
          </View>
        ) : null}

        {state === 'buyable' ? (
          <View className="gap-2">
            <Button size="lg" onPress={onBuy} disabled={busy} accessibilityHint={`Your balance after: ${coinsLabel(balance - item.price)}`}>
              <Text>{buy.isPending ? 'Buying…' : `Buy for ${coinsLabel(item.price)}`}</Text>
            </Button>
            <Text variant="muted" className="text-center text-[13px]" style={TABULAR}>
              Balance after: {coinsLabel(balance - item.price)}
            </Text>
          </View>
        ) : state === 'short' ? (
          <View className="gap-2">
            <Button size="lg" disabled>
              <Icon as={LockIcon} className="text-primary-foreground size-4" />
              <Text>Not enough coins</Text>
            </Button>
            <Text variant="muted" className="text-center text-[13px] leading-[18px]">
              You need {coinsLabel(missing)} more. Play matches and solo runs, and collect your daily bonus.
            </Text>
          </View>
        ) : state === 'owned' ? (
          <Button size="lg" onPress={() => onEquip(item.id)} disabled={busy}>
            <Text>{equip.isPending ? 'Equipping…' : 'Equip'}</Text>
          </Button>
        ) : (
          <Button size="lg" variant="outline" onPress={() => onEquip(null)} disabled={busy}>
            <Text>{equip.isPending ? 'Removing…' : 'Unequip'}</Text>
          </Button>
        )}

        <ErrorText>{error}</ErrorText>
        <Button variant="ghost" onPress={onClose}>
          <Text>{state === 'equipped' || state === 'owned' ? 'Done' : 'Not now'}</Text>
        </Button>
      </View>
    </BottomSheet>
  );
}

/** You, as others would see you with the previewed look: banner, framed avatar, coloured name and badge. */
function PreviewCard({ me, look }: { me: Profile | null; look: ReturnType<typeof lookOf> }) {
  const name = me ? me.display_name || me.username : 'You';
  return (
    <View className="bg-card border-border items-center gap-2 overflow-hidden rounded-2xl border px-4 pb-4 pt-5">
      {look.banner ? <ProfileBanner banner={look.banner} radius={0} className="absolute left-0 right-0 top-0" style={{ height: 64 }} /> : null}
      <ProfileAvatar profile={me} look={look} size="xl" ring />
      <PlayerName look={look} name={name} className="text-center text-[20px] font-extrabold leading-7 tracking-tight" badgeSize={18} />
      {me ? <Text className="text-muted-foreground -mt-1 text-[14px] leading-5">@{me.username}</Text> : null}
    </View>
  );
}

/** The live earning rules (coin_rules), so the copy follows any tuning. */
function HowToEarn({ lines }: { lines: { label: string; value: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <View className="gap-2">
      <SectionHeader variant="group" title="How to earn" />
      <View className="bg-card border-border overflow-hidden rounded-2xl border">
        {lines.map((l, i) => (
          <View key={l.label}>
            {i > 0 && <Separator className="ml-4" />}
            <View className="flex-row items-center gap-3 px-4 py-3" accessible accessibilityLabel={`${l.label}: ${l.value} coins`}>
              <Text className="flex-1 text-[15px]">{l.label}</Text>
              <CoinIcon className="size-3.5" />
              <Text className="text-[15px] font-bold" style={TABULAR}>
                {l.value}
              </Text>
            </View>
          </View>
        ))}
      </View>
      <Text variant="muted" className="px-1 text-[13px] leading-[18px]">
        Coins are earned by playing; they can&apos;t be bought. Guests don&apos;t earn coins.
      </Text>
    </View>
  );
}

function ShopSkeleton({ tileW }: { tileW: number }) {
  return (
    <>
      {[0, 1].map((s) => (
        <View key={s} className="gap-3">
          <SkeletonText lineHeight={22} width={132} />
          <View className="flex-row flex-wrap" style={{ gap: GAP }}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} className="bg-card border-border gap-2.5 rounded-2xl border p-2.5" style={{ width: tileW }}>
                <Skeleton className="h-[84px] rounded-xl" />
                <View className="gap-0.5 px-1">
                  <SkeletonText lineHeight={20} width="60%" />
                  <SkeletonText lineHeight={18} width="40%" />
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </>
  );
}
