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
import { createControls } from './controls.ts';
import { createLabels, type Labels } from './labels.ts';
import { applyLowFx } from './lowfx.ts';
import { loadLumberModels } from './models.ts';
import { PALETTE, createLumberScene, type LumberScene } from './scene.ts';
import {
  MODES,
  type Progress,
  isUnlocked,
  modeDef,
  newlyUnlocked,
  parseProgress,
  starText,
  starsFor,
  totalStars,
} from './progress.ts';
import { CASH_ZONE, LumberSim, UNLOCKS, type ModeId, type SimEvent } from './sim.ts';

const TELEMETRY_MS = 10_000;

const ACHIEVEMENTS: { key: string; title: string; earned: (s: LumberSim) => boolean }[] = [
  { key: 'first_sale', title: 'Open for Business', earned: (s) => s.served >= 1 },
  { key: 'earn_1000', title: "Good Day's Work", earned: (s) => s.earned >= 1000 },
  { key: 'earn_2500', title: 'Timber Tycoon', earned: (s) => s.earned >= 2500 },
  { key: 'full_camp', title: 'Full Camp', earned: (s) => s.unlocked.size === UNLOCKS.length },
  { key: 'no_walkouts', title: 'Nobody Waits', earned: (s) => s.lost === 0 && s.earned >= 500 },
  { key: 'rush_hero', title: 'Rush Hour Hero', earned: (s) => s.mode === 'rush' && s.earned >= 800 },
];

/** First-shift tutorial, one line at a time; each step ends when its condition holds. */
const TUTORIAL: { text: string; done: (s: LumberSim) => boolean }[] = [
  { text: 'Grab planks at the sawmill', done: (s) => s.player.carry > 0 || s.counter > 0 },
  { text: 'Drop them on the counter', done: (s) => s.counter > 0 || s.served > 0 },
  { text: 'Stand at the till to sell', done: (s) => s.served > 0 },
  { text: 'Pick up your cash', done: (s) => s.wallet > 0 },
  { text: 'Stand on a pad to buy it', done: (s) => s.unlocked.size > 0 },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  wallet: $('wallet'),
  walletAmount: $('wallet-amount'),
  clock: $('clock'),
  earnedAmount: $('earned-amount'),
  hint: $('hint'),
  prompt: $('prompt'),
  modes: $('modes'),
  stick: $('stick'),
  over: $('over'),
  overLabel: $('over-label'),
  overScore: $('over-score'),
  overStars: $('over-stars'),
  overBest: $('over-best'),
  overStats: $('over-stats'),
  overBoard: $('over-board'),
  overUnlocked: $('over-unlocked'),
  overMode: $('over-mode'),
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

const money = (n: number) => `$${Math.floor(n).toLocaleString('en-US')}`;
const clock = (s: number) => {
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

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
// The scene and its labels are built in boot(), once the models have loaded.
let scene!: LumberScene;
let labels!: Labels;
loading(0.15);

// --- services --------------------------------------------------------------------------------------
const save = createSave<Progress>(rally, 'progress', parseProgress(null), {
  debounceMs: 800,
  parse: (raw) => parseProgress(raw),
  onError: (err) => console.warn('[lumber] save failed', err),
});
const solo = createSolo(rally, { user: () => rally.context?.user ?? null });
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());
const controls = createControls(ui.canvas, ui.stick);

// --- game state ------------------------------------------------------------------------------------
let sim = new LumberSim(1);
let readyMs = -1;
let gameOverToken = 0;
let tutorial = -1;
let autoplay: Bot | null = null;
const shown = { wallet: -1, earned: -1, clock: '' };
/** Last time (ms) each sound played, to keep per-tick events from buzzing. */
const lastSound = new Map<string, number>();

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    controls.release();
    audio.suspend();
    void save.flush();
  },
  onResume: () => {
    ui.paused.hidden = true;
    audio.resume();
    metrics.reset();
  },
  onExitRequested: async () => {
    // Leaving: stop what would keep running until the host unmounts the WebView (or forever in the dev harness).
    clearInterval(telemetryTimer);
    app.timeScale = 0;
    controls.enabled = false;
    audio.suspend();
    ui.paused.hidden = true;
    await save.flush();
  },
  onLowMemory: () => {
    scene?.trim();
    audio.close();
  },
});

/** The mode the next shift plays: the saved choice, while it is unlocked. */
function nextMode(): ModeId {
  const m = save.data.mode;
  return isUnlocked(m, save.data.bests) ? m : 'classic';
}

function newShift() {
  sim = new LumberSim((save.data.played * 7919 + 17) >>> 0, nextMode());
  labels.clear();
  scene.reset(sim);
  ui.over.hidden = true;
  ui.prompt.hidden = false;
  // Mouse + keyboard (desktop, the dev harness): mention the keys too.
  ui.prompt.textContent = window.matchMedia?.('(pointer: fine)').matches
    ? 'Drag, or use the arrow keys / WASD'
    : 'Drag anywhere to walk';
  tutorial = save.data.played === 0 ? 0 : -1;
  ui.hint.hidden = true;
  renderModes();
  shown.wallet = shown.earned = -1;
  shown.clock = '';
  ui.clock.classList.remove('hurry');
  renderHud();
}

/** The mode picker under the start prompt: each mode with its best stars, or what it takes to unlock it. */
function renderModes() {
  const bests = save.data.bests;
  const total = totalStars(bests);
  ui.modes.innerHTML = MODES.map((m) => {
    const open = isUnlocked(m.id, bests);
    const side = open
      ? `<span class="stars">${starText(starsFor(m.id, bests[m.id]))}</span>`
      : `<span class="lock">🔒 ${m.unlockAt - total} ★ to go</span>`;
    const cls = ['mode', m.id === sim.mode ? 'on' : '', open ? '' : 'locked'].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-mode="${m.id}"><b>${m.title}</b>${side}<small>${m.blurb}</small></button>`;
  }).join('');
  ui.modes.hidden = sim.phase !== 'ready';
}

ui.modes.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as ModeId | undefined;
  if (!id || sim.phase !== 'ready') return;
  if (!isUnlocked(id, save.data.bests)) {
    audio.blip(200, 90, { type: 'square', gain: 0.12 });
    ui.hint.textContent = `Earn ${modeDef(id).unlockAt} ★ to unlock ${modeDef(id).title}`;
    ui.hint.hidden = false;
    return;
  }
  if (id === sim.mode) return;
  audio.blip(520, 40, { gain: 0.2 });
  save.update((d) => {
    d.mode = id;
  });
  newShift();
});

function renderHud() {
  if (sim.wallet !== shown.wallet) {
    if (sim.wallet > shown.wallet && shown.wallet >= 0) {
      ui.wallet.classList.remove('bump');
      void ui.wallet.offsetWidth; // restart the CSS animation
      ui.wallet.classList.add('bump');
    }
    shown.wallet = sim.wallet;
    ui.walletAmount.textContent = Math.floor(sim.wallet).toLocaleString('en-US');
  }
  if (sim.earned !== shown.earned) {
    shown.earned = sim.earned;
    ui.earnedAmount.textContent = money(sim.earned);
  }
  const c = clock(sim.timeLeft);
  if (c !== shown.clock) {
    shown.clock = c;
    ui.clock.textContent = c;
    ui.clock.classList.toggle('hurry', sim.phase === 'playing' && sim.timeLeft <= 15);
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

function sound(key: string, minGapMs: number, play: () => void) {
  const now = performance.now();
  if (now - (lastSound.get(key) ?? -Infinity) < minGapMs) return;
  lastSound.set(key, now);
  play();
}

function onEvent(e: SimEvent) {
  switch (e.type) {
    case 'pickup':
      sound('pickup', 55, () => audio.blip(420 + sim.player.carry * 18, 45, { type: 'triangle', gain: 0.22 }));
      break;
    case 'drop':
      sound('drop', 55, () => audio.blip(300 - sim.player.carry * 6, 45, { type: 'triangle', gain: 0.22 }));
      break;
    case 'serve':
      sound('serve', 80, () => audio.blip(520, 35, { type: 'square', gain: 0.08 }));
      break;
    case 'sale':
      labels.float(`+${money(e.amount)}`, CASH_ZONE);
      audio.blip(988, 70, { type: 'square', gain: 0.12 });
      audio.blip(1319, 110, { type: 'square', gain: 0.12, delayMs: 70 });
      break;
    case 'collect':
      sound('collect', 70, () => audio.blip(1200 + Math.random() * 200, 40, { type: 'sine', gain: 0.18 }));
      break;
    case 'pay':
      sound('pay', 60, () => audio.blip(660, 30, { type: 'square', gain: 0.07 }));
      break;
    case 'unlock': {
      const def = UNLOCKS.find((u) => u.id === e.id)!;
      scene.burst(def, PALETTE.padFill);
      labels.float(def.title, def, 'spend');
      [0, 80, 160, 260].forEach((ms, i) =>
        audio.blip(523.25 * 2 ** ([0, 4, 7, 12][i]! / 12), 120, { delayMs: ms, gain: 0.3 }),
      );
      break;
    }
    case 'walkout':
      sound('walkout', 400, () => audio.blip(180, 220, { type: 'sawtooth', slideTo: 110, gain: 0.12 }));
      if (!e.turnedAway) labels.float('Walked out', { x: 3.6, z: 4.2 }, 'lost');
      break;
    case 'arrive':
      break;
    case 'over':
      audio.blip(880, 500, { type: 'sine', slideTo: 660, gain: 0.3 });
      void gameOver();
      break;
  }
}

async function gameOver() {
  const token = ++gameOverToken;
  const mode = sim.mode;
  const def = modeDef(mode);
  const score = sim.earned;
  const before = { ...save.data.bests };
  const prevBest = before[mode];
  save.update((d) => {
    d.played += 1;
    d.bests[mode] = Math.max(d.bests[mode], score);
  });
  const best = Math.max(prevBest, score);
  const newBest = score > prevBest && score > 0;
  const stars = starsFor(mode, score);
  const opened = newlyUnlocked(before, save.data.bests);
  controls.release();
  ui.hint.hidden = true;
  ui.overLabel.textContent = mode === 'classic' ? 'Shift over' : `${def.title} over`;
  ui.overScore.textContent = money(score);
  ui.overStars.innerHTML = [0, 1, 2].map((i) => `<i class="${i < stars ? 'on' : ''}">★</i>`).join('');
  ui.overStars.setAttribute('aria-label', `${stars} of 3 stars`);
  ui.overMode.textContent = opened.length ? `New mode: ${opened.map((m) => m.title).join(' · ')}` : '';
  ui.overMode.hidden = !opened.length;
  ui.overBest.textContent = newBest ? 'New best!' : `Best ${money(best)}`;
  ui.overBest.classList.toggle('new', newBest);
  ui.overStats.textContent = `Served ${sim.served} · Walked out ${sim.lost} · Upgrades ${sim.unlocked.size}/${UNLOCKS.length}`;
  ui.overBoard.textContent = 'Leaderboard …';
  ui.overUnlocked.hidden = true;
  scene.setOverview(true);
  setTimeout(() => {
    if (token === gameOverToken) ui.over.hidden = false;
  }, 700);
  if (newBest)
    [0, 90, 180].forEach((ms, i) => audio.blip(523.25 * 2 ** ((i * 4) / 12), 140, { delayMs: 600 + ms, gain: 0.35 }));

  const earned = ACHIEVEMENTS.filter((a) => a.earned(sim));
  const [submit, unlocks] = await Promise.all([
    solo.submit(def.board, score),
    Promise.all(earned.map(async (a) => ({ a, r: await solo.unlock(a.key) }))),
  ]);
  const top = await solo.top(def.board, { scope: 'global', limit: 10 });
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
      ? `Leaderboard unavailable · best ${money(boardBest)}`
      : `Offline · best ${money(boardBest)}`;
  } else if (me) {
    ui.overBoard.textContent = `Leaderboard · best ${money(me.score)} · #${me.rank} global`;
  } else {
    ui.overBoard.textContent = `Leaderboard · best ${money(boardBest)} · not in top ${top.entries.length || 10}`;
  }
}

ui.again.addEventListener('click', () => {
  audio.blip(440, 60, { gain: 0.3 });
  newShift();
});

/** Dev only (store art): the sim stands still while the scene keeps rendering and animating. */
let hold = false;

app.on('update', (dt: number) => {
  if (hold) {
    scene.sync(sim, dt);
    labels.sync(sim);
    renderHud();
    return;
  }
  const live = !lifecycle.isPaused && !lifecycle.isExiting;
  const stick = live ? (autoplay ? null : controls.stick) : { x: 0, z: 0 };
  if (sim.phase === 'ready' && live && (autoplay || (stick && Math.hypot(stick.x, stick.z) > 0.25))) {
    sim.start();
    ui.prompt.hidden = true;
    ui.modes.hidden = true;
    if (tutorial < 0) ui.hint.hidden = true;
    audio.blip(660, 80, { gain: 0.25 });
  }
  if (stick) sim.setStick(stick.x, stick.z);
  for (const e of sim.advance(dt, autoplay?.drive)) onEvent(e);
  scene.sync(sim, dt);
  labels.sync(sim);
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
    earned: sim.earned,
    mode: sim.mode,
    stars: totalStars(save.data.bests),
    phase: sim.phase,
    shiftTime: round(sim.time, 1),
    unlocked: sim.unlocked.size,
    customers: sim.customers.length,
    best: save.data.bests[sim.mode],
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
const telemetryTimer = setInterval(() => rally.telemetry.report('lumber', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------
async function boot() {
  // The save is not on the critical path: `createSave` reapplies updates made before it resolves. Render first.
  const saved = save.load().catch(() => save.data);
  const models = await loadLumberModels(app, (f) => loading(0.15 + f * 0.65));
  scene = createLumberScene(app, models, { shadows: !LOWFX });
  labels = createLabels(ui.labels, scene);
  app.start();
  newShift();
  loading(0.9);
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
  loading(1);
  await saved;
  // Not started yet: re-seed from the real play count and show the tutorial only on a first shift.
  if (sim.phase === 'ready') newShift();
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
  // Without a scene (the models did not load) there is nothing to show; the host has the error.
  if (scene && sim.phase === 'ready') newShift();
});

// Dev-only probe for the Playwright e2e (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __lumber: unknown }).__lumber = {
    get phase() {
      return sim.phase;
    },
    get time() {
      return sim.time;
    },
    get earned() {
      return sim.earned;
    },
    get wallet() {
      return sim.wallet;
    },
    get carry() {
      return sim.player.carry;
    },
    get lowfx() {
      return LOWFX;
    },
    get player() {
      return { x: sim.player.x, z: sim.player.z };
    },
    /** The live sim, for setting up scenes by hand in the console. */
    get sim() {
      return sim;
    },
    /** Where the player is drawn (CSS px), for close-up screenshots. */
    get playerScreen() {
      const out = { x: 0, y: 0 };
      scene.project(sim.player.x, 0.8, sim.player.z, out);
      return out;
    },
    get unlocked() {
      return [...sim.unlocked];
    },
    get paused() {
      return lifecycle.isPaused;
    },
    get save() {
      return { ...save.data, version: save.version };
    },
    get mode() {
      return sim.mode;
    },
    get stars() {
      return totalStars(save.data.bests);
    },
    /** Let the greedy bot play (true) or hand control back (false). */
    autoplay(on: boolean) {
      autoplay = on ? new Bot() : null;
    },
    /** Store art: stop the sim (the scene keeps animating; floating labels stay up), and frame the camera. */
    hold(on: boolean) {
      hold = on;
      labels.freeze(on);
    },
    artView(view: { zoom: number; at?: { x: number; z: number } } | null) {
      scene.setArtView(view);
    },
    /** Jump the shift clock forward (testing the end of a shift without waiting 4 minutes). */
    skip(seconds: number) {
      for (let t = 0; t < seconds && sim.phase === 'playing'; t += 0.5)
        for (const e of sim.advance(0.5, autoplay?.drive)) onEvent(e);
    },
  };
}
