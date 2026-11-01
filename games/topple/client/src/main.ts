import {
  applySafeAreaVars,
  createApp,
  createAudio,
  createDirectionKeys,
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
import { applyLowFx } from './lowfx.ts';
import { SEAT_COLORS, createToppleScene } from './scene.ts';
import { PIECES, TURN_SECONDS, ToppleSim, initPhysics, type BotLevel, type Seat, type SimEvent } from './sim.ts';

const BOARD = 'tower';
const TELEMETRY_MS = 10_000;
const MAX_SEATS = 6;
/** Held-piece speed with the keyboard, world units per second. */
const KEY_SPEED = 1.6;

interface Progress {
  best: number;
  played: number;
  wins: number;
  version: 1;
}

/** Seat 0 is the phone's owner (the Rally account); the others are friends passing the phone, or bots. */
type SeatChoice = 'human' | BotLevel;
const CHOICES: SeatChoice[] = ['human', 'easy', 'normal', 'hard'];
const CHOICE_LABEL: Record<SeatChoice, string> = {
  human: 'Pass & play',
  easy: 'Bot · Easy',
  normal: 'Bot · Normal',
  hard: 'Bot · Hard',
};

const ACHIEVEMENTS: { key: string; title: string; earned: (s: ToppleSim) => boolean }[] = [
  { key: 'first_win', title: 'Last One Standing', earned: (s) => s.winner === 0 },
  {
    key: 'beat_five',
    title: 'Against the Odds',
    earned: (s) => s.winner === 0 && s.players.length === 6 && s.players.slice(1).every((p) => p.kind === 'bot'),
  },
  { key: 'tower_15', title: 'Skyline', earned: (s) => s.maxStanding >= 15 },
  { key: 'tower_30', title: 'Cloud Scraper', earned: (s) => s.maxStanding >= 30 },
  { key: 'full_table', title: 'Full Table', earned: (s) => s.players.filter((p) => p.kind === 'human').length >= 4 },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  players: $('players'),
  turn: $('turn'),
  turnName: $('turn-name'),
  turnSub: $('turn-sub'),
  timer: $('timer-bar'),
  big: $('big'),
  controls: $('controls'),
  viewLeft: $<HTMLButtonElement>('view-left'),
  viewRight: $<HTMLButtonElement>('view-right'),
  rotate: $<HTMLButtonElement>('rotate'),
  flip: $<HTMLButtonElement>('flip'),
  drop: $<HTMLButtonElement>('drop'),
  setup: $('setup'),
  seats: $('seats'),
  addSeat: $<HTMLButtonElement>('add-seat'),
  start: $<HTMLButtonElement>('start'),
  over: $('over'),
  overTitle: $('over-title'),
  overPlaces: $('over-places'),
  overStats: $('over-stats'),
  overBoard: $('over-board'),
  overUnlocked: $('over-unlocked'),
  again: $<HTMLButtonElement>('again'),
  change: $<HTMLButtonElement>('change'),
  paused: $('paused'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
};

function loading(progress: number) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (rally.isHosted) void rally.ui.loading(progress).catch(() => {});
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
const scene = createToppleScene(app, { shadows: !LOWFX });
loading(0.3);

// --- services --------------------------------------------------------------------------------------
const save = createSave<Progress>(
  rally,
  'progress',
  { best: 0, played: 0, wins: 0, version: 1 },
  {
    debounceMs: 800,
    parse: (raw, d) => {
      const r = (raw ?? {}) as Partial<Progress>;
      const num = (v: unknown, f: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f;
      return { best: num(r.best, d.best), played: num(r.played, d.played), wins: num(r.wins, d.wins), version: 1 };
    },
    onError: (err) => console.warn('[topple] save failed', err),
  },
);
const solo = createSolo(rally, { user: () => rally.context?.user ?? null });
const audio = createAudio();
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());

// --- state -----------------------------------------------------------------------------------------
let sim: ToppleSim | null = null;
const seats: SeatChoice[] = ['human', 'normal', 'normal'];
let readyMs = -1;
let gameOverToken = 0;
let bigTimer: ReturnType<typeof setTimeout> | undefined;
let lastTurnKey = '';
/** Drag: the aim when the finger went down (null = the drag orbits the view instead). */
let dragFrom: { x: number; z: number } | null = null;
let orbitFrom = 0;

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    dragFrom = null;
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
    audio.suspend();
    ui.paused.hidden = true;
    await save.flush();
  },
  onLowMemory: () => {
    scene.trim();
    audio.close();
  },
});

function seatName(i: number, choice: SeatChoice): string {
  if (i === 0) return 'You';
  if (choice === 'human') return `Player ${i + 1}`;
  return `Bot ${i}`;
}

function toSeats(choices: SeatChoice[]): Seat[] {
  return choices.map((c, i) =>
    c === 'human' ? { name: seatName(i, c), kind: 'human' } : { name: seatName(i, c), kind: 'bot', level: c },
  );
}

// --- setup screen ----------------------------------------------------------------------------------
function renderSetup() {
  ui.seats.innerHTML = seats
    .map((c, i) => {
      const color = SEAT_COLORS[i % SEAT_COLORS.length];
      const kind =
        i === 0
          ? `<span class="kind fixed">This phone</span>`
          : `<button type="button" class="kind" data-seat="${i}">${CHOICE_LABEL[c]}</button>`;
      const remove =
        i >= 2
          ? `<button type="button" class="remove" data-remove="${i}" aria-label="Remove seat">×</button>`
          : '<span class="remove"></span>';
      return `<div class="seat"><i style="background:${color}"></i><span class="name">${esc(seatName(i, c))}</span>${kind}${remove}</div>`;
    })
    .join('');
  ui.addSeat.hidden = seats.length >= MAX_SEATS;
}

ui.seats.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const seat = t.closest<HTMLElement>('[data-seat]')?.dataset.seat;
  const remove = t.closest<HTMLElement>('[data-remove]')?.dataset.remove;
  if (seat) {
    const i = Number(seat);
    seats[i] = CHOICES[(CHOICES.indexOf(seats[i]!) + 1) % CHOICES.length]!;
  } else if (remove) {
    seats.splice(Number(remove), 1);
  } else {
    return;
  }
  audio.blip(520, 40, { gain: 0.2 });
  renderSetup();
});
ui.addSeat.addEventListener('click', () => {
  if (seats.length >= MAX_SEATS) return;
  seats.push('normal');
  audio.blip(600, 40, { gain: 0.2 });
  renderSetup();
});
ui.start.addEventListener('click', () => {
  audio.blip(660, 80, { gain: 0.3 });
  startMatch();
});
ui.again.addEventListener('click', () => {
  audio.blip(660, 80, { gain: 0.3 });
  startMatch();
});
ui.change.addEventListener('click', () => {
  ui.over.hidden = true;
  showSetup();
});

function showSetup() {
  renderSetup();
  ui.setup.hidden = false;
  ui.controls.hidden = true;
  ui.turn.hidden = true;
}

function startMatch() {
  sim?.dispose();
  scene.reset();
  sim = new ToppleSim(toSeats(seats), (save.data.played * 7919 + 101) >>> 0);
  ui.setup.hidden = true;
  ui.over.hidden = true;
  lastTurnKey = '';
  renderPlayers();
  announce('Round 1');
}

// --- HUD -------------------------------------------------------------------------------------------
function renderPlayers() {
  if (!sim) {
    ui.players.innerHTML = '';
    return;
  }
  const s = sim;
  ui.players.innerHTML = s.players
    .map((p) => {
      const cls = ['chip', p.alive ? '' : 'out', s.current === p.index && !s.finished ? 'current' : ''].join(' ');
      return `<span class="${cls}"><i style="background:${SEAT_COLORS[p.index % SEAT_COLORS.length]}"></i>${esc(p.name)}</span>`;
    })
    .join('');
}

function announce(text: string, sub = '', ms = 1200) {
  ui.big.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  ui.big.classList.add('show');
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => ui.big.classList.remove('show'), ms);
}

function renderTurn() {
  if (!sim || sim.finished) {
    ui.turn.hidden = true;
    ui.controls.hidden = true;
    return;
  }
  const p = sim.currentPlayer;
  const aiming = sim.phase === 'aim';
  ui.turn.hidden = !aiming;
  ui.controls.hidden = !sim.humanAiming || lifecycle.isPaused;
  if (!aiming) return;
  const key = `${sim.current}/${sim.round}/${sim.piece}/${sim.pieces.length}`;
  if (key !== lastTurnKey) {
    lastTurnKey = key;
    ui.turnName.textContent =
      p.kind === 'bot' ? `${p.name} is thinking…` : p.index === 0 ? 'Your turn' : `${p.name}'s turn`;
    ui.turnName.style.color = SEAT_COLORS[p.index % SEAT_COLORS.length]!;
    ui.turnSub.textContent = `${PIECES[sim.piece].label} · next: ${PIECES[sim.next].label}`;
    renderPlayers();
  }
  const k = Math.max(0, sim.turnLeft / TURN_SECONDS);
  ui.timer.style.transform = `scaleX(${k.toFixed(3)})`;
  ui.timer.parentElement!.classList.toggle('hurry', k < 0.3 && p.kind === 'human');
}

function onEvent(e: SimEvent) {
  const s = sim!;
  switch (e.type) {
    case 'turn':
      renderPlayers();
      if (s.players[e.player]!.kind === 'human') audio.blip(784, 70, { gain: 0.25 });
      break;
    case 'drop':
      audio.blip(330, 90, { type: 'triangle', slideTo: 180, gain: 0.25 });
      break;
    case 'settled':
      audio.blip(220, 50, { type: 'square', gain: 0.1 });
      break;
    case 'topple':
      scene.shake(0.35);
      announce('TOPPLED!', `${s.players[e.player]!.name} knocked it over`, 1800);
      audio.blip(140, 600, { type: 'sawtooth', slideTo: 50, gain: 0.3 });
      audio.blip(90, 700, { type: 'square', slideTo: 40, gain: 0.15, delayMs: 120 });
      break;
    case 'out':
      renderPlayers();
      break;
    case 'round':
      announce(`Round ${e.round}`, `${s.alive.length} players left`);
      scene.reset();
      break;
    case 'win':
      void gameOver();
      break;
  }
}

async function gameOver() {
  const s = sim!;
  const token = ++gameOverToken;
  const score = s.maxStanding;
  const prevBest = save.data.best;
  const won = s.winner === 0;
  save.update((d) => {
    d.played += 1;
    d.best = Math.max(d.best, score);
    if (won) d.wins += 1;
  });
  renderPlayers();
  ui.controls.hidden = true;
  ui.turn.hidden = true;
  const winner = s.players[s.winner!]!;
  ui.overTitle.textContent = won ? 'You win!' : `${winner.name} wins`;
  ui.overPlaces.innerHTML = [...s.players]
    .sort((a, b) => (a.place ?? 99) - (b.place ?? 99))
    .map(
      (p) =>
        `<li><b>${p.place}</b><i style="background:${SEAT_COLORS[p.index % SEAT_COLORS.length]}"></i>${esc(p.name)}</li>`,
    )
    .join('');
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  ui.overStats.textContent = `Tallest tower ${plural(score, 'piece')} · ${plural(s.round, 'round')}${score > prevBest && score > 0 ? ' · new best!' : ''}`;
  ui.overBoard.textContent = 'Leaderboard …';
  ui.overUnlocked.hidden = true;
  if (won)
    [0, 90, 180, 300].forEach((ms, i) =>
      audio.blip(523.25 * 2 ** ([0, 4, 7, 12][i]! / 12), 140, { delayMs: ms, gain: 0.3 }),
    );
  setTimeout(() => {
    if (token === gameOverToken) ui.over.hidden = false;
  }, 900);

  const earned = ACHIEVEMENTS.filter((a) => a.earned(s));
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
  const boardBest = Math.max(me?.score ?? 0, submit.best ?? 0, save.data.best);
  if (submit.source === 'local' || top.source === 'local') {
    ui.overBoard.textContent = rally.isHosted
      ? `Leaderboard unavailable · best ${boardBest}`
      : `Offline · tallest tower ${boardBest}`;
  } else if (me) {
    ui.overBoard.textContent = `Tallest tower · best ${me.score} · #${me.rank} global`;
  } else {
    ui.overBoard.textContent = `Tallest tower · best ${boardBest} · not in top ${top.entries.length || 10}`;
  }
}

// --- input -----------------------------------------------------------------------------------------
/** Screen drag (CSS px) → a move on the ground, relative to where the camera looks from. */
function screenToGround(dx: number, dy: number): { x: number; z: number } {
  const u = scene.unitsPerPx * 1.3;
  const yaw = scene.yaw;
  return {
    x: (dx * Math.cos(yaw) + dy * Math.sin(yaw)) * u,
    z: (-dx * Math.sin(yaw) + dy * Math.cos(yaw)) * u,
  };
}

createInput(
  ui.canvas,
  {
    onPress: () => {
      if (!sim || lifecycle.isPaused) return;
      // On your turn a drag moves the piece; otherwise it turns the view.
      dragFrom = sim.humanAiming ? { x: sim.aim.x, z: sim.aim.z } : null;
      orbitFrom = 0;
    },
    onDrag: (e) => {
      if (!sim || lifecycle.isPaused) return;
      const dx = e.x - e.startX;
      const dy = e.y - e.startY;
      if (dragFrom && sim.humanAiming) {
        const m = screenToGround(dx, dy);
        sim.setAim(dragFrom.x + m.x, dragFrom.z + m.z);
      } else {
        const want = -dx * 0.008;
        scene.orbit(want - orbitFrom);
        orbitFrom = want;
      }
    },
    onDragEnd: () => {
      dragFrom = null;
    },
  },
  { keyboard: false, tapSlop: 4, tapMaxMs: 10_000 },
);

const keys = createDirectionKeys();
const press = (fn: () => void) => (e: Event) => {
  e.preventDefault();
  if (!sim?.humanAiming || lifecycle.isPaused) return;
  fn();
};
const turnPiece = () => {
  sim!.turn(1);
  audio.blip(600, 30, { gain: 0.15 });
};
const flipPiece = () => {
  sim!.flip();
  audio.blip(500, 30, { gain: 0.15 });
};
const dropPiece = () => sim!.drop();
ui.rotate.addEventListener('pointerdown', press(turnPiece));
ui.flip.addEventListener('pointerdown', press(flipPiece));
ui.drop.addEventListener('pointerdown', press(dropPiece));
ui.viewLeft.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  scene.orbit(Math.PI / 4);
});
ui.viewRight.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  scene.orbit(-Math.PI / 4);
});
window.addEventListener('keydown', (e) => {
  if (e.repeat || !sim || lifecycle.isPaused) return;
  if (e.code === 'KeyZ' || e.code === 'BracketLeft') scene.orbit(Math.PI / 4);
  else if (e.code === 'KeyX' || e.code === 'BracketRight') scene.orbit(-Math.PI / 4);
  if (!sim.humanAiming) return;
  if (e.code === 'KeyQ' || e.code === 'KeyE') {
    sim.turn(e.code === 'KeyE' ? 1 : -1);
    audio.blip(600, 30, { gain: 0.15 });
  } else if (e.code === 'KeyF') flipPiece();
  else if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    dropPiece();
  }
});

app.on('update', (dt: number) => {
  if (sim && !lifecycle.isPaused && !lifecycle.isExiting) {
    // Keyboard: move the held piece relative to the view.
    const k = keys.stick;
    if (sim.humanAiming && (k.x || k.y)) {
      const m = screenToGround(k.x, k.y);
      const len = Math.hypot(m.x, m.z) || 1;
      sim.setAim(sim.aim.x + (m.x / len) * KEY_SPEED * dt, sim.aim.z + (m.z / len) * KEY_SPEED * dt);
    }
    for (const e of sim.advance(dt)) onEvent(e);
    scene.sync(sim, dt);
  } else if (!sim) {
    scene.sync(idle, dt);
  }
  renderTurn();
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
    phase: sim?.phase ?? 'setup',
    seats: sim?.players.length ?? 0,
    pieces: sim?.pieces.length ?? 0,
    round: sim?.round ?? 0,
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
const telemetryTimer = setInterval(() => rally.telemetry.report('topple', collect()), TELEMETRY_MS);

// --- boot ------------------------------------------------------------------------------------------
/** An empty table behind the setup screen (a sim nobody plays: the scene just shows the pedestal). */
let idle: ToppleSim;

async function boot() {
  const saved = save.load().catch(() => save.data);
  await initPhysics();
  loading(0.7);
  idle = new ToppleSim(toSeats(['human', 'normal']), 1);
  app.start();
  showSetup();
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
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
});

// Dev-only probe for the Playwright e2e (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __topple: unknown }).__topple = {
    get lowfx() {
      return LOWFX;
    },
    get sim() {
      return sim;
    },
    get phase() {
      return sim?.phase ?? 'setup';
    },
    get current() {
      return sim?.current ?? -1;
    },
    get round() {
      return sim?.round ?? 0;
    },
    get pieces() {
      return sim?.pieces.length ?? 0;
    },
    get winner() {
      return sim?.winner ?? null;
    },
    get paused() {
      return lifecycle.isPaused;
    },
    get save() {
      return { ...save.data, version: save.version };
    },
    get seats() {
      return [...seats];
    },
    /** Aim the held piece (on a human turn). */
    aim(x: number, z: number) {
      sim?.setAim(x, z);
    },
  };
}
