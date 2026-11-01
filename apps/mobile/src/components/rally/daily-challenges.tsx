import {
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  Gamepad2Icon,
  JoystickIcon,
  ShapesIcon,
  TargetIcon,
  TrophyIcon,
  UserRoundIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View, type TextStyle } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useClaimChallenge, useDailyChallenges } from '@/lib/levels';
import {
  challengeA11y,
  challengeCount,
  challengeFraction,
  challengeStatus,
  countdown,
  doneSummary,
  isCarriedOver,
  nextResetAt,
  rewardLine,
  visibleChallenges,
  xpLabel,
  type Challenge,
  type ChallengeKind,
} from '@/lib/levels-model';
import { useLayout } from '@/lib/use-layout';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { CoinAmount } from './coins';
import { EmptyState, RetryButton } from './empty-state';
import { SectionHeader } from './section-header';

const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

const KIND_ICONS: Record<ChallengeKind, LucideIcon> = {
  play_matches: Gamepad2Icon,
  win_matches: TrophyIcon,
  friend_match: UsersIcon,
  play_games: ShapesIcon,
  play_game: JoystickIcon,
  score: TargetIcon,
  solo_runs: UserRoundIcon,
};

/** The clock for the reset countdown: re-renders every `ms` while mounted. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * "Daily challenges" (dashboard and the coin history): today's three challenges (20261101000100_progress.sql), each
 * with its progress bar, its reward (coins and XP) and a Claim button once done, plus any finished yesterday and not
 * claimed yet; the header says how many are done and when the set resets (00:00 UTC). Optional: nothing nags, there
 * are no notifications. Hidden for signed-out and anonymous sessions (guests earn nothing). `inset` adds the
 * dashboard's page padding (its rows are full-bleed); elsewhere the screen's column pads it.
 */
export function DailyChallenges({ inset = false, className }: { inset?: boolean; className?: string }) {
  const { signedIn } = useSession();
  const { pad } = useLayout();
  const challenges = useDailyChallenges();
  const claim = useClaimChallenge();
  const now = useNow(30_000);
  const all = challenges.data ?? [];
  const resetAt = nextResetAt(all, now);
  const { refetch } = challenges;

  // A new set at the reset (a little after it, so the server's day has turned).
  useEffect(() => {
    if (!signedIn) return;
    const t = setTimeout(() => void refetch(), Math.max(0, resetAt - Date.now()) + 3000);
    return () => clearTimeout(t);
  }, [resetAt, refetch, signedIn]);

  if (!signedIn) return null;
  const list = visibleChallenges(all, now);
  const style = inset ? { paddingLeft: pad.left, paddingRight: pad.right } : undefined;
  const until = countdown(resetAt, now);

  return (
    <View className={cn('gap-3', className)} style={style}>
      <SectionHeader
        title="Daily challenges"
        detail={challenges.data ? doneSummary(all, now) : undefined}
        className="px-0"
        accessory={
          <View className="flex-row items-center gap-1" accessible accessibilityLabel={`New challenges in ${until}`}>
            <Icon as={ClockIcon} className="text-muted-foreground size-3.5" />
            <Text className="text-muted-foreground text-[13px] font-medium" style={TABULAR}>
              {until}
            </Text>
          </View>
        }
      />
      {challenges.isLoading ? (
        <ChallengesSkeleton />
      ) : challenges.isError ? (
        <EmptyState
          compact
          icon={CircleAlertIcon}
          title="Couldn't load your challenges"
          body="Check your connection and try again."
          action={<RetryButton compact onPress={() => void refetch()} />}
        />
      ) : list.length === 0 ? (
        <EmptyState compact icon={TargetIcon} title="No challenges right now" body={`New ones arrive in ${until}.`} />
      ) : (
        <View className="bg-card border-border overflow-hidden rounded-2xl border">
          {list.map((c, i) => (
            <View key={c.id}>
              {i > 0 && <Separator className="ml-[64px]" />}
              <ChallengeRow
                challenge={c}
                carriedOver={isCarriedOver(c, now)}
                claiming={claim.isPending && claim.variables === c.id}
                onClaim={() => claim.mutate(c.id)}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Icon tile, title, then the bar with "1/3" (open), the reward line (done: "+35 coins · +50 XP"), or "Claimed"; on the
 * right the reward (open) or the Claim button (done).
 */
function ChallengeRow({
  challenge: c,
  carriedOver,
  claiming,
  onClaim,
}: {
  challenge: Challenge;
  carriedOver: boolean;
  claiming: boolean;
  onClaim: () => void;
}) {
  const palette = usePalette();
  const status = challengeStatus(c);
  const reward = rewardLine(c);
  const pct = Math.round(challengeFraction(c) * 100);
  return (
    <View className={cn('flex-row items-center gap-3 px-4 py-3', status === 'claimed' && 'opacity-55')}>
      <View className="shrink grow flex-row items-center gap-3" accessible accessibilityLabel={challengeA11y(c)}>
        <View
          className={cn(
            'size-9 items-center justify-center rounded-xl',
            status === 'open' ? 'bg-muted' : 'bg-foreground',
          )}
        >
          <Icon
            as={status === 'open' ? KIND_ICONS[c.kind] : CheckIcon}
            className={cn('size-[18px]', status === 'open' ? 'text-secondary-foreground' : 'text-background')}
          />
        </View>
        <View className="shrink grow gap-1.5">
          <Text className="text-[15px] font-semibold leading-5" numberOfLines={1}>
            {c.title}
          </Text>
          {status === 'open' ? (
            <View className="flex-row items-center gap-2.5">
              <View className="bg-fill h-1.5 shrink grow overflow-hidden rounded-full">
                <View className="bg-foreground h-full rounded-full" style={{ width: `${pct}%` }} />
              </View>
              <Text className="text-muted-foreground text-[12px] font-semibold leading-4" style={TABULAR}>
                {challengeCount(c)}
              </Text>
            </View>
          ) : (
            <Text className="text-muted-foreground text-[12px] font-medium leading-4" numberOfLines={1} style={TABULAR}>
              {[status === 'claimed' ? 'Claimed' : carriedOver ? 'From yesterday' : 'Done', reward]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          )}
        </View>
      </View>
      {status === 'open' ? (
        <View className="items-end gap-0.5" accessible={false} importantForAccessibility="no-hide-descendants">
          {c.coins > 0 ? (
            <CoinAmount amount={c.coins} iconClassName="size-3.5" textClassName="text-[13px] leading-[18px]" />
          ) : null}
          {c.xp > 0 ? (
            <Text className="text-muted-foreground text-[12px] font-semibold leading-4" style={TABULAR}>
              {xpLabel(c.xp)}
            </Text>
          ) : null}
        </View>
      ) : status === 'claimable' ? (
        <Button
          size="sm"
          className="h-8 min-w-[72px] rounded-full px-3.5"
          onPress={onClaim}
          disabled={claiming}
          accessibilityLabel={`Claim ${reward}`}
          accessibilityHint={c.title}
        >
          {claiming ? (
            <ActivityIndicator size="small" color={palette.primaryForeground} />
          ) : (
            <Text className="text-[13px]">Claim</Text>
          )}
        </Button>
      ) : null}
    </View>
  );
}

function ChallengesSkeleton() {
  return (
    <View className="bg-card border-border overflow-hidden rounded-2xl border">
      {[0, 1, 2].map((i) => (
        <View key={i}>
          {i > 0 && <Separator className="ml-[64px]" />}
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Skeleton className="size-9 rounded-xl" />
            <View className="shrink grow gap-1.5">
              <SkeletonText lineHeight={20} width={i === 1 ? '62%' : '48%'} />
              <Skeleton className="h-1.5 w-[70%] rounded-full" />
            </View>
            <View className="items-end gap-1">
              <Skeleton className="h-3.5 w-9 rounded-full" />
              <Skeleton className="h-3 w-11 rounded-full" />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
