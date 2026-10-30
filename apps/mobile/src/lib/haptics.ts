import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { prefs } from './prefs';

/**
 * The shell's haptics, all behind Settings → Haptics (`prefs.haptics`, on by default). Fire-and-forget: unsupported
 * devices just stay silent. Fired on press, never on scroll or on a press a drag cancelled.
 */

/**
 * The one tap haptic (buttons, tiles, hero, drawer rows): a light impact on iOS, the system's "virtual key" click on
 * Android (honours the system's touch-feedback setting).
 */
export function tapHaptic(): void {
  if (!prefs.get().haptics) return;
  const done =
    Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Virtual_Key)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  void done.catch(() => {});
}

/** A state flip that matters a little more than a tap (favourite on / off): a medium impact, Android's "confirm". */
export function toggleHaptic(): void {
  if (!prefs.get().haptics) return;
  const done =
    Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  void done.catch(() => {});
}
