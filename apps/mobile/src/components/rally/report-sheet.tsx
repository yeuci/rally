import { BanIcon, CheckIcon, FlagIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import { useFriendshipAction } from '@/lib/friends';
import { reportPlayer } from '@/lib/report';
import {
  REPORT_NOTE_MAX,
  REPORT_REASON_OPTIONS,
  canSendReport,
  reportErrorMessage,
  reportThanks,
  type ReportReason,
} from '@/lib/report-model';
import type { Friendship } from '@/lib/social';
import { showToast } from '@/lib/toast';
import { usePalette } from '@/lib/use-palette';
import { cn } from '@/lib/utils';
import { useViewport } from '@/lib/viewport';
import { SHEET_ORIENTATIONS } from '@/game-host/orientation';
import { BottomSheet, SheetScrollView } from './bottom-sheet';
import { ErrorText } from './form-field';

/**
 * Height kept free around the scrolling part of the sheet: the grabber, title and description above it, the Send
 * button and the bottom padding below it, and a margin under the status bar.
 */
const RESERVED_HEIGHT = 250;

/** Who is being reported, and from where (the context goes to moderators with the report). */
export interface ReportTarget {
  userId: string;
  /** How the sheet names them: "@ben", or the in-game name while the profile is unknown. */
  name: string;
  /** The relationship when known; an already blocked player gets no "Also block" switch. */
  friendship?: Friendship | null;
  gameId?: string | null;
  roomId?: string | null;
}

/**
 * "Report @ben" (App Store 1.2 / 4.7.1; docs/moderation.md): a reason from the fixed list, an optional note, an "Also
 * block this player" switch, and Send. The report goes through `report_user` (lib/report.ts); with the switch on, the
 * player is then blocked through the usual `block_user` mutation (optimistic everywhere the relationship shows, its own
 * alert if it fails). A thank-you toast closes it. Opened from a public profile's ⋯ menu and from the game menu's
 * People list; it can rise over a running game (SHEET_ORIENTATIONS, and BottomSheet keeps it upright over a game turned
 * inside the app).
 */
export function ReportSheet({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  // While a report is on its way the sheet stays open (the backdrop and Android back do nothing).
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target ? `Report ${target.name}` : 'Report a player'}
      description={`Only Rally's moderators see reports. ${target?.name ?? 'They'} won't know it was you.`}
      supportedOrientations={SHEET_ORIENTATIONS}
    >
      {/* Mounted per opening: every report starts empty. */}
      {target ? <ReportForm key={target.userId} target={target} onBusyChange={setBusy} onDone={onClose} /> : null}
    </BottomSheet>
  );
}

function ReportForm({
  target,
  onBusyChange,
  onDone,
}: {
  target: ReportTarget;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const palette = usePalette();
  const { height, insets } = useViewport();
  const block = useFriendshipAction();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alreadyBlocked = target.friendship === 'blocked';

  // Unmounted mid-send (the caller dropped the target): the next opening must not start locked.
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const send = async () => {
    if (!canSendReport(reason, sending)) return;
    setSending(true);
    onBusyChange(true);
    setError(null);
    try {
      await reportPlayer({ userId: target.userId, reason, note, gameId: target.gameId, roomId: target.roomId });
    } catch (err) {
      setError(reportErrorMessage(err));
      setSending(false);
      onBusyChange(false);
      return;
    }
    // The report is in either way; a failed block explains itself (useFriendshipAction's alert).
    const blocked =
      alsoBlock && !alreadyBlocked
        ? await block
            .mutateAsync({ userId: target.userId, intent: 'block', current: target.friendship ?? 'none' })
            .then(
              () => true,
              () => false,
            )
        : false;
    onBusyChange(false);
    onDone();
    showToast(reportThanks(target.name, blocked));
  };

  return (
    <View className="gap-4">
      <SheetScrollView
        style={{ maxHeight: Math.max(180, height - insets.top - RESERVED_HEIGHT) }}
        contentContainerClassName="gap-4"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View
          className="bg-card border-border overflow-hidden rounded-2xl border"
          accessibilityRole="radiogroup"
          accessibilityLabel="Reason"
        >
          {REPORT_REASON_OPTIONS.map((o, i) => {
            const selected = o.value === reason;
            return (
              <View key={o.value}>
                {i > 0 && <Separator className="ml-4" />}
                <TapPressable
                  onPress={() => setReason(o.value)}
                  disabled={sending}
                  accessibilityRole="radio"
                  accessibilityLabel={o.label}
                  accessibilityState={{ checked: selected, disabled: sending }}
                  className="active:bg-accent min-h-11 flex-row items-center gap-3 px-4 py-2.5"
                >
                  <Text className={cn('flex-1 text-[15px]', selected ? 'font-semibold' : 'font-medium')}>
                    {o.label}
                  </Text>
                  <View
                    className={cn(
                      'size-5 items-center justify-center rounded-full border-2',
                      selected ? 'bg-primary border-primary' : 'border-input',
                    )}
                  >
                    {selected ? <Icon as={CheckIcon} className="text-primary-foreground size-3" /> : null}
                  </View>
                </TapPressable>
              </View>
            );
          })}
        </View>
        <Textarea
          value={note}
          onChangeText={setNote}
          placeholder="Add details (optional)"
          maxLength={REPORT_NOTE_MAX}
          numberOfLines={4}
          className="min-h-[72px]"
          editable={!sending}
          accessibilityLabel="Details, optional"
        />
        {alreadyBlocked ? null : (
          <TapPressable
            onPress={() => setAlsoBlock(!alsoBlock)}
            disabled={sending}
            accessibilityRole="switch"
            accessibilityLabel="Also block this player"
            accessibilityState={{ checked: alsoBlock, disabled: sending }}
            className="bg-card border-border active:bg-accent flex-row items-center gap-3.5 rounded-2xl border px-4 py-3"
          >
            <View className="bg-muted size-9 items-center justify-center rounded-xl">
              <Icon as={BanIcon} className="text-secondary-foreground size-[18px]" />
            </View>
            <View className="shrink grow gap-0.5">
              <Text className="text-[15px] font-medium">Also block this player</Text>
              <Text className="text-muted-foreground text-[13px] leading-[18px]">
                They can&apos;t find you, see your profile or send you requests.
              </Text>
            </View>
            <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Switch checked={alsoBlock} onCheckedChange={setAlsoBlock} />
            </View>
          </TapPressable>
        )}
        <ErrorText>{error}</ErrorText>
      </SheetScrollView>
      <Button
        size="lg"
        className="h-14 rounded-2xl"
        disabled={!canSendReport(reason, sending)}
        onPress={() => void send()}
      >
        {sending ? (
          <ActivityIndicator color={palette.primaryForeground} />
        ) : (
          <Icon as={FlagIcon} className="text-primary-foreground size-[18px]" />
        )}
        <Text className="text-[17px] font-bold">{sending ? 'Sending…' : 'Send report'}</Text>
      </Button>
    </View>
  );
}
