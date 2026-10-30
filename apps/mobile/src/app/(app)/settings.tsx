import { router } from 'expo-router';
import { GaugeIcon, LifeBuoyIcon, LogOutIcon, ShieldIcon, SunMoonIcon } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { ErrorText } from '@/components/rally/form-field';
import { LogoMark } from '@/components/rally/logo';
import { Segmented } from '@/components/rally/segmented';
import { SettingsGroup, SettingsRow, ToggleRow } from '@/components/rally/settings-rows';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { config } from '@/config';
import { tapHaptic } from '@/lib/haptics';
import { prefs, usePrefs, type Appearance } from '@/lib/prefs';
import { usePrivacy } from '@/lib/privacy';
import { useProfile } from '@/lib/profile';
import { visibilityLabel } from '@/lib/social';
import { openSupportMail } from '@/lib/support';
import { useColumnPadding, useLayout } from '@/lib/use-layout';
import { useSignOut } from '@/lib/use-sign-out';

const APPEARANCE_OPTIONS: readonly { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/**
 * Settings (`/settings`, the drawer's Settings item and Profile's Settings row): Appearance (System / Dark / Light,
 * lib/prefs.ts → `Uniwind.setTheme`), Games (Show FPS in games), Privacy (a summary, opens Edit profile scrolled to its
 * Privacy section), Help & support, Sign out, and the app version. Device preferences live in lib/prefs.ts; privacy
 * is account data (`my_privacy`), edited on Edit profile.
 */
export default function SettingsScreen() {
  const { insets } = useLayout();
  const column = useColumnPadding();
  const { showFps, appearance } = usePrefs();
  const profile = useProfile();
  const privacy = usePrivacy();
  const { signingOut, error: signOutError, signOut } = useSignOut();

  const privacySummary = privacy.data
    ? `Games played: ${visibilityLabel(privacy.data.games)} · Friends list: ${visibilityLabel(privacy.data.friends)}`
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
        <View className="flex-row flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3">
          <View className="bg-muted size-9 items-center justify-center rounded-xl">
            <Icon as={SunMoonIcon} className="text-secondary-foreground size-[18px]" />
          </View>
          <Text className="flex-1 text-[15px] font-medium">Theme</Text>
          <Segmented
            options={APPEARANCE_OPTIONS}
            value={appearance}
            onChange={(next) => {
              if (next === appearance) return;
              tapHaptic();
              prefs.update({ appearance: next });
            }}
            accessibilityLabel="Theme"
          />
        </View>
      </SettingsGroup>

      <SettingsGroup title="Games" footer="A frame-rate counter in the top-left corner while a game runs.">
        <ToggleRow
          icon={GaugeIcon}
          label="Show FPS in games"
          value={showFps}
          onChange={(next) => prefs.update({ showFps: next })}
        />
      </SettingsGroup>

      <SettingsGroup title="Privacy" footer={privacySummary}>
        <SettingsRow
          icon={ShieldIcon}
          label="Profile privacy"
          hint="Choose who sees your games played and friends list"
          onPress={() => router.push({ pathname: '/profile/edit', params: { section: 'privacy' } })}
        />
      </SettingsGroup>

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
