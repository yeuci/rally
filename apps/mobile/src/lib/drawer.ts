/**
 * Pure parts of the app drawer (components/rally/app-drawer.tsx): its width, where it may be swiped open, and its
 * items. No React Native imports; test/drawer.test.ts covers it.
 */

/** Drawer panel: ≈ 78 % of the window on phones, never wider than this. */
export const DRAWER_MAX_WIDTH = 340;

/**
 * Width (pt) of the left-edge strip where the swipe that opens the drawer may start (`swipeEdgeWidth`; the library's
 * default is 32). Kept modest: everything under it (hero art, the first tile, the search pill) is pressable, and
 * those presses are guarded against the swipe (lib/press-guard.ts). The dashboard hero's pager does not start in it.
 */
export const DRAWER_EDGE_WIDTH = 28;

export function drawerWidth(windowWidth: number): number {
  return Math.round(Math.max(0, Math.min(windowWidth * 0.78, DRAWER_MAX_WIDTH)));
}

/**
 * The edge swipe opens the drawer only on the dashboard (`/`), the root of the stack. Every pushed screen uses the
 * same left edge for the back swipe (iOS) / back gesture (Android), the game host (`/game/:id/play`) is full screen
 * and must never be dragged aside, and the auth screens live outside `(app)` so they never have a drawer at all. The
 * menu button on the dashboard opens it too.
 */
export function drawerSwipeEnabled(pathname: string): boolean {
  return pathname === '/';
}

export type DrawerItemKey = 'home' | 'browse' | 'search' | 'friends' | 'profile' | 'settings' | 'developer';

export type DrawerItem = {
  key: DrawerItemKey;
  label: string;
  /** Count bubble (pending friend requests). */
  badge: string | null;
  /** Screen-reader hint where the destination is not obvious from the label. */
  hint?: string;
};

/**
 * Items top to bottom (Browse opens `/browse`, Settings `/settings`). Developer only when dev tools are on
 * (`config.devTools`). Sign out sits apart at the bottom of the panel.
 */
export function drawerItems({
  devTools,
  incomingRequests,
}: {
  devTools: boolean;
  incomingRequests: string | null;
}): DrawerItem[] {
  const items: DrawerItem[] = [
    { key: 'home', label: 'Home', badge: null },
    { key: 'browse', label: 'Browse', badge: null },
    { key: 'search', label: 'Search', badge: null },
    {
      key: 'friends',
      label: 'Friends',
      badge: incomingRequests,
      hint: incomingRequests ? 'Opens your friend requests' : undefined,
    },
    { key: 'profile', label: 'Profile', badge: null },
    { key: 'settings', label: 'Settings', badge: null },
  ];
  if (devTools) items.push({ key: 'developer', label: 'Developer', badge: null });
  return items;
}
