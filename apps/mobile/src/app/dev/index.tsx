import { Stack } from 'expo-router';
import { MoonStarIcon, SunIcon } from 'lucide-react-native';
import { ScrollView } from 'react-native';
import { useUniwind } from 'uniwind';
import { DiagnosticsSection } from '@/components/dev/diagnostics-section';
import { EnvironmentSection } from '@/components/dev/environment-section';
import { LaunchSection } from '@/components/dev/launch-section';
import { PreviewsSection } from '@/components/dev/previews-section';
import { ResetSection } from '@/components/dev/reset-section';
import { Icon } from '@/components/ui/icon';
import { TapPressable } from '@/components/ui/tap-pressable';
import { Text } from '@/components/ui/text';
import { prefs } from '@/lib/prefs';
import { useColumnPadding } from '@/lib/use-layout';
import { useViewport } from '@/lib/viewport';

/**
 * Developer (`/dev`, dev builds and `EXPO_PUBLIC_DEV_TOOLS=1` only: `config.devTools`), reached from the drawer, the
 * profile and the welcome screen, so it works signed out. Self-contained sections, each folding away
 * (components/dev/*): Environment (build, services with a live game server check, account, device), Launch a game
 * (presets for every game in games/*, the full-screen dev host), UI previews (toasts, celebrations, the friend-request
 * banner, the vote prompt, the offline pill, the intro), Reset and storage, and Diagnostics (bug reports, haptics, an
 * error-boundary check, the log buffer). The header's button flips the theme.
 */
export default function DeveloperScreen() {
  const { insets } = useViewport();
  const column = useColumnPadding(640);
  return (
    <>
      <Stack.Screen options={{ title: 'Developer', headerRight: () => <ThemeToggle /> }} />
      <ScrollView
        className="bg-background flex-1"
        contentContainerClassName="gap-8 pt-4"
        contentContainerStyle={[column, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text variant="muted" className="px-1 text-[13px] leading-[18px]">
          What this build talks to, game launches, UI previews, resets and logs. Only in dev builds; works signed out.
        </Text>
        <EnvironmentSection />
        <LaunchSection />
        <PreviewsSection />
        <ResetSection />
        <DiagnosticsSection />
      </ScrollView>
    </>
  );
}

/** Light / dark, through the preference (persisted, and Settings → Appearance shows it), not Uniwind.setTheme directly. */
function ThemeToggle() {
  const { theme } = useUniwind();
  const dark = theme === 'dark';
  return (
    <TapPressable
      onPress={() => prefs.update({ appearance: dark ? 'light' : 'dark' })}
      accessibilityRole="button"
      accessibilityLabel={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}
      hitSlop={10}
      className="active:opacity-70"
    >
      <Icon as={dark ? SunIcon : MoonStarIcon} className="text-foreground size-6" />
    </TapPressable>
  );
}
