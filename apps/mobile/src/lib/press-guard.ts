/**
 * Pure rules that keep a drawer swipe from also "tapping" what it started on (dashboard tiles, hero, search pill,
 * top bar, drawer rows; see components/ui/tap-pressable.tsx). No React Native imports; test/press-guard.test.ts.
 *
 * Why a JS guard: react-native-drawer-layout's edge pan is a gesture-handler Pan with `cancelsJSResponder` on by
 * default, so on activation RNGH asks React Native to cancel its JS responders (iOS: toggles the surface's
 * RCTSurfaceTouchHandler; Android: the orchestrator cancels via the root view). That path is best effort (it depends
 * on finding the right touch handler / root view), and the owner saw presses complete after a drawer swipe on device.
 * The guard does not depend on it: a press is dropped when the drawer gesture started during it, or when the touch
 * travelled like a drag rather than a tap.
 */

/** Travel (pt) beyond which a touch is a drag, not a tap (Android's touch slop; UIKit taps allow ~10). */
export const TAP_SLOP = 8;

/**
 * Horizontal travel that activates the drawer's edge pan (react-native-drawer-layout `SWIPE_MIN_OFFSET`). A touch
 * that starts in the edge zone and moves right this far has opened (or is opening) the drawer.
 */
export const EDGE_SWIPE_SLOP = 5;

export type PressPoint = { x: number; y: number };
/** Where a press began (`pageX` / `pageY`) and the drawer-gesture epoch at that moment. */
export type PressStart = PressPoint & { epoch: number };

/**
 * A press's screen point from a responder event's `nativeEvent`, or null when it carries none (an accessibility
 * activation or a keyboard "click": those are never drags and must always go through).
 */
export function pressPoint(native: { pageX?: unknown; pageY?: unknown } | null | undefined): PressPoint | null {
  const x = native?.pageX;
  const y = native?.pageY;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Whether to swallow a press: the drawer's gesture started since the press began (`epoch` moved on), the touch moved
 * further than a tap (`TAP_SLOP`), or it began inside the drawer's edge zone (`edgeWidth`, left edge, LTR) and moved
 * right by the pan's activation distance. Without a start or an end point (no touch behind it) it always passes.
 */
export function shouldDropPress({
  start,
  end,
  epoch,
  edgeWidth,
}: {
  start: PressStart | null;
  end: PressPoint | null;
  epoch: number;
  edgeWidth: number;
}): boolean {
  if (!start || !end) return false;
  if (epoch !== start.epoch) return true;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) > TAP_SLOP) return true;
  return edgeWidth > 0 && start.x <= edgeWidth && dx >= EDGE_SWIPE_SLOP;
}

let epoch = 0;

/**
 * Counter bumped each time the drawer's pan activates (`Drawer onGestureStart`, components/rally/app-drawer.tsx). A
 * press compares the value at press-in with the value at release.
 */
export const drawerGesture = {
  epoch: () => epoch,
  mark: () => {
    epoch += 1;
  },
};
