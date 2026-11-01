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
import { createLabels } from './labels.ts';
import { applyLowFx } from './lowfx.ts';
import { loadSawlineModels } from './models.ts';
import { PALETTE, type SawlineScene, createSawlineScene } from './scene.ts';
import {
  BAY_SPOTS,
  DEBARKER_Z,
  LINE_X,
  SAW_Z,
  SHIFT_SECONDS,
  SawlineSim,
  TRUNK_RADIUS,
  UPGRADES,
  type ModeId,
  type SimEvent,
  type UpgradeId,
} from './sim.ts';
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

const TELEMETRY_MS = 10_000;
const SHOP_SLOTS = 4;

const ACHIEVEMENTS: { key: string; title: string; earned: (s: SawlineSim) => boolean }[] = [
  { key: 'first_truck', title: 'First Delivery', earned: (s) => s.trucksServed >= 1 },
  { key: 'perfect_10', title: 'Sharp Eye', earned: (s) => s.bestCombo >= 10 },
  { key: 'earn_3000', title: 'Busy Mill', earned: (s) => s.earned >= 3000 },
  { key: 'earn_5000', title: 'Sawmill Tycoon', earned: (s) => s.earned >= 5000 },
  { key: 'full_line', title: 'Fully Loaded', earned: (s) => s.upgrades.size === UPGRADES.length },
  {
    key: 'steady_hands',
    title: 'Steady Hands',
    earned: (s) => s.mode === 'precision' && s.strikes === 0 && s.time >= SHIFT_SECONDS,
  },
];

/** First-shift tutorial, one line at a time; each step ends when its condition holds. */
const TUTORIAL: { text: string; done: (s: SawlineSim) => boolean }[] = [
  { text: 'Hold DEBARK to strip the trunk', done: (s) => s.items.some((i) => i.debarked > 1) || s.autoDebark },
  { text: 'Tap CUT when the glowing mark hits the blade', done: (s) => s.cuts.perfect + s.cuts.good > 0 },
  { text: 'Planks fill the trucks. Keep the line moving!', done: (s) => s.trucksServed > 0 },
  { text: 'Spend your earnings on upgrades', done: (s) => s.upgrades.size > 0 },
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
  combo: $('combo'),
  prompt: $('prompt'),
  modes: $('modes'),
  strikes: $('strikes'),
  shop: $('shop'),
  debark: $<HTMLButtonElement>('debark'),
  cut: $<HTMLButtonElement>('cut'),
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
// The scene needs the workers' models, so boot() builds it once they have loaded.
let scene!: SawlineScene;
let labels!: ReturnType<typeof createLabels>;
loading(0.1);

// --- services --------------------------------------------------------------------------------------
const save = createSave<Progress>(rally, 'progress', parseProgress(null), {
  debounceMs: 800,
  parse: (raw) => parseProgress(raw),
  onError: (err) => console.warn('[sawline] save failed', err),
});
const solo = createSolo(rally, { user: () => rally.context?.user ?? null });
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());

// --- game state ------------------------------------------------------------------------------------
let sim = new SawlineSim(1);
let readyMs = -1;
let gameOverToken = 0;
let tutorial = -1;
let autoplay: Bot | null = null;
/** Saw taps (event timestamps) waiting for the next frame to be judged. */
let presses: number[] = [];
const held = { pointer: false, keys: false };
const shown = { wallet: -1, earned: -1, clock: '', shop: '' };
let comboTimer: ReturnType<typeof setTimeout> | undefined;
const lastSound = new Map<string, number>();

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    releaseAll();
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
    releaseAll();
    audio.suspend();
    ui.paused.hidden = true;
    await save.flush();
  },
  onLowMemory: () => {
    scene?.trim();
    audio.close();
  },
});

function releaseAll() {
  held.pointer = held.keys = false;
  presses = [];
  ui.debark.classList.remove('down');
}

/** The mode the next shift plays: the saved choice, while it is unlocked. */
function nextMode(): ModeId {
  const m = save.data.mode;
  return isUnlocked(m, save.data.bests) ? m : 'classic';
}

function newShift() {
  sim = new SawlineSim((save.data.played * 7919 + 31) >>> 0, nextMode());
  labels.clear();
  scene.reset(sim);
  releaseAll();
  ui.over.hidden = true;
  ui.prompt.hidden = false;
  tutorial = save.data.played === 0 ? 0 : -1;
  ui.hint.hidden = true;
  ui.combo.classList.remove('show');
  renderModes();
  renderStrikes();
  shown.wallet = shown.earned = -1;
  shown.clock = shown.shop = '';
  ui.clock.classList.remove('hurry');
  renderHud();
}

/** The mode picker (before a shift): each mode with its best stars, or what it takes to unlock it. */
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

/** Precision: one pip per allowed strike on the CUT button, filled as they go. */
function renderStrikes() {
  const max = sim.rules.strikes;
  ui.strikes.hidden = max === 0;
  ui.strikes.innerHTML = Array.from({ length: max }, (_, i) => `<i class="${i < sim.strikes ? 'on' : ''}"></i>`).join(
    '',
  );
}

function startIfReady() {
  if (sim.phase !== 'ready' || lifecycle.isPaused || lifecycle.isExiting) return;
  sim.start();
  ui.prompt.hidden = true;
  ui.modes.hidden = true;
  if (tutorial < 0) ui.hint.hidden = true;
  audio.blip(660, 80, { gain: 0.25 });
}

// --- controls --------------------------------------------------------------------------------------
ui.debark.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ui.debark.setPointerCapture?.(e.pointerId);
  held.pointer = true;
  ui.debark.classList.add('down');
  startIfReady();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
  ui.debark.addEventListener(type, () => {
    held.pointer = false;
    ui.debark.classList.remove('down');
  });
}
ui.cut.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startIfReady();
  if (sim.phase === 'playing' && !lifecycle.isPaused) presses.push(e.timeStamp);
});
ui.shop.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest('button')?.dataset.id as UpgradeId | undefined;
  if (id) buy(id);
});

const DEBARK_KEYS = new Set(['KeyD', 'ArrowLeft', 'ShiftLeft']);
const CUT_KEYS = new Set(['Space', 'KeyK', 'ArrowRight', 'KeyJ']);
window.addEventListener('keydown', (e) => {
  if (DEBARK_KEYS.has(e.code)) {
    held.keys = true;
    startIfReady();
    e.preventDefault();
  } else if (CUT_KEYS.has(e.code)) {
    e.preventDefault();
    if (e.repeat) return;
    startIfReady();
    if (sim.phase === 'playing' && !lifecycle.isPaused) presses.push(e.timeStamp);
  } else if (/^Digit[1-4]$/.test(e.code)) {
    const offer = sim.shop.slice(0, SHOP_SLOTS)[Number(e.code.slice(5)) - 1];
    if (offer) buy(offer.id);
  }
});
window.addEventListener('keyup', (e) => {
  if (DEBARK_KEYS.has(e.code)) held.keys = false;
});
window.addEventListener('blur', releaseAll);

function buy(id: UpgradeId) {
  if (!sim.buy(id)) {
    audio.blip(160, 90, { type: 'square', gain: 0.1 });
    return;
  }
  // Effects come from the 'buy' event on the next frame.
}

// --- HUD -------------------------------------------------------------------------------------------
function renderShop() {
  const offers = sim.shop.slice(0, SHOP_SLOTS);
  const key = offers.map((u) => `${u.id}:${sim.wallet >= u.cost ? 1 : 0}`).join('|') + `|${sim.phase}`;
  if (key === shown.shop) return;
  shown.shop = key;
  ui.shop.innerHTML = offers
    .map((u) => {
      const can = sim.wallet >= u.cost && sim.phase === 'playing';
      return `<button type="button" data-id="${u.id}" class="${can ? 'can' : ''}" ${can ? '' : 'disabled'}><b>${u.title}</b><small>${u.blurb}</small><span>${money(u.cost)}</span></button>`;
    })
    .join('');
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
  ui.debark.classList.toggle('auto', sim.autoDebark);
  ui.debark.querySelector('small')!.textContent = sim.autoDebark ? 'auto' : 'hold';
  ui.cut.querySelector('small')!.textContent = sim.autoSaw ? 'auto · tap for perfect' : 'tap';
  renderShop();
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

function showCombo(n: number) {
  ui.combo.textContent = n >= 2 ? `Perfect ×${n}` : 'Perfect';
  ui.combo.classList.add('show');
  clearTimeout(comboTimer);
  comboTimer = setTimeout(() => ui.combo.classList.remove('show'), 900);
}

function sound(key: string, minGapMs: number, play: () => void) {
  const now = performance.now();
  if (now - (lastSound.get(key) ?? -Infinity) < minGapMs) return;
  lastSound.set(key, now);
  play();
}

function onEvent(e: SimEvent) {
  const sawY = TRUNK_RADIUS + 1.1;
  scene.event(e);
  switch (e.type) {
    case 'blade':
      audio.blip(220, 60, { type: 'square', slideTo: 120, gain: 0.12 });
      ui.cut.classList.remove('flash');
      void ui.cut.offsetWidth;
      ui.cut.classList.add('flash');
      break;
    case 'cut': {
      scene.burst(LINE_X, TRUNK_RADIUS + 0.4, SAW_Z, PALETTE.woodEnd, e.quality === 'perfect' ? 10 : 5, 3.2);
      const text = e.quality === 'perfect' ? 'PERFECT' : e.quality === 'good' ? 'GOOD' : 'OFF';
      // Precision's off cuts say which strike they are instead (the 'strike' event, right after).
      if (!(e.quality === 'off' && sim.rules.strikes > 0)) {
        labels.float(
          e.auto && e.quality !== 'off' ? 'auto' : text,
          LINE_X + 1.2,
          sawY,
          SAW_Z,
          e.auto ? 'good' : e.quality,
        );
      }
      if (e.quality === 'perfect') {
        showCombo(e.combo);
        const f = 523.25 * 2 ** (Math.min(e.combo - 1, 12) / 12);
        audio.blip(f, 120, { type: 'sine', gain: 0.4 });
        audio.blip(f * 2, 100, { type: 'sine', gain: 0.15, delayMs: 30 });
      } else if (e.quality === 'good') {
        audio.blip(392, 80, { type: 'triangle', gain: 0.3 });
      } else {
        audio.blip(150, 160, { type: 'sawtooth', gain: 0.12 });
      }
      break;
    }
    case 'split':
      sound('split', 120, () => audio.blip(1100, 50, { type: 'sine', gain: 0.1, slideTo: 1500 }));
      break;
    case 'pile':
      sound('pile', 90, () => audio.blip(260, 70, { type: 'triangle', gain: 0.2 }));
      break;
    case 'sale': {
      const bay = BAY_SPOTS[e.bay]!;
      labels.float(`+${money(e.amount)}`, bay.x, 2.2, bay.z, 'money');
      audio.blip(988, 70, { type: 'square', gain: 0.12 });
      audio.blip(1319, 110, { type: 'square', gain: 0.12, delayMs: 70 });
      break;
    }
    case 'truckLeft':
      sound('left', 400, () => audio.blip(180, 220, { type: 'sawtooth', slideTo: 110, gain: 0.12 }));
      break;
    case 'buy': {
      const u = UPGRADES.find((x) => x.id === e.id)!;
      labels.float(u.title, LINE_X + 1.6, 2.4, DEBARKER_Z + 2, 'perfect');
      [0, 80, 160, 260].forEach((ms, i) =>
        audio.blip(523.25 * 2 ** ([0, 4, 7, 12][i]! / 12), 120, { delayMs: ms, gain: 0.3 }),
      );
      break;
    }
    case 'truckArrive':
      break;
    case 'strike':
      renderStrikes();
      audio.blip(110, 260, { type: 'sawtooth', slideTo: 70, gain: 0.2 });
      labels.float(`OFF · strike ${e.strikes}`, LINE_X + 1.2, TRUNK_RADIUS + 1.1, SAW_Z, 'off');
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
  releaseAll();
  ui.hint.hidden = true;
  ui.overLabel.textContent = sim.struckOut
    ? `Line stopped · ${sim.rules.strikes} bad cuts`
    : mode === 'classic'
      ? 'Shift over'
      : `${def.title} over`;
  ui.overScore.textContent = money(score);
  ui.overStars.innerHTML = [0, 1, 2].map((i) => `<i class="${i < stars ? 'on' : ''}">★</i>`).join('');
  ui.overStars.setAttribute('aria-label', `${stars} of 3 stars`);
  ui.overMode.textContent = opened.length ? `New mode: ${opened.map((m) => m.title).join(' · ')}` : '';
  ui.overMode.hidden = !opened.length;
  ui.overBest.textContent = newBest ? 'New best!' : `Best ${money(best)}`;
  ui.overBest.classList.toggle('new', newBest);
  const cuts = sim.cuts.perfect + sim.cuts.good + sim.cuts.off;
  ui.overStats.textContent = `Trucks ${sim.trucksServed} · Perfect ${sim.cuts.perfect}/${cuts} · Best combo ${sim.bestCombo}`;
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
  if (autoplay && live) startIfReady();
  if (!autoplay) sim.setDebark(live && (held.pointer || held.keys));
  const frameWall = performance.now();
  const events = sim.advance(dt, autoplay?.drive);
  for (const e of events) onEvent(e);
  // Judge each saw tap at the moment it happened (see sim.cut), oldest first. Its events land after the tick's.
  const handled = events.length;
  for (const t of presses) {
    if (sim.phase !== 'playing') break;
    const lateBy = Math.min(Math.max(0, (frameWall - t) / 1000) * app.timeScale, Math.max(dt, 1 / 30));
    sim.cut(lateBy);
  }
  presses = [];
  for (const e of sim.events.slice(handled)) onEvent(e);
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
    strikes: sim.strikes,
    phase: sim.phase,
    shiftTime: round(sim.time, 1),
    upgrades: sim.upgrades.size,
    pile: sim.pile,
    trucks: sim.trucks.length,
    best: save.data.bests[sim.mode],
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
const telemetryTimer = setInterval(() => rally.telemetry.report('sawline', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------
async function boot() {
  const saved = save.load().catch(() => save.data);
  const models = await loadSawlineModels(app, (f) => loading(0.1 + f * 0.7));
  scene = createSawlineScene(app, models, { shadows: !LOWFX });
  labels = createLabels(ui.labels, scene);
  app.start();
  newShift();
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
  if (sim.phase === 'ready') newShift();
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
  if (scene && sim.phase === 'ready') newShift();
});

// Dev-only probe for the Playwright e2e (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __sawline: unknown }).__sawline = {
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
    get lowfx() {
      return LOWFX;
    },
    get cuts() {
      return { ...sim.cuts };
    },
    get sawDepth() {
      return sim.sawDepth;
    },
    get mode() {
      return sim.mode;
    },
    get stars() {
      return totalStars(save.data.bests);
    },
    get strikes() {
      return sim.strikes;
    },
    /** Set best shifts (stars) by hand, e.g. to unlock a mode in the e2e. */
    setBests(bests: Partial<Progress['bests']>) {
      save.update((d) => {
        Object.assign(d.bests, bests);
      });
      if (sim.phase === 'ready') renderModes();
    },
    get upgrades() {
      return [...sim.upgrades];
    },
    get paused() {
      return lifecycle.isPaused;
    },
    get sim() {
      return sim;
    },
    /** Let the greedy bot play (true) or hand control back (false). */
    autoplay(on: boolean) {
      autoplay = on ? new Bot() : null;
    },
    /** Store art: stop the sim (the scene keeps animating; floating labels and the combo stay up), and frame it. */
    hold(on: boolean) {
      hold = on;
      labels.freeze(on);
      if (on) clearTimeout(comboTimer);
    },
    artView(view: { zoom: number; at?: { x: number; z: number } } | null) {
      scene.setArtView(view);
    },
    /** Jump the shift clock forward. */
    skip(seconds: number) {
      for (let t = 0; t < seconds && sim.phase === 'playing'; t += 0.5)
        for (const e of sim.advance(0.5, autoplay?.drive)) onEvent(e);
    },
  };
}
