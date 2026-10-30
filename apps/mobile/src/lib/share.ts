/**
 * Share copy for a game (pure; unit-tested). The link is the web catalog's Universal Link `<origin>/game/<id>`
 * (apps/web: the game's page there opens the app when it is installed), and only when the build knows the site's
 * origin (`EXPO_PUBLIC_WEB_ORIGIN`, the web build's `SITE_ORIGIN`); otherwise the share is the title alone.
 */

/** `https://rally.app/` → `https://rally.app`; anything that is not a bare http(s) origin (a path, a typo) → null. */
export function normalizeWebOrigin(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s?#]+$/i.test(v) ? v : null;
}

/** The game's page on the web catalog, or null without an origin. */
export function gameWebUrl(origin: string | null, gameId: string): string | null {
  return origin ? `${origin}/game/${encodeURIComponent(gameId)}` : null;
}

export interface ShareContent {
  title: string;
  message: string;
  /** iOS only: the share sheet's link (it previews it and offers Copy / AirDrop). */
  url?: string;
}

/**
 * React Native `Share.share` content: iOS takes the link as `url` beside the message; Android has no `url` field,
 * so the link goes at the end of the message.
 */
export function gameShareContent(
  game: { id: string; title: string },
  origin: string | null,
  platform: string,
): ShareContent {
  const url = gameWebUrl(origin, game.id);
  if (!url) return { title: game.title, message: game.title };
  return platform === 'ios'
    ? { title: game.title, message: game.title, url }
    : { title: game.title, message: `${game.title} ${url}` };
}
