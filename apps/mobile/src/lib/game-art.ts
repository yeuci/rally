import type { Tables } from '@rally/db';

/**
 * Which uploaded artwork a game surface shows (architecture §3; game.json `icon`, `cover`, `feature`, `screenshots`,
 * uploaded by tooling/publish-game into `games.icon_url`, `games.cover_url`, `games.feature_url`,
 * `games.screenshots`):
 *
 * - `tile`: square dashboard / search tiles → icon, else cover, else the first screenshot.
 * - `feature`: the tall dashboard hero on phones and the loading screen's backdrop → feature art, else cover, else
 *   the first screenshot.
 * - `banner`: wide surfaces (the category cards, the hero on a wide window) → cover, else the first screenshot.
 * - `hero`: the game page hero when there are no screenshots to page through → cover, else the first screenshot.
 *   With screenshots the hero is the screenshot gallery; the cover is for the dashboard.
 *
 * null means nothing is set: the caller draws generated art (lib/cover-art.ts). Pure, so it is unit-tested.
 */
export type ArtSlot = 'tile' | 'feature' | 'banner' | 'hero';
export type GameArt = Pick<Tables<'games'>, 'icon_url' | 'cover_url' | 'screenshots'> & {
  /** Optional: rows read before feature art existed, or queries that do not select it, behave as without one. */
  feature_url?: string | null;
};

export function coverUriFor(game: GameArt, slot: ArtSlot): string | null {
  const firstShot = present(game.screenshots[0]);
  const cover = present(game.cover_url);
  if (slot === 'tile') return present(game.icon_url) ?? cover ?? firstShot;
  if (slot === 'feature') return present(game.feature_url) ?? cover ?? firstShot;
  return cover ?? firstShot;
}

/** The game page hero gallery: every screenshot, in order (empty strings dropped). Empty = show the cover instead. */
export function heroScreenshots(game: Pick<GameArt, 'screenshots'>): string[] {
  return game.screenshots.filter((s): s is string => !!present(s));
}

function present(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null;
}
