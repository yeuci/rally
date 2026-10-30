import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePathname } from 'expo-router';
import { CircleAlertIcon } from 'lucide-react-native';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { createRejoinJournal, type RejoinRecord } from '@/game-host/rejoin-journal';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth/session';
import { useGame } from '@/lib/catalog';
import { isGameScreen, rejoinCountdown, rejoinTitle, shouldOfferRejoin } from '@/lib/rejoin';
import { noticeFor, useLaunchGame } from '@/lib/use-launch-game';
import { usePalette } from '@/lib/use-palette';
import { BottomSheet } from './bottom-sheet';
import { LaunchConsentDialog } from './consent-dialog';

/**
 * "Rejoin your Sumo match? 0:42" (m3-phase2 §4): the seat a killed app or an unconsented close left behind, while
 * the server's grace lasts. **Rejoin** opens the game with `join=resume` (the record stays: the play route reads it);
 * **Leave** clears the record. The countdown closes the sheet when it runs out.
 */
export function RejoinSheet({
  record,
  gameTitle,
  resolving,
  notice,
  onRejoin,
  onLeave,
  onClose,
  onExpire,
}: {
  record: RejoinRecord | null;
  gameTitle: string | null | undefined;
  resolving: boolean;
  notice: string | null;
  onRejoin: () => void;
  onLeave: () => void;
  /** Backdrop / Android back: hidden without clearing (the seat is still held). */
  onClose: () => void;
  onExpire: () => void;
}) {
  return (
    <BottomSheet
      open={!!record}
      onClose={onClose}
      title={rejoinTitle(gameTitle)}
      description="Your seat is held until the timer runs out."
    >
      {record ? (
        <RejoinBody
          record={record}
          resolving={resolving}
          notice={notice}
          onRejoin={onRejoin}
          onLeave={onLeave}
          onExpire={onExpire}
        />
      ) : null}
    </BottomSheet>
  );
}

function RejoinBody({
  record,
  resolving,
  notice,
  onRejoin,
  onLeave,
  onExpire,
}: {
  record: RejoinRecord;
  resolving: boolean;
  notice: string | null;
  onRejoin: () => void;
  onLeave: () => void;
  onExpire: () => void;
}) {
  const palette = usePalette();
  const [now, setNow] = useState(Date.now);
  const expire = useEffectEvent(onExpire);

  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (record.expiresAt <= t) expire();
    }, 1000);
    return () => clearInterval(timer);
  }, [record.expiresAt]);

  const countdown = rejoinCountdown(record, now);
  return (
    <View className="gap-4">
      <View
        className="bg-card border-border items-center rounded-2xl border py-4"
        accessible
        accessibilityLabel={countdown.spoken}
      >
        <Text className="text-[44px] font-extrabold leading-[52px] tabular-nums tracking-tight">{countdown.label}</Text>
        <Text className="text-muted-foreground text-[13px]">left to rejoin</Text>
      </View>
      {notice ? (
        <View className="flex-row items-center justify-center gap-1.5 px-2" accessibilityLiveRegion="polite">
          <Icon as={CircleAlertIcon} className="text-muted-foreground size-4" />
          <Text variant="muted" className="shrink text-center">
            {notice}
          </Text>
        </View>
      ) : null}
      <View className="gap-2">
        <Button size="lg" className="h-14 rounded-2xl" disabled={resolving || countdown.expired} onPress={onRejoin}>
          {resolving ? <ActivityIndicator color={palette.primaryForeground} /> : null}
          <Text className="text-[17px] font-bold">Rejoin</Text>
        </Button>
        <Button variant="secondary" size="lg" className="h-12 rounded-2xl" disabled={resolving} onPress={onLeave}>
          <Text>Leave match</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * The rejoin sheet as `(app)/_layout.tsx` mounts it: reads the signed-in user's rejoin journal on cold start and
 * whenever the app becomes active, and offers a live record (more than 5 s left) unless a game is open (its host
 * reconnects by itself). A record hidden with the backdrop is not offered again in this run.
 */
export function RejoinPrompt() {
  const { userId } = useSession();
  const pathname = usePathname();
  const gameOpen = isGameScreen(pathname);
  const launcher = useLaunchGame();
  const journal = useMemo(() => (userId ? createRejoinJournal(AsyncStorage, userId) : null), [userId]);
  const [offer, setOffer] = useState<RejoinRecord | null>(null);
  const [dismissedRoomId, setDismissedRoomId] = useState<string | null>(null);
  const game = useGame(offer?.gameId);

  // Reads the latest pathname and dismissal when the journal answers (not when it was asked).
  const apply = useEffectEvent((rec: RejoinRecord | null) => {
    setOffer(shouldOfferRejoin(rec, { now: Date.now(), gameOpen, dismissedRoomId }) ? rec : null);
  });

  useEffect(() => {
    if (!journal) return;
    let live = true;
    const load = () => {
      void journal.get().then((rec) => {
        if (live) apply(rec);
      });
    };
    load();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [journal]);

  // A game opened (Rejoin, or any other launch): the offer is spent; the play route owns the record now.
  if (gameOpen && offer) setOffer(null);

  const rec = offer;
  return (
    <>
      <RejoinSheet
        // Hidden while the consent dialog (a portal below this modal) asks first.
        record={rec && !launcher.consentGame ? rec : null}
        gameTitle={game.data?.title}
        resolving={!!launcher.pending}
        notice={noticeFor(launcher, rec?.gameId)}
        onRejoin={() =>
          rec && launcher.launch({ id: rec.gameId, title: game.data?.title ?? 'this game' }, { join: 'resume' })
        }
        onLeave={() => {
          if (!rec) return;
          setOffer(null);
          void journal?.clear((r) => r.roomId === rec.roomId);
        }}
        onClose={() => {
          if (rec) setDismissedRoomId(rec.roomId);
          setOffer(null);
        }}
        onExpire={() => setOffer(null)}
      />
      <LaunchConsentDialog launcher={launcher} />
    </>
  );
}
