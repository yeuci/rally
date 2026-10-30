import * as pc from 'playcanvas';

/** DPR is capped at 2: higher only burns fill rate on phones (architecture §2). */
export const MAX_PIXEL_RATIO = 2;

export interface CreateAppOptions {
  canvas: HTMLCanvasElement;
  /** Device-pixel-ratio cap. Default {@link MAX_PIXEL_RATIO}. */
  maxPixelRatio?: number;
  /** MSAA. Default true. */
  antialias?: boolean;
  /** Attach PlayCanvas mouse/touch devices (the spike's orbit HUD uses them; tap games use `createInput`). Default false. */
  pointerDevices?: boolean;
  /** Extra graphics-device options merged over the defaults. */
  graphicsDeviceOptions?: Record<string, unknown>;
}

export interface AppHandle {
  app: pc.Application;
  /** Re-apply the DPR cap and resize the canvas (called on resize / orientation change). */
  resize(): void;
  /** Subscribe to size changes after the canvas was resized. Returns an unsubscribe function. */
  onResize(fn: (width: number, height: number) => void): () => void;
  destroy(): void;
}

/**
 * PlayCanvas boot shared by every game: full-window canvas, automatic resolution, DPR cap, resize and
 * orientation handling, `touch-action: none` on the canvas. The app is returned **not started** so the caller can
 * build its scene first and then call `app.start()`.
 */
export function createApp(options: CreateAppOptions): AppHandle {
  const { canvas, maxPixelRatio = MAX_PIXEL_RATIO, antialias = true, pointerDevices = false } = options;
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  (canvas.style as CSSStyleDeclaration & { webkitTouchCallout?: string }).webkitTouchCallout = 'none';

  const app = new pc.Application(canvas, {
    graphicsDeviceOptions: {
      antialias,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      ...options.graphicsDeviceOptions,
    },
    mouse: pointerDevices ? new pc.Mouse(canvas) : undefined,
    touch: pointerDevices && pc.platform.touch ? new pc.TouchDevice(canvas) : undefined,
  });

  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);

  const listeners = new Set<(w: number, h: number) => void>();
  const resize = () => {
    // DPR can change at runtime (browser zoom, moving a window between screens).
    app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    app.resizeCanvas();
    const { width, height } = app.graphicsDevice;
    for (const fn of listeners) fn(width, height);
  };
  resize();

  // iOS reports the old size for a frame or two after `orientationchange`; resize again once it settles.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const onOrientation = () => {
    resize();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(resize, 250);
  };
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', onOrientation);
  window.visualViewport?.addEventListener('resize', resize);

  return {
    app,
    resize,
    onResize(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      clearTimeout(settleTimer);
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', onOrientation);
      window.visualViewport?.removeEventListener('resize', resize);
      listeners.clear();
      app.destroy();
    },
  };
}
