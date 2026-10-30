import { DarkTheme, DefaultTheme, type Theme } from 'expo-router/react-navigation';
import { PALETTE } from '@/lib/brand';

/** React Navigation theme (headers, screen backgrounds) from the same palette as `global.css`. */
export const NAV_THEME: Record<'light' | 'dark', Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: PALETTE.light.background,
      border: PALETTE.light.border,
      card: PALETTE.light.card,
      notification: PALETTE.light.destructive,
      primary: PALETTE.light.primary,
      text: PALETTE.light.foreground,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: PALETTE.dark.background,
      border: PALETTE.dark.border,
      card: PALETTE.dark.card,
      notification: PALETTE.dark.destructive,
      primary: PALETTE.dark.primary,
      text: PALETTE.dark.foreground,
    },
  },
};
