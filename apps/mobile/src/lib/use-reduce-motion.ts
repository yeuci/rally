import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The OS "Reduce motion" setting, kept current (Reanimated's `useReducedMotion` reads it once at startup). For
 * showing the state (Settings); animations follow it through `ReduceMotion.System` / `useReducedMotion`.
 */
export function useReduceMotionSetting(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (alive) setEnabled(on);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setEnabled);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return enabled;
}
