/**
 * Which AsyncStorage keys the Developer page's resets remove (components/dev/reset-section.tsx). Each reset clears
 * one family of keys by prefix, for every game or account on the device. No React Native imports:
 * test/dev-tools.test.ts runs it under plain Node.
 */
import { menuButtonKey } from '../game-host/menu-button-model';
import { VOTE_PROMPT_KEY_PREFIX } from './votes-model';
import { WELCOMED_KEY_PREFIX } from './welcome-model';

export const STORAGE_RESET_PREFIXES = {
  /** Where each game's menu button was moved or tucked (game-host/menu-button-model.ts, per game id). */
  menuButtons: menuButtonKey(''),
  /** The post-match vote prompt's memory: asked, snoozed, voted (lib/votes.ts, per account). */
  votePrompt: VOTE_PROMPT_KEY_PREFIX,
  /** Which accounts saw the first-run welcome on this device (lib/welcome.ts, per account). */
  welcome: WELCOMED_KEY_PREFIX,
} as const;

/** The keys under `prefix`. An empty prefix matches nothing: a reset must never wipe the whole store. */
export function keysWithPrefix(keys: readonly string[], prefix: string): string[] {
  if (!prefix) return [];
  return keys.filter((k) => k.startsWith(prefix));
}
