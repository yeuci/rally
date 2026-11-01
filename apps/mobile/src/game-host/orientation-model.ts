/**
 * Orientation decisions (pure, so they are unit-tested; orientation.ts applies them). Orientation values are
 * expo-screen-orientation's `Orientation`: 0 unknown, 1 portrait up, 2 portrait down, 3 landscape left, 4 landscape
 * right.
 */
export type Shape = 'portrait' | 'landscape';

/**
 * Tablets turn freely; phones keep the app's own pages in portrait (games still turn). A tablet is an iPad, or an
 * Android screen whose short side is at least 600 dp (the platform's own tablet line).
 */
export function isTabletDevice(os: string, isPad: boolean, screen: { width: number; height: number }): boolean {
  if (os === 'ios') return isPad;
  return Math.min(screen.width, screen.height) >= 600;
}

/**
 * Which way the shell turns back after a game, before the page underneath is shown: a phone always to portrait (its
 * pages never turn); a tablet the way the player held it before the game (landscape stays landscape; portrait, upside
 * down or unknown → portrait).
 */
export function shellTurnFor(before: number | null, tablet: boolean): Shape {
  if (!tablet) return 'portrait';
  return before === 3 || before === 4 ? 'landscape' : 'portrait';
}

/** The window's shape (a square counts as portrait). */
export function shapeOf(size: { width: number; height: number }): Shape {
  return size.width > size.height ? 'landscape' : 'portrait';
}
