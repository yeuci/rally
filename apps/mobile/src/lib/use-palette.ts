import { useUniwind } from 'uniwind';
import { PALETTE } from '@/lib/brand';

/** Resolved colours of the active theme, for props that take a colour value (SVG stops, RefreshControl). */
export function usePalette() {
  const { theme } = useUniwind();
  return PALETTE[theme === 'light' ? 'light' : 'dark'];
}
