/**
 * The fake Rally host. Built as a self-contained IIFE (dist/harness.iife.js) and inlined by the Vite plugin
 * at the very top of <head>, so — like the shell's `injectedJavaScriptBeforeContentLoaded` — it runs before
 * any game script. It installs exactly what the shell installs:
 *
 *   window.__rally = { nonce, version, queue, recv }      (apps/mobile/src/game-host/injected.ts)
 *   window.ReactNativeWebView = { postMessage }           (react-native-webview)
 *
 * and answers on the other side with a port of the shell's HostBridge dispatcher.
 */
import {
  LaunchIntent,
  PROTOCOL_VERSION,
  type HostEvent,
  type HostEventPayload,
  type LaunchContext,
} from '@rally/protocol';
import type { HarnessConfig } from './config.ts';
import { createHarnessHandlers, localSaveStore } from './handlers.ts';
import { HostBridge } from './host-bridge.ts';
import { toHttpUrl } from './matchmake.ts';
import { Panel, type LogLevel } from './panel.ts';
import { localProgressStore } from './progress.ts';

/** Same as the shell's GameHost: how long the game may take to call ready(). */
const READY_TIMEOUT_MS = 20_000;
const TAG = '[rally-harness]';

interface InstalledHost {
  nonce: string;
  version: number;
  queue?: string[];
  recv: (json: string) => void;
}

declare global {
  interface Window {
    __rally?: InstalledHost;
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

const DEFAULT_CONFIG: HarnessConfig = {
  game: { id: 'dev-game', version: '0.0.0' },
  room: null,
  leaderboards: [],
  achievements: [],
  colyseusUrl: 'http://localhost:2567',
  launch: {},
  panel: true,
};

function main(): void {
  const cfg = window.__RALLY_HARNESS_CONFIG__ ?? DEFAULT_CONFIG;
  const params = new URLSearchParams(location.search);
  const hostOn = !params.has('nohost');
  const colyseusUrl = toHttpUrl(params.get('colyseus') || cfg.colyseusUrl);
  const saves = localSaveStore(cfg.game.id);
  const progress = localProgressStore(cfg.game.id);
  // Older plugin builds may inline a config without these fields.
  const leaderboards = cfg.leaderboards ?? [];
  const achievements = cfg.achievements ?? [];

  const panel = new Panel({
    hostOn,
    visible: cfg.panel,
    onHostEvent: (e) => sendHostEvent(e),
    onToggleHost: () => {
      const url = new URL(location.href);
      if (hostOn) url.searchParams.set('nohost', '');
      else url.searchParams.delete('nohost');
      location.href = url.toString().replace(/([?&]nohost)=(?=&|$)/, '$1');
    },
    onClearSaves: () => {
      saves.clear();
      progress.clear();
      log('save slots, leaderboards and achievements cleared', 'warn');
    },
  });
  /** Panel line + console. Error *responses* are normal flow (CONFLICT, NOT_SUPPORTED), so they go to console.warn. */
  const log = (text: string, level: LogLevel = 'info', key?: string, consoleLevel: LogLevel = level) => {
    const fn = consoleLevel === 'error' ? console.error : consoleLevel === 'warn' ? console.warn : console.debug;
    if (!key) fn(TAG, text);
    panel.log(text, level, key);
  };

  if (!hostOn) {
    panel.setStatus('off: standalone (no window.__rally)');
    log('host disabled by ?nohost; the game runs its standalone path', 'warn');
    return;
  }
  if (window.__rally) {
    // Inside the real shell (a phone loading the dev server): stand down completely, including the panel.
    console.warn(TAG, 'window.__rally already exists (inside the real shell); harness not installed');
    panel.destroy();
    return;
  }

  // --- exactly what apps/mobile/src/game-host/injected.ts installs -----------------------------------
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const queue: string[] = [];
  window.__rally = {
    nonce,
    version: PROTOCOL_VERSION,
    queue,
    recv: (json: string) => {
      queue.push(json);
    },
  };
  // ----------------------------------------------------------------------------------------------------

  const startedAt = performance.now();
  let readyAt: number | null = null;
  const intentParam = LaunchIntent.safeParse(params.get('intent') ?? undefined);
  const userParam = params.get('user');
  const user = userParam
    ? { id: `dev-${userParam}`, username: userParam, avatarUrl: null }
    : (cfg.launch.user ?? { id: 'dev-user', username: 'dev', avatarUrl: null });

  const buildLaunchContext = (): LaunchContext => ({
    game: cfg.game,
    user,
    intent: intentParam.success ? intentParam.data : (cfg.launch.intent ?? 'quick'),
    ...(cfg.launch.party ? { party: cfg.launch.party } : {}),
    ...(cfg.launch.resume ? { resume: cfg.launch.resume } : {}),
    device: {
      safeArea: cfg.launch.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 },
      orientation: window.matchMedia?.('(orientation: portrait)').matches ? 'portrait' : 'landscape',
      pixelRatio: window.devicePixelRatio || 1,
      locale: navigator.language || 'en-US',
    },
  });

  const bridge = new HostBridge({
    nonce,
    bundleUrl: location.href,
    // The shell delivers with injectJavaScript, which never runs inside the game's postMessage call.
    deliver: (json) => setTimeout(() => window.__rally?.recv(json), 0),
    handlers: createHarnessHandlers({
      buildLaunchContext,
      colyseusUrl,
      room: cfg.room,
      saves,
      leaderboards,
      achievements,
      progress,
      user: { id: user.id, username: user.username },
      onReady: (ctx) => {
        readyAt = performance.now();
        panel.setLoading(1);
        panel.setStatus(`ready · ${ctx.user.username} · ${ctx.intent}`);
        log(
          `ready() after ${Math.round(readyAt - startedAt)} ms → launch context (${ctx.intent}, ${ctx.device.orientation}, dpr ${ctx.device.pixelRatio})`,
          'ok',
        );
      },
      onLoading: (p) => panel.setLoading(p),
      onExit: (reason) => {
        log(`exit("${reason}")`, 'warn');
        panel.setStatus(`exited (${reason})`);
        bridge.close();
        panel.showExit(reason);
      },
      onJoined: ({ roomId, sessionId }) => {
        panel.setStatus(`in room ${String(roomId)}`);
        log(`matchmade ${cfg.room} via ${colyseusUrl} → room ${String(roomId)}, session ${String(sessionId)}`, 'ok');
      },
      onReconnection: ({ roomId, ttlSec }) => log(`reconnection token stored for room ${roomId} (${ttlSec} s)`),
      onScore: ({ boardId, score, accepted, best, note }) =>
        log(
          `score ${score} on "${boardId}": ${accepted ? 'new best' : note ? `rejected, ${note}` : 'not a new best'} (best ${best ?? '—'})`,
          accepted ? 'ok' : note ? 'warn' : 'info',
        ),
      onUnlock: ({ key, title, alreadyHad }) =>
        log(`achievement "${title}" (${key}) ${alreadyHad ? 'already unlocked' : 'unlocked'}`, alreadyHad ? 'info' : 'ok'),
    }),
    onRequest: (env) => {
      if (env.method !== 'ping') log(`→ ${env.method}`, 'info');
    },
    onResponse: (env, ms) => {
      const took = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
      if (env.error)
        log(
          `← ${env.method} ${env.error.code}: ${env.error.message.replace(/\s+/g, ' ').slice(0, 240)}`,
          'error',
          undefined,
          'warn',
        );
      else if (env.method === 'ping') log(`← ping (${took})`, 'ok', 'ping');
      else log(`← ${env.method} ok (${took})`, 'ok');
    },
    onGameEvent: (ev) => {
      if (ev.method === 'telemetry.report') {
        console.debug(TAG, 'telemetry', ev.params.name, ev.params.values);
        log(`telemetry ${ev.params.name}`, 'info', 'telemetry');
      } else {
        console.error(TAG, 'game.error', ev.params.message, ev.params.stack ?? '');
        log(`game.error: ${ev.params.message}`, 'error');
      }
    },
    onDrop: (reason) => log(`dropped message: ${reason}`, 'warn'),
  });

  window.ReactNativeWebView = {
    // react-native-webview reports the page URL as nativeEvent.url; the bridge checks it against the bundle path.
    postMessage: (message: string) => bridge.handleMessage(String(message), location.href),
  };

  function sendHostEvent(event: HostEvent): void {
    if (bridge.isClosed) return;
    const payload =
      event === 'partyUpdated'
        ? ({
            id: 'dev-party',
            leaderId: user.id,
            memberIds: [user.id, 'dev-friend'],
          } satisfies HostEventPayload<'partyUpdated'>)
        : {};
    bridge.sendEvent(event, payload as HostEventPayload<typeof event>);
    log(`→ evt ${event}`, 'info');
  }

  setTimeout(() => {
    if (readyAt === null && !bridge.isClosed) {
      log(`no ready() after ${READY_TIMEOUT_MS / 1000} s; the shell would show its load-failure overlay`, 'error');
    }
  }, READY_TIMEOUT_MS);

  panel.setStatus(`on · ${cfg.game.id}@${cfg.game.version} · waiting for ready()`);
  log(
    `host installed (nonce ${nonce.slice(0, 6)}…, room ${cfg.room ?? 'none'}, boards ${leaderboards.map((b) => b.id).join(', ') || 'none'}, ` +
      `${achievements.length} achievement(s), colyseus ${colyseusUrl})`,
  );
}

main();
