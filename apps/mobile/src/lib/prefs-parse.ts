/** Device-side preferences: shape, defaults and the parser for the stored JSON (pure; see prefs.ts for the store). */

/** Colour scheme of the shell: follow the system, or force one (Settings → Appearance). */
export type Appearance = 'system' | 'dark' | 'light';
export const APPEARANCES: readonly Appearance[] = ['system', 'dark', 'light'];

/**
 * How an incoming friend request is presented (Settings → Notifications): `sheet` = the pop-up sheet, `banner` = a
 * strip at the top of the screen that goes away after 5 s, `off` = nothing on screen (the Friends badge and the
 * Requests tab still update). The "accepted" toast follows the same setting (Off: none).
 */
export type FriendAlertStyle = 'sheet' | 'banner' | 'off';
export const FRIEND_ALERT_STYLES: readonly FriendAlertStyle[] = ['sheet', 'banner', 'off'];

export interface Prefs {
  /** Frame-rate counter in the top-left corner while a game runs (sampled inside the game's WebView). */
  showFps: boolean;
  /** Applied with `Uniwind.setTheme` (which also sets the native `Appearance`), see prefs.ts. */
  appearance: Appearance;
  /** The shell's tap / toggle haptics (lib/haptics.ts); games are not affected. */
  haptics: boolean;
  /** Friend requests outside a game (lib/friend-alerts.ts). */
  friendAlerts: FriendAlertStyle;
  /** Friend requests while a game screen is open: a banner by default, so the game stays playable. */
  friendAlertsInGame: FriendAlertStyle;
}

export const DEFAULTS: Prefs = {
  showFps: false,
  appearance: 'system',
  haptics: true,
  friendAlerts: 'sheet',
  friendAlertsInGame: 'banner',
};

export function isAppearance(v: unknown): v is Appearance {
  return typeof v === 'string' && (APPEARANCES as readonly string[]).includes(v);
}

export function isFriendAlertStyle(v: unknown): v is FriendAlertStyle {
  return typeof v === 'string' && (FRIEND_ALERT_STYLES as readonly string[]).includes(v);
}

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULTS;
    const p = parsed as Partial<Record<keyof Prefs, unknown>>;
    return {
      showFps: typeof p.showFps === 'boolean' ? p.showFps : DEFAULTS.showFps,
      appearance: isAppearance(p.appearance) ? p.appearance : DEFAULTS.appearance,
      haptics: typeof p.haptics === 'boolean' ? p.haptics : DEFAULTS.haptics,
      friendAlerts: isFriendAlertStyle(p.friendAlerts) ? p.friendAlerts : DEFAULTS.friendAlerts,
      friendAlertsInGame: isFriendAlertStyle(p.friendAlertsInGame) ? p.friendAlertsInGame : DEFAULTS.friendAlertsInGame,
    };
  } catch {
    return DEFAULTS;
  }
}
