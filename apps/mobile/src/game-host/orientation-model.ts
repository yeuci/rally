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

/**
 * A quarter turn of the game's frame inside the app, in degrees clockwise: 0 none; 90 puts the frame's top along the
 * screen's right edge (a phone held with its notch on the left); -90 along the left edge (notch on the right).
 */
export type Turn = 0 | 90 | -90;

/**
 * iPhones turn landscape games inside the app and never ask iOS to rotate (orientation.ts says why). Tablets and
 * Android rotate natively.
 */
export function turnsInApp(os: string, tablet: boolean): boolean {
  return os === 'ios' && !tablet;
}

/**
 * The turn that keeps a landscape game upright for how the phone is held: expo-sensors DeviceMotion `orientation` (the
 * device's physical orientation: -90 with the notch on the left, 90 with it on the right). Null when it doesn't say
 * (upright, upside down, flat): keep the current turn.
 */
export function turnForDevice(deviceOrientation: number): 90 | -90 | null {
  if (deviceOrientation === -90) return 90;
  if (deviceOrientation === 90) return -90;
  return null;
}

export interface Size {
  width: number;
  height: number;
}

export interface Frame extends Size {
  left: number;
  top: number;
  turn: Turn;
}

/**
 * Where the game's frame sits on the screen. When this device turns games in the app and the window's shape is not
 * the game's, the frame is the game's own box (the window's sides swapped), centred and turned by `held` to fill the
 * screen; otherwise it is the whole window, unturned.
 */
export function frameFor(window: Size, game: 'portrait' | 'landscape' | 'any', inApp: boolean, held: 90 | -90): Frame {
  if (!inApp || game === 'any' || shapeOf(window) === game) {
    return { width: window.width, height: window.height, left: 0, top: 0, turn: 0 };
  }
  return {
    width: window.height,
    height: window.width,
    left: (window.width - window.height) / 2,
    top: (window.height - window.width) / 2,
    turn: held,
  };
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The screen's safe-area insets as the turned frame sees them (the notch and home indicator move to its sides). */
export function turnInsets(i: Insets, turn: Turn): Insets {
  if (turn === 90) return { top: i.right, right: i.bottom, bottom: i.left, left: i.top };
  if (turn === -90) return { top: i.left, right: i.top, bottom: i.right, left: i.bottom };
  return i;
}

/**
 * A movement on screen (touch deltas or velocities, which React Native reports in screen axes) in the turned frame's
 * axes, for code that moves things by raw touch movement inside the frame.
 */
export function screenToFrame(dx: number, dy: number, turn: Turn): { dx: number; dy: number } {
  if (turn === 90) return { dx: dy, dy: 0 - dx };
  if (turn === -90) return { dx: 0 - dy, dy: dx };
  return { dx, dy };
}
