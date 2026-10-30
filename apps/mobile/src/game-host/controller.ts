import type { LaunchContext, LaunchIntent } from '@rally/protocol';
import { HostBridge } from './bridge';
import { createHostHandlers, type HostHandlers, type MatchmakingTarget } from './handlers';
import { buildDeliverScript, parseDiagnostic, type PageDiagnostic } from './injected';
import type { PlaySessionService } from './play-session';
import type { ProgressStore } from './progress';
import type { SaveStore } from './saves';
import type { WebViewHandle } from './webview';

/** How long the game may take from first byte to `ready()` before we show the failure overlay. */
export const READY_TIMEOUT_MS = 20_000;
/** A second exit request within this window force-closes the game (Android back twice, or the close button twice). */
const FORCE_EXIT_WINDOW_MS = 2000;

export type HostPhase = 'loading' | 'ready' | 'crashed' | 'failed';

/** Everything the GameHost screen renders. Immutable snapshots for `useSyncExternalStore`. */
export interface HostView {
  /** Bumped on reload; used as the WebView `key`. */
  attempt: number;
  /** Per-launch nonce injected before any game script runs (architecture §2). */
  nonce: string;
  phase: HostPhase;
  progress: number;
  status: string;
  error: string | null;
}

export interface GameHostResult {
  reason: string;
  /** ms from WebView start to `ready()`; null if the game never became ready. */
  readyMs: number | null;
  /** Foreground seconds between `ready()` and exit; 0 if never ready. Feeds `end_play_session` / `record_play`. */
  playtimeS: number;
  metrics: Record<string, number | string | boolean> | null;
  error: string | null;
}

export type DeviceInfo = LaunchContext['device'];

export interface GameHostControllerOptions {
  bundleUrl: string;
  game: LaunchContext['game'];
  user: LaunchContext['user'];
  intent: LaunchIntent;
  saves: SaveStore;
  progress: ProgressStore;
  /** False for multiplayer games: `leaderboard.submit` answers NOT_SUPPORTED (results come from the room). */
  soloScores: boolean;
  /** Server play sessions; null records nothing (Developer launcher). */
  playSessions: PlaySessionService | null;
  matchmaking: MatchmakingTarget | null;
  device: DeviceInfo;
  onExit: (result: GameHostResult) => void;
  /** After the session was closed on the server (`end_play_session`, or the `record_play` fallback), even if that failed. */
  onPlayRecorded?: () => void;
  createNonce: () => string;
  readyTimeoutMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

/**
 * Owns one game session's mutable state (bridge, timers, WebView handle, metrics) outside React. GameHost.tsx
 * creates it once, renders `getSnapshot()` and forwards WebView / lifecycle callbacks to it. Framework-agnostic
 * and unit-tested in test/controller.test.ts.
 */
export class GameHostController {
  private readonly opts: GameHostControllerOptions;
  private readonly now: () => number;
  private view: HostView;
  private readonly listeners = new Set<() => void>();
  private bridge: HostBridge;
  private handlers!: HostHandlers;
  private getWebView: (() => WebViewHandle | null) | null = null;

  private device: DeviceInfo;
  private onExit: (result: GameHostResult) => void;
  private onPlayRecorded: (() => void) | undefined;
  /** `start_play_session`, fired on the first `start()`; resolves to null if it failed. */
  private playSession: Promise<string | null> | null = null;
  private startedAt: number;
  private readyAt: number | null = null;
  private pausedAt: number | null = null;
  private pausedMs = 0;
  private metrics: Record<string, number | string | boolean> | null = null;
  private lastError: string | null = null;
  private exitRequestedAt = 0;
  private exited = false;
  private active = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private unmountTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GameHostControllerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.device = opts.device;
    this.onExit = opts.onExit;
    this.onPlayRecorded = opts.onPlayRecorded;
    this.startedAt = this.now();
    const nonce = opts.createNonce();
    this.view = { attempt: 0, nonce, phase: 'loading', progress: 0, status: 'Loading…', error: null };
    this.bridge = this.createBridge(nonce);
  }

  // --- store -------------------------------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): HostView => this.view;

  private setView(patch: Partial<HostView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  // --- lifecycle -----------------------------------------------------------------------------------------------

  /** Latest values from props; read lazily when the game calls `ready()` or exits. */
  update(patch: { device?: DeviceInfo; onExit?: (result: GameHostResult) => void; onPlayRecorded?: () => void }): void {
    if (patch.device) this.device = patch.device;
    if (patch.onExit) this.onExit = patch.onExit;
    if (patch.onPlayRecorded) this.onPlayRecorded = patch.onPlayRecorded;
  }

  /**
   * Mount: arm the load timeout and start the server play session (once; in parallel with the WebView load, never
   * awaited here). Safe to call again after `stop()` / `unmount()` (StrictMode double effects).
   */
  start(): void {
    if (this.unmountTimer !== null) clearTimeout(this.unmountTimer);
    this.unmountTimer = null;
    if (this.exited) return;
    this.active = true;
    this.startPlaySession();
    if (this.view.phase === 'loading') this.armReadyTimeout();
  }

  /** The play session id for `leaderboard.submit`: waits for a start still in flight; null without a session. */
  getPlaySessionId = (): Promise<string | null> => this.playSession ?? Promise.resolve(null);

  /** Stop timers and drop traffic; `start()` can resume. */
  stop(): void {
    this.active = false;
    this.clearReadyTimeout();
  }

  /**
   * The host component is going away (navigation, sign-out, a parent unmounting) without the game having
   * exited: end the session as `finish('unmount')` so `onExit` (and `end_play_session`) still runs exactly once.
   * Deferred by a tick and cancelled by `start()`, because StrictMode replays effects (cleanup, then setup)
   * on a component that stays mounted.
   */
  unmount(): void {
    this.stop();
    if (this.exited || this.unmountTimer !== null) return;
    this.unmountTimer = setTimeout(() => {
      this.unmountTimer = null;
      this.finish('unmount');
    }, 0);
  }

  /** How to reach the live WebView (GameHost passes a getter over its ref from an effect). */
  setWebView(getter: (() => WebViewHandle | null) | null): void {
    this.getWebView = getter;
  }

  // --- WebView callbacks ----------------------------------------------------------------------------------------

  /** Diagnostics for the load-timeout overlay: what the game sent (or didn't) before giving up. */
  private readonly seenMethods: string[] = [];
  private droppedCount = 0;
  /** Page-level reports from the injected diagnostics script (CSP violations, failed loads, exceptions). */
  private readonly diagnostics: PageDiagnostic[] = [];

  handleMessage = (data: string, sourceUrl: string | undefined): void => {
    const diag = parseDiagnostic(data);
    if (diag) {
      if (this.diagnostics.length < 12) this.diagnostics.push(diag);
      if (diag.kind !== 'boot') this.warn(`[game ${diag.kind}] ${diag.message}`);
      return;
    }
    const m = /"method":"([^"]+)"/.exec(data)?.[1];
    if (m && this.seenMethods.length < 20) this.seenMethods.push(m);
    if (!this.active || this.exited) return;
    this.bridge.handleMessage(data, sourceUrl);
  };

  /** `onShouldStartLoadWithRequest`: only the bundle's own directory may load. */
  /**
   * The WebView began loading a main document. On a reload of the bundle (Vite re-optimising dependencies on a
   * cold cache, a game calling location.reload()) the game will call ready() again, so the handshake is reset and
   * the loading overlay returns until it does.
   */
  onMainFrameLoadStart = (url: string): void => {
    if (!this.bridge.isInsideBundle(url)) return;
    this.handlers.resetHandshake();
    if (this.view.phase === 'ready') {
      this.setView({ phase: 'loading', progress: 0, status: 'Reloading…' });
      this.armReadyTimeout();
    }
  };

  allowNavigation = (url: string): boolean => {
    if (this.bridge.isInsideBundle(url)) return true;
    this.warn(`[bridge] blocked navigation to ${url}`);
    return false;
  };

  onLoadProgress = (progress: number): void => {
    if (this.view.phase !== 'loading') return;
    const next = Math.max(this.view.progress, progress * 0.5);
    if (next !== this.view.progress) this.setView({ progress: next });
  };

  onProcessGone = (message: string): void => {
    this.lastError = message;
    this.clearReadyTimeout();
    this.setView({ phase: 'crashed', error: message });
  };

  onLoadError = (message: string): void => {
    this.lastError = message;
    this.clearReadyTimeout();
    this.setView({ phase: 'failed', error: message });
  };

  /** App background / foreground → game `pause` / `resume`; paused time is not counted as playtime. */
  setAppActive = (active: boolean): void => {
    if (active) {
      if (this.pausedAt !== null) this.pausedMs += this.now() - this.pausedAt;
      this.pausedAt = null;
      this.bridge.sendEvent('resume', {});
    } else {
      this.pausedAt ??= this.now();
      this.bridge.sendEvent('pause', {});
    }
  };

  /** Close button / Android back: ask the game to leave; a second request (or a game that isn't ready) force-exits. */
  requestExit = (): void => {
    const t = this.now();
    if (this.view.phase !== 'ready' || t - this.exitRequestedAt < FORCE_EXIT_WINDOW_MS) {
      this.finish('forced');
      return;
    }
    this.exitRequestedAt = t;
    this.bridge.sendEvent('exitRequested', {});
    this.setView({ status: 'Leaving…' });
  };

  /** Crash / failure overlay "Reload": new nonce, new bridge, new WebView (keyed by `attempt`). */
  reload = (): void => {
    this.bridge.close();
    const nonce = this.opts.createNonce();
    this.bridge = this.createBridge(nonce);
    this.startedAt = this.now();
    this.readyAt = null;
    this.pausedAt = null;
    this.pausedMs = 0;
    this.lastError = null;
    this.exitRequestedAt = 0;
    this.setView({ attempt: this.view.attempt + 1, nonce, phase: 'loading', progress: 0, status: 'Loading…', error: null });
    if (this.active) this.armReadyTimeout();
  };

  /** Overlay "Back" and every other exit path. Idempotent. */
  finish = (reason: string): void => {
    if (this.exited) return;
    this.exited = true;
    this.stop();
    this.bridge.close();
    const end = this.pausedAt ?? this.now();
    const playtimeS = this.readyAt === null ? 0 : Math.max(0, (end - this.readyAt - this.pausedMs) / 1000);
    this.onExit({
      reason,
      readyMs: this.readyAt === null ? null : this.readyAt - this.startedAt,
      playtimeS,
      metrics: this.metrics,
      error: this.lastError,
    });
    void this.closePlaySession(playtimeS, this.readyAt !== null);
  };

  // --- internals -------------------------------------------------------------------------------------------------

  private startPlaySession() {
    const svc = this.opts.playSessions;
    if (!svc || this.playSession) return;
    this.playSession = svc.start(this.opts.game).then(
      (id) => id || null,
      (err: unknown) => {
        this.warn(`[play-session] start failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      },
    );
  }

  /**
   * Exactly once per controller (from `finish`): close the session with the playtime, or, if none could be started
   * (offline at launch), fall back to `record_play` for a game that became ready. Failures are logged, not thrown.
   */
  private async closePlaySession(playtimeS: number, wasReady: boolean) {
    const svc = this.opts.playSessions;
    if (!svc) return;
    try {
      const id = await (this.playSession ?? Promise.resolve(null));
      if (id) await svc.end(id, playtimeS);
      else if (wasReady) await svc.recordPlay(this.opts.game.id, playtimeS);
      else return;
    } catch (err) {
      this.warn(`[play-session] close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.onPlayRecorded?.();
  }

  private createBridge(nonce: string): HostBridge {
    return new HostBridge({
      nonce,
      bundleUrl: this.opts.bundleUrl,
      deliver: (json) => {
        if (this.active) this.getWebView?.()?.injectJavaScript(buildDeliverScript(json));
      },
      handlers: (this.handlers = createHostHandlers({
        getLaunchContext: () => ({
          game: this.opts.game,
          user: this.opts.user,
          intent: this.opts.intent,
          device: this.device,
        }),
        saves: this.opts.saves,
        progress: this.opts.progress,
        soloScores: this.opts.soloScores,
        getPlaySessionId: this.getPlaySessionId,
        matchmaking: this.opts.matchmaking,
        now: this.opts.now,
        onReady: () => {
          this.readyAt = this.now();
          this.clearReadyTimeout();
          this.setView({ phase: 'ready', progress: 1 });
        },
        onLoading: (progress) => {
          if (this.view.phase === 'loading') this.setView({ progress: Math.max(this.view.progress, progress) });
        },
        onExit: (reason) => this.finish(reason),
      })),
      onGameEvent: (ev) => {
        if (ev.method === 'telemetry.report') this.metrics = ev.params.values;
        else if (ev.method === 'game.error') this.lastError = ev.params.message;
      },
      onDrop: (reason) => {
        this.droppedCount += 1;
        this.warn(`[bridge] dropped message: ${reason}`);
      },
    });
  }

  private armReadyTimeout() {
    this.clearReadyTimeout();
    const ms = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.view.phase !== 'loading') return;
      const seen = this.seenMethods.length ? `received: ${[...new Set(this.seenMethods)].join(', ')}` : 'no messages from the game';
      const dropped = this.droppedCount ? `, ${this.droppedCount} dropped (nonce/origin)` : '';
      const booted = this.diagnostics.some((d) => d.kind === 'boot');
      const page = this.diagnostics.filter((d) => d.kind !== 'boot').map((d) => `${d.kind}: ${d.message}`);
      const detail = [
        booted ? 'injected script ran' : 'injected script did not run',
        ...(page.length ? page : booted ? ['no page errors reported'] : []),
      ].join('\n');
      this.lastError ??= `game did not call ready() within ${Math.round(ms / 1000)}s (${seen}${dropped}, url ${this.opts.bundleUrl})\n${detail}`;
      this.setView({ phase: 'failed', error: this.lastError });
    }, ms);
  }

  private clearReadyTimeout() {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private warn(message: string) {
    (this.opts.warn ?? console.warn)(message);
  }
}
