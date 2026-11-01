import * as ScreenOrientation from 'expo-screen-orientation';
import { shellTurnFor } from './orientation-model';

/**
 * Orientation around a game. The shell follows the device in any orientation (phones and tablets alike); a game may
 * lock its own (game.json `orientation`). Leaving turns the screen back to how the player held it before the game,
 * BEFORE the page underneath is shown (so it never lays out mid-rotation), then frees it to follow the device again.
 */

let before: number | null = null;
let held = false;

/** Lock the game's orientation, remembering the shell's (null: the game takes any orientation, nothing to lock). */
export async function lockForGame(lock: ScreenOrientation.OrientationLock | null): Promise<void> {
  if (lock === null) return;
  if (!held) {
    before = await ScreenOrientation.getOrientationAsync().catch(() => null);
    held = true;
  }
  await ScreenOrientation.lockAsync(lock).catch(() => {});
}

/** Turn back to the orientation the player had before the game; waits at most `capMs` for the rotation. */
export async function turnBackFromGame(capMs = 600): Promise<void> {
  if (!held) return;
  const target =
    shellTurnFor(before) === 'landscape'
      ? ScreenOrientation.OrientationLock.LANDSCAPE
      : ScreenOrientation.OrientationLock.PORTRAIT_UP;
  await Promise.race([ScreenOrientation.lockAsync(target).catch(() => {}), new Promise((r) => setTimeout(r, capMs))]);
}

/** The game is gone: the shell follows the device again (after the turn back, so the page is already laid out). */
export function releaseGameOrientation(): void {
  if (!held) return;
  held = false;
  before = null;
  ScreenOrientation.unlockAsync().catch(() => {});
}
