import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import {
  DatabaseIcon,
  HandIcon,
  ImageOffIcon,
  MoveIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  ThumbsUpIcon,
} from 'lucide-react-native';
import { DevSettings } from 'react-native';
import { SettingsGroup, SettingsRow } from '@/components/rally/settings-rows';
import { Separator } from '@/components/ui/separator';
import { STORAGE_RESET_PREFIXES, keysWithPrefix } from '@/lib/dev-storage-model';
import { prefs } from '@/lib/prefs';
import { DEFAULTS } from '@/lib/prefs-parse';
import { showToast } from '@/lib/toast';
import { DevSection, useConfirm } from './dev-section';

/** Removes every stored key under `prefix`; how many went. */
async function removeStoredKeys(prefix: string): Promise<number> {
  const keys = keysWithPrefix(await AsyncStorage.getAllKeys(), prefix);
  if (keys.length > 0) await AsyncStorage.multiRemove(keys);
  return keys.length;
}

/** "1 game", "3 games". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Reset and storage: clear the query cache and expo-image's caches, forget where game menu buttons were moved, what
 * the vote prompt remembers and which accounts saw the first-run welcome, put the device preferences back to their
 * defaults, and (dev JS) reload to replay the intro. Each asks first and ends with a toast. Account data on the
 * server is never touched.
 */
export function ResetSection() {
  const qc = useQueryClient();
  const { ask, dialog } = useConfirm();

  const clearQueries = () =>
    ask({
      title: 'Clear the query cache?',
      body: 'Every cached server answer is dropped. Screens that are open load theirs again.',
      action: 'Clear',
      onConfirm: () => {
        const n = qc.getQueryCache().getAll().length;
        // Inactive answers go; active ones are reset and fetched again, so nothing on screen keeps stale data.
        qc.removeQueries({ type: 'inactive' });
        void qc.resetQueries({ type: 'active' });
        showToast(`Cleared ${count(n, 'cached query', 'cached queries')}`);
      },
    });

  const clearImages = () =>
    ask({
      title: 'Clear the image cache?',
      body: "Avatars, covers and art are dropped from expo-image's memory and disk caches and download again when shown.",
      action: 'Clear',
      onConfirm: () => {
        Promise.all([Image.clearMemoryCache(), Image.clearDiskCache()]).then(
          () => showToast('Image cache cleared'),
          () => showToast("Couldn't clear the image cache"),
        );
      },
    });

  const resetMenuButtons = () =>
    ask({
      title: 'Reset game menu buttons?',
      body: 'Every game puts its menu button back in the top-left corner, untucked, in both orientations.',
      action: 'Reset',
      onConfirm: () => {
        removeStoredKeys(STORAGE_RESET_PREFIXES.menuButtons).then(
          (n) => showToast(n ? `Menu buttons reset in ${count(n, 'game', 'games')}` : 'No menu button had been moved'),
          () => showToast("Couldn't reset the menu buttons"),
        );
      },
    });

  const resetVotePrompt = () =>
    ask({
      title: "Reset the vote prompt's memory?",
      body: 'The post-match "Did you enjoy…?" prompt forgets which games it asked about, snoozed or saw a vote for, for every account on this device. Votes on the server stay.',
      action: 'Reset',
      onConfirm: () => {
        removeStoredKeys(STORAGE_RESET_PREFIXES.votePrompt).then(
          (n) => showToast(n ? 'The vote prompt starts fresh' : 'The vote prompt had nothing to forget'),
          () => showToast("Couldn't reset the vote prompt"),
        );
      },
    });

  const resetWelcome = () =>
    ask({
      title: 'Forget the welcome?',
      body: 'Every account on this device counts as not yet welcomed. The welcome still only opens by itself for an account created in the last ten minutes (lib/welcome-model.ts); UI previews shows it any time.',
      action: 'Reset',
      onConfirm: () => {
        removeStoredKeys(STORAGE_RESET_PREFIXES.welcome).then(
          (n) =>
            showToast(
              n
                ? `The welcome is forgotten for ${count(n, 'account', 'accounts')}`
                : 'No account had been welcomed here',
            ),
          () => showToast("Couldn't reset the welcome"),
        );
      },
    });

  const resetPrefs = () =>
    ask({
      title: 'Reset preferences?',
      body: 'Theme, haptics, friend request alerts, coin popups and Show FPS go back to their defaults. Game settings (graphics, sound, controls) stay.',
      action: 'Reset',
      onConfirm: () => {
        prefs.update({ ...DEFAULTS });
        showToast('Preferences reset to defaults');
      },
    });

  const reload = () =>
    ask({
      title: 'Reload the app?',
      body: "The JavaScript restarts as on a cold start, so the intro plays again. The launcher's settings, its last run and the log buffer are lost.",
      action: 'Reload',
      onConfirm: () => DevSettings.reload('Developer page: replay the intro'),
    });

  return (
    <DevSection id="reset" title="Reset and storage">
      <SettingsGroup title="Caches">
        <SettingsRow icon={DatabaseIcon} label="Clear the query cache" chevron={false} onPress={clearQueries} />
        <Separator className="ml-16" />
        <SettingsRow icon={ImageOffIcon} label="Clear the image cache" chevron={false} onPress={clearImages} />
      </SettingsGroup>
      <SettingsGroup
        title="On this device"
        footer={
          __DEV__
            ? 'The intro plays on every cold start; nothing remembers that it ran. Reload restarts the JavaScript to play it again (UI previews also has it).'
            : 'The intro plays on every cold start; nothing remembers that it ran. UI previews plays it now.'
        }
      >
        <SettingsRow icon={MoveIcon} label="Reset game menu buttons" chevron={false} onPress={resetMenuButtons} />
        <Separator className="ml-16" />
        <SettingsRow icon={ThumbsUpIcon} label="Reset the vote prompt" chevron={false} onPress={resetVotePrompt} />
        <Separator className="ml-16" />
        <SettingsRow icon={HandIcon} label="Forget the welcome" chevron={false} onPress={resetWelcome} />
        <Separator className="ml-16" />
        <SettingsRow icon={SlidersHorizontalIcon} label="Reset preferences" chevron={false} onPress={resetPrefs} />
        {/* DevSettings.reload does nothing in release JS (React Native makes it a no-op there). */}
        {__DEV__ ? (
          <>
            <Separator className="ml-16" />
            <SettingsRow icon={RotateCwIcon} label="Reload and replay the intro" chevron={false} onPress={reload} />
          </>
        ) : null}
      </SettingsGroup>
      {dialog}
    </DevSection>
  );
}
