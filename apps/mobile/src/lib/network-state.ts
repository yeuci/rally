/**
 * Connectivity rules for the app-wide offline banner and TanStack Query's onlineManager (lib/network.ts feeds them
 * from @react-native-community/netinfo). Pure: test/network.test.ts.
 */

/** The NetInfo fields we read. `null` = not known yet (NetInfo answers asynchronously, and reachability later still). */
export interface NetState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

/**
 * Queries pause only when the device has no network at all. Reachability (`isInternetReachable`) is NetInfo's own
 * probe, which can be wrong on captive or filtered networks; pausing every query on its say-so would freeze the app,
 * so it only feeds the banner.
 */
export function onlineForQueries(s: NetState | null | undefined): boolean {
  return s?.isConnected !== false;
}

/** The banner's "You're offline": no network, or a network with no internet behind it. Unknown reads as online. */
export function isOffline(s: NetState | null | undefined): boolean {
  return s?.isConnected === false || s?.isInternetReachable === false;
}

/** The banner waits this long before showing (a network hand-over or the first reachability probe can blip). */
export const OFFLINE_BANNER_DELAY_MS = 1500;
