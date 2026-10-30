import { useUniwind } from 'uniwind';
import { PALETTE } from '@/lib/brand';

/** Resolved colours of the active theme, for props that take a colour value (SVG stops, RefreshControl). */
export function usePalette() {
  const { theme } = useUniwind();
  return PALETTE[theme === 'light' ? 'light' : 'dark'];
}

/**
 * iOS keyboard appearance for the app's theme. `default` follows the system, which is wrong when Settings forces
 * Light or Dark against it (a dark keyboard under a light form); Android ignores the prop.
 */
export function useKeyboardAppearance(): 'light' | 'dark' {
  const { theme } = useUniwind();
  return theme === 'light' ? 'light' : 'dark';
}
