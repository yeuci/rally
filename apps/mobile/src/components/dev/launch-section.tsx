import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Gamepad2Icon, GlobeIcon, LayersIcon, LogInIcon, PlayIcon } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ErrorText } from '@/components/rally/form-field';
import { Segmented } from '@/components/rally/segmented';
import { SettingsGroup } from '@/components/rally/settings-rows';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { roomByCode } from '@/game-host/matchmake';
import { launchStore, useLaunchStore, type DevJoinMode, type LaunchSettings } from '@/launch-store';
import { hostOf } from '@/lib/dev-env-model';
import {
  DEV_GAME_PRESETS,
  applyPreset,
  devMachineHost,
  effectiveGameId,
  isSoloLaunch,
  lookupMessage,
  planLaunch,
  presetById,
  presetFor,
  presetHost,
  runRows,
} from '@/lib/dev-launch-model';
import { joinTargetParams, targetForCode, type JoinTarget } from '@/lib/join-target';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { usePalette } from '@/lib/use-palette';
import { CopyRow, DevRowIcon, DevSection, Disclosure } from './dev-section';
import { HealthRows } from './environment-section';

const CUSTOM = 'custom';

const PRESET_OPTIONS: readonly { value: string; label: string }[] = [
  ...DEV_GAME_PRESETS.map((p) => ({ value: p.id, label: p.title })),
  { value: CUSTOM, label: 'Custom' },
];

const JOIN_MODES: readonly { value: DevJoinMode; label: string }[] = [
  { value: 'quick', label: 'Quick' },
  { value: 'create', label: 'Create' },
  { value: 'code', label: 'Code' },
  { value: 'room', label: 'Room id' },
];

const ORIENTATIONS: readonly { value: LaunchSettings['orientation']; label: string }[] = [
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
];

/** Presets fall back to the machine Metro runs on (a LAN address in Expo Go), else localhost (a simulator). */
const FALLBACK_HOST = devMachineHost(Constants.expoConfig?.hostUri) ?? 'localhost';

/**
 * Launch a game: a preset per game in games/* (its Vite dev server on the dev machine, its room type and
 * orientation) or Custom, the join mode, and Launch, which opens the full-screen dev host (app/dev/play.tsx) as a
 * guest with in-memory saves. The raw fields (bundle URL, game server, room, game id, orientation) sit under Advanced;
 * editing one makes the launch custom. The last run's timings and the game's metrics follow when there is one.
 */
export function LaunchSection() {
  const { settings, lastRun } = useLaunchStore();
  const palette = usePalette();
  const [custom, setCustom] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const matched = presetFor(settings);
  const preset = custom ? null : matched;
  const solo = isSoloLaunch(settings);
  const gameId = effectiveGameId(settings);
  const title = preset?.title ?? presetById(gameId)?.title ?? gameId;

  function choose(id: string) {
    setError(null);
    if (id === CUSTOM) {
      setCustom(true);
      setAdvanced(true);
      return;
    }
    const next = presetById(id);
    if (!next) return;
    setCustom(false);
    launchStore.setSettings(applyPreset(next, settings, FALLBACK_HOST));
  }

  /** Settings → the same `JoinTarget` the play route takes (a code is looked up first, like the code sheet does). */
  async function launch() {
    const plan = planLaunch(settings);
    if (plan.kind === 'error') {
      setError(plan.message);
      return;
    }
    let target: JoinTarget;
    if (plan.kind === 'code') {
      setLooking(true);
      try {
        const found = await targetForCode(plan.code, plan.roomName, (code) => roomByCode(settings.colyseusUrl, code));
        if (!found.ok) {
          setError(
            found.reason === 'bad-code'
              ? 'Codes are 6 characters (no 0, O, 1, I or L).'
              : `That code is not for a "${plan.roomName}" room.`,
          );
          return;
        }
        target = found.target;
      } catch (err) {
        setError(lookupMessage(err));
        return;
      } finally {
        setLooking(false);
      }
    } else {
      target = plan.target;
    }
    setError(null);
    router.push({ pathname: '/dev/play', params: joinTargetParams(target) });
  }

  return (
    <DevSection id="launch" title="Launch a game" summary={title} defaultOpen>
      <View className="gap-3">
        <Segmented
          options={PRESET_OPTIONS}
          value={preset?.id ?? CUSTOM}
          onChange={choose}
          scrollable
          accessibilityLabel="Game preset"
        />
        <SettingsGroup>
          <CopyRow icon={Gamepad2Icon} label="Game" value={`${title} · ${settings.orientation}`} />
          <Separator className="ml-16" />
          <CopyRow
            icon={GlobeIcon}
            label="Bundle"
            value={hostOf(settings.bundleUrl) ?? settings.bundleUrl}
            copy={settings.bundleUrl}
          />
          <Separator className="ml-16" />
          <CopyRow
            icon={LayersIcon}
            label="Room"
            value={solo ? 'None (solo game)' : `${settings.roomName.trim()} on ${hostOf(settings.colyseusUrl) ?? '?'}`}
          />
          {solo ? null : (
            <>
              <Separator className="ml-16" />
              {/* Wraps under the label in a narrow column, like Settings' choice rows. */}
              <View className="flex-row flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3">
                <DevRowIcon icon={LogInIcon} />
                <Text className="flex-1 text-[15px] font-medium">Join</Text>
                <Segmented
                  options={JOIN_MODES}
                  value={settings.join}
                  onChange={(join) => launchStore.setSettings({ join })}
                  size="sm"
                  accessibilityLabel="How session.join matchmakes"
                />
              </View>
              {settings.join === 'code' || settings.join === 'room' ? (
                <View className="px-4 pb-3">
                  <Input
                    accessibilityLabel={settings.join === 'code' ? 'Join code' : 'Room id'}
                    value={settings.joinValue}
                    onChangeText={(joinValue) => launchStore.setSettings({ joinValue })}
                    autoCapitalize={settings.join === 'code' ? 'characters' : 'none'}
                    autoCorrect={false}
                    placeholder={settings.join === 'code' ? 'K7M-2PQ' : 'room id (from /rooms/<name> or the monitor)'}
                  />
                </View>
              ) : null}
            </>
          )}
        </SettingsGroup>
        <ErrorText>{error}</ErrorText>
        <Button size="lg" onPress={() => void launch()} disabled={looking}>
          {looking ? <ActivityIndicator color={palette.primaryForeground} /> : <Icon as={PlayIcon} />}
          <Text>{`Launch ${title}`}</Text>
        </Button>
        <Text variant="muted" className="px-1 text-[13px] leading-[18px]">
          {`Opens full screen as a guest: no account needed, saves stay in memory, and FPS, frame time and round trips are measured. Start the game's dev server first: pnpm --filter @rally/game-${preset?.id ?? gameId} dev. Presets use ${presetHost(settings.bundleUrl, FALLBACK_HOST)}; change it in the bundle URL under Advanced.`}
        </Text>
      </View>

      <View className="gap-3">
        <Disclosure open={advanced} onToggle={() => setAdvanced(!advanced)} label="Advanced" />
        {advanced ? <AdvancedFields settings={settings} /> : null}
      </View>

      {lastRun ? (
        <SettingsGroup title="Last run" footer={new Date(lastRun.endedAt).toLocaleTimeString()}>
          {runRows(lastRun).map((row, i) => (
            // A game's metric may share a label with a timing row: the index keeps keys unique.
            <View key={`${i}:${row.label}`}>
              {i > 0 ? <Separator className="ml-4" /> : null}
              <MetricRow label={row.label} value={row.value} />
            </View>
          ))}
        </SettingsGroup>
      ) : null}
    </DevSection>
  );
}

/** The raw launch settings, and a health check of the launcher's own game server (it may differ from the app's). */
function AdvancedFields({ settings }: { settings: LaunchSettings }) {
  // Checked once typing pauses, not on every keystroke.
  const serverUrl = useDebouncedValue(settings.colyseusUrl, 700);
  return (
    <View className="gap-4">
      <Field id="dev-bundle" label="Game bundle URL">
        <Input
          aria-labelledby="dev-bundle"
          value={settings.bundleUrl}
          onChangeText={(bundleUrl) => launchStore.setSettings({ bundleUrl })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.20:5182/index.html"
        />
      </Field>
      <Field id="dev-colyseus" label="Colyseus HTTP URL">
        <Input
          aria-labelledby="dev-colyseus"
          value={settings.colyseusUrl}
          onChangeText={(colyseusUrl) => launchStore.setSettings({ colyseusUrl: colyseusUrl.replace(/\/$/, '') })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://<app>.colyseus.cloud"
        />
      </Field>
      <SettingsGroup>
        <HealthRows url={serverUrl} label="Server" />
      </SettingsGroup>
      <Field id="dev-room" label="Room">
        <Input
          aria-labelledby="dev-room"
          value={settings.roomName}
          onChangeText={(roomName) => launchStore.setSettings({ roomName })}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="empty for a solo game"
        />
      </Field>
      <Field id="dev-game-id" label="Game id">
        <Input
          aria-labelledby="dev-game-id"
          value={settings.gameId}
          onChangeText={(gameId) => launchStore.setSettings({ gameId })}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={effectiveGameId({ gameId: '', roomName: settings.roomName })}
        />
      </Field>
      <Field id="dev-orientation" label="Orientation">
        <Segmented
          options={ORIENTATIONS}
          value={settings.orientation}
          onChange={(orientation) => launchStore.setSettings({ orientation })}
          accessibilityLabel="Orientation"
        />
      </Field>
    </View>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Label nativeID={id}>{label}</Label>
      {children}
    </View>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-3 px-4 py-2.5">
      <Text variant="muted">{label}</Text>
      <Text className="shrink text-right font-mono text-sm" selectable>
        {value}
      </Text>
    </View>
  );
}
