import {
  applySafeAreaVars,
  createApp,
  createAudio,
  createFrameMetrics,
  createInput,
  createLifecycle,
  createSave,
  createSolo,
  jsHeapMb,
  round,
  safeArea,
} from '@rally/game-kit';
import { rally } from '@rally/sdk';
import { createStackScene } from './scene.ts';
import { StackSim, type DropOutcome } from './sim.ts';

const BOARD = 'height';
const TELEMETRY_MS = 10_000;

interface Progress {
  best: number;
  played: number;
  version: 1;
}

const ACHIEVEMENTS: { key: string; title: string; earned: (s: StackSim) => boolean }[] = [
  { key: 'first_drop', title: 'First Drop', earned: (s) => s.score >= 1 },
  { key: 'height_10', title: 'Ten High', earned: (s) => s.score >= 10 },
  { key: 'height_25', title: 'Skyline', earned: (s) => s.score >= 25 },
  { key: 'height_50', title: 'Cloud Piercer', earned: (s) => s.score >= 50 },
  { key: 'perfect_5', title: 'Perfect Five', earned: (s) => s.bestStreak >= 5 },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  score: $('score'),
  combo: $('combo'),
  prompt: $('prompt'),
  over: $('over'),
  overScore: $('over-score'),
  overBest: $('over-best'),
  overBoard: $('over-board'),
  overUnlocked: $('over-unlocked'),
  again: $<HTMLButtonElement>('again'),
  paused: $('paused'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
};

/** Own loading UI plus the host's overlay progress (`ui.loading` only exists inside the shell). */
function loading(progress: number) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (rally.isHosted) void rally.ui.loading(progress).catch(() => {});
}

const bootStart = performance.now();
loading(0.05);

// --- engine + scene ------------------------------------------------------------------------------
const { app } = createApp({ canvas: ui.canvas });
const scene = createStackScene(app);
loading(0.5);

// --- services --------------------------------------------------------------------------------------
const save = createSave<Progress>(
  rally,
  'progress',
  { best: 0, played: 0, version: 1 },
  {
    debounceMs: 800,
    parse: (raw, d) => {
      const r = (raw ?? {}) as Partial<Progress>;
      const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f);
      return { best: num(r.best, d.best), played: num(r.played, d.played), version: 1 };
    },
    onError: (err) => console.warn('[stack] save failed', err),
  },
);
const solo = createSolo(rally, { user: () => rally.context?.user ?? null });
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());

// --- game state ------------------------------------------------------------------------------------
let sim = new StackSim();
let presses: number[] = [];
let readyMs = -1;
let gameOverToken = 0;
let comboTimer: ReturnType<typeof setTimeout> | undefined;

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    presses = [];
    audio.suspend();
    void save.flush();
  },
  onResume: () => {
    ui.paused.hidden = true;
    audio.resume();
    metrics.reset();
  },
  onExitRequested: async () => {
    ui.paused.hidden = true;
    await save.flush();
  },
  onLowMemory: () => {
    scene.trim();
    audio.close();
  },
});

function newGame() {
  sim = new StackSim();
  presses = [];
  scene.reset((save.data.played * 67 + 200) % 360);
  scene.setSlider(sim.slider());
  ui.score.textContent = '0';
  ui.score.hidden = true;
  ui.combo.classList.remove('show');
  ui.over.hidden = true;
  ui.prompt.hidden = false;
}

function setScore(n: number) {
  ui.score.textContent = String(n);
  ui.score.classList.remove('bump');
  void ui.score.offsetWidth; // restart the CSS animation
  ui.score.classList.add('bump');
}

function showCombo(streak: number) {
  ui.combo.textContent = streak >= 2 ? `Perfect ×${streak}` : 'Perfect';
  ui.combo.classList.add('show');
  clearTimeout(comboTimer);
  comboTimer = setTimeout(() => ui.combo.classList.remove('show'), 900);
}

function onDrop(o: DropOutcome) {
  if (o.kind === 'ignored') return;
  if (o.kind === 'miss') {
    scene.spawnDebris(o.debris, Math.sign(sim.axis === 'x' ? o.debris.x : o.debris.z) || 1);
    scene.setSlider(null);
    audio.blip(196, 420, { type: 'sawtooth', slideTo: 55, gain: 0.28 });
    void gameOver();
    return;
  }
  setScore(sim.score);
  if (o.kind === 'perfect') {
    scene.place(o.placed, true);
    showCombo(o.streak);
    const f = 523.25 * 2 ** (Math.min(o.streak - 1, 12) / 12);
    audio.blip(f, 140, { type: 'sine', gain: 0.5 });
    audio.blip(f * 2, 120, { type: 'sine', gain: 0.18, delayMs: 30 });
  } else {
    scene.place(o.placed, false);
    const axisOff = o.debris.layer % 2 === 1 ? o.debris.x - o.placed.x : o.debris.z - o.placed.z;
    scene.spawnDebris(o.debris, Math.sign(axisOff) || 1);
    audio.blip(330 + Math.min(sim.score, 40) * 6, 80, { type: 'triangle', gain: 0.45 });
  }
}

async function gameOver() {
  const token = ++gameOverToken;
  const score = sim.score;
  const prevBest = save.data.best;
  save.update((d) => {
    d.played += 1;
    d.best = Math.max(d.best, score);
  });
  const best = Math.max(prevBest, score);
  const newBest = score > prevBest && score > 0;
  ui.score.hidden = true;
  ui.combo.classList.remove('show');
  ui.overScore.textContent = String(score);
  ui.overBest.textContent = newBest ? `New best!` : `Best ${best}`;
  ui.overBest.classList.toggle('new', newBest);
  ui.overBoard.textContent = 'Leaderboard …';
  ui.overUnlocked.hidden = true;
  scene.setOverview(true, score);
  setTimeout(() => {
    if (token === gameOverToken) ui.over.hidden = false;
  }, 450);
  if (newBest) [0, 90, 180].forEach((ms, i) => audio.blip(523.25 * 2 ** ((i * 4) / 12), 140, { delayMs: 400 + ms, gain: 0.35 }));

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
    ui.overBoard.textContent = rally.isHosted ? `Leaderboard unavailable · best ${boardBest}` : `Offline · best ${boardBest}`;
  } else if (me) {
    ui.overBoard.textContent = `Leaderboard · best ${me.score} · #${me.rank} global`;
  } else {
    ui.overBoard.textContent = `Leaderboard · best ${boardBest} · not in top ${top.entries.length || 10}`;
  }
}

ui.again.addEventListener('click', () => {
  audio.blip(440, 60, { gain: 0.3 });
  newGame();
});

createInput(ui.canvas, {
  onPress: (e) => {
    if (lifecycle.isPaused || lifecycle.isExiting || !ui.over.hidden) return;
    if (sim.phase === 'ready') {
      sim.start();
      ui.prompt.hidden = true;
      ui.score.hidden = false;
      audio.blip(440, 60, { gain: 0.3 });
      return;
    }
    if (sim.phase === 'playing') presses.push(e.time);
  },
});

app.on('update', (dt: number) => {
  const frameWall = performance.now();
  sim.advance(dt);
  // Judge each press at the moment it happened (see sim.ts), oldest first.
  for (const t of presses) {
    if (sim.phase !== 'playing') break;
    const lateBy = Math.min(Math.max(0, (frameWall - t) / 1000) * app.timeScale, dt);
    onDrop(sim.drop(lateBy));
  }
  presses = [];
  if (sim.phase !== 'over') scene.setSlider(sim.slider());
  scene.update(dt);
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
    score: sim.score,
    phase: sim.phase,
    best: save.data.best,
    played: save.data.played,
    paused: lifecycle.isPaused,
    entities: scene.entityCount,
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    readyMs,
    heapMb: jsHeapMb() ?? -1,
  };
}
setInterval(() => rally.telemetry.report('stack', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------
async function boot() {
  const saved = save.load().catch(() => save.data);
  app.start();
  loading(0.8);
  await saved;
  newGame();
  loading(1);
  // Show the first rendered frame before telling the host to drop its overlay (bounded: a page that boots hidden
  // gets no rAF, and the host would hit its load timeout).
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
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
  if (sim.phase === 'ready') newGame();
});

// Dev-only probe for the Playwright e2e (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __stack: unknown }).__stack = {
    get phase() {
      return sim.phase;
    },
    get score() {
      return sim.score;
    },
    get streak() {
      return sim.streak;
    },
    offset: () => (sim.phase === 'playing' ? sim.offset() : null),
    get layerTime() {
      return sim.layerTime;
    },
    get paused() {
      return lifecycle.isPaused;
    },
    get save() {
      return { ...save.data, version: save.version };
    },
  };
}
