import { useEffect } from 'react';
import { createScreenCounter, resolveAlertStyle, type FriendAlertStyle } from './friend-alerts-model';
import { prefs, usePrefs } from './prefs';

/**
 * Settings → Notifications applied (rules in lib/friend-alerts-model.ts): `friendAlertsInGame` while a game screen is
 * open, `friendAlerts` elsewhere. The hosts (components/rally/friend-request-sheet.tsx) resolve it by placement; the
 * Realtime router (lib/social-realtime.ts), which has no screen, asks `currentAlertStyle()`.
 */

const gameScreens = createScreenCounter();

/** Mounted by the play route's host: "a game screen is open" for code outside React. */
export function useGameScreenMarker(enabled: boolean): void {
  useEffect(() => (enabled ? gameScreens.enter() : undefined), [enabled]);
}

/** The style that applies right now (for the accepted toast). */
export function currentAlertStyle(): FriendAlertStyle {
  return resolveAlertStyle(prefs.get(), gameScreens.isOpen());
}

/** The style for a host: the game's preference in the play route, the app's elsewhere. */
export function useAlertStyle(inGame: boolean): FriendAlertStyle {
  return resolveAlertStyle(usePrefs(), inGame);
}
