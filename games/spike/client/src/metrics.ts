/** Rolling frame statistics for the HUD and telemetry. */
export class FrameMetrics {
  private frames: number[] = [];
  private lastFrame = performance.now();
  private readonly windowMs: number;

  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }

  /** Call once per rendered frame. */
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

  snapshot() {
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

export function round(x: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** JS heap in MB when the browser exposes it (Chromium only; WKWebView does not). */
export function jsHeapMb(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
  return perf.memory ? round(perf.memory.usedJSHeapSize / 1048576, 0) : null;
}
