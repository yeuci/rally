import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * The one tap haptic of the shell (buttons, tiles, hero, drawer rows): a light impact on iOS, the system's
 * "virtual key" click on Android (honours the system's touch-feedback setting). Fired on press, never on scroll or
 * on a press a drag cancelled. Fire-and-forget: unsupported devices just stay silent.
 */
export function tapHaptic(): void {
  const done =
    Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Virtual_Key)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  void done.catch(() => {});
}
