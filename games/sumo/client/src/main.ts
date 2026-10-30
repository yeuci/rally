import {
  SnapshotBuffer,
  applySafeAreaVars,
  createApp,
  createAudio,
  createFrameMetrics,
  createLifecycle,
  jsHeapMb,
  round,
  safeArea,
} from '@rally/game-kit';
import { rally } from '@rally/sdk';
import { ClientMessage, type FxEvent } from '@rally/game-sumo-server';
import { createControls } from './controls.ts';
import { createHud } from './hud.ts';
import { connect, type Net } from './net.ts';
import { Predictor, shouldPredict } from './predict.ts';
import { createSumoScene } from './scene.ts';

const TELEMETRY_MS = 10_000;
/** Reconnection grace the room grants (RallyRoom.reconnectSeconds); reported to the host for "Rejoin match?". */
const RECONNECT_TTL_SEC = 30;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  stick: $('stick'),
  exit: $<HTMLButtonElement>('exit'),
  paused: $('paused'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
};
const params = new URLSearchParams(location.search);
/** `?predict=0` renders your own puck interpolated like everyone else's (to compare). */
const PREDICT = params.get('predict') !== '0';

function loading(progress: number) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (rally.isHosted) void rally.ui.loading(progress).catch(() => {});
}

const bootStart = performance.now();
loading(0.05);

// --- engine, scene, HUD, input -----------------------------------------------------------------------
const { app, onResize } = createApp({ canvas: ui.canvas });
const scene = createSumoScene(app, (fn) => onResize(fn));
const hud = createHud();
const controls = createControls(ui.canvas, ui.stick);
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());
loading(0.5);

// --- netcode state -------------------------------------------------------------------------------------
let net: Net | null = null;
/** Matchmaking + socket join in flight (exit must wait for it, then leave, or the seat is held as a ghost). */
let joining: Promise<Net> | null = null;
let me = '';
let readyMs = -1;
let exiting = false;
/** Other players are drawn 100 ms in the past, interpolated between server patches (20 Hz). */
const remote = new SnapshotBuffer({ fields: ['x', 'y'] as const, delayMs: 100 });
/** Our own puck is predicted (see predict.ts for exactly what is and is not). */
const predictor = new Predictor();
const wasAlive = new Map<string, boolean>();
const labels = new Map<string, HTMLElement>();
let lastPhase = '';
let lastRound = -1;
let lastCountdown = -1;

/**
 * Stop our puck on the server now. The frame loop only sends sticks while frames run; a paused or backgrounded
 * WebView gets none, and the server would keep applying the last held stick until the socket times out.
 */
function releaseInput() {
  const now = performance.now();
  const sent = net?.releaseStick(now);
  if (sent) predictor.recordStick(now, sent);
}

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    controls.enabled = false;
    releaseInput();
    audio.suspend();
  },
  onResume: () => {
    ui.paused.hidden = true;
    controls.enabled = true;
    audio.resume();
    metrics.reset();
  },
  onExitRequested: async () => {
    exiting = true;
    controls.enabled = false;
    releaseInput();
    // Consented leave: the seat is freed at once instead of being held for the reconnection grace. A join still in
    // flight is awaited first (bounded by the lifecycle's exit timeout; boot() also leaves if it lands later).
    const joined = net ?? (await joining?.catch(() => null));
    await joined?.leave().catch(() => {});
    if (!rally.isHosted) hud.setMessage('You left the game', 'Reload to play again');
  },
  onLowMemory: () => {
    scene.trim();
    audio.close();
  },
});
ui.exit.addEventListener('click', () => void lifecycle.exit('button'));
// Hosted games are not paused on visibility (the shell sends `pause`), but the stick must still stop when the
// page is hidden or loses focus; the next frame sends whatever is held again.
const stopInput = () => {
  controls.release();
  releaseInput();
};
window.addEventListener('blur', stopInput);
window.addEventListener('pagehide', stopInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopInput();
});

// --- server events → sound, shake, flashes -------------------------------------------------------------
function onFx(fx: FxEvent[]) {
  for (const e of fx) {
    if (e.k === 'hit') {
      const mine = e.a === me || e.b === me;
      scene.flash(e.x, e.y, e.i);
      if (mine) scene.shake(0.08 + Math.min(e.i, 14) * 0.03);
      audio.blip(110 + Math.min(e.i, 14) * 22, 90, { type: 'triangle', gain: mine ? 0.55 : 0.25, slideTo: 60 });
    } else if (e.k === 'out') {
      const mine = e.id === me;
      if (mine) scene.shake(0.45);
      audio.blip(520, 520, { type: 'sawtooth', slideTo: 70, gain: mine ? 0.3 : 0.14 });
      if (e.by === me) audio.blip(784, 120, { gain: 0.35, delayMs: 120 });
    } else if (e.k === 'round' && e.winner === me) {
      [0, 4, 7].forEach((st, i) => audio.blip(523.25 * 2 ** (st / 12), 150, { gain: 0.35, delayMs: i * 90 }));
    } else if (e.k === 'match' && e.winner === me) {
      [0, 4, 7, 12].forEach((st, i) => audio.blip(523.25 * 2 ** (st / 12), 200, { gain: 0.4, delayMs: 500 + i * 110 }));
    }
  }
}

/** Every state patch: feed the interpolation buffer and rebase the prediction. */
function onPatch(t: number) {
  if (!net) return;
  const st = net.state;
  if (!st?.players) return;
  if (st.round !== lastRound) {
    // New round: everyone teleported to a spawn point; do not interpolate across that.
    remote.clear();
    lastRound = st.round;
  }
  const entries: [string, { x: number; y: number }][] = [];
  st.players.forEach((p, id) => entries.push([id, { x: p.x, y: p.y }]));
  remote.push(t, entries);
  const mine = st.players.get(me);
  predictor.rttMs = net.rttMs ?? 0;
  if (mine?.alive) predictor.rebase({ x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy }, t);
  else predictor.reset();
}

const anchor = { x: 0, y: 0 };
function frame(dt: number) {
  scene.update(dt);
  if (!net) return;
  const now = performance.now();
  const st = net.state;
  // The first full state can land a frame or two after the seat is consumed.
  if (!st?.players) return;

  // Input: the stick goes to the server (≤ 20 Hz, on change) and the same value into the predictor's history.
  const sent = net.offerStick(lifecycle.isPaused || exiting ? { x: 0, y: 0 } : controls.stick, now);
  if (sent) predictor.recordStick(now, sent);
  if (controls.used) hud.hideHint();

  // Phase cues.
  if (st.phase !== lastPhase) {
    if (st.phase === 'playing' && lastPhase === 'countdown') {
      hud.flashTitle('GO!', 650);
      audio.blip(880, 220, { gain: 0.4 });
    }
    lastPhase = st.phase;
    lastCountdown = -1;
  }
  if (st.phase === 'countdown') {
    const n = Math.ceil(st.timer);
    if (n !== lastCountdown && n > 0) audio.blip(440, 110, { gain: 0.3 });
    lastCountdown = n;
  }

  scene.setRadius(st.radius);
  const seen = new Set<string>();
  const predicting = PREDICT && shouldPredict(st.phase);
  st.players.forEach((p, id) => {
    seen.add(id);
    const mine = id === me;
    const pos = (mine && predicting && p.alive ? predictor.sample(now) : null) ??
      remote.sample(id, now) ?? { x: p.x, y: p.y };
    if (wasAlive.get(id) && !p.alive) scene.fall(id, p.vx, p.vy);
    wasAlive.set(id, p.alive);
    scene.setPuck(id, { x: pos.x, y: pos.y, color: p.color, me: mine, visible: p.alive });

    let label = labels.get(id);
    if (!label) {
      label = document.createElement('div');
      label.className = 'label';
      ui.labels.appendChild(label);
      labels.set(id, label);
    }
    label.classList.toggle('me', mine);
    if (label.textContent !== p.name) label.textContent = p.name;
    if (scene.labelAnchor(id, anchor)) {
      label.style.opacity = '1';
      label.style.transform = `translate(${anchor.x}px, ${anchor.y}px) translate(-50%, -100%)`;
    } else {
      label.style.opacity = '0';
    }
  });
  for (const id of [...wasAlive.keys()]) {
    if (seen.has(id)) continue;
    wasAlive.delete(id);
    scene.removePuck(id);
    labels.get(id)?.remove();
    labels.delete(id);
  }
  hud.render(st, me, net.rttMs);
}
app.on('update', (dt: number) => frame(dt));

// --- telemetry -------------------------------------------------------------------------------------------
function collect() {
  const f = metrics.snapshot();
  const gd = app.graphicsDevice;
  return {
    fps: f.fps,
    frameMs: f.frameMs,
    p95Ms: f.p95Ms,
    worstMs: f.worstMs,
    wsRttMs: net?.rttMs ?? -1,
    players: net?.state?.players?.size ?? 0,
    phase: net?.state.phase ?? 'none',
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    readyMs,
    heapMb: jsHeapMb() ?? -1,
  };
}
setInterval(() => rally.telemetry.report('sumo', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------------
function reportReconnection() {
  if (!rally.isHosted || !net) return;
  void rally.session
    .reportReconnection({ roomId: net.room.roomId, token: net.room.reconnectionToken, ttlSec: RECONNECT_TTL_SEC })
    .catch(() => {});
}

function toWs(url: string) {
  return url.replace(/^http/, 'ws').replace(/\/+$/, '');
}

async function boot() {
  app.start();
  loading(0.8);
  // First frame before ready(), so the host drops its overlay onto a rendered arena (bounded for hidden pages).
  await new Promise<void>((resolve) => {
    app.once('frameend', () => resolve());
    setTimeout(resolve, 1000);
  });
  let username = params.get('name') ?? 'player';
  if (rally.isHosted) {
    const ctx = await rally.ready();
    applySafeAreaVars(safeArea(ctx.device.safeArea));
    username = ctx.user.username;
  } else {
    applySafeAreaVars(safeArea());
  }
  readyMs = Math.round(performance.now() - bootStart);
  loading(1);
  ui.loading.hidden = true;

  if (exiting) return; // exit requested while loading: never take a seat
  hud.setMessage('Joining…');
  joining = (async () => {
    if (rally.isHosted) {
      // The host matchmakes (with the player's Supabase token) and hands over a seat; the socket is ours.
      const { endpoint, seatReservation } = await rally.session.join();
      return connect(endpoint, { seatReservation });
    }
    const endpoint = toWs(params.get('colyseus') ?? `ws://${location.hostname || 'localhost'}:2567`);
    return connect(endpoint, {
      roomName: 'sumo',
      options: { username, ...(params.has('private') ? { private: true } : {}) },
    });
  })();
  let joined: Net;
  try {
    joined = await joining;
  } catch (err) {
    if (exiting) return;
    hud.setMessage("Couldn't join", err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (exiting) {
    // Exit was requested while the join was in flight: give the seat back now instead of leaving a ghost player
    // (held for the reconnection grace once the page goes away, or forever while it stays open).
    await joined.leave().catch(() => {});
    return;
  }
  net = joined;
  me = net.sessionId;
  hud.setMessage(null);
  // Guests (no Supabase session, e.g. the dev harness) show the launch-context name; the server ignores this
  // for signed-in players, whose name comes from their verified token.
  net.room.send(ClientMessage.profile, { username });
  net.onPatch(onPatch);
  net.onFx(onFx);
  reportReconnection();
  net.room.onDrop(() => hud.setMessage('Connection lost', 'Reconnecting…'));
  net.room.onReconnect(() => {
    hud.setMessage(null);
    reportReconnection();
  });
  net.room.onLeave((code) => {
    if (!exiting) hud.setMessage('Disconnected', `The server closed the connection (${code}).`);
  });
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
});

// Dev-only probe for the Playwright e2e (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __sumo: unknown }).__sumo = {
    get joined() {
      return net !== null;
    },
    get me() {
      return me;
    },
    get phase() {
      return net?.state.phase ?? null;
    },
    get round() {
      return net?.state.round ?? 0;
    },
    get code() {
      return net?.state.code ?? '';
    },
    get roomId() {
      return net?.room.roomId ?? '';
    },
    get rtt() {
      return net?.rttMs ?? null;
    },
    get stick() {
      return controls.stick;
    },
    names() {
      const out: string[] = [];
      net?.state?.players?.forEach((p) => out.push(p.name));
      return out.sort();
    },
    position(name: string) {
      let found: { x: number; y: number; alive: boolean } | null = null;
      net?.state?.players?.forEach((p) => {
        if (p.name === name) found = { x: p.x, y: p.y, alive: p.alive };
      });
      return found;
    },
  };
}
