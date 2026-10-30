export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
let probe: HTMLElement | null = null;

/**
 * Safe-area insets in CSS px from `env(safe-area-inset-*)` (needs `viewport-fit=cover`). `fallback` (e.g. the
 * launch context's `device.safeArea`) is merged with `max`, so whichever source knows about the notch wins.
 */
export function safeArea(fallback: Partial<Insets> = {}): Insets {
  const css = readEnvInsets();
  return {
    top: Math.max(css.top, fallback.top ?? 0),
    right: Math.max(css.right, fallback.right ?? 0),
    bottom: Math.max(css.bottom, fallback.bottom ?? 0),
    left: Math.max(css.left, fallback.left ?? 0),
  };
}

/**
 * Expose insets as CSS custom properties (`--safe-top` …) on `el` (default `<html>`), so HUD CSS can use
 * `var(--safe-top)` and get the max of `env()` and the host's numbers.
 */
export function applySafeAreaVars(insets: Insets, el: HTMLElement = document.documentElement): void {
  el.style.setProperty('--safe-top', `${insets.top}px`);
  el.style.setProperty('--safe-right', `${insets.right}px`);
  el.style.setProperty('--safe-bottom', `${insets.bottom}px`);
  el.style.setProperty('--safe-left', `${insets.left}px`);
}

function readEnvInsets(): Insets {
  if (typeof document === 'undefined' || !document.body) return ZERO;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

export interface ViewportInfo {
  /** CSS px. */
  width: number;
  height: number;
  portrait: boolean;
  /** Raw `devicePixelRatio` (not capped). */
  dpr: number;
}

/** Current layout viewport (visual viewport when available, which excludes the iOS keyboard / toolbars). */
export function viewport(): ViewportInfo {
  const vv = window.visualViewport;
  const width = vv?.width ?? window.innerWidth;
  const height = vv?.height ?? window.innerHeight;
  return { width, height, portrait: height >= width, dpr: window.devicePixelRatio || 1 };
}

/** Call `fn` whenever the viewport size or orientation changes. Returns an unsubscribe function. */
export function onViewportChange(fn: (v: ViewportInfo) => void): () => void {
  const handler = () => fn(viewport());
  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);
  window.visualViewport?.addEventListener('resize', handler);
  return () => {
    window.removeEventListener('resize', handler);
    window.removeEventListener('orientationchange', handler);
    window.visualViewport?.removeEventListener('resize', handler);
  };
}
