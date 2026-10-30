/**
 * Rally brand constants: palette, the logo mark's geometry and the native splash layout. Plain data with no React
 * Native imports, so `scripts/generate-brand-assets.cjs` can load it to rasterise the app icons and splash image
 * from the same numbers the app draws with. Theme tokens for classNames live in `global.css` (keep them in sync).
 *
 * The brand is monochrome: neutral greys (shadcn "neutral"), the mark in the foreground colour, no accent hue.
 */

export const BRAND = {
  /** Near-black base: dark background, native splash, Android adaptive-icon background. */
  base: '#0A0A0A',
  white: '#FFFFFF',
} as const;

/** Resolved theme colours for places that need a value rather than a className (navigation theme, SVG, spinners). */
export const PALETTE = {
  dark: {
    background: BRAND.base,
    foreground: '#FAFAFA',
    card: '#171717',
    muted: '#262626',
    mutedForeground: '#A1A1A1',
    border: 'rgba(255, 255, 255, 0.10)',
    primary: '#FAFAFA',
    primaryForeground: '#171717',
    ring: '#737373',
    destructive: '#FF6467',
  },
  light: {
    background: '#FFFFFF',
    foreground: BRAND.base,
    card: '#FFFFFF',
    muted: '#F5F5F5',
    mutedForeground: '#737373',
    border: 'rgba(0, 0, 0, 0.10)',
    primary: '#171717',
    primaryForeground: '#FAFAFA',
    ring: '#A1A1A1',
    destructive: '#E7000B',
  },
} as const;

export type ThemeName = keyof typeof PALETTE;

/**
 * The mark: an "R" whose bowl is a rounded play triangle, with the leg set apart from it like a ball leaving the
 * paddle. Drawn as round-capped strokes in one flat colour in a 100×100 box (bounding box ≈ 20.5–79.5 × 8–92,
 * centred so the intro spin does not wobble).
 */
export const MARK = {
  viewBox: 100,
  strokeWidth: 16,
  stem: 'M28.5 16 L28.5 84',
  bowl: 'M28.5 16 L28.5 56 L71.5 36 Z',
  leg: 'M52.5 68 L69.5 84',
} as const;

/**
 * Native splash: `splash-icon.png` is the mark's full 100×100 box in white, shown `imageWidth` points wide, centred
 * in the window on `backgroundColor` (expo-splash-screen centres an imageWidth×imageWidth image on iOS and Android).
 * The intro overlay draws the same box at the same size and place, so hiding the native splash shows no jump.
 * Mirrored in app.json; the asset script fails if the two disagree.
 */
export const SPLASH = {
  imageWidth: 128,
  backgroundColor: BRAND.base,
  markColor: BRAND.white,
} as const;
