import { Dimensions, Platform, type ScaledSize } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { isTabletDevice, shapeOf, shellTurnFor, type Shape } from './orientation-model';

/**
 * Orientation for the whole app. Phones keep the app's own pages in portrait: on an iPhone, turning the shell left
 * its root view one rotation behind the window (a landscape layout on a portrait screen and the other way round), so
 * the pages never turn there. Tablets follow the device. A game locks its own orientation (game.json `orientation`)
 * inside its full-screen modal; leaving turns the screen back BEFORE the modal closes, so the page underneath comes
 * back to the window the shape it left it, then the shell's rule applies again.
 */

const tablet = isTabletDevice(Platform.OS, Platform.OS === 'ios' && Platform.isPad, Dimensions.get('screen'));

/** Whether this device is a tablet (its pages turn with the device). */
export function isTablet(): boolean {
  return tablet;
}

/** The shell's rule: phones locked to portrait, tablets free. Called at startup and after every game. */
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
