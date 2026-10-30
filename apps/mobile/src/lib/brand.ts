/**
 * Rally brand constants: palette, the logo mark's geometry and the native splash layout. Plain data with no React
 * Native imports, so `scripts/generate-brand-assets.cjs` can load it to rasterise the app icons and splash image
 * from the same numbers the app draws with. Theme tokens for classNames live in `global.css` (keep them in sync).
 */

export const BRAND = {
  /** Near-black base: dark background, native splash, Android adaptive-icon background. */
  base: '#0B1019',
  /** The one accent gradient (logo, focus rings, selected states, hero glows): electric violet → cyan. */
  violet: '#7C5CFF',
  cyan: '#38E1FF',
  /** Warm highlight, reserved for Play and other primary actions. */
  warm: '#FF6A3D',
  white: '#FFFFFF',
} as const;

/** Resolved theme colours for places that need a value rather than a className (navigation theme, SVG scrims). */
export const PALETTE = {
  dark: {
    background: '#0B1019',
    foreground: '#F3F5FA',
    card: '#121A28',
    muted: '#172031',
    mutedForeground: '#93A0B6',
    border: 'rgba(255, 255, 255, 0.08)',
    primary: BRAND.warm,
    destructive: '#FF5470',
  },
  light: {
    background: '#F5F6FA',
    foreground: '#0B1019',
    card: '#FFFFFF',
    muted: '#E9ECF3',
    mutedForeground: '#596377',
    border: 'rgba(11, 16, 25, 0.09)',
    primary: '#F45A2C',
    destructive: '#E0244A',
  },
} as const;

export type ThemeName = keyof typeof PALETTE;

/** Gradient stops shared by every accent-gradient surface. */
export const ACCENT_STOPS = [
  { offset: 0, color: BRAND.violet },
  { offset: 1, color: BRAND.cyan },
] as const;

/**
 * The mark: an "R" whose bowl is a rounded play triangle, with the leg set apart from it like a ball leaving the
 * paddle. Drawn as round-capped strokes in a 100×100 box (bounding box ≈ 20.5–79.5 × 8–92, centred so the intro
 * spin does not wobble). The gradient runs top-left → bottom-right in user space, so all three strokes share it.
 */
export const MARK = {
  viewBox: 100,
  strokeWidth: 16,
  stem: 'M28.5 16 L28.5 84',
  bowl: 'M28.5 16 L28.5 56 L71.5 36 Z',
  leg: 'M52.5 68 L69.5 84',
  gradient: { x1: 20, y1: 8, x2: 80, y2: 92 },
} as const;

/**
 * Native splash: `splash-icon.png` is the mark's full 100×100 box, shown `imageWidth` points wide, centred in the
 * window on `backgroundColor` (expo-splash-screen centres an imageWidth×imageWidth image on iOS and Android). The
 * intro overlay draws the same box at the same size and place, so hiding the native splash shows no jump.
 * Mirrored in app.json; the asset script fails if the two disagree.
 */
export const SPLASH = {
  imageWidth: 128,
  backgroundColor: BRAND.base,
} as const;
