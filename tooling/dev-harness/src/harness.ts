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
import {
  createHarnessHandlers,
  joinTargetHref,
  launchIntentFor,
  localRejoinJournal,
  localSaveStore,
  parseJoinTarget,
} from './handlers.ts';
import { HostBridge } from './host-bridge.ts';
import { listRooms, toHttpUrl } from './matchmake.ts';
import { Panel, type LogLevel } from './panel.ts';
import { localProgressStore } from './progress.ts';

/** Same as the shell's GameHost: how long the game may take to call ready(). */
const READY_TIMEOUT_MS = 20_000;
const TAG = '[rally-harness]';
/** Display name chosen in the panel (all games share it: it is "who is at this browser"). */
const NAME_KEY = 'rally-harness:name';

function storedName(): string | null {
  try {
    return window.localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

/**
 * A phone opening the dev server at http://<pc-ip>:5182 must not matchmake against its own localhost: when the
 * configured URL is a localhost one and the page is not, use the page's host (same port as configured).
 */
function lanDefault(url: string): string {
  try {
    const u = new URL(url);
    const local = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    if (local(u.hostname) && location.hostname && !local(location.hostname)) u.hostname = location.hostname;
    return u.toString();
  } catch {
    return url;
  }
}

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
  const colyseusUrl = toHttpUrl(params.get('colyseus') || lanDefault(cfg.colyseusUrl));
  const saves = localSaveStore(cfg.game.id);
  const progress = localProgressStore(cfg.game.id);
  // Older plugin builds may inline a config without these fields.
  const leaderboards = cfg.leaderboards ?? [];
  const achievements = cfg.achievements ?? [];

  // Who is at this browser: ?name= (or the older ?user=), else the name set in the panel, else the plugin config.
  const nameParam = (params.get('name') ?? params.get('user'))?.trim().slice(0, 20) || null;
  const chosenName = nameParam || storedName()?.trim().slice(0, 20) || null;
  const user = chosenName
    ? { id: `dev-${chosenName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`, username: chosenName, avatarUrl: null }
    : (cfg.launch.user ?? { id: 'dev-user', username: 'dev', avatarUrl: null });

  // Rejoin journal (session.reportReconnection → ?resume), per game and player like the shell's rally.rejoin.<userId>.
  const rejoin = localRejoinJournal(cfg.game.id, user.id);
  const stored = rejoin.get();
  const roomName = cfg.room;
  /**
   * `?hold`: leaving the page (refresh, close, navigation) drops the socket WITHOUT consent, so the server holds the
   * seat for its reconnection grace, as when a phone loses the network (rejoin testing with `?resume`). Without it the
   * game is asked to leave with consent first (see the `pagehide` handler), so a refresh does not leave a ghost seat.
   */
  let holdSeatOnUnload = params.has('hold');
  /** Room of the last successful session.join (highlighted in the panel's room list). */
  let joinedRoomId: string | null = null;

  const panel = new Panel({
    hostOn,
    visible: cfg.panel,
    name: user.username,
    listRooms: roomName && hostOn ? () => listRooms(colyseusUrl, roomName) : undefined,
    currentRoomId: () => joinedRoomId,
    onJoinRoom: (row) => {
      location.href = joinTargetHref(location.href, {
        kind: 'room',
        roomId: row.roomId,
        ...(row.code ? { code: row.code } : {}),
      });
    },
    rejoin:
      roomName && hostOn
        ? {
            current: () => rejoin.get(),
            onRejoin: () => {
              // This reload must keep the seat it is about to take back.
              holdSeatOnUnload = true;
              location.href = joinTargetHref(location.href, { kind: 'stored' });
            },
          }
        : undefined,
    onSetName: cfg.room
      ? (name) => {
          try {
            window.localStorage.setItem(NAME_KEY, name);
          } catch {
            /* storage blocked: the ?name= parameter below still applies */
          }
          const url = new URL(location.href);
          url.searchParams.delete('user');
          url.searchParams.set('name', name);
          location.href = url.toString();
        }
      : undefined,
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
  const baseIntent = intentParam.success ? intentParam.data : (cfg.launch.intent ?? 'quick');
  const join = parseJoinTarget(params, { intent: baseIntent, stored });
  const intent = launchIntentFor(join, baseIntent, stored);
  // The game learns it is resuming from the launch context (`resume.reconnectionToken`, the SDK's format).
  const resume = join.kind === 'resume' ? { reconnectionToken: `${join.roomId}:${join.token}` } : cfg.launch.resume;
  if (join.kind === 'invalid') log(join.reason, 'warn');

  const buildLaunchContext = (): LaunchContext => ({
    game: cfg.game,
    user,
    intent,
    ...(cfg.launch.party ? { party: cfg.launch.party } : {}),
    ...(resume ? { resume } : {}),
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
    deliver: (json, now) => (now ? window.__rally?.recv(json) : setTimeout(() => window.__rally?.recv(json), 0)),
    handlers: createHarnessHandlers({
      buildLaunchContext,
      colyseusUrl,
      room: cfg.room,
      join,
      rejoin,
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
      onJoined: ({ roomId, sessionId, kind }) => {
        joinedRoomId = typeof roomId === 'string' ? roomId : null;
        panel.setStatus(`in room ${String(roomId)}`);
        panel.refreshRooms();
        log(
          `${kind === 'resume' ? 'reconnected to' : 'matchmade'} ${cfg.room} via ${colyseusUrl} (${kind}, as "${user.username}") → room ${String(roomId)}, session ${String(sessionId)}`,
          'ok',
        );
      },
      onReconnection: ({ roomId, ttlSec, stored: kept, note }) =>
        kept
          ? log(`reconnection token stored for room ${roomId} (${ttlSec} s): reload with ?resume to rejoin`)
          : log(`reconnection token for room ${roomId} ignored: ${note ?? 'unknown reason'}`, 'warn'),
      onScore: ({ boardId, score, accepted, best, note }) =>
        log(
          `score ${score} on "${boardId}": ${accepted ? 'new best' : note ? `rejected, ${note}` : 'not a new best'} (best ${best ?? '—'})`,
          accepted ? 'ok' : note ? 'warn' : 'info',
        ),
      onUnlock: ({ key, title, alreadyHad }) =>
        log(
          `achievement "${title}" (${key}) ${alreadyHad ? 'already unlocked' : 'unlocked'}`,
          alreadyHad ? 'info' : 'ok',
        ),
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
      } else if (ev.method === 'menu.players') {
        log(`menu.players: ${ev.params.players.map((p) => p.name).join(', ')}`, 'info');
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

  // Leaving the page (refresh, close, navigation). By default the game leaves its room with consent, through the
  // same `exitRequested` path as the panel button, delivered synchronously (no timer runs after pagehide); the SDK's
  // consented leave sends its message on the socket at once, so the server frees the seat instead of holding it for
  // the 60 s grace (which showed every refresh as one more player in the room list). The rejoin record is cleared:
  // that seat is gone. With `?hold` (or the panel's "reload with ?resume") the socket just drops: the server's grace
  // starts now, so the record's expiry does too (§4).
  window.addEventListener('pagehide', () => {
    if (holdSeatOnUnload || joinedRoomId === null || bridge.isClosed) {
      rejoin.restamp();
      return;
    }
    bridge.sendEvent('exitRequested', {}, { now: true });
    rejoin.clear();
  });

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
