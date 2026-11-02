import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { BombIcon, CopyIcon, InboxIcon, Trash2Icon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Segmented } from '@/components/rally/segmented';
import { SettingsGroup, SettingsRow } from '@/components/rally/settings-rows';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { useSession } from '@/lib/auth/session';
import {
  LOG_LEVEL_TAG,
  LOG_POLL_MS,
  LOG_PREVIEW_LINES,
  LOG_VIEW_LINES,
  logCounts,
  logSignature,
  logTime,
  recentLogs,
  type LogFilter,
} from '@/lib/dev-logs-model';
import { formatLogLines, logBuffer, type LogLevel, type LogLine } from '@/lib/log-buffer';
import { usePrefs } from '@/lib/prefs';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DevSection, copyToClipboard, useConfirm } from './dev-section';

const FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
];

/** The level's colour: errors in the destructive red, warnings in the coins' gold, the rest muted. */
const TONE: Record<LogLevel, string> = { log: 'text-muted-foreground', warn: 'text-gold', error: 'text-destructive' };

const HAPTICS: readonly { label: string; run: () => Promise<void> }[] = [
  { label: 'Light', run: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light) },
  { label: 'Medium', run: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium) },
  { label: 'Heavy', run: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy) },
  { label: 'Success', run: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) },
  { label: 'Warning', run: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning) },
  { label: 'Error', run: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error) },
];

/**
 * Diagnostics: your bug reports, a haptics tester, a deliberate render error for the error boundary, and the in-app
 * log buffer (lib/log-buffer.ts) newest first, with Copy all and Clear.
 */
export function DiagnosticsSection() {
  const { ask, dialog } = useConfirm();
  const [crash, setCrash] = useState(false);
  return (
    <DevSection id="diagnostics" title="Diagnostics">
      <BugReportsGroup />
      <HapticsGroup />
      <SettingsGroup
        title="Error boundary"
        footer="Throws while this page renders, so the root layout's error boundary (expo-router's) takes over with its Retry button. Dev JS shows the red error screen first."
      >
        <SettingsRow
          icon={BombIcon}
          label="Throw a render error"
          destructive
          onPress={() =>
            ask({
              title: 'Throw a render error?',
              body: 'The app is replaced by its error screen until you tap Retry.',
              action: 'Throw',
              onConfirm: () => setCrash(true),
            })
          }
        />
      </SettingsGroup>
      <LogGroup ask={ask} />
      {dialog}
      {crash ? <RenderError /> : null}
    </DevSection>
  );
}

/** Throws on render, on purpose (Diagnostics → Throw a render error). */
function RenderError(): never {
  throw new Error('Developer page: a render error on purpose (Diagnostics → Throw a render error)');
}

function BugReportsGroup() {
  const { signedIn } = useSession();
  const footer = !config.bugReports
    ? 'Bug reports are off in this build (EXPO_PUBLIC_BUG_REPORTS=1 turns them on).'
    : signedIn
      ? 'Shake your phone on any screen to report a bug.'
      : 'Sign in to see your reports.';
  return (
    <SettingsGroup title="Bug reports" footer={footer}>
      <SettingsRow
        icon={InboxIcon}
        label="Your bug reports"
        disabled={!config.bugReports || !signedIn}
        onPress={() => router.push('/bug-reports')}
      />
    </SettingsGroup>
  );
}

function HapticsGroup() {
  const { haptics } = usePrefs();
  return (
    <SettingsGroup
      title="Haptics"
      footer={`${haptics ? 'Calls expo-haptics directly, so it plays even with Settings → Haptics off.' : 'Settings → Haptics is off; the tester plays anyway (it calls expo-haptics directly).'} Simulators and devices without a haptic engine stay silent.`}
    >
      <View className="flex-row flex-wrap gap-2 p-3">
        {HAPTICS.map((h) => (
          <Button
            key={h.label}
            variant="secondary"
            size="sm"
            // The tester's own feedback only: no extra tap haptic from the button.
            haptic={false}
            className="min-w-[30%] grow"
            onPress={() => void h.run().catch(() => {})}
          >
            <Text>{h.label}</Text>
          </Button>
        ))}
      </View>
    </SettingsGroup>
  );
}

/**
 * The log buffer, newest first (the first LOG_PREVIEW_LINES, then up to LOG_VIEW_LINES). The buffer has no change
 * events, so the open viewer looks again every LOG_POLL_MS and redraws only when its fingerprint changed.
 */
function LogGroup({ ask }: { ask: ReturnType<typeof useConfirm>['ask'] }) {
  const [lines, setLines] = useState<LogLine[]>(() => logBuffer.lines());
  const [filter, setFilter] = useState<LogFilter>('all');
  const [more, setMore] = useState(false);

  useEffect(() => {
    // Empty, not the buffer's current fingerprint: a line logged between the first render and now still shows.
    let seen = '';
    const timer = setInterval(() => {
      const next = logBuffer.lines();
      const sig = logSignature(next);
      if (sig === seen) return;
      seen = sig;
      setLines(next);
    }, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const shown = recentLogs(lines, filter, more ? LOG_VIEW_LINES : LOG_PREVIEW_LINES);
  const matching = recentLogs(lines, filter, LOG_VIEW_LINES).length;
  const counts = logCounts(lines);

  const copyAll = () => {
    const all = logBuffer.lines();
    if (all.length === 0) {
      showToast('The log is empty');
      return;
    }
    // Oldest first with UTC times, the way a bug report carries them.
    copyToClipboard(`${all.length} log ${all.length === 1 ? 'line' : 'lines'}`, formatLogLines(all));
  };
  const clear = () =>
    ask({
      title: 'Clear the log?',
      body: 'The buffer starts empty. Bug reports sent later carry only what is logged from now on.',
      action: 'Clear',
      onConfirm: () => {
        logBuffer.clear();
        setLines([]);
        showToast('Log cleared');
      },
    });

  const footer = config.bugReports
    ? `Keeps the last 200 warnings, errors and game host lines (${counts.error} errors, ${counts.warn} warnings, ${counts.log} other). Copy all copies them oldest first, as a bug report does.`
    : 'Log capture is off in this build: it is on in dev JS and with EXPO_PUBLIC_BUG_REPORTS=1.';

  return (
    <SettingsGroup title="Log" footer={footer}>
      <View className="flex-row flex-wrap items-center gap-2 px-3 py-2.5">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} size="sm" accessibilityLabel="Log level" />
        <View className="grow" />
        <Button size="sm" variant="ghost" onPress={copyAll} accessibilityLabel="Copy all log lines">
          <Icon as={CopyIcon} className="text-foreground size-4" />
          <Text>Copy all</Text>
        </Button>
        <Button size="sm" variant="ghost" onPress={clear} accessibilityLabel="Clear the log">
          <Icon as={Trash2Icon} className="text-foreground size-4" />
          <Text>Clear</Text>
        </Button>
      </View>
      <Separator />
      {shown.length === 0 ? (
        <Text variant="muted" className="px-4 py-6 text-center text-[13px]">
          {lines.length === 0 ? 'Nothing logged yet.' : 'No lines at this level.'}
        </Text>
      ) : (
        shown.map((line, i) => (
          <View key={`${line.at}:${i}`} className={cn('gap-0.5 px-4 py-2', i > 0 && 'border-border border-t')}>
            <View className="flex-row items-center gap-2">
              <Text className={cn('text-[11px] font-bold tracking-wide', TONE[line.level])}>
                {LOG_LEVEL_TAG[line.level]}
              </Text>
              <Text className="text-muted-foreground font-mono text-[11px]">{logTime(line.at)}</Text>
            </View>
            <Text className="font-mono text-[12px] leading-4" selectable numberOfLines={8}>
              {line.text}
            </Text>
          </View>
        ))
      )}
      {matching > shown.length ? (
        <>
          <Separator />
          <Button variant="ghost" className="rounded-none" onPress={() => setMore(true)}>
            <Text>{`Show ${matching - shown.length} more`}</Text>
          </Button>
        </>
      ) : null}
    </SettingsGroup>
  );
}
