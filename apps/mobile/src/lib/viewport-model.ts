/** A view's frame from `onLayout` (relative to its parent). */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Safe-area insets from the probe: `outer` is the full-screen view, `inner` the content box inside a padding-mode
 * SafeAreaView that fills it (its frame relative to the SafeAreaView, which sits at the outer origin). Each inset is
 * the gap on that side, never negative, rounded to the half point.
 */
export function insetsFromProbe(outer: Frame, inner: Frame) {
  const r = (v: number) => Math.max(0, Math.round(v * 2) / 2);
  return {
    top: r(inner.y),
    left: r(inner.x),
    right: r(outer.width - inner.x - inner.width),
    bottom: r(outer.height - inner.y - inner.height),
  };
}
