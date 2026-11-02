/**
 * Swipe-down-to-close for bottom sheets (components/rally/bottom-sheet.tsx). Pure, so it is unit-tested.
 */

/** A drag takes the sheet once it moves this far down, clearly more down than sideways. */
const START_PX = 8;
/** Let go past this distance and the sheet closes. */
const CLOSE_PX = 110;
/** A downward flick this fast (px/ms) closes it from a shorter drag... */
const FLICK_VY = 0.8;
/** ...of at least this far, so a tap's jitter never closes it. */
const FLICK_MIN_PX = 24;
/** Dragged upward, the sheet gives a little, then stops. */
const UP_LIMIT_PX = 14;

/** Whether a move (from where the finger went down) is a drag of the sheet, not a tap, a scroll or a swipe across. */
export function sheetDragStarts(dx: number, dy: number): boolean {
  return dy > START_PX && dy > Math.abs(dx) * 1.5;
}

/** How far the sheet sits below its resting place for a drag of `dy`: follows the finger down, resists going up. */
export function sheetDragOffset(dy: number): number {
  if (dy >= 0) return dy;
  return -Math.min(UP_LIMIT_PX, Math.sqrt(-dy) * 2);
}

/** Whether letting go closes the sheet: dragged far enough, or flicked down. */
export function sheetDragCloses(dy: number, vy: number): boolean {
  return dy > CLOSE_PX || (vy > FLICK_VY && dy > FLICK_MIN_PX);
}

/** Pulled this far past the top of a sheet's scrolling content, letting go closes the sheet... */
const OVERSCROLL_CLOSE_PX = 56;
/** ...or a shorter pull flicked down at least this fast (iOS reports a downward flick as a negative velocity). */
const OVERSCROLL_FLICK_PX = 16;
const OVERSCROLL_FLICK_VY = -0.6;

/**
 * Whether letting go of a sheet's scrolling content closes the sheet. iOS gives a drag inside a scroll view to the
 * scroll view, so the sheet's own swipe never sees it there; pulling the content down past its top (the bounce)
 * stands in for it. `offsetY` is the content offset when the finger lifts (negative past the top).
 */
export function sheetOverscrollCloses(offsetY: number, velocityY: number): boolean {
  return offsetY < -OVERSCROLL_CLOSE_PX || (offsetY < -OVERSCROLL_FLICK_PX && velocityY < OVERSCROLL_FLICK_VY);
}
