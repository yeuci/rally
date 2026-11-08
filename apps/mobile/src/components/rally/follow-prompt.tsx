import { usePathname } from 'expo-router';
import { useEffect, useEffectEvent, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useGame } from '@/lib/catalog';
import { createBannerCountdown } from '@/lib/friend-alerts-model';
import { tapHaptic } from '@/lib/haptics';
import { useOtherSheetOpen, usePromptSlot } from '@/lib/open-sheets';
import { followStore, useFollowLaunch, useParty, type FollowLaunch } from '@/lib/party';
import {
  FOLLOW_COUNTDOWN_MS,
  followBannerLine,
  followDecision,
  followSecondsLeft,
  followTitle,
  memberName,
  memberOf,
} from '@/lib/party-model';
import { isGameScreen } from '@/lib/rejoin';
import { showToast } from '@/lib/toast';
import { useLaunchGame } from '@/lib/use-launch-game';
import { usePalette } from '@/lib/use-palette';
import { SHEET_ORIENTATIONS } from '@/game-host/orientation';
import { AlertBanner } from './alert-banner';
import { BottomSheet } from './bottom-sheet';
import { LaunchConsentDialog } from './consent-dialog';
import { useSettled } from './friend-request-sheet';

/** The in-game banner's auto-dismiss (5 s, like the other banners); on expiry the launch is let go. */
const followBannerCountdown = createBannerCountdown(
  {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: Date.now,
  },
  (launchId) => followStore.dismiss(launchId),
);

/** The countdown's refresh (the number on the sheet changes once a second; this keeps it on time). */
const TICK_MS = 250;

/**
 * "Joining sloth in Sumo…" with a 4 s countdown, **Not now** and **Join now** (docs/social-phase.md §5, the follow
 * flow). Presentational; FollowPrompt decides when it shows and what joining does.
 */
export function FollowSheet({
  launch,
  title,
  busy,
  onJoin,
  onNotNow,
}: {
  launch: FollowLaunch | null;
  title: string;
  busy: boolean;
  onJoin: () => void;
  onNotNow: () => void;
}) {
  return (
    <BottomSheet
      open={!!launch}
      onClose={onNotNow}
      title={title}
      description="Your party leader started a game. You'll join them in a moment."
      supportedOrientations={SHEET_ORIENTATIONS}
      register={false}
    >
      {launch ? <FollowBody key={launch.launchId} busy={busy} onJoin={onJoin} onNotNow={onNotNow} /> : null}
    </BottomSheet>
  );
}

function FollowBody({ busy, onJoin, onNotNow }: { busy: boolean; onJoin: () => void; onNotNow: () => void }) {
  const palette = usePalette();
  // The countdown starts when the sheet shows (not when the launch arrived).
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(startedAt);
  const join = useEffectEvent(onJoin);
  const left = followSecondsLeft(startedAt, now, FOLLOW_COUNTDOWN_MS);
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (followSecondsLeft(startedAt, t, FOLLOW_COUNTDOWN_MS) <= 0) {
        clearInterval(timer);
        join();
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <View className="gap-4">
      <View
        className="bg-card border-border items-center rounded-2xl border py-4"
        accessible
        accessibilityLabel={left === 1 ? 'Joining in 1 second' : `Joining in ${left} seconds`}
      >
        <Text className="text-[44px] font-extrabold leading-[52px] tabular-nums tracking-tight">{left}</Text>
        <Text className="text-muted-foreground text-[13px]">{busy ? 'Starting…' : 'Joining in'}</Text>
      </View>
      <View className="flex-row gap-2">
        <Button variant="secondary" size="lg" className="h-12 flex-1 rounded-2xl" disabled={busy} onPress={onNotNow}>
          <Text>Not now</Text>
        </Button>
        <Button size="lg" className="h-12 flex-1 rounded-2xl" disabled={busy} onPress={onJoin}>
          {busy ? <ActivityIndicator color={palette.primaryForeground} /> : null}
          <Text className="text-[16px] font-bold">Join now</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * The follow flow's host (lib/party.ts `followStore`, filled by a `launch` on the party channel; the leader's own
 * launch never gets there). Mounted twice like the other prompts, exactly one active:
 *
 * - `shell` in `(app)/_layout.tsx` while no game is open: the countdown sheet; at 0 (or on **Join now**) it opens
 *   `join=party&launch=<id>`; **Not now** lets the launch go (the party screen still offers "Playing Sumo · Join");
 * - `game` in the play route (a member already in another game): the banner "Your party started Sumo" [Join], which
 *   replaces the running game with the party's. `currentLaunchId` is the launch the play route was opened with:
 *   that one shows nothing.
 *
 * The store drops a launch FOLLOW_MAX_AGE_MS after it arrived, so one that waited for a host too long never shows.
 */
export function FollowPrompt({
  placement,
  currentLaunchId,
}: {
  placement: 'shell' | 'game';
  currentLaunchId?: string | null;
}) {
  const inGame = placement === 'game';
  const { userId } = useSession();
  const launch = useFollowLaunch();
  const party = useParty();
  const gameOpen = isGameScreen(usePathname());
  const otherSheet = useOtherSheetOpen();
  const shellReady = useSettled(!gameOpen && !otherSheet, true);
  const gameReady = useSettled(true, false);
  const active = inGame ? gameReady : shellReady;
  const launcher = useLaunchGame();
  const game = useGame(launch?.gameId);

  const decision = launch && active ? followDecision(launch, userId, inGame) : 'none';
  const own = !!launch && launch.launchId === currentLaunchId;
  const head = launch && decision !== 'none' && !own ? launch : null;

  // The launch this screen joined is let go (the store drops stale ones by itself: lib/party.ts followStore).
  const ownId = own && launch ? launch.launchId : null;
  useEffect(() => {
    if (ownId) followStore.dismiss(ownId);
  }, [ownId]);
  // One self-opening prompt at a time (lib/open-sheets.ts): the follow waits while a request or invite shows (the
  // launch store drops it if it waits too long).
  const slot = usePromptSlot(`follow:${placement}`, !!head);
  const shown = slot ? head : null;

  const leader = memberOf(party.data, shown?.leaderId ?? null);
  const leaderName = leader ? memberName(leader) : null;
  const gameTitle = game.data?.title ?? null;

  const shownId = shown?.launchId ?? null;
  // Once per launch shown: the latest names are read when it shows, not when they load.
  const announce = useEffectEvent(() =>
    AccessibilityInfo.announceForAccessibility(
      inGame ? followBannerLine(gameTitle) : followTitle(leaderName, gameTitle),
    ),
  );
  useEffect(() => {
    if (!shownId) return;
    tapHaptic();
    announce();
  }, [shownId]);

  const notice = launcher.notice?.message ?? null;
  useEffect(() => {
    if (notice) showToast(notice);
  }, [notice]);

  const join = () => {
    if (!shown) return;
    followStore.dismiss(shown.launchId);
    launcher.launch(
      { id: shown.gameId, title: gameTitle ?? 'this game' },
      { join: 'party', launch: shown.launchId },
      { replace: inGame },
    );
  };
  const notNow = () => shown && followStore.dismiss(shown.launchId);

  const bannerItem =
    inGame && shown && decision === 'banner'
      ? {
          key: shown.launchId,
          label: 'Party',
          bold: null,
          rest: followBannerLine(gameTitle),
          avatar: leader
            ? {
                userId: leader.user_id,
                username: leader.username,
                displayName: leader.display_name,
                avatarUrl: leader.avatar_url,
              }
            : null,
          actionLabel: 'Join',
          actionAccessibilityLabel: `Join your party in ${gameTitle ?? 'their game'}`,
        }
      : null;

  return (
    <>
      {inGame ? (
        <AlertBanner
          item={bannerItem}
          countdown={followBannerCountdown}
          onAction={join}
          onDismiss={(id) => followStore.dismiss(id)}
        />
      ) : (
        <FollowSheet
          launch={shown && decision === 'sheet' ? shown : null}
          title={followTitle(leaderName, gameTitle)}
          busy={!!launcher.pending}
          onJoin={join}
          onNotNow={notNow}
        />
      )}
      <LaunchConsentDialog launcher={launcher} />
    </>
  );
}
