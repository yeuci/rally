/**
 * Which way to turn the shell back after a game (pure, so it is unit-tested; orientation.ts applies it). The values
 * are expo-screen-orientation's `Orientation`: 0 unknown, 1 portrait up, 2 portrait down, 3 landscape left, 4
 * landscape right.
 */
export type ShellTurn = 'portrait' | 'landscape';

/** The orientation the player was in before the game: a landscape tablet goes back to landscape; anything else
 * (portrait, upside down, unknown) to portrait. */
export function shellTurnFor(before: number | null): ShellTurn {
  return before === 3 || before === 4 ? 'landscape' : 'portrait';
}
