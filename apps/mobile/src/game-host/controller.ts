import type { LaunchContext, LaunchIntent } from '@rally/protocol';
import { HostBridge } from './bridge';
import {
  createHostHandlers,
  createJoinState,
  type HostHandlers,
  type JoinState,
  type MatchmakingTarget,
} from './handlers';
import { DIAG_PREFIX, buildDeliverScript, parseDiagnostic, type PageDiagnostic } from './injected';
import { BAR_SHARE, gameBarPosition, loadingCopy, pageBarPosition, type LoadStage } from './loading-copy';
import type { PlaySessionService } from './play-session';
import type { ProgressStore } from './progress';
import type { SaveStore } from './saves';
import type { WebViewHandle } from './webview';

/** How long the game may take from first byte to `ready()` before we show the failure overlay. */
export const READY_TIMEOUT_MS = 20_000;
/** A second exit request within this window force-closes the game (Android back twice, or the close button twice). */
const FORCE_EXIT_WINDOW_MS = 2000;
/**
 * The hold contract's safety net: a game that sent loading labels but never `progress: 1` is shown this long after
 * `ready()` anyway (and the host logs it), so a game that forgets the last step never strands the player.
 */
export const REVEAL_TIMEOUT_MS = 25_000;
/**
 * "Leave" while a ready game is still behind the loading screen (joining its match): it gets this long to leave its
 * room with consent and call `exit()`, then the host closes it. It cannot ask the player anything from under there.
 */
export const LEAVE_GRACE_MS = 2500;

export type HostPhase = 'loading' | 'ready' | 'crashed' | 'failed';

/** Everything the GameHost screen renders. Immutable snapshots for `useSyncExternalStore`. */
export interface HostView {
  /** Bumped on reload; used as the WebView `key`. */
  attempt: number;
  /** Per-launch nonce injected before any game script runs (architecture §2). */
  nonce: string;
  /**
   * `loading` while the loading screen is up: before `ready()`, and after it while a game that sends loading labels
   * has not reported `progress: 1` yet (the hold contract). The game is live (playtime, exit requests) from `ready()`.
   */
  phase: HostPhase;
  /** 0…1 across the whole boot (entry, page, then the game's own stages); never decreases within one load. */
  progress: number;
  /** Which part of the boot is running (loading-copy.ts). */
  stage: LoadStage;
  /** The game's latest `ui.loading` label for the current page, or null. */
  label: string | null;
  /** The line under the bar, in plain words: the game's label, else the host's own for its stage. */
  status: string;
  /** A quiet byte count or percentage beside the status, or null. */
  detail: string | null;
  error: string | null;
  /** Last frame rate the game's WebView reported (once a second while the FPS overlay is on); null otherwise. */
  fps: number | null;
}

export interface GameHostResult {
  reason: string;
  /** ms from WebView start to `ready()`; null if the game never became ready. */
  readyMs: number | null;
  /** ms from start to the entry document being downloaded and verified; null if it never was. */
  entryMs: number | null;
  /** ms from start to the WebView beginning to load the entry; null if it never did. */
  pageMs: number | null;
  /**
   * Foreground seconds the game was playable (from each `ready()` to the next reload / crash / exit, summed over
   * every reload of this session); 0 if never ready. Feeds `end_play_session` / `record_play`.
   */
  playtimeS: number;
  /** The game called `ready()` at least once in this session (any attempt). Only then is a play recorded. */
  played: boolean;
  metrics: Record<string, number | string | boolean> | null;
  error: string | null;
}

export type DeviceInfo = LaunchContext['device'];

export interface GameHostControllerOptions {
  bundleUrl: string;
  game: LaunchContext['game'];
  /** The game's display name, for the loading screen ("Getting Gun Run ready…"); null says "the game". */
  title?: string | null;
  /**
   * Bytes of the files the page itself loads (loading-copy.ts `pageBytesOf`), shown as "1.2 of 3.4 MB" while the
   * WebView loads them; null shows a percentage.
   */
  pageBytes?: number | null;
  user: LaunchContext['user'];
  intent: LaunchIntent;
  /** `join=resume`: the game's reconnection token, shown in the launch context until the resume was used. */
  resume?: LaunchContext['resume'];
  saves: SaveStore;
  progress: ProgressStore;
  /** False for multiplayer games: `leaderboard.submit` / `achievement.unlock` answer NOT_SUPPORTED (results come from the room). */
  soloScores: boolean;
  /** Server play sessions; null records nothing (Developer launcher, and multiplayer games: their stats are server-written). */
  playSessions: PlaySessionService | null;
  /** Matchmaking, with its join target and rejoin journal; the join state is kept across reloads of this session. */
  matchmaking: MatchmakingTarget | null;
  device: DeviceInfo;
  onExit: (result: GameHostResult) => void;
  /** After the session was closed on the server (`end_play_session`, or the `record_play` fallback), even if that failed. */
  onPlayRecorded?: () => void;
  createNonce: () => string;
  readyTimeoutMs?: number;
  /** Override {@link REVEAL_TIMEOUT_MS} (tests). */
  revealTimeoutMs?: number;
  /** Override {@link LEAVE_GRACE_MS} (tests). */
  leaveGraceMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  /** Launch timings, one line per session (dev builds log them to the Metro terminal). */
  log?: (message: string) => void;
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
  /** Sticky join target, joined room and reconnection report: one per session, shared by every bridge. */
  private readonly joinState: JoinState;
  private getWebView: (() => WebViewHandle | null) | null = null;

  private device: DeviceInfo;
  private onExit: (result: GameHostResult) => void;
  private onPlayRecorded: (() => void) | undefined;
  /** `start_play_session`, fired on the first `start()`; resolves to null if it failed. */
  private playSession: Promise<string | null> | null = null;
  private startedAt: number;
  /** When the current attempt called `ready()` (launch timing); reset by `reload()`. */
  private readyAt: number | null = null;
  /** Start of the current playable stretch (since the latest `ready()`); null while loading, crashed or failed. */
  private segmentAt: number | null = null;
  /** Playtime of earlier stretches of this session (before an in-page reload, a crash or an overlay reload). */
  private bankedMs = 0;
  /** `ready()` happened in some attempt: the only case in which the session records a play. */
  private everReady = false;
  private entryAt: number | null = null;
  private pageAt: number | null = null;
  private fpsOverlay = false;
  private pausedAt: number | null = null;
  private pausedMs = 0;
  private metrics: Record<string, number | string | boolean> | null = null;
  private lastError: string | null = null;
  private exitRequestedAt = 0;
  private exited = false;
  private active = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private unmountTimer: ReturnType<typeof setTimeout> | null = null;

  // --- the loading screen and the hold contract (per page: reset by a reload and by a new main document) ---------
  /** Bytes of the host-side download in progress (entry document, or the page's files), when known. */
  private bytes: { loaded: number; total: number } | null = null;
  /** The player asked to leave (the status line says so). */
  private leaving = false;
  /** This page sent a `ui.loading` label: it promised `progress: 1` once playable, so ready() alone does not reveal it. */
  private labelled = false;
  /** This page reported `progress: 1`. */
  private playable = false;
  /** ready() came from a labelled page that is not playable yet: live, but still behind the loading screen. */
  private holding = false;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GameHostControllerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.device = opts.device;
    this.onExit = opts.onExit;
    this.onPlayRecorded = opts.onPlayRecorded;
    this.startedAt = this.now();
    this.joinState = createJoinState(opts.matchmaking?.join);
    const nonce = opts.createNonce();
    this.view = {
      attempt: 0,
      nonce,
      phase: 'loading',
      progress: 0,
      stage: 'entry',
      label: null,
      ...this.copy({ stage: 'entry', label: null, progress: 0 }),
      error: null,
      fps: null,
    };
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

  /** Every change goes through here; the status line and its detail are derived, never patched. */
  private setView(patch: Partial<Omit<HostView, 'status' | 'detail'>>) {
    const next = { ...this.view, ...patch };
    this.view = { ...next, ...this.copy(next) };
    for (const l of this.listeners) l();
  }

  private copy(v: Pick<HostView, 'stage' | 'label' | 'progress'>) {
    return loadingCopy({
      title: this.opts.title ?? null,
      stage: v.stage,
      label: v.label,
      progress: v.progress,
      bytes: this.bytes,
      leaving: this.leaving,
    });
  }

  /** The page's files as bytes at WebView progress `p`, when their size is known. */
  private pageBytesAt(p: number): { loaded: number; total: number } | null {
    const total = this.opts.pageBytes;
    return total && total > 0 ? { loaded: Math.round(Math.min(1, Math.max(0, p)) * total), total } : null;
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
    if (this.holding) this.armRevealTimeout();
    else if (this.view.phase === 'loading') this.armReadyTimeout();
  }

  /** The play session id for `leaderboard.submit`: waits for a start still in flight; null without a session. */
  getPlaySessionId = (): Promise<string | null> => this.playSession ?? Promise.resolve(null);

  /** Stop timers and drop traffic; `start()` can resume. */
  stop(): void {
    this.active = false;
    this.clearReadyTimeout();
    this.clearRevealTimeout();
    this.clearLeaveTimeout();
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

  /** Diagnostics for the load-timeout overlay: what the current attempt sent (or didn't) before giving up. */
  private seenMethods: string[] = [];
  private droppedCount = 0;
  /** Page-level reports from the injected diagnostics script (CSP violations, failed loads, exceptions). */
  private diagnostics: PageDiagnostic[] = [];

  handleMessage = (data: string, sourceUrl: string | undefined): void => {
    if (data.startsWith(DIAG_PREFIX)) {
      // Same gate as bridge traffic minus the nonce (the diagnostics script has none): from the bundle's own
      // directory, while the session is live. The script caps each report at 400 chars and sends at most 12 per
      // page; anything bigger is not ours, and only what is kept (12 per attempt) is logged.
      if (data.length > 4096 || !this.active || this.exited || !sourceUrl || !this.bridge.isInsideBundle(sourceUrl))
        return;
      const diag = parseDiagnostic(data);
      if (!diag) return;
      if (diag.kind === 'fps') {
        const fps = Number(diag.message);
        if (this.fpsOverlay && Number.isFinite(fps) && fps !== this.view.fps) this.setView({ fps });
        return;
      }
      if (this.diagnostics.length >= 12) return;
      this.diagnostics.push(diag);
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
  /** Bytes of the entry document so far (`total` null when the response did not say); GameHost reports them. */
  onEntryProgress = (loaded: number, total: number | null): void => {
    if (this.view.phase !== 'loading' || this.view.stage !== 'entry') return;
    this.bytes = total && total > 0 ? { loaded: Math.min(Math.max(0, loaded), total), total } : null;
    const f = this.bytes ? this.bytes.loaded / this.bytes.total : 0;
    this.setView({ progress: Math.max(this.view.progress, BAR_SHARE.entry * f) });
  };

  /** GameHost downloaded and verified the entry document (see entry.ts); the WebView loads the page next. */
  onEntryLoaded = (): void => {
    this.entryAt ??= this.now();
    if (this.view.phase !== 'loading' || this.view.stage !== 'entry') return;
    this.bytes = this.pageBytesAt(0);
    this.setView({ stage: 'page', progress: Math.max(this.view.progress, BAR_SHARE.entry) });
  };

  /** Show or hide the FPS overlay: starts/stops the sampler in the page; takes effect live. */
  setFpsOverlay = (on: boolean): void => {
    if (on === this.fpsOverlay) return;
    this.fpsOverlay = on;
    if (!on && this.view.fps !== null) this.setView({ fps: null });
    this.getWebView?.()?.injectJavaScript(
      `window.__rallyDiag && window.__rallyDiag.fps(${on ? 'true' : 'false'}); true;`,
    );
  };

  onMainFrameLoadStart = (url: string): void => {
    if (!this.bridge.isInsideBundle(url)) {
      // Belt and braces for the navigation gate: Android's onShouldStartLoadWithRequest fails open when the JS
      // thread does not answer within its timeout, so a main-frame load outside the bundle is stopped here too.
      this.getWebView?.()?.stopLoading?.();
      this.warn(`[bridge] stopped main-frame load outside the bundle: ${url}`);
      this.onLoadError(`navigation outside the game bundle was blocked (${url})`);
      return;
    }
    this.pageAt ??= this.now();
    // An in-page reload: the time played so far counts; the next ready() starts a new stretch.
    this.bankPlaytime();
    this.handlers.resetHandshake();
    // A new document makes its own promises: labels and `progress: 1` count per page.
    const live = this.view.phase === 'ready' || this.holding;
    this.resetHold();
    if (live) {
      this.bytes = this.pageBytesAt(0);
      this.setView({ phase: 'loading', progress: 0, stage: 'page', label: null });
      this.armReadyTimeout();
    } else if (this.view.phase === 'loading') {
      this.bytes = this.pageBytesAt(0);
      this.setView({ stage: 'page', label: null, progress: Math.max(this.view.progress, BAR_SHARE.entry) });
    }
  };

  allowNavigation = (url: string): boolean => {
    if (this.bridge.isInsideBundle(url)) return true;
    this.warn(`[bridge] blocked navigation to ${url}`);
    return false;
  };

  /** WebView load progress (0…1) of the page's own files: the bar's page share, until the game reports. */
  onLoadProgress = (progress: number): void => {
    if (this.view.phase !== 'loading' || this.holding) return;
    const next = Math.max(this.view.progress, pageBarPosition(progress));
    if (this.view.stage === 'game') {
      if (next !== this.view.progress) this.setView({ progress: next });
      return;
    }
    this.bytes = this.pageBytesAt(progress);
    this.setView({ stage: 'page', progress: next });
  };

  onProcessGone = (message: string): void => {
    this.bankPlaytime();
    this.lastError = message;
    this.clearReadyTimeout();
    this.resetHold();
    this.setView({ phase: 'crashed', error: message });
  };

  onLoadError = (message: string): void => {
    this.bankPlaytime();
    this.lastError = message;
    this.clearReadyTimeout();
    this.resetHold();
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
      // The app may never come back: the rejoin record's grace counts from here.
      this.handlers.background();
      // The app may be killed in the background without another callback: leave the playtime where the next
      // launch can close the session with it.
      this.checkpoint();
    }
  };

  /**
   * Close button, the loading screen's "Leave", Android back: ask a live game to leave; a second request within 2 s
   * (or a game that never became ready) force-exits. A ready game still behind the loading screen (the hold) gets
   * {@link LEAVE_GRACE_MS} to leave its room and call `exit()`, then it is closed: it cannot show the player anything.
   */
  requestExit = (): void => {
    const t = this.now();
    const live = this.view.phase === 'ready' || this.holding;
    if (!live || t - this.exitRequestedAt < FORCE_EXIT_WINDOW_MS) {
      this.finish('forced');
      return;
    }
    this.exitRequestedAt = t;
    this.bridge.sendEvent('exitRequested', {});
    this.leaving = true;
    this.setView({});
    if (this.holding && this.leaveTimer === null) {
      this.leaveTimer = setTimeout(() => {
        this.leaveTimer = null;
        this.finish('forced');
      }, this.opts.leaveGraceMs ?? LEAVE_GRACE_MS);
    }
  };

  /**
   * Crash / failure overlay "Reload": new nonce, new bridge, new WebView (keyed by `attempt`). Same play session:
   * the playtime so far is kept; launch timings and load diagnostics start over for the new attempt.
   */
  reload = (): void => {
    this.bankPlaytime();
    this.bridge.close();
    const nonce = this.opts.createNonce();
    this.bridge = this.createBridge(nonce);
    this.startedAt = this.now();
    this.readyAt = null;
    this.entryAt = null;
    this.pageAt = null;
    this.pausedAt = null;
    this.pausedMs = 0;
    this.lastError = null;
    this.exitRequestedAt = 0;
    this.seenMethods = [];
    this.droppedCount = 0;
    this.diagnostics = [];
    this.resetHold();
    this.clearLeaveTimeout();
    this.leaving = false;
    this.bytes = null;
    this.setView({
      attempt: this.view.attempt + 1,
      nonce,
      phase: 'loading',
      progress: 0,
      stage: 'entry',
      label: null,
      error: null,
      fps: null,
    });
    if (this.active) this.armReadyTimeout();
  };

  /** Overlay "Back" and every other exit path. Idempotent. */
  finish = (reason: string): void => {
    if (this.exited) return;
    this.exited = true;
    this.stop();
    this.bridge.close();
    const playtimeS = this.playtimeMs() / 1000;
    this.onExit({
      reason,
      readyMs: this.readyAt === null ? null : this.readyAt - this.startedAt,
      entryMs: this.entryAt === null ? null : this.entryAt - this.startedAt,
      pageMs: this.pageAt === null ? null : this.pageAt - this.startedAt,
      playtimeS,
      played: this.everReady,
      metrics: this.metrics,
      error: this.lastError,
    });
    void this.closePlaySession(playtimeS, this.everReady);
  };

  // --- internals -------------------------------------------------------------------------------------------------

  /** Banked stretches plus the current one (foreground time since the latest `ready()`). */
  private playtimeMs(): number {
    if (this.segmentAt === null) return this.bankedMs;
    const end = this.pausedAt ?? this.now();
    return this.bankedMs + Math.max(0, end - this.segmentAt - this.pausedMs);
  }

  /** Close the current playable stretch (reload, crash, load failure). Idempotent. */
  private bankPlaytime() {
    if (this.segmentAt === null) return;
    this.bankedMs = this.playtimeMs();
    this.segmentAt = null;
    this.pausedMs = 0;
    if (this.pausedAt !== null) this.pausedAt = this.now();
    this.checkpoint();
  }

  /** Hand the open session's latest playtime to the service (`checkpoint`), once its id is known. Best effort. */
  private checkpoint() {
    const svc = this.opts.playSessions;
    if (!svc?.checkpoint || !this.playSession || this.exited) return;
    const playtimeS = this.playtimeMs() / 1000;
    const played = this.everReady;
    void this.playSession.then((id) => {
      if (id && !this.exited) svc.checkpoint?.(id, playtimeS, played);
    });
  }

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
   * Exactly once per controller (from `finish`). A game that became ready (in any attempt) records a play: close the
   * session with the playtime, or, if none could be started (offline at launch), fall back to `record_play`. A
   * launch that never reached `ready()` records nothing: the session is abandoned (`end_play_session` would count a
   * play). Failures are logged, not thrown.
   */
  private async closePlaySession(playtimeS: number, played: boolean) {
    const svc = this.opts.playSessions;
    if (!svc) return;
    try {
      const id = await (this.playSession ?? Promise.resolve(null));
      if (!played) {
        if (id) await svc.abandon?.(id);
        return;
      }
      if (id) await svc.end(id, playtimeS);
      else await svc.recordPlay(this.opts.game.id, playtimeS);
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
          ...(this.opts.resume ? { resume: this.opts.resume } : {}),
          device: this.device,
        }),
        saves: this.opts.saves,
        progress: this.opts.progress,
        soloScores: this.opts.soloScores,
        getPlaySessionId: this.getPlaySessionId,
        matchmaking: this.opts.matchmaking,
        joinState: this.joinState,
        now: this.opts.now,
        onReady: () => {
          this.readyAt = this.now();
          // A new playable stretch (the first one, or after an in-page reload). Pauses before it don't count.
          this.bankPlaytime();
          this.segmentAt = this.readyAt;
          this.pausedMs = 0;
          if (this.pausedAt !== null) this.pausedAt = this.readyAt;
          this.everReady = true;
          this.checkpoint();
          this.clearReadyTimeout();
          const ms = (t: number | null) => (t === null ? '—' : `${t - this.startedAt} ms`);
          this.opts.log?.(
            `[game-host] ${this.opts.game.id}@${this.opts.game.version} ready in ${ms(this.readyAt)} (entry downloaded ${ms(this.entryAt)}, page load started ${ms(this.pageAt)})`,
          );
          // The hold contract: a game that sends labels stays behind the loading screen until it says it is playable.
          if (this.labelled && !this.playable) {
            this.holding = true;
            this.armRevealTimeout();
          } else {
            this.reveal();
          }
        },
        onLoading: (progress, label) => this.onGameLoading(progress, label),
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

  /** `ui.loading` from the game: its label and progress on the bar; `progress: 1` ends a hold. */
  private onGameLoading(progress: number, label: string | undefined) {
    if (label) this.labelled = true;
    if (progress >= 1) this.playable = true;
    if (this.view.phase !== 'loading') return;
    if (this.holding && this.playable) {
      this.reveal();
      return;
    }
    this.bytes = null;
    this.setView({
      stage: 'game',
      progress: Math.max(this.view.progress, gameBarPosition(progress)),
      ...(label ? { label } : {}),
    });
  }

  /** Drop the loading screen: the game is on screen. */
  private reveal() {
    const held = this.holding;
    this.holding = false;
    this.clearRevealTimeout();
    this.setView({ phase: 'ready', progress: 1 });
    if (held && this.readyAt !== null) {
      const t = this.now();
      this.opts.log?.(
        `[game-host] ${this.opts.game.id}@${this.opts.game.version} playable in ${t - this.startedAt} ms (${t - this.readyAt} ms after ready)`,
      );
    }
  }

  /** Forget the current page's labels, `progress: 1` and any hold (a reload, a new document, a crash). */
  private resetHold() {
    this.labelled = false;
    this.playable = false;
    this.holding = false;
    this.clearRevealTimeout();
  }

  private armRevealTimeout() {
    this.clearRevealTimeout();
    const ms = this.opts.revealTimeoutMs ?? REVEAL_TIMEOUT_MS;
    this.revealTimer = setTimeout(() => {
      this.revealTimer = null;
      if (!this.holding) return;
      this.warn(
        `[game-host] ${this.opts.game.id}@${this.opts.game.version} sent loading labels but no ui.loading progress 1 within ${Math.round(ms / 1000)}s of ready(); showing the game anyway`,
      );
      this.reveal();
    }, ms);
  }

  private clearRevealTimeout() {
    if (this.revealTimer !== null) clearTimeout(this.revealTimer);
    this.revealTimer = null;
  }

  private clearLeaveTimeout() {
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }

  private armReadyTimeout() {
    this.clearReadyTimeout();
    const ms = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.view.phase !== 'loading' || this.holding) return;
      const seen = this.seenMethods.length
        ? `received: ${[...new Set(this.seenMethods)].join(', ')}`
        : 'no messages from the game';
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
