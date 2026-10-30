export interface FrameSnapshot {
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
}

/** Rolling frame statistics for HUDs and `telemetry.report`. */
export class FrameMetrics {
  private frames: number[] = [];
  private lastFrame: number;
  private readonly windowMs: number;

  constructor(windowMs = 2000, now = performance.now()) {
    this.windowMs = windowMs;
    this.lastFrame = now;
  }

  /** Call once per rendered frame (e.g. on the app's `frameend`). */
  tick(now = performance.now()): void {
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    this.frames.push(dt);
    // Keep roughly `windowMs` worth of frames.
    let total = 0;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      total += this.frames[i]!;
      if (total > this.windowMs) {
        this.frames.splice(0, i);
        break;
      }
    }
  }

  /** Forget history (after a pause, so the paused gap does not count as one long frame). */
  reset(now = performance.now()): void {
    this.frames = [];
    this.lastFrame = now;
  }

  snapshot(): FrameSnapshot {
    const n = this.frames.length;
    if (n === 0) return { fps: 0, frameMs: 0, p95Ms: 0, worstMs: 0 };
    const sorted = [...this.frames].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    return {
      fps: Math.round(1000 / avg),
      frameMs: round(avg),
      p95Ms: round(sorted[Math.min(n - 1, Math.floor(n * 0.95))]!),
      worstMs: round(sorted[n - 1]!),
    };
  }
}

/** `new FrameMetrics(windowMs)`; hook `tick` to the app's `frameend`. */
export function createFrameMetrics(windowMs = 2000): FrameMetrics {
  return new FrameMetrics(windowMs);
}

export function round(x: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** JS heap in MB when the browser exposes it (Chromium only; WKWebView does not). */
export function jsHeapMb(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
  return perf.memory ? round(perf.memory.usedJSHeapSize / 1048576, 0) : null;
}
