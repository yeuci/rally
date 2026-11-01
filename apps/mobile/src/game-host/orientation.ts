import { Dimensions, Platform, type ModalProps, type ScaledSize } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { isTabletDevice, shapeOf, shellTurnFor, turnsInApp, type Shape } from './orientation-model';

/**
 * Orientation for the whole app.
 *
 * iPhones never rotate: the app's pages stay in portrait, and a landscape game is turned inside the app
 * (game-frame.tsx). Every rotation forced in Expo Go on an iPhone went wrong somewhere: the root view stayed one
 * rotation behind the window after the shell turned, and games were drawn sideways inside a turned screen.
 *
 * Tablets follow the device, and Android phones keep pages in portrait; on both a game locks its own orientation
 * (game.json `orientation`) inside its full-screen modal, and leaving turns the screen back BEFORE the modal closes,
 * so the page underneath comes back to the window the shape it left it.
 */

const tablet = isTabletDevice(Platform.OS, Platform.OS === 'ios' && Platform.isPad, Dimensions.get('screen'));
/** iPhones turn landscape games inside the app (game-frame.tsx) instead of rotating. */
const turnsGamesInApp = turnsInApp(Platform.OS, tablet);

/**
 * The play route's own orientation (the native stack's `orientation` option). On an iPhone portrait: the game screen
 * would otherwise tell iOS it may turn, and a phone held sideways could turn it on its own. Elsewhere unset, so the
 * game's lock decides.
 */
export const PLAY_SCREEN_ORIENTATION: 'portrait_up' | undefined = turnsGamesInApp ? 'portrait_up' : undefined;

/**
 * Orientations for a sheet that can rise over a game (a React Native Modal). On an iPhone only portrait: the screen
 * never turns there, and a modal that allowed landscape could make iOS turn it. Elsewhere every orientation, since a
 * game may have turned the screen.
 */
export const SHEET_ORIENTATIONS: ModalProps['supportedOrientations'] = turnsGamesInApp
  ? ['portrait']
  : ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'];

/** Whether this device is a tablet (its pages turn with the device). */
export function isTablet(): boolean {
  return tablet;
}

/** The shell's rule: phones locked to portrait, tablets free. Called at startup and after every game (Android, tablets). */
export function applyShellOrientation(): Promise<void> {
  return (
    tablet
      ? ScreenOrientation.unlockAsync()
      : ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
  ).catch(() => {});
}

let before: number | null = null;
let held = false;

/** Lock the game's orientation (null: the game takes any, so it follows the device), remembering the shell's. */
export async function lockForGame(lock: ScreenOrientation.OrientationLock | null): Promise<void> {
  // An iPhone never rotates for a game: its frame turns inside the app instead.
  if (turnsGamesInApp) return;
  if (!held) {
    held = true;
    before = await ScreenOrientation.getOrientationAsync().catch(() => null);
  }
  await (lock === null ? ScreenOrientation.unlockAsync() : ScreenOrientation.lockAsync(lock)).catch(() => {});
}

/** iOS animates a rotation for about a third of a second after the window takes its new size. */
const SETTLE_MS = 320;

/**
 * Turn back to the shell's orientation and wait until the window has (at most `capMs`): a phone to portrait, a tablet
 * the way the player held it before the game. Resolves at once when the window already has that shape.
 */
export async function turnBackFromGame(capMs = 900): Promise<void> {
  if (!held) return;
  const target: Shape = shellTurnFor(before, tablet);
  const lock =
    target === 'landscape'
      ? ScreenOrientation.OrientationLock.LANDSCAPE
      : ScreenOrientation.OrientationLock.PORTRAIT_UP;
  const turned = windowTurned(target, capMs);
  await ScreenOrientation.lockAsync(lock).catch(() => {});
  await turned;
}

/** The game is gone: back to the shell's rule (phones stay in portrait, tablets follow the device again). */
export function releaseGameOrientation(): void {
  if (!held) return;
  held = false;
  before = null;
  void applyShellOrientation();
}

/** Resolves once the window has `shape` and the rotation has had time to finish, or after `capMs`. */
function windowTurned(shape: Shape, capMs: number): Promise<void> {
  if (shapeOf(Dimensions.get('window')) === shape) return Promise.resolve();
  return new Promise((resolve) => {
    let settle: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      sub.remove();
      clearTimeout(cap);
      if (settle) clearTimeout(settle);
      resolve();
    };
    const sub = Dimensions.addEventListener('change', ({ window }: { window: ScaledSize }) => {
      if (settle || shapeOf(window) !== shape) return;
      settle = setTimeout(done, SETTLE_MS);
    });
    const cap = setTimeout(done, capMs);
  });
}
