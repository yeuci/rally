import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  BugIcon,
  CoinsIcon,
  Gamepad2Icon,
  GaugeIcon,
  InboxIcon,
  LifeBuoyIcon,
  LogOutIcon,
  ShieldIcon,
  SparklesIcon,
  SunMoonIcon,
  UserPlusIcon,
  VibrateIcon,
  type LucideIcon,
} from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { RetryButton } from '@/components/rally/empty-state';
import { ErrorText } from '@/components/rally/form-field';
import { LogoMark } from '@/components/rally/logo';
import { Segmented } from '@/components/rally/segmented';
import { SettingsGroup, SettingsRow, ToggleRow, ValueRow } from '@/components/rally/settings-rows';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { startBugReport, useMyBugReports } from '@/lib/bug-report';
import { tapHaptic } from '@/lib/haptics';
import { prefs, usePrefs, type Appearance, type FriendAlertStyle } from '@/lib/prefs';
import { usePrivacy } from '@/lib/privacy';
import { useProfile } from '@/lib/profile';
import { visibilityLabel } from '@/lib/social';
import { openSupportMail } from '@/lib/support';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { useReduceMotionSetting } from '@/lib/use-reduce-motion';
import { useSignOut } from '@/lib/use-sign-out';

const APPEARANCE_OPTIONS: readonly { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const ALERT_OPTIONS: readonly { value: FriendAlertStyle; label: string }[] = [
  { value: 'sheet', label: 'Pop-up' },
  { value: 'banner', label: 'Banner' },
  { value: 'off', label: 'Off' },
];

/** Icon, label and a segmented choice on one row (wraps under the label in a narrow column). */
function ChoiceRow<T extends string>({
  icon,
  label,
  options,
  value,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3">
      <View className="bg-muted size-9 items-center justify-center rounded-xl">
        <Icon as={icon} className="text-secondary-foreground size-[18px]" />
      </View>
      <Text className="flex-1 text-[15px] font-medium">{label}</Text>
      <Segmented
        options={options}
        value={value}
        onChange={(next) => {
          if (next === value) return;
          tapHaptic();
          onChange(next);
        }}
        accessibilityLabel={label}
      />
    </View>
  );
}

/**
 * Settings (`/settings`, the drawer's Settings item and Profile's Settings row): Appearance (System / Dark / Light,
 * lib/prefs.ts → `Uniwind.setTheme`), Notifications (friend requests outside and inside games: Pop-up / Banner / Off,
 * lib/friend-alerts.ts; Coin popups: the "+25 coins" toast on or off, lib/coin-toast.ts), Feedback & motion
 * (Haptics, `prefs.haptics` → lib/haptics.ts; Reduce motion is the OS setting, shown, not owned), Games (Show FPS in games), Privacy (a summary, opens Edit profile scrolled to its
 * Privacy section), Developer (dev builds and `EXPO_PUBLIC_BUG_REPORTS=1` only: report a bug, your bug reports),
 * Help & support, Sign out, and the app version. Device preferences live in lib/prefs.ts; privacy is account data
 * (`my_privacy`), edited on Edit profile.
 */
export default function SettingsScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const { showFps, appearance, haptics, friendAlerts, friendAlertsInGame, coinPopups } = usePrefs();
  const reduceMotion = useReduceMotionSetting();
  const profile = useProfile();
  const privacy = usePrivacy();
  const { signingOut, error: signOutError, signOut } = useSignOut();

  const privacySummary = privacy.data
    ? `Games played: ${visibilityLabel(privacy.data.games)} · Friends list: ${visibilityLabel(privacy.data.friends)} · Online status: ${visibilityLabel(privacy.data.presence)}`
    : privacy.isError
      ? "Couldn't load your privacy settings."
      : undefined;

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerClassName="gap-7 pt-6"
      contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
    >
      <SettingsGroup title="Appearance" footer="System follows your device's light or dark setting.">
        <ChoiceRow
          icon={SunMoonIcon}
          label="Theme"
          options={APPEARANCE_OPTIONS}
          value={appearance}
          onChange={(next) => prefs.update({ appearance: next })}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Notifications"
        footer="A banner shows at the top for 5 seconds. With Off, requests still wait in Friends. Coin popups show what you just earned, in games too."
      >
        <ChoiceRow
          icon={UserPlusIcon}
          label="Friend requests"
          options={ALERT_OPTIONS}
          value={friendAlerts}
          onChange={(next) => prefs.update({ friendAlerts: next })}
        />
        <Separator className="ml-16" />
        <ChoiceRow
          icon={Gamepad2Icon}
          label="While playing"
          options={ALERT_OPTIONS}
          value={friendAlertsInGame}
          onChange={(next) => prefs.update({ friendAlertsInGame: next })}
        />
        <Separator className="ml-16" />
        <ToggleRow
          icon={CoinsIcon}
          label="Coin popups"
          value={coinPopups}
          onChange={(next) => prefs.update({ coinPopups: next })}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Feedback & motion"
        footer="Reduce motion follows your device's accessibility setting: with it on, Rally pauses the featured carousel and skips animations."
      >
        <ToggleRow
          icon={VibrateIcon}
          label="Haptics"
          value={haptics}
          onChange={(next) => prefs.update({ haptics: next })}
        />
        <Separator className="ml-16" />
        <ValueRow
          icon={SparklesIcon}
          label="Reduce motion"
          value={reduceMotion === null ? '…' : reduceMotion ? 'On' : 'Off'}
        />
      </SettingsGroup>

      <SettingsGroup title="Games" footer="A frame-rate counter in the top-left corner while a game runs.">
        <ToggleRow
          icon={GaugeIcon}
          label="Show FPS in games"
          value={showFps}
          onChange={(next) => prefs.update({ showFps: next })}
        />
      </SettingsGroup>

      <View className="gap-2">
        <SettingsGroup title="Privacy" footer={privacySummary}>
          <SettingsRow
            icon={ShieldIcon}
            label="Profile privacy"
            hint="Choose who sees your games, friends and online status"
            onPress={() => router.push({ pathname: '/profile/edit', params: { section: 'privacy' } })}
          />
        </SettingsGroup>
        {privacy.isError ? (
          <View className="self-start px-1">
            <RetryButton compact onPress={() => void privacy.refetch()} />
          </View>
        ) : null}
      </View>

      {config.bugReports ? <DeveloperSection /> : null}

      <View className="gap-2">
        <SettingsGroup>
          <SettingsRow
            icon={LifeBuoyIcon}
            label="Help & support"
            onPress={() => openSupportMail('Rally support', profile.data?.username)}
          />
          <Separator className="ml-16" />
          <SettingsRow
            icon={LogOutIcon}
            label={signingOut ? 'Signing out…' : 'Sign out'}
            onPress={signOut}
            disabled={signingOut}
            chevron={false}
          />
        </SettingsGroup>
        <ErrorText>{signOutError}</ErrorText>
      </View>

      <View className="flex-row items-center justify-center gap-1.5 opacity-70">
        <LogoMark size={16} />
        <Text variant="muted" className="text-xs">
          Rally {config.appVersion}
        </Text>
      </View>
    </ScrollView>
  );
}

/**
 * Developer (playtest builds): "Report a bug" (the shake sheet, for when shaking is not handy) and your own reports
 * (`/bug-reports`). See docs/bug-reports.md.
 */
function DeveloperSection() {
  const qc = useQueryClient();
  const reports = useMyBugReports();
  const count = reports.data?.length;
  return (
    <SettingsGroup
      title="Developer"
      footer="Shake your phone on any screen to report a bug. A screenshot, the app version and recent logs go with your note."
    >
      <SettingsRow icon={BugIcon} label="Report a bug" onPress={() => void startBugReport(qc, '/settings')} />
      <Separator className="ml-16" />
      <SettingsRow
        icon={InboxIcon}
        label="Bug reports"
        value={count ? String(count) : undefined}
        onPress={() => router.push('/bug-reports')}
      />
    </SettingsGroup>
  );
}
