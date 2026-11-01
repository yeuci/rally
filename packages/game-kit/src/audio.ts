export interface BlipOptions {
  /** Oscillator wave. Default 'sine'. */
  type?: OscillatorType;
  /** Peak gain 0..1 before the master volume. Default 0.5. */
  gain?: number;
  /** Glide the frequency to this value over the blip. */
  slideTo?: number;
  /** Start delay in ms (for little arpeggios). Default 0. */
  delayMs?: number;
}

export interface AudioHandle {
  /** True once a user gesture resumed the context; before that `blip` is a no-op. */
  readonly unlocked: boolean;
  /** Null until the first gesture (the context is created lazily inside it). */
  readonly context: AudioContext | null;
  muted: boolean;
  /**
   * The player's loudness 0…1 over the base volume (the game menu's master × effects, game-kit `effectsVolume`).
   * Applied live; 0 is silent. Default 1.
   */
  volume: number;
  /** Short procedural tone with a fast attack and exponential decay. */
  blip(freq: number, ms: number, opts?: BlipOptions): void;
  /** Suspend output (host `pause`). */
  suspend(): void;
  /** Resume output after `suspend()` (host `resume`). */
  resume(): void;
  /** Close the context (`lowMemory` or teardown); the next gesture recreates it. */
  close(): void;
  destroy(): void;
}

type AudioContextCtor = typeof AudioContext;

const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'] as const;

/**
 * WebAudio with unlock-on-first-gesture. iOS (and Chrome's autoplay policy) only lets a context start inside a
 * user gesture, so the context is created/resumed from the first pointer/touch/key event and a one-sample silent
 * buffer is played to fully unlock WebKit. Listeners stay attached until the context is actually running, and are
 * attached again whenever it stops running without our `suspend()` (interruptions, a non-gesture `resume()`).
 */
export function createAudio(options: { volume?: number; target?: EventTarget } = {}): AudioHandle {
  const target = options.target ?? window;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let suspended = false;
  let listening = false;
  const base = options.volume ?? 0.35;
  let scale = 1;

  const handle: AudioHandle = {
    get volume() {
      return scale;
    },
    set volume(v: number) {
      scale = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
      if (master) master.gain.value = base * scale;
    },
    get unlocked() {
      return ctx?.state === 'running';
    },
    get context() {
      return ctx;
    },
    muted: false,
    blip(freq, ms, opts = {}) {
      if (!ctx || !master || ctx.state !== 'running' || handle.muted || suspended || scale === 0) return;
      const t0 = ctx.currentTime + (opts.delayMs ?? 0) / 1000;
      const dur = Math.max(0.01, ms / 1000);
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = opts.type ?? 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.slideTo), t0 + dur);
      const peak = Math.max(0.0001, Math.min(1, opts.gain ?? 0.5));
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.008, dur / 4));
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(env).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      osc.onended = () => env.disconnect();
    },
    suspend() {
      suspended = true;
      void ctx?.suspend().catch(() => {});
    },
    resume() {
      suspended = false;
      const c = ctx;
      if (!c) return;
      // The host's `resume` arrives through injectJavaScript, not a gesture: WebKit may leave the context suspended
      // or interrupted, and only a gesture can start it again, so re-arm the unlock listeners in that case.
      c.resume().then(
        () => {
          if (ctx === c && c.state !== 'running') listen();
        },
        () => listen(),
      );
    },
    close() {
      closeContext();
      listen();
    },
    destroy() {
      closeContext();
      unlisten();
    },
  };

  function unlock() {
    if (!Ctor || suspended) return;
    if (!ctx) {
      try {
        ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      master = ctx.createGain();
      master.gain.value = base * scale;
      master.connect(ctx.destination);
      const c = ctx;
      // The system can stop a running context (iOS interruption: a call, Siri, another app's audio). Unless we
      // suspended it ourselves, wait for the next gesture to start it again.
      c.onstatechange = () => {
        if (ctx === c && !suspended && c.state !== 'running') listen();
      };
    }
    // A one-sample silent buffer started inside the gesture is what finally unlocks WebKit.
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    void ctx.resume().then(
      () => {
        if (ctx?.state === 'running') unlisten();
      },
      () => {},
    );
  }

  function closeContext() {
    const c = ctx;
    ctx = null;
    master = null;
    void c?.close().catch(() => {});
  }

  function listen() {
    if (listening) return;
    listening = true;
    for (const e of UNLOCK_EVENTS) target.addEventListener(e, unlock, { capture: true, passive: true });
  }
  function unlisten() {
    if (!listening) return;
    listening = false;
    for (const e of UNLOCK_EVENTS) target.removeEventListener(e, unlock, { capture: true });
  }

  listen();
  return handle;
}
