import type { RallyLike } from './host.ts';

export interface LifecycleOptions {
  /** Simulation frozen (host `pause`, page hidden, or `lifecycle.pause()`). */
  onPause?: () => void;
  onResume?: () => void;
  /**
   * Host asked the game to close (back button / ✕). Save and leave rooms here; it is awaited (bounded by
   * `exitTimeoutMs`) before `rally.exit('host')`.
   */
  onExitRequested?: () => void | Promise<void>;
  /** Drop caches, pools, extra render targets. */
  onLowMemory?: () => void;
  /**
   * The host's game menu opened or closed (`menu` event): release held input while it is open (sticks, fire). A solo
   * game may also pause (`pauseWhileMenuOpen`).
   */
  onMenu?: (open: boolean) => void;
  /** Pause (reason 'menu') while the host's game menu is open. Default false: multiplayer keeps running underneath. */
  pauseWhileMenuOpen?: boolean;
  /** Also pause while `document.hidden`. Default: only when not hosted (the shell sends `pause` itself). */
  pauseWhenHidden?: boolean;
  /** Upper bound for `onExitRequested` before exiting anyway. Default 3000 ms. */
  exitTimeoutMs?: number;
}

export interface Lifecycle {
  readonly isPaused: boolean;
  readonly isExiting: boolean;
  /** Why the game is paused: any of 'host', 'hidden' or reasons passed to `pause()`. */
  readonly pauseReasons: ReadonlySet<string>;
  pause(reason?: string): void;
  resume(reason?: string): void;
  /** Run `onExitRequested`, then `rally.exit(reason)` when hosted. Idempotent. */
  exit(reason?: string): Promise<void>;
  destroy(): void;
}

/**
 * Wires the host events (`pause`, `resume`, `exitRequested`, `lowMemory`) to callbacks and `app.timeScale`.
 * Pausing is reason-counted, so a host `resume` does not undo a pause the page-visibility handler still holds.
 * Freezing `timeScale` keeps PlayCanvas rendering (dt = 0) while game time stands still.
 */
export function createLifecycle(
  rally: Pick<RallyLike, 'isHosted' | 'on' | 'exit'>,
  app: { timeScale: number } | null,
  options: LifecycleOptions = {},
): Lifecycle {
  const reasons = new Set<string>();
  let exiting: Promise<void> | null = null;
  const pauseWhenHidden = options.pauseWhenHidden ?? !rally.isHosted;

  const lifecycle: Lifecycle = {
    get isPaused() {
      return reasons.size > 0;
    },
    get isExiting() {
      return exiting !== null;
    },
    pauseReasons: reasons,
    pause(reason = 'host') {
      const was = reasons.size > 0;
      reasons.add(reason);
      if (was) return;
      if (app) app.timeScale = 0;
      options.onPause?.();
    },
    resume(reason = 'host') {
      if (!reasons.delete(reason) || reasons.size > 0) return;
      if (app) app.timeScale = 1;
      options.onResume?.();
    },
    exit(reason = 'host') {
      exiting ??= (async () => {
        const timeoutMs = options.exitTimeoutMs ?? 3000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => options.onExitRequested?.()),
            new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
          ]);
        } catch (err) {
          console.warn('[game-kit] onExitRequested failed', err);
        } finally {
          clearTimeout(timer);
        }
        if (rally.isHosted) await rally.exit(reason).catch(() => null);
      })();
      return exiting;
    },
    destroy() {
      for (const off of unsubscribers) off();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
  };

  const onVisibility = () => {
    if (document.hidden) lifecycle.pause('hidden');
    else lifecycle.resume('hidden');
  };
  const unsubscribers = [
    rally.on('pause', () => lifecycle.pause('host')),
    rally.on('resume', () => lifecycle.resume('host')),
    rally.on('exitRequested', () => void lifecycle.exit('host')),
    rally.on('lowMemory', () => options.onLowMemory?.()),
    rally.on('menu', ({ open }) => {
      if (options.pauseWhileMenuOpen) {
        if (open) lifecycle.pause('menu');
        else lifecycle.resume('menu');
      }
      options.onMenu?.(open);
    }),
  ];
  if (pauseWhenHidden && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  return lifecycle;
}
