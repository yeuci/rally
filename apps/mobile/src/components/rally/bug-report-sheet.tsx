import { useQueryClient } from '@tanstack/react-query';
import { Accelerometer } from 'expo-sensors';
import { usePathname } from 'expo-router';
import { ImageOffIcon, SendIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import {
  bugReportKeys,
  bugSheet,
  osLabel,
  sendBugReport,
  startBugReport,
  useBugSheet,
  type BugReportDraft,
} from '@/lib/bug-report';
import { BUG_NOTE_MAX, gameIdFromPath } from '@/lib/bug-report-model';
import { toggleHaptic } from '@/lib/haptics';
import { isAnySheetOpen } from '@/lib/open-sheets';
import { SHAKE, createShakeDetector } from '@/lib/shake';
import { showToast } from '@/lib/toast';
import { usePalette } from '@/lib/use-palette';
import { BottomSheet } from './bottom-sheet';
import { ErrorText } from './form-field';
import { Image } from './image';
import { SHEET_ORIENTATIONS } from '@/game-host/orientation';

/** Height of the screenshot preview; its width follows the screen's aspect ratio (capped for landscape). */
const PREVIEW_HEIGHT = 112;

/**
 * "Report a bug": a note, the screenshot taken when the sheet opened (with a switch to leave it out), what else goes
 * with it, and Send. Presentational; `BugReportHost` owns the state.
 */
export function BugReportSheet({
  draft,
  note,
  onNoteChange,
  includeScreenshot,
  onIncludeScreenshotChange,
  sending,
  error,
  onSend,
  onClose,
}: {
  draft: BugReportDraft | null;
  note: string;
  onNoteChange: (note: string) => void;
  includeScreenshot: boolean;
  onIncludeScreenshotChange: (include: boolean) => void;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onClose: () => void;
}) {
  const palette = usePalette();
  const shot = draft?.screenshot ?? null;
  const previewWidth = Math.min(Math.round(PREVIEW_HEIGHT * (draft?.aspect ?? 0.5)), 200);
  const attached = draft
    ? [
        `Rally ${config.appVersion}`,
        osLabel(),
        draft.gameId ? [draft.gameId, draft.gameVersion].filter(Boolean).join(' ') : draft.route,
        `${draft.logLines} log ${draft.logLines === 1 ? 'line' : 'lines'}`,
      ].join(' · ')
    : '';
  return (
    <BottomSheet
      open={!!draft}
      onClose={sending ? () => {} : onClose}
      title="Report a bug"
      description="What went wrong? The screen and recent logs come along."
      supportedOrientations={SHEET_ORIENTATIONS}
    >
      <View className="gap-4">
        <Textarea
          value={note}
          onChangeText={onNoteChange}
          placeholder="What happened, and what did you expect?"
          maxLength={BUG_NOTE_MAX}
          numberOfLines={5}
          className="min-h-[96px]"
          editable={!sending}
          accessibilityLabel="What went wrong"
        />
        <TapPressable
          onPress={() => shot && onIncludeScreenshotChange(!includeScreenshot)}
          disabled={!shot || sending}
          accessibilityRole="switch"
          accessibilityLabel="Include screenshot"
          accessibilityState={{ checked: !!shot && includeScreenshot, disabled: !shot || sending }}
          className="bg-card border-border active:bg-accent flex-row items-center gap-3.5 rounded-2xl border p-3"
        >
          <View
            className="bg-muted border-border items-center justify-center overflow-hidden rounded-lg border"
            style={{ width: previewWidth, height: PREVIEW_HEIGHT, opacity: shot && !includeScreenshot ? 0.35 : 1 }}
          >
            {shot ? (
              <Image source={{ uri: shot }} className="absolute inset-0" contentFit="cover" transition={0} />
            ) : (
              <Icon as={ImageOffIcon} className="text-muted-foreground size-5" />
            )}
          </View>
          <View className="shrink grow gap-0.5">
            <Text className="text-[15px] font-medium">{shot ? 'Include screenshot' : 'No screenshot'}</Text>
            <Text className="text-muted-foreground text-[13px] leading-[18px]">
              {!shot
                ? "This screen couldn't be captured. The report still goes out."
                : draft?.inGame
                  ? 'Game graphics may come out blank in it.'
                  : 'Of the screen you shook on.'}
            </Text>
          </View>
          {shot ? (
            <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Switch checked={includeScreenshot} onCheckedChange={onIncludeScreenshotChange} />
            </View>
          ) : null}
        </TapPressable>
        <Text variant="muted" className="px-1 text-[12px] leading-4" numberOfLines={2}>
          {`Also sent: ${attached}`}
        </Text>
        <ErrorText>{error}</ErrorText>
        <Button size="lg" className="h-14 rounded-2xl" disabled={sending} onPress={onSend}>
          {sending ? (
            <ActivityIndicator color={palette.primaryForeground} />
          ) : (
            <Icon as={SendIcon} className="text-primary-foreground size-[18px]" />
          )}
          <Text className="text-[17px] font-bold">{sending ? 'Sending…' : 'Send report'}</Text>
        </Button>
      </View>
    </BottomSheet>
  );
}

/**
 * Mounted twice, one of them active at a time (like the friend-request sheet): `shell` in the root layout (every screen
 * but the play route), `game` in the play route (on iOS a Modal only rises over the full-screen game from inside it).
 * The shell host also listens for shakes (lib/shake.ts) while the app is active and a linked account is signed in;
 * a shake captures the screen and opens the sheet (lib/bug-report.ts). Off unless `config.bugReports`.
 */
export function BugReportHost({ placement }: { placement: 'shell' | 'game' }) {
  const { userId, signedIn } = useSession();
  const pathname = usePathname();
  const qc = useQueryClient();
  const draft = useBugSheet();
  const inPlayRoute = !!gameIdFromPath(pathname);
  const active = placement === 'game' || !inPlayRoute;
  const enabled = config.bugReports && signedIn && !!userId;

  // The shake listener lives in the shell host only (always mounted); it reads the route at shake time.
  const route = useRef(pathname);
  useEffect(() => {
    route.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (placement !== 'shell' || !enabled) return;
    const detector = createShakeDetector();
    let sub: { remove: () => void } | null = null;
    let available = false;
    let disposed = false;
    const onShake = () => {
      if (bugSheet.get()) return;
      if (isAnySheetOpen()) {
        showToast('Close the open sheet first to report a bug');
        return;
      }
      toggleHaptic();
      void startBugReport(qc, route.current);
    };
    const start = () => {
      if (sub || !available || disposed) return;
      Accelerometer.setUpdateInterval(SHAKE.intervalMs);
      sub = Accelerometer.addListener((s) => {
        if (detector.push(s, Date.now())) onShake();
      });
    };
    const stop = () => {
      sub?.remove();
      sub = null;
      detector.reset();
    };
    void Accelerometer.isAvailableAsync()
      .then((ok) => {
        available = ok;
        if (AppState.currentState === 'active') start();
      })
      .catch(() => {});
    const appState = AppState.addEventListener('change', (state) => (state === 'active' ? start() : stop()));
    return () => {
      disposed = true;
      stop();
      appState.remove();
    };
  }, [placement, enabled, qc]);

  // Signed out (or the flag is off) while open: drop it.
  useEffect(() => {
    if (!enabled) bugSheet.close();
  }, [enabled]);

  const shown = active && enabled ? draft : null;
  return <BugReportForm key={shown?.id ?? 0} draft={shown} userId={userId} />;
}

function BugReportForm({ draft, userId }: { draft: BugReportDraft | null; userId: string | null }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!draft || !userId || sending) return;
    setSending(true);
    setError(null);
    try {
      const { screenshotSent } = await sendBugReport(userId, draft, { note, includeScreenshot });
      bugSheet.close();
      void qc.invalidateQueries({ queryKey: bugReportKeys.mine(userId) });
      showToast(
        includeScreenshot && draft.screenshot && !screenshotSent
          ? 'Bug report sent (without the screenshot)'
          : 'Bug report sent. Thanks!',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        /RATE_LIMITED/.test(message)
          ? "That's a lot of reports. Try again in a while."
          : /network request failed|fetch failed/i.test(message)
            ? "You're offline. Try again when you're back online."
            : "Couldn't send the report. Try again.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <BugReportSheet
      draft={draft}
      note={note}
      onNoteChange={setNote}
      includeScreenshot={includeScreenshot}
      onIncludeScreenshotChange={setIncludeScreenshot}
      sending={sending}
      error={error}
      onSend={() => void send()}
      onClose={() => bugSheet.close()}
    />
  );
}
