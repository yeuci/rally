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
import { createLabels } from './labels.ts';
import { PALETTE, createLumberScene } from './scene.ts';
import { CASH_ZONE, LumberSim, UNLOCKS, type SimEvent } from './sim.ts';

const BOARD = 'earnings';
const TELEMETRY_MS = 10_000;

interface Progress {
  best: number;
  played: number;
  version: 1;
}

const ACHIEVEMENTS: { key: string; title: string; earned: (s: LumberSim) => boolean }[] = [
  { key: 'first_sale', title: 'Open for Business', earned: (s) => s.served >= 1 },
  { key: 'earn_1000', title: "Good Day's Work", earned: (s) => s.earned >= 1000 },
  { key: 'earn_2500', title: 'Timber Tycoon', earned: (s) => s.earned >= 2500 },
  { key: 'full_camp', title: 'Full Camp', earned: (s) => s.unlocked.size === UNLOCKS.length },
  { key: 'no_walkouts', title: 'Nobody Waits', earned: (s) => s.lost === 0 && s.earned >= 500 },
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
  stick: $('stick'),
  over: $('over'),
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

const bootStart = performance.now();
loading(0.05);

// --- engine + scene ------------------------------------------------------------------------------
const { app } = createApp({ canvas: ui.canvas });
const scene = createLumberScene(app);
const labels = createLabels(ui.labels, scene);
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
      const num = (v: unknown, f: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f;
      return { best: num(r.best, d.best), played: num(r.played, d.played), version: 1 };
    },
    onError: (err) => console.warn('[lumber] save failed', err),
  },
);
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
    scene.trim();
    audio.close();
  },
});

function newShift() {
  sim = new LumberSim((save.data.played * 7919 + 17) >>> 0);
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
  shown.wallet = shown.earned = -1;
  shown.clock = '';
  ui.clock.classList.remove('hurry');
  renderHud();
}

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
  const score = sim.earned;
  const prevBest = save.data.best;
  save.update((d) => {
    d.played += 1;
    d.best = Math.max(d.best, score);
  });
  const best = Math.max(prevBest, score);
  const newBest = score > prevBest && score > 0;
  controls.release();
  ui.hint.hidden = true;
  ui.overScore.textContent = money(score);
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

app.on('update', (dt: number) => {
  const live = !lifecycle.isPaused && !lifecycle.isExiting;
  const stick = live ? (autoplay ? null : controls.stick) : { x: 0, z: 0 };
  if (sim.phase === 'ready' && live && (autoplay || (stick && Math.hypot(stick.x, stick.z) > 0.25))) {
    sim.start();
    ui.prompt.hidden = true;
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
    phase: sim.phase,
    shiftTime: round(sim.time, 1),
    unlocked: sim.unlocked.size,
    customers: sim.customers.length,
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
const telemetryTimer = setInterval(() => rally.telemetry.report('lumber', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------
async function boot() {
  // The save is not on the critical path: `createSave` reapplies updates made before it resolves. Render first.
  const saved = save.load().catch(() => save.data);
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
  if (sim.phase === 'ready') newShift();
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
    /** Let the greedy bot play (true) or hand control back (false). */
    autoplay(on: boolean) {
      autoplay = on ? new Bot() : null;
    },
    /** Jump the shift clock forward (testing the end of a shift without waiting 4 minutes). */
    skip(seconds: number) {
      for (let t = 0; t < seconds && sim.phase === 'playing'; t += 0.5)
        for (const e of sim.advance(0.5, autoplay?.drive)) onEvent(e);
    },
  };
}
