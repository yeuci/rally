/**
 * The shell's loading screen and its hold contract, ported for the harness (apps/mobile/src/game-host/controller.ts):
 *
 * - the screen is up from the start, showing the game's `ui.loading` progress and label;
 * - a game that never sends a label is revealed at `ready()`;
 * - a game that sends labels stays behind the screen after `ready()` until it sends `progress: 1` (playable: models
 *   loaded and the match joined), and is revealed {@link REVEAL_TIMEOUT_MS} after `ready()` anyway if it never does.
 *
 * DOM-free (the panel draws it), so it is unit-tested in test/loading.test.ts.
 */

/** Same as the shell's REVEAL_TIMEOUT_MS. */
export const REVEAL_TIMEOUT_MS = 25_000;

export interface LoadingState {
  visible: boolean;
  /** 0…1; never decreases while the screen is up. */
  progress: number;
  label: string | null;
  /** ready() came, and the screen waits for `progress: 1`. */
  holding: boolean;
}

export interface LoadingHoldOptions {
  onChange: (state: LoadingState) => void;
  /** The safety reveal fired (a game bug worth logging). */
  onSafetyReveal?: (ms: number) => void;
  revealTimeoutMs?: number;
}

export class LoadingHold {
  private readonly opts: LoadingHoldOptions;
  private s: LoadingState = { visible: true, progress: 0, label: null, holding: false };
  private labelled = false;
  private playable = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LoadingHoldOptions) {
    this.opts = opts;
  }

  get state(): LoadingState {
    return this.s;
  }

  /** `ui.loading` from the game. */
  loading(progress: number, label?: string): void {
    if (label) this.labelled = true;
    if (progress >= 1) this.playable = true;
    if (!this.s.visible) return;
    if (this.s.holding && this.playable) return this.reveal();
    this.set({ progress: Math.max(this.s.progress, Math.min(1, Math.max(0, progress))), label: label ?? this.s.label });
  }

  /** The game's `ready()` handshake succeeded. */
  ready(): void {
    if (!this.s.visible) return;
    if (this.labelled && !this.playable) {
      this.set({ holding: true });
      const ms = this.opts.revealTimeoutMs ?? REVEAL_TIMEOUT_MS;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.s.holding) return;
        this.opts.onSafetyReveal?.(ms);
        this.reveal();
      }, ms);
      return;
    }
    this.reveal();
  }

  /** The game exited (or the harness gave up on it): nothing to show any more. */
  close(): void {
    this.reveal();
  }

  private reveal(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.s.visible) return;
    this.set({ visible: false, holding: false, progress: 1 });
  }

  private set(patch: Partial<LoadingState>): void {
    this.s = { ...this.s, ...patch };
    this.opts.onChange(this.s);
  }
}
