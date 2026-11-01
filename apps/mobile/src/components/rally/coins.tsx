import { CoinsIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, View, type TextStyle } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { Icon } from '@/components/ui/icon';
import { SkeletonText } from '@/components/ui/skeleton';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { hideCoinToast, useCoinToast } from '@/lib/coin-toast';
import { COIN_TOAST_MS, coinsLabel, coinToastText, formatCoins, formatCoinsShort } from '@/lib/coins-model';
import { useToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { CelebrationToast } from './level-toast';
import { useViewport } from '@/lib/viewport';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

/**
 * Coins in the UI: the coin glyph and amounts drawn in the `gold` tokens (the leaderboard's medal colours, tuned per
 * theme; the shell has no other hue), the balance pill (profile header, drawer), and the "+25 coins" toast.
 */
export function CoinIcon({ className }: { className?: string }) {
  return <Icon as={CoinsIcon} className={cn('text-gold size-4', className)} />;
}

/** Glyph + amount ("🪙 1,250"), tabular figures. */
export function CoinAmount({
  amount,
  className,
  iconClassName,
  textClassName,
}: {
  amount: number;
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <View className={cn('flex-row items-center gap-1', className)} accessible accessibilityLabel={coinsLabel(amount)}>
      <CoinIcon className={iconClassName} />
      <Text className={cn('text-[15px] font-bold', textClassName)} style={TABULAR}>
        {formatCoins(amount)}
      </Text>
    </View>
  );
}

/**
 * The balance as a gold-tinted pill. Tappable with `onPress` (opens the shop); a skeleton bar while `balance` is
 * undefined. It sits in tight rows (the profile header, the drawer header), so from 10,000 the amount is compact
 * ("12.3K", "1M"); screen readers still hear the exact amount. The shop and the coin history show full numbers.
 */
export function CoinBalancePill({
  balance,
  onPress,
  size = 'md',
  className,
}: {
  balance: number | undefined;
  onPress?: () => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const sm = size === 'sm';
  const body =
    balance === undefined ? (
      <>
        <CoinIcon className={sm ? 'size-3.5' : undefined} />
        <SkeletonText lineHeight={sm ? 16 : 20} width={sm ? 28 : 40} />
      </>
    ) : (
      <>
        <CoinIcon className={sm ? 'size-3.5' : undefined} />
        <Text className={cn('text-foreground font-bold', sm ? 'text-[12px] leading-4' : 'text-[14px] leading-5')} style={TABULAR}>
          {formatCoinsShort(balance)}
        </Text>
      </>
    );
  const box = cn(
    'bg-gold-soft border-gold-line flex-row items-center rounded-full border',
    sm ? 'h-6 gap-1 px-2' : 'h-9 gap-1.5 px-3.5',
    className,
  );
  const label = balance === undefined ? 'Coins' : coinsLabel(balance);
  return onPress ? (
    <TapPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the shop"
      className={cn(box, 'active:opacity-70')}
    >
      {body}
    </TapPressable>
  ) : (
    <View className={box} accessible accessibilityLabel={label}>
      {body}
    </View>
  );
}

/** The shell and the play route each mount a host (the game is a native modal over the shell): announce once. */
let announcedKey = 0;

/**
 * "+25 coins · Win" (lib/coin-toast.ts): a gold-edged pill under the status bar, in the shell and over a running game
 * (the play route mounts its own host, like the friend-request banner). Awards arriving while it is up add to it.
 * Announced to screen readers; a tap dismisses it, so does time. Sits under the app's regular toast when both show.
 * Touches around it pass through. Level-ups and finished daily challenges (lib/level-toast.ts) show under it.
 */
export function CoinToastHost() {
  const toast = useCoinToast();
  const other = useToast();
  const { insets } = useViewport();

  useEffect(() => {
    if (!toast) return;
    const { amount, reasons } = coinToastText(toast);
    if (announcedKey !== toast.key) {
      announcedKey = toast.key;
      AccessibilityInfo.announceForAccessibility(`${amount}, ${reasons}`);
    }
    const timer = setTimeout(() => hideCoinToast(toast.key), COIN_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const text = toast ? coinToastText(toast) : null;
  return (
    <View
      className="absolute left-0 right-0 items-center gap-2 px-4"
      style={{ top: insets.top + 8 + (other ? 56 : 0) }}
      pointerEvents="box-none"
    >
      {toast && text ? (
        <Animated.View
          key={toast.ids[0]}
          entering={FadeInUp.duration(220).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutUp.duration(180).reduceMotion(ReduceMotion.System)}
          className="max-w-md"
        >
          <Pressable
            onPress={() => hideCoinToast(toast.key)}
            accessibilityRole="alert"
            accessibilityLabel={`${text.amount}, ${text.reasons}`}
            accessibilityHint="Dismisses the message"
            className="bg-card border-gold-line flex-row items-center gap-2.5 rounded-full border py-2 pl-2 pr-4 shadow-lg shadow-black/20 active:opacity-70"
          >
            <View className="bg-gold-soft size-8 items-center justify-center rounded-full">
              <CoinIcon className="size-[18px]" />
            </View>
            <Text className="text-[15px] font-extrabold leading-5" style={TABULAR}>
              {text.amount}
            </Text>
            <Text className="text-muted-foreground shrink text-[13px] font-medium leading-[18px]" numberOfLines={1}>
              {text.reasons}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}
      <CelebrationToast />
    </View>
  );
}
