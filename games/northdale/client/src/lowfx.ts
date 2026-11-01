import type { Application } from 'playcanvas';

/**
 * Dev-only low-render mode (`?lowfx=1`, see main.ts), as in Sumo: the Playwright e2e runs two pages at once, each
 * rendering WebGL in software (swiftshader) on a 2-vCPU runner. With lowfx a page draws at most {@link LOWFX_FPS}
 * frames per second at DPR 1, without clustered lighting, MSAA, shadows, floor decals, blood bursts or camera shake.
 * The game logic (input, netcode, HUD) still runs every animation frame; only the WebGL draw is skipped in between.
 *
 * Clustered lighting (PlayCanvas' default) is by far the biggest cost in software: the scene has only a directional
 * light, which is lit the same way without it, but every fragment still walks the light-cluster textures. Measured
 * with swiftshader on 2 cores at 1100×620: ~6 frames/s with it, ~60 without.
 */
export const LOWFX_FPS = 15;

/** Decides which animation frames get drawn: at most `fps` per second, on a steady cadence. */
export class FrameGate {
  private next = -Infinity;
  private readonly intervalMs: number;

  constructor(fps: number) {
    if (!(fps > 0)) throw new Error(`FrameGate: fps must be > 0 (got ${fps})`);
    this.intervalMs = 1000 / fps;
  }

  /** Whether the frame at `now` (ms) should be drawn. The first frame always is. */
  due(now: number): boolean {
    // 1 ms of slack: requestAnimationFrame timestamps jitter around the display interval (4 × 16.67 ms ≈ 66.67).
    if (now + 1 < this.next) return false;
    // Keep the cadence without drifting, but after a stall (hidden tab, long task) restart from now: no burst of
    // catch-up frames.
    this.next = now - this.next > this.intervalMs ? now + this.intervalMs : this.next + this.intervalMs;
    return true;
  }
}

/** Draw at most `fps` frames per second: the app's update loop keeps running, rendering only on due frames. */
export function throttleRender(
  app: Pick<Application, 'autoRender' | 'renderNextFrame' | 'on'>,
  fps: number,
  now: () => number = () => performance.now(),
): FrameGate {
  const gate = new FrameGate(fps);
  app.autoRender = false;
  // `framerender` fires after the update, right before the engine decides whether to render this frame.
  app.on('framerender', () => {
    if (gate.due(now())) app.renderNextFrame = true;
  });
  return gate;
}

/**
 * Everything lowfx changes on the app: no clustered lighting, rendering capped at {@link LOWFX_FPS}. (main.ts also
 * passes DPR 1 and no MSAA to createApp, and no shadows or effects to the scene.)
 */
export function applyLowFx(
  app: Pick<Application, 'autoRender' | 'renderNextFrame' | 'on'> & { scene: { clusteredLightingEnabled: boolean } },
  now?: () => number,
): FrameGate {
  app.scene.clusteredLightingEnabled = false;
  return throttleRender(app, LOWFX_FPS, now);
}
