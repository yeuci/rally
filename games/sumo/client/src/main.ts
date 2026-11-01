import {
  RenderClock,
  SnapshotBuffer,
  applySafeAreaVars,
  bindSettings,
  createApp,
  createAudio,
  createBootProgress,
  createFrameMetrics,
  createLifecycle,
  createNetStatus,
  effectsVolume,
  graphicsPreset,
  jsHeapMb,
  matchmakingLabel,
  rememberGraphics,
  rememberedGraphics,
  round,
  safeArea,
  stickLook,
} from '@rally/game-kit';
import { rally, type MenuPlayer, type PlayerSettings } from '@rally/sdk';
import { ClientMessage, DT, PATCH_MS, type FxEvent } from '@rally/game-sumo-server';
import { createControls } from './controls.ts';
import { createHud } from './hud.ts';
import { applyLowFx } from './lowfx.ts';
import { connect, type Net } from './net.ts';
import { Predictor, shouldPredict } from './predict.ts';
import { MatchResultView } from './result.ts';
import { createSumoScene } from './scene.ts';

const TELEMETRY_MS = 10_000;
/** Reconnection grace the room grants (RallyRoom.reconnectSeconds); reported to the host for "Rejoin match?". */
const RECONNECT_TTL_SEC = 60;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  stick: $('stick'),
  exit: $<HTMLButtonElement>('exit'),
  paused: $('paused'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
  loadingLabel: $('loading-label'),
  loadingDetail: $('loading-detail'),
};
const params = new URLSearchParams(location.search);
/** `?predict=0` renders your own puck interpolated like everyone else's (to compare). */
const PREDICT = params.get('predict') !== '0';
/** Dev only: `?art=icon|cover|countdown|match|result` stages a frozen scene for the store art (src/art.ts). */
const ART = import.meta.env.DEV ? params.get('art') : null;
/**
 * Dev only: `?lowfx=1` draws at most 15 fps at DPR 1, without clustered lighting, MSAA, shadows or hit effects
 * (src/lowfx.ts). The Playwright e2e opens every page with it: several software-rendered WebGL pages share a 2-vCPU
 * CI runner.
 */
const LOWFX = import.meta.env.DEV && !ART && params.has('lowfx') && params.get('lowfx') !== '0';

/**
 * Boot progress through the join, in the host's loading screen (labelled, so it stays up until `done()`: the player
 * lands in a joined match) and in the page's own veil (standalone / dev), with the same words in both.
 */
const loader = createBootProgress({
  host: rally,
  veil: { root: ui.loading, bar: ui.loadingBar, label: ui.loadingLabel, detail: ui.loadingDetail },
  stages: [
    { id: 'start', label: 'Starting the game', weight: 1 },
    { id: 'arena', label: 'Building the arena', weight: 2 },
    { id: 'match', label: 'Finding players', weight: 3 },
    { id: 'join', label: 'Joining the match', weight: 2 },
  ],
});

const bootStart = performance.now();

// --- engine, scene, HUD, input -----------------------------------------------------------------------
// The art capture renders at up to 3× device pixels (store screenshots); the game itself keeps the cap of 2.
/**
 * The host's game menu sets the graphics quality (DPR, shadows, effects: live). MSAA and clustered lighting are fixed
 * at boot, from the quality chosen last time. `?lowfx` (e2e) and `?art` keep their own settings.
 */
const FIXED_GRAPHICS = LOWFX || !!ART;
const bootGraphics = graphicsPreset(rememberedGraphics());
const { app, onResize, setMaxPixelRatio } = createApp({
  canvas: ui.canvas,
  antialias: bootGraphics.antialias,
  maxPixelRatio: bootGraphics.maxPixelRatio,
  ...(ART ? { maxPixelRatio: 3, antialias: true } : {}),
  ...(LOWFX ? { maxPixelRatio: 1, antialias: false } : {}),
});
if (LOWFX) applyLowFx(app);
else if (!FIXED_GRAPHICS && !bootGraphics.clusteredLighting) app.scene.clusteredLightingEnabled = false;
loader.stage('arena');
const scene = createSumoScene(
  app,
  (fn) => onResize(fn),
  LOWFX
    ? { shadows: false, effects: false }
    : ART
      ? {}
      : { shadows: bootGraphics.shadows, effects: bootGraphics.effects },
);
const hud = createHud();
const controls = createControls(ui.canvas, ui.stick);
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());
loader.progress(0.5);

// --- netcode state -------------------------------------------------------------------------------------
let net: Net | null = null;
/** Matchmaking + socket join in flight (exit must wait for it, then leave, or the seat is held as a ghost). */
let joining: Promise<Net> | null = null;
let me = '';
let readyMs = -1;
let exiting = false;
/**
 * Other players: every patch is one snapshot on the SERVER's timeline (`tick` × DT, not its arrival time), drawn
 * 2–3 patch intervals behind the estimated server time (Hermite curves through positions and velocities; at most
 * one interval of extrapolation if patches stop, then held). See game-kit netclock.ts.
 */
const clock = new RenderClock({ intervalMs: PATCH_MS });
const remote = new SnapshotBuffer({
  fields: ['x', 'y', 'vx', 'vy'] as const,
  rates: { x: 'vx', y: 'vy' },
  extrapolateMs: PATCH_MS,
});
/** Our own puck is predicted (see predict.ts for exactly what is and is not). */
const predictor = new Predictor();
/** Our `result` message for the match-over banner. */
const results = new MatchResultView();
let lastResult: unknown = null;
const wasAlive = new Map<string, boolean>();
const labels = new Map<string, HTMLElement>();
let lastPhase = '';
let lastRound = -1;
let lastCountdown = -1;
/** Dev only (e2e / jitter measurement): the rendered position of one player, every frame. */
let trace: { name: string; samples: { t: number; x: number; y: number }[] } | null = null;

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
    netStatus.stop();
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
  // The host's game menu: the match keeps running underneath, but nothing we hold keeps pushing.
  onMenu: (open) => {
    controls.enabled = !open;
    if (open) releaseInput();
  },
});
ui.exit.addEventListener('click', () => void lifecycle.exit('button'));
// In the shell, Leave is in the host's game menu (its button sits where ours was): ours stays for a plain browser.
ui.exit.hidden = rally.isHosted;

// --- the host's game menu: how to play, our settings, the player's settings, players and connection --------
const MENU = {
  settings: [
    { type: 'toggle' as const, key: 'showNames', label: 'Names over pucks', default: true },
    { type: 'toggle' as const, key: 'screenShake', label: 'Screen shake', default: true },
  ],
  help: [
    { title: 'Push', text: 'Drag anywhere to push your puck. The farther you drag, the harder you push.' },
    {
      title: 'Knock them off',
      text: 'Bump the other pucks over the edge. The last puck on the platform wins the round.',
    },
    { title: 'The ring shrinks', text: 'The platform gets smaller as the round goes on, so nobody can hide for long.' },
    { title: 'First to three', text: 'Win three rounds to win the match. Wins go on the leaderboard.' },
    { title: 'Keyboard', text: 'On a computer, use WASD or the arrow keys. Escape opens this menu.' },
  ],
};

function applySettings(s: PlayerSettings) {
  audio.volume = effectsVolume(s);
  controls.configure(stickLook(s.controls));
  ui.labels.hidden = s.game.showNames === false;
  const g = graphicsPreset(s.graphics);
  if (!FIXED_GRAPHICS) {
    setMaxPixelRatio(g.maxPixelRatio);
    if (rally.isHosted) rememberGraphics(s.graphics);
  }
  scene.setQuality({
    shadows: FIXED_GRAPHICS ? !LOWFX : g.shadows,
    effects: FIXED_GRAPHICS ? !LOWFX : g.effects,
    shake: s.game.screenShake !== false,
  });
}
const settings = bindSettings(rally, applySettings);
/** Connection for the host's ping bars and its Reconnecting / Connection lost banner. */
const netStatus = createNetStatus(rally, { rtt: () => net?.rttMs ?? null });
let playersKey = '';
/** Who is in the match, for the menu's People list: on join and whenever the roster or a score changes. */
function reportPlayers() {
  if (!net?.state?.players || !rally.isHosted) return;
  const players: MenuPlayer[] = [];
  net.state.players.forEach((p, id) =>
    players.push({
      name: p.name.slice(0, 32) || 'Player',
      detail: `${p.score} ${p.score === 1 ? 'round' : 'rounds'}`,
      ...(id === me ? { you: true } : {}),
    }),
  );
  players.sort((a, b) => Number(!!b.you) - Number(!!a.you) || a.name.localeCompare(b.name));
  const key = JSON.stringify(players);
  if (key === playersKey) return;
  playersKey = key;
  rally.menu.players(players.slice(0, 16));
}
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

/**
 * Every state patch (`onStateChange`: once per patch, after the whole patch is decoded, so all pucks and the tick
 * are from the same server step): feed the interpolation buffer and rebase the prediction.
 */
function onPatch(t: number) {
  if (!net) return;
  const st = net.state;
  if (!st?.players) return;
  if (st.round !== lastRound) {
    // New round: everyone teleported to a spawn point; do not interpolate across that.
    remote.clear();
    lastRound = st.round;
  }
  const serverMs = st.tick * DT * 1000;
  clock.observe(serverMs, t);
  const entries: [string, { x: number; y: number; vx: number; vy: number }][] = [];
  st.players.forEach((p, id) => entries.push([id, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }]));
  remote.push(serverMs, entries);
  reportPlayers();
  const mine = st.players.get(me);
  predictor.rttMs = net.rttMs ?? 0;
  // The snapshot's content time on the local clock (when that tick's data is expected to arrive), not its arrival
  // time: a patch carries 1 or 2 ticks and arrives in bursts, which would otherwise show up as a correction.
  if (mine?.alive)
    predictor.rebase({ x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy }, clock.server.toLocal(serverMs), t);
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
  const renderAt = clock.renderTime(now);
  st.players.forEach((p, id) => {
    seen.add(id);
    const mine = id === me;
    const pos = (mine && predicting && p.alive ? predictor.sample(now) : null) ??
      (renderAt === null ? null : remote.sampleAt(id, renderAt)) ?? { x: p.x, y: p.y };
    if (wasAlive.get(id) && !p.alive) scene.fall(id, p.vx, p.vy);
    wasAlive.set(id, p.alive);
    scene.setPuck(id, { x: pos.x, y: pos.y, color: p.color, me: mine, visible: p.alive });
    if (import.meta.env.DEV && trace?.name === p.name) trace.samples.push({ t: now, x: pos.x, y: pos.y });

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
  results.observe(st.phase, st.matchWinner, now);
  hud.render(st, me, net.rttMs, results.current());
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
  // First frame before ready(), so the arena is drawn under the host's screen (bounded for hidden pages).
  await new Promise<void>((resolve) => {
    app.once('frameend', () => resolve());
    setTimeout(resolve, 1000);
  });
  loader.progress(1);
  let username = params.get('name') ?? 'player';
  if (rally.isHosted) {
    const ctx = await rally.ready();
    applySafeAreaVars(safeArea(ctx.device.safeArea));
    username = ctx.user.username;
    // The host's menu button sits top-left: keep our HUD out of it.
    const b = ctx.device.menuButton;
    if (b) document.documentElement.style.setProperty('--rally-menu-inset', `${b.x + b.width + 8}px`);
    settings.refresh();
    void rally.menu.define(MENU).then(
      () => settings.refresh(),
      (err: unknown) => console.warn('[sumo] menu.define failed', err),
    );
  } else {
    applySafeAreaVars(safeArea());
  }
  readyMs = Math.round(performance.now() - bootStart);

  if (exiting) return; // exit requested while loading: never take a seat
  hud.setMessage('Joining…');
  joining = (async () => {
    if (import.meta.env.DEV && ART) {
      const art = await import('./art.ts');
      if (!art.isArtShot(ART)) throw new Error(`?art=${ART}: expected one of ${art.ART_SHOTS.join(', ')}`);
      return art.stageArt(ART, { app, scene, hud });
    }
    if (rally.isHosted) {
      // The host matchmakes (with the player's Supabase token) and hands over a seat; the socket is ours.
      loader.stage('match', matchmakingLabel(rally.context));
      const { endpoint, seatReservation } = await rally.session.join();
      loader.stage('join');
      return connect(endpoint, { seatReservation });
    }
    loader.stage('match', 'Connecting to the server');
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
    // Our own error UI is up: the host shows the game now.
    loader.done();
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
  net.onResult((r) => {
    lastResult = r;
    results.receive(r, performance.now());
  });
  reportReconnection();
  // The connection: in the shell its banner says Reconnecting / Connection lost; in a plain browser our HUD does.
  netStatus.set('connected');
  reportPlayers();
  net.room.onDrop(() => {
    netStatus.set('reconnecting');
    if (!rally.isHosted) hud.setMessage('Connection lost', 'Reconnecting…');
  });
  net.room.onReconnect(() => {
    netStatus.set('connected');
    if (!rally.isHosted) hud.setMessage(null);
    reportReconnection();
  });
  net.room.onLeave((code) => {
    if (exiting) return;
    netStatus.set('disconnected');
    if (!rally.isHosted) hud.setMessage('Disconnected', `The server closed the connection (${code}).`);
  });
  // In the match: playable. The host drops its loading screen, the veil goes.
  loader.done();
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  loader.done();
});

// Dev-only probe for the Playwright e2e (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __sumo: unknown }).__sumo = {
    get joined() {
      return net !== null;
    },
    /** `?lowfx=1` is in effect (capped, plain rendering). */
    get lowfx() {
      return LOWFX;
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
    get sessionId() {
      return net?.sessionId ?? '';
    },
    /** `<roomId>:<token>` for the harness' `?resume=`. */
    get reconnectionToken() {
      return net?.room.reconnectionToken ?? '';
    },
    /** The last `result` message received (any match). */
    get result() {
      return lastResult;
    },
    /** Whether the player shown as `name` is connected (false inside their reconnection grace); null if absent. */
    connectedOf(name: string) {
      const found: boolean[] = [];
      net?.state?.players?.forEach((p) => {
        if (p.name === name) found.push(p.connected);
      });
      return found.length ? found[0] : null;
    },
    /** The match-over line on screen, if any. */
    get resultLine() {
      const el = document.querySelector<HTMLElement>('[data-role="result"]');
      return el ? { kind: el.dataset.kind ?? '', text: el.textContent ?? '' } : null;
    },
    get rtt() {
      return net?.rttMs ?? null;
    },
    /** What the game applied from the host's game menu (e2e). */
    get applied() {
      return {
        volume: audio.volume,
        dpr: app.graphicsDevice.maxPixelRatio,
        namesHidden: ui.labels.hidden,
        settings: rally.settings,
        net: netStatus.state,
      };
    },
    get stick() {
      return controls.stick;
    },
    names() {
      const out: string[] = [];
      net?.state?.players?.forEach((p) => out.push(p.name));
      return out.sort();
    },
    /** Start recording where the puck of the player shown as `name` is drawn, every frame. */
    traceStart(name: string) {
      trace = { name, samples: [] };
    },
    /** Stop recording; returns `{ t, x, y }` per frame (t = performance.now() of the frame). */
    traceStop() {
      const out = trace?.samples ?? [];
      trace = null;
      return out;
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
