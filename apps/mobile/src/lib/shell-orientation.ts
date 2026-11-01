import { Dimensions, Platform } from 'react-native';

/**
 * Which way the app's own screens may turn. Phones keep the shell in portrait (games still turn: their play route
 * declares the game's orientation, and iOS turns only that screen, never the pages underneath). Tablets turn freely.
 * Declared on every stack's screens (the native stack's `orientation` option), never forced at runtime.
 */
export function isTablet(): boolean {
  if (Platform.OS === 'ios') return Platform.isPad;
  const { width, height } = Dimensions.get('screen');
  return Math.min(width, height) >= 600;
}

export const SHELL_ORIENTATION: 'portrait' | 'default' = isTablet() ? 'default' : 'portrait';
