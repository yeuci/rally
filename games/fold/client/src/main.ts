import {
  applySafeAreaVars,
  createApp,
  createAudio,
  createFrameMetrics,
  createLifecycle,
  createSave,
  createSolo,
  jsHeapMb,
  round,
  safeArea,
} from '@rally/game-kit';
import { rally } from '@rally/sdk';
import { Bot } from './bot.ts';
import { applyLowFx } from './lowfx.ts';
import { createFoldScene, type FoldScene } from './scene.ts';
import { FoldSim, type Form, type Input, type SimEvent } from './sim.ts';

const BOARD = 'distance';
const TELEMETRY_MS = 10_000;
/** A swipe is a vertical move of at least this many CSS px; a tap moves less than TAP_SLOP and lasts < TAP_MS. */
const SWIPE_PX = 26;
const TAP_SLOP = 14;
const TAP_MS = 400;

interface Progress {
  best: number;
  played: number;
  version: 1;
}

const ACHIEVEMENTS: { key: string; title: string; earned: (s: FoldSim) => boolean }[] = [
  { key: 'first_100', title: 'Paper Wings', earned: (s) => s.distance >= 100 },
  { key: 'all_folds', title: 'Origami', earned: (s) => s.formsUsed.size === 3 },
  { key: 'km', title: 'Long Haul', earned: (s) => s.distance >= 1000 },
  { key: 'stamps_25', title: 'Stamp Collector', earned: (s) => s.stamps >= 25 },
  { key: 'stairwells_5', title: 'Over the Edge', earned: (s) => s.stairwells >= 5 },
];

/** First-run tutorial, one line at a time; each step ends when its condition holds. */
const TUTORIAL: { text: string; done: (s: FoldSim) => boolean }[] = [
  { text: 'Tap to flap up over the bookshelf', done: (s) => s.plane.x > 13.6 },
  { text: 'Swipe down to dive under the lamp', done: (s) => s.plane.x > 22.4 },
  { text: 'Swipe up to glide across the stairwell', done: (s) => s.plane.x > 33.4 },
];

const CRASH_LINES: Record<string, string> = {
  doorway: 'Hit a door frame',
  shelf: 'Hit a bookshelf',
  lamp: 'Hit a lamp',
  table: 'Hit a table',
  kettle: 'Hit the kettle',
  radiator: 'Hit a radiator',
  fan: 'Hit the fan',
  stall: 'Skidded to a stop',
  stairwell: 'Fell down the stairs',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  distance: $('distance-value'),
  stamps: $('stamps-value'),
  best: $('best-value'),
  forms: $('forms'),
  hint: $('hint'),
  prompt: $('prompt'),
  over: $('over'),
  overLabel: $('over-label'),
  overScore: $('over-score'),
  overBest: $('over-best'),
  overStats: $('over-stats'),
  overBoard: $('over-board'),
  overUnlocked: $('over-unlocked'),
  again: $<HTMLButtonElement>('again'),
  paused: $('paused'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
};

function loading(progress: number) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (rally.isHosted) void rally.ui.loading(progress).catch(() => {});
}

const metres = (n: number) => `${Math.floor(n).toLocaleString('en-US')} m`;

/**
 * Dev only: `?lowfx=1` draws at most 15 fps at DPR 1, without clustered lighting, MSAA or shadows (src/lowfx.ts). The
 * Playwright e2e uses it: CI renders WebGL in software on a small runner.
 */
const params = new URLSearchParams(location.search);
const LOWFX = import.meta.env.DEV && params.has('lowfx') && params.get('lowfx') !== '0';

const bootStart = performance.now();
loading(0.05);

// --- engine + scene ------------------------------------------------------------------------------
const { app } = createApp({ canvas: ui.canvas, ...(LOWFX ? { maxPixelRatio: 1, antialias: false } : {}) });
if (LOWFX) applyLowFx(app);
// Built in boot() (the scene may load models first).
let scene!: FoldScene;
loading(0.2);

// --- services --------------------------------------------------------------------------------------
const save = createSave<Progress>(
  rally,
  'progress',
  { best: 0, played: 0, version: 1 },
  {
    debounceMs: 800,
    parse: (raw, d) => {
      const r = (raw ?? {}) as Partial<Progress>;
      const num = (v: unknown, f: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f;
      return { best: num(r.best, d.best), played: num(r.played, d.played), version: 1 };
    },
    onError: (err) => console.warn('[fold] save failed', err),
  },
);
const solo = createSolo(rally, { user: () => rally.context?.user ?? null });
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());

// --- game state ------------------------------------------------------------------------------------
let sim = new FoldSim(1);
let readyMs = -1;
let gameOverToken = 0;
let tutorial = -1;
let autoplay: Bot | null = null;
/** Dev only (store art): the sim stands still while the scene keeps rendering. */
let hold = false;
const shown = { distance: -1, stamps: -1, form: '' as Form | '' };

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    gesture = null;
    audio.suspend();
    void save.flush();
  },
  onResume: () => {
    ui.paused.hidden = true;
    audio.resume();
    metrics.reset();
  },
  onExitRequested: async () => {
    clearInterval(telemetryTimer);
    app.timeScale = 0;
    gesture = null;
    audio.suspend();
    ui.paused.hidden = true;
    await save.flush();
  },
  onLowMemory: () => {
    scene?.trim();
    audio.close();
  },
});

/** A new run: a fresh house (seeded by the play count, so each run is new but replayable), the plane at the start. */
function newRun() {
  sim = new FoldSim((save.data.played * 7919 + 23) >>> 0);
  scene.reset(sim);
  ui.over.hidden = true;
  ui.prompt.hidden = false;
  ui.prompt.textContent = window.matchMedia?.('(pointer: fine)').matches
    ? 'Space / tap to flap · ↑ glide · ↓ dive'
    : 'Tap to flap · swipe up to glide · swipe down to dive';
  tutorial = save.data.played === 0 ? 0 : -1;
  ui.hint.hidden = true;
  shown.distance = shown.stamps = -1;
  shown.form = '';
  ui.best.textContent = metres(save.data.best);
  renderHud();
}

function command(cmd: Input) {
  if (lifecycle.isPaused || lifecycle.isExiting || sim.phase === 'over') return;
  if (sim.phase === 'ready') ui.prompt.hidden = true;
  sim.input(cmd);
}

// --- input: one thumb, anywhere on the screen -------------------------------------------------------------
let gesture: { id: number; x: number; y: number; t: number; swiped: boolean } | null = null;
ui.canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ui.canvas.setPointerCapture?.(e.pointerId);
  gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, swiped: false };
});
ui.canvas.addEventListener('pointermove', (e) => {
  const g = gesture;
  if (!g || g.id !== e.pointerId || g.swiped) return;
  const dy = e.clientY - g.y;
  if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > Math.abs(e.clientX - g.x)) {
    g.swiped = true;
    command(dy < 0 ? 'glider' : 'dart');
  }
});
const endGesture = (e: PointerEvent) => {
  const g = gesture;
  if (!g || g.id !== e.pointerId) return;
  gesture = null;
  if (g.swiped) return;
  const moved = Math.hypot(e.clientX - g.x, e.clientY - g.y);
  if (moved < TAP_SLOP && e.timeStamp - g.t < TAP_MS) command('flap');
};
ui.canvas.addEventListener('pointerup', endGesture);
ui.canvas.addEventListener('pointercancel', () => (gesture = null));

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') command('glider');
  else if (e.code === 'ArrowDown' || e.code === 'KeyS') command('dart');
  else if (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'KeyK' || e.code === 'ArrowRight') command('flap');
  else if (e.code === 'Enter' && sim.phase === 'over' && !ui.over.hidden) ui.again.click();
  else return;
  e.preventDefault();
});

// --- HUD -------------------------------------------------------------------------------------------
function renderHud() {
  const d = Math.floor(sim.distance);
  if (d !== shown.distance) {
    shown.distance = d;
    ui.distance.textContent = d.toLocaleString('en-US');
  }
  if (sim.stamps !== shown.stamps) {
    shown.stamps = sim.stamps;
    ui.stamps.textContent = String(sim.stamps);
  }
  if (sim.plane.form !== shown.form) {
    shown.form = sim.plane.form;
    for (const el of ui.forms.querySelectorAll<HTMLElement>('.form')) {
      el.classList.toggle('on', el.dataset.form === shown.form);
    }
  }
  if (tutorial >= 0 && sim.phase === 'playing') {
    while (tutorial < TUTORIAL.length && TUTORIAL[tutorial]!.done(sim)) tutorial++;
    const step = TUTORIAL[tutorial];
    if (!step) {
      tutorial = -1;
      ui.hint.hidden = true;
    } else if (ui.hint.textContent !== step.text || ui.hint.hidden) {
      ui.hint.textContent = step.text;
      ui.hint.hidden = false;
    }
  }
}

function onEvent(e: SimEvent) {
  scene.event(e, sim);
  switch (e.type) {
    case 'flap':
      audio.blip(520, 70, { type: 'triangle', slideTo: 760, gain: 0.18 });
      break;
    case 'form':
      if (e.form === 'dart') audio.blip(700, 110, { type: 'sine', slideTo: 300, gain: 0.16 });
      else if (e.form === 'glider') audio.blip(360, 140, { type: 'sine', slideTo: 520, gain: 0.14 });
      break;
    case 'stamp':
      audio.blip(1320, 60, { type: 'square', gain: 0.1 });
      audio.blip(1760, 90, { type: 'square', gain: 0.08, delayMs: 60 });
      break;
    case 'skid':
      audio.blip(140, 160, { type: 'sawtooth', gain: 0.08 });
      break;
    case 'soggy':
      audio.blip(260, 220, { type: 'sine', slideTo: 180, gain: 0.12 });
      break;
    case 'stairwell':
      audio.blip(880, 120, { type: 'sine', gain: 0.18 });
      break;
    case 'crash':
      audio.blip(220, 380, { type: 'sawtooth', slideTo: 70, gain: 0.25 });
      break;
    case 'over':
      void gameOver();
      break;
    default:
      break;
  }
}

async function gameOver() {
  const token = ++gameOverToken;
  const score = Math.floor(sim.distance);
  const prevBest = save.data.best;
  save.update((d) => {
    d.played += 1;
    d.best = Math.max(d.best, score);
  });
  const best = Math.max(prevBest, score);
  const newBest = score > prevBest && score > 0;
  gesture = null;
  ui.hint.hidden = true;
  ui.overLabel.textContent = sim.crash ? (CRASH_LINES[sim.crash.cause] ?? 'Crumpled') : 'Crumpled';
  ui.overScore.textContent = metres(score);
  ui.overBest.textContent = newBest ? 'New best!' : `Best ${metres(best)}`;
  ui.overBest.classList.toggle('new', newBest);
  ui.overStats.textContent = `Stamps ${sim.stamps} · Stairwells ${sim.stairwells} · ${Math.round(sim.time)} s`;
  ui.overBoard.textContent = 'Leaderboard …';
  ui.overUnlocked.hidden = true;
  ui.best.textContent = metres(best);
  setTimeout(() => {
    if (token === gameOverToken) ui.over.hidden = false;
  }, 750);
  if (newBest)
    [0, 90, 180].forEach((ms, i) => audio.blip(523.25 * 2 ** ((i * 4) / 12), 140, { delayMs: 600 + ms, gain: 0.3 }));

  const earned = ACHIEVEMENTS.filter((a) => a.earned(sim));
  const [submit, unlocks] = await Promise.all([
    solo.submit(BOARD, score),
    Promise.all(earned.map(async (a) => ({ a, r: await solo.unlock(a.key) }))),
  ]);
  const top = await solo.top(BOARD, { scope: 'global', limit: 10 });
  if (token !== gameOverToken) return;
  const fresh = unlocks.filter((u) => u.r.unlocked && !u.r.alreadyHad).map((u) => u.a.title);
  if (fresh.length) {
    ui.overUnlocked.textContent = `Unlocked: ${fresh.join(' · ')}`;
    ui.overUnlocked.hidden = false;
  }
  const me = solo.findMe(top.entries);
  const boardBest = Math.max(me?.score ?? 0, submit.best ?? 0, best);
  if (submit.source === 'local' || top.source === 'local') {
    ui.overBoard.textContent = rally.isHosted
      ? `Leaderboard unavailable · best ${metres(boardBest)}`
      : `Offline · best ${metres(boardBest)}`;
  } else if (me) {
    ui.overBoard.textContent = `Leaderboard · best ${metres(me.score)} · #${me.rank} global`;
  } else {
    ui.overBoard.textContent = `Leaderboard · best ${metres(boardBest)} · not in top ${top.entries.length || 10}`;
  }
}

ui.again.addEventListener('click', () => {
  audio.blip(440, 60, { gain: 0.3 });
  newRun();
});

app.on('update', (dt: number) => {
  if (hold) {
    scene.sync(sim, dt);
    renderHud();
    return;
  }
  if (autoplay && sim.phase === 'ready') {
    sim.start();
    ui.prompt.hidden = true;
  }
  for (const e of sim.advance(dt, autoplay?.drive)) onEvent(e);
  scene.sync(sim, dt);
  renderHud();
});

// --- telemetry -------------------------------------------------------------------------------------
function collect() {
  const f = metrics.snapshot();
  const gd = app.graphicsDevice;
  return {
    fps: f.fps,
    frameMs: f.frameMs,
    p95Ms: f.p95Ms,
    worstMs: f.worstMs,
    distance: Math.floor(sim.distance),
    phase: sim.phase,
    runTime: round(sim.time, 1),
    form: sim.plane.form,
    stamps: sim.stamps,
    best: save.data.best,
    played: save.data.played,
    paused: lifecycle.isPaused,
    entities: scene?.entityCount ?? 0,
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    readyMs,
    heapMb: jsHeapMb() ?? -1,
  };
}
const telemetryTimer = setInterval(() => rally.telemetry.report('fold', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------
async function boot() {
  const saved = save.load().catch(() => save.data);
  scene = createFoldScene(app, { shadows: !LOWFX });
  app.start();
  newRun();
  loading(0.9);
  await new Promise<void>((resolve) => {
    app.once('frameend', () => resolve());
    setTimeout(resolve, 1000);
  });
  if (rally.isHosted) {
    const ctx = await rally.ready();
    applySafeAreaVars(safeArea(ctx.device.safeArea));
  } else {
    applySafeAreaVars(safeArea());
  }
  readyMs = Math.round(performance.now() - bootStart);
  ui.loading.hidden = true;
  loading(1);
  await saved;
  // Not started yet: re-seed from the real play count and show the tutorial only on a first run.
  if (sim.phase === 'ready') newRun();
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
  if (scene && sim.phase === 'ready') newRun();
});

// Dev-only probe for the Playwright e2e and the art script (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __fold: unknown }).__fold = {
    get phase() {
      return sim.phase;
    },
    get distance() {
      return sim.distance;
    },
    get stamps() {
      return sim.stamps;
    },
    get form() {
      return sim.plane.form;
    },
    get plane() {
      return { x: sim.plane.x, y: sim.plane.y, vx: sim.plane.vx, vy: sim.plane.vy };
    },
    get crash() {
      return sim.crash;
    },
    get lowfx() {
      return LOWFX;
    },
    get paused() {
      return lifecycle.isPaused;
    },
    get save() {
      return { ...save.data, version: save.version };
    },
    /** The live sim, for setting up scenes by hand in the console. */
    get sim() {
      return sim;
    },
    /** Send a command as the player would. */
    input(cmd: Input) {
      command(cmd);
    },
    /** Let the bot fly (true) or hand control back (false). */
    autoplay(on: boolean) {
      autoplay = on ? new Bot() : null;
    },
    /** Run the sim `seconds` ahead at once (the bot flies if autoplay is on). */
    skip(seconds: number) {
      for (let t = 0; t < seconds && sim.phase === 'playing'; t += 0.1)
        for (const e of sim.advance(0.1, autoplay?.drive)) onEvent(e);
    },
    /** Store art: stop the sim (the scene keeps rendering). */
    hold(on: boolean) {
      hold = on;
    },
  };
}
