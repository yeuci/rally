import { CircleAlertIcon, FlameIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { nextUtcMidnight, xpLabel } from '@/lib/levels-model';
import { useMyStreak } from '@/lib/streak';
import {
  currentStreak,
  longestLabel,
  nextBonusWhen,
  streakA11y,
  streakStatus,
  streakStatusLine,
  streakTitle,
  type Streak,
} from '@/lib/streak-model';
import { useLayout } from '@/lib/use-layout';
import { cn } from '@/lib/utils';
import { CoinAmount } from './coins';
import { EmptyState, RetryButton } from './empty-state';
import { SectionHeader } from './section-header';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

/** The clock for the day boundary: re-renders every `ms` while mounted. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * "Daily streak" on the dashboard, next to the daily challenges: the current streak with a flame (lit once today's
 * game is in), "Done for today" / "Play today to keep it", the longest streak, and what the next day's first game pays
 * (20261102000400_streaks.sql). The day turns at 00:00 UTC, like the challenges; the card follows without a refetch
 * and asks the server again shortly after. Hidden for signed-out and anonymous sessions (guests earn nothing). `inset`
 * adds the dashboard's page padding (its rows are full-bleed).
 */
export function StreakCard({ inset = false, className }: { inset?: boolean; className?: string }) {
  const { signedIn } = useSession();
  const { pad } = useLayout();
  const streak = useMyStreak();
  const now = useNow(60_000);
  const midnight = nextUtcMidnight(now);
  const { refetch } = streak;

  // A new day at 00:00 UTC (a little after it, so the server's day has turned and next_coins moved on).
  useEffect(() => {
    if (!signedIn) return;
    const t = setTimeout(() => void refetch(), Math.max(0, midnight - Date.now()) + 3000);
    return () => clearTimeout(t);
  }, [midnight, refetch, signedIn]);

  if (!signedIn) return null;
  return (
    <StreakCardView
      streak={streak.data}
      loading={streak.isLoading}
      error={streak.isError}
      now={now}
      onRetry={() => void refetch()}
      className={className}
      style={inset ? { paddingLeft: pad.left, paddingRight: pad.right } : undefined}
    />
  );
}

/** The card as drawn from its data (StreakCard feeds it; a preview can too). */
export function StreakCardView({
  streak,
  loading,
  error,
  now,
  onRetry,
  className,
  style,
}: {
  streak: Streak | undefined;
  loading: boolean;
  error: boolean;
  now: number;
  onRetry: () => void;
  className?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View className={cn('gap-3', className)} style={style}>
      <SectionHeader title="Daily streak" detail={streak ? longestLabel(streak.longest) : undefined} className="px-0" />
      {loading || (!streak && !error) ? (
        <StreakSkeleton />
      ) : error || !streak ? (
        <EmptyState
          compact
          icon={CircleAlertIcon}
          title="Couldn't load your streak"
          body="Check your connection and try again."
          action={<RetryButton compact onPress={onRetry} />}
        />
      ) : (
        <StreakRow streak={streak} now={now} />
      )}
    </View>
  );
}

/**
 * Flame tile (lit when today is done), "3-day streak" over "Done for today" / "Play today to keep it", and on the right
 * the next bonus: "Today" or "Tomorrow", then its coins and XP.
 */
function StreakRow({ streak: s, now }: { streak: Streak; now: number }) {
  const status = streakStatus(s, now);
  const days = currentStreak(s, now);
  const lit = status === 'done';
  return (
    <View
      className="bg-card border-border flex-row items-center gap-3 rounded-2xl border px-4 py-3"
      accessible
      accessibilityLabel={streakA11y(s, now)}
    >
      <View className={cn('size-11 items-center justify-center rounded-xl', lit ? 'bg-foreground' : 'bg-muted')}>
        <Icon as={FlameIcon} className={cn('size-[22px]', lit ? 'text-background' : 'text-secondary-foreground')} />
      </View>
      <View className="shrink grow gap-0.5">
        <Text className="text-[17px] font-extrabold leading-[22px] tracking-tight" numberOfLines={1} style={TABULAR}>
          {streakTitle(days)}
        </Text>
        <Text className="text-muted-foreground text-[13px] font-medium leading-[18px]" numberOfLines={1}>
          {streakStatusLine(status)}
        </Text>
      </View>
      {s.nextCoins > 0 || s.nextXp > 0 ? (
        <View className="items-end gap-0.5">
          <Text className="text-muted-foreground text-[12px] font-semibold leading-4">{nextBonusWhen(s, now)}</Text>
          <View className="flex-row items-center gap-1.5">
            {s.nextCoins > 0 ? (
              <CoinAmount amount={s.nextCoins} iconClassName="size-3.5" textClassName="text-[13px] leading-[18px]" />
            ) : null}
            {s.nextXp > 0 ? (
              <Text className="text-muted-foreground text-[12px] font-semibold leading-4" style={TABULAR}>
                {xpLabel(s.nextXp)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function StreakSkeleton() {
  return (
    <View className="bg-card border-border flex-row items-center gap-3 rounded-2xl border px-4 py-3">
      <Skeleton className="size-11 rounded-xl" />
      <View className="shrink grow gap-1">
        <SkeletonText lineHeight={22} width="46%" />
        <SkeletonText lineHeight={18} width="58%" />
      </View>
      <View className="items-end gap-1">
        <Skeleton className="h-3 w-12 rounded-full" />
        <Skeleton className="h-3.5 w-16 rounded-full" />
      </View>
    </View>
  );
}
