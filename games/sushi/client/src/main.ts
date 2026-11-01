import {
  RenderClock,
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
import { rally, type PlayerSettings } from '@rally/sdk';
import {
  BELT_LENGTH,
  BELT_SLOTS,
  COUNTER_TOP,
  ChefAct,
  ClientMessage,
  Cook,
  DT,
  type Kind,
  PATCH_MS,
  Pan,
  SEATS,
  STATIONS,
  actionFor,
  beltPoint,
  decodeItem,
  matItems,
  matchRecipe,
  pickTarget,
  stationType,
  targetPoint,
  tierOf,
  workFor,
  type DevCommand,
  type FxBatch,
  type FxEvent,
  type ResultMessage,
  type SushiStateView,
  type Vec2,
} from '@rally/game-sushi-server';
import { SLOT_COLORS } from './colors.ts';
import { createControls } from './controls.ts';
import { LESSONS, createHud, createLabels, dayName, esc, orderHtml, patienceColor, yen } from './hud.ts';
import { applyLowFx } from './lowfx.ts';
import { loadSushiModels } from './models.ts';
import { connect, type Net } from './net.ts';
import { Predictor, shouldPredict } from './predict.ts';
import { effectsVolume, rememberGraphics, rememberedGraphics, renderQuality, type Graphics } from './quality.ts';
import { createSceneSafe, type SushiScene } from './sceneboot.ts';
import { createSfx } from './sfx.ts';
import { actionLabel, customerState, worldOf } from './world.ts';

const TELEMETRY_MS = 10_000;
/** Reconnection grace the room grants (RallyRoom.reconnectSeconds); reported to the host for "Rejoin match?". */
const RECONNECT_TTL_SEC = 60;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  stick: $('stick'),
  action: $('action'),
  paused: $('paused'),
  exit: $<HTMLButtonElement>('exit'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
  loadingLabel: $('loading-label'),
};
const params = new URLSearchParams(location.search);
/** `?predict=0` draws your own chef interpolated like everyone else (to compare). */
const PREDICT = params.get('predict') !== '0';
/** Dev only: `?art=<shot>` stages a frozen scene for the store art (src/art.ts). */
const ART = import.meta.env.DEV ? params.get('art') : null;
/** Dev only: `?lowfx=1` draws at most 15 fps at DPR 1 without MSAA, shadows or effects (the e2e). */
const LOWFX = import.meta.env.DEV && !ART && params.has('lowfx') && params.get('lowfx') !== '0';
/** Dev-only perf knobs (test/perf.cjs PERF_QUERY): `?noscroll` (the belt's slats stand still), `?nolabels`. */
const NOSCROLL = import.meta.env.DEV && params.has('noscroll');
const NOLABELS = import.meta.env.DEV && params.has('nolabels');

/** Boot progress to the host's loading screen (with a user-facing label) and to our own veil. */
let lastLabel = '';
function loading(progress: number, label?: string) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (label) {
    lastLabel = label;
    ui.loadingLabel.textContent = label;
  }
  if (rally.isHosted) void rally.ui.loading(progress, label ?? (lastLabel || undefined)).catch(() => {});
}

const bootStart = performance.now();
loading(0.02, 'Downloading the kitchen');
if (!rally.isHosted) document.body.classList.add('standalone');
ui.exit.hidden = rally.isHosted;

// --- engine, HUD, input, sound -----------------------------------------------------------------------------
let graphics: Graphics = LOWFX ? 'low' : rememberedGraphics(globalThis.localStorage ?? null);
const bootQuality = renderQuality(graphics);
const { app, onResize, resize } = createApp({
  canvas: ui.canvas,
  maxPixelRatio: ART ? 3 : bootQuality.maxPixelRatio,
  antialias: ART ? true : bootQuality.antialias,
});
if (LOWFX) applyLowFx(app);
let scene!: SushiScene;
const hud = createHud();
const labels = createLabels(ui.labels);
const controls = createControls(ui.canvas, ui.stick, ui.action);
const audio = createAudio();
const sfx = createSfx(audio);
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());

/** The game's own settings (host menu): order hints under the bubbles, the station highlight. */
const gameSettings = { orderHints: true, highlight: true };

// --- netcode state ---------------------------------------------------------------------------------------------
let net: Net | null = null;
let joining: Promise<Net> | null = null;
let me = '';
let readyMs = -1;
let exiting = false;
let menuOpen = false;
let playable = false;
const clock = new RenderClock({ intervalMs: PATCH_MS });
const chefBuf = new SnapshotBuffer({
  fields: ['x', 'y', 'vx', 'vy'] as const,
  rates: { x: 'vx', y: 'vy' },
  extrapolateMs: PATCH_MS,
});
const custBuf = new SnapshotBuffer({ fields: ['x', 'y'] as const, extrapolateMs: PATCH_MS });
const predictor = new Predictor();
let lastResult: ResultMessage | null = null;
let resultDay = '';
const seen = { coins: 0, stale: 0, angry: 0, bonks: 0, fx: [] as string[] };
let myFace = -Math.PI / 2;
let target = -1;
/** The belt offset as last patched, when, and its speed: the client runs it on between patches. */
const belt = { s: 0, at: 0, speed: 0 };
let lastPhase = '';
let lastZones = -1;
let lastPlayersKey = '';
const menuSent = { define: false, players: 0 };

function releaseInput() {
  const now = performance.now();
  const sent = net?.release(now);
  if (sent) predictor.recordStick(now, { x: 0, y: 0 });
}

const inputLive = () => controls.enabled;
const setInputEnabled = () => {
  controls.enabled = !lifecycle.isPaused && !menuOpen && !exiting;
  if (!controls.enabled) releaseInput();
};

const lifecycle = createLifecycle(rally, app, {
  onPause: () => {
    ui.paused.hidden = false;
    setInputEnabled();
    audio.suspend();
  },
  onResume: () => {
    ui.paused.hidden = true;
    setInputEnabled();
    audio.resume();
    metrics.reset();
  },
  onExitRequested: async () => {
    exiting = true;
    setInputEnabled();
    const joined = net ?? (await joining?.catch(() => null));
    await joined?.leave().catch(() => {});
    if (!rally.isHosted) hud.setMessage('You left the kitchen', 'Reload to play again');
  },
  onLowMemory: () => {
    scene?.trim();
    audio.close();
  },
});
ui.exit.addEventListener('click', () => void lifecycle.exit('button'));
const stopInput = () => {
  controls.release();
  releaseInput();
};
window.addEventListener('blur', stopInput);
window.addEventListener('pagehide', stopInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopInput();
});
// The host's game menu: while it is open, nothing we hold keeps acting (the shift keeps running on the server).
rally.on('menu', ({ open }) => {
  menuOpen = open;
  setInputEnabled();
});
rally.on('settingsChanged', (s) => applySettings(s));
hud.onStart(() => net?.start());
hud.onVote((i) => {
  net?.vote(i);
  sfx.vote();
});

function applySettings(s: PlayerSettings) {
  sfx.volume = effectsVolume(s.volume);
  // Shared touch settings (Sushi Shift has no aiming: aimAssist does not apply).
  if (s.controls) {
    controls.setLayout({ swap: s.controls.swapSticks, size: s.controls.stickSize, opacity: s.controls.stickOpacity });
  }
  if (!LOWFX && !ART && s.graphics !== graphics) {
    graphics = s.graphics;
    rememberGraphics(globalThis.localStorage ?? null, graphics);
    const q = renderQuality(graphics);
    app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, q.maxPixelRatio);
    resize();
    scene?.setQuality(q);
  }
  if (typeof s.game.orderHints === 'boolean') gameSettings.orderHints = s.game.orderHints;
  if (typeof s.game.highlight === 'boolean') gameSettings.highlight = s.game.highlight;
}

/** The host menu: our settings and "How to play". */
async function defineMenu() {
  const values = await rally.menu
    .define({
      settings: [
        { type: 'toggle', key: 'orderHints', label: 'Recipe hints on orders', default: true },
        { type: 'toggle', key: 'highlight', label: 'Highlight stations', default: true },
      ],
      help: [
        {
          title: 'Moving and the button',
          text: 'Drag anywhere with your left thumb to walk. Tap the big button to pick up or put down; hold it to chop, roll, wash or stir. The glowing ring shows what it will use.',
        },
        {
          title: 'Making sushi',
          text: 'Fish from a crate, hold to chop it on the board, rice from the pot, both on the mat, hold to roll. Tap the plate stack to plate it, then set it on the belt.',
        },
        {
          title: 'The kaiten belt',
          text: 'Plates ride past the stools; each customer grabs the first plate of what they ordered. White, red and gold plates pay more. Faster service earns bigger tips.',
        },
        {
          title: 'Stale plates',
          text: 'A plate nobody takes goes stale and grey after a lap or two. Pull it off the belt and bin it, or it clogs a slot.',
        },
        {
          title: 'Stars',
          text: 'A customer who waits too long leaves angry and costs a star. A day with no angry customers wins one back. Lose all five and the restaurant closes.',
        },
        {
          title: 'The week',
          text: 'Each day is about two minutes with a lunch and a dinner rush. Tables open Wednesday, dishes Thursday, a VIP Friday, the fish truck Saturday, the festival Sunday. Vote an upgrade each night.',
        },
      ],
    })
    .catch(() => null);
  menuSent.define = true;
  if (values) applySettings({ ...rally.settings, game: { ...rally.settings.game, ...values } });
}

/** The People list: the crew, with a short stat. */
function sendPlayers(st: SushiStateView) {
  if (!rally.isHosted) return;
  const list: { name: string; userId?: string; you?: boolean; detail?: string }[] = [];
  st.players.forEach((p, id) => {
    list.push({
      name: (p.name || 'chef').slice(0, 32),
      ...(p.uid ? { userId: p.uid } : {}),
      ...(id === me ? { you: true } : {}),
      detail: (p.bot ? 'Helper bot' : `${dayName(st.day)} · ${st.served} served`).slice(0, 24),
    });
  });
  rally.menu.players(list);
  menuSent.players++;
}

// --- effects from the server -----------------------------------------------------------------------------------
const tmpScreen = { x: 0, y: 0 };
function popAt(x: number, y: number, h: number, cls: string, html: string) {
  if (scene.toScreen(x, y, h, tmpScreen)) labels.pop(cls, html, tmpScreen.x, tmpScreen.y);
}

function onFx(batch: FxBatch) {
  const st = net?.state;
  for (const e of batch.e) {
    seen.fx.push(e.k);
    if (seen.fx.length > 200) seen.fx.shift();
    playFx(e, st);
  }
}

function playFx(e: FxEvent, st: SushiStateView | undefined) {
  const mySlot = st?.players.get(me)?.slot ?? -1;
  switch (e.k) {
    case 'morning':
      sfx.day();
      for (const m of e.teach) hud.teach(m, true);
      break;
    case 'pick':
      if (e.p === mySlot) sfx.pick();
      break;
    case 'put':
      if (e.p === mySlot) sfx.put();
      break;
    case 'chop':
      sfx.rolled();
      break;
    case 'roll': {
      sfx.rolled();
      const s = STATIONS[e.s];
      if (s) scene.sparkle(s.x, s.y, COUNTER_TOP + 0.3, '#ffe08a');
      break;
    }
    case 'belt':
      sfx.belt();
      break;
    case 'coin': {
      seen.coins++;
      const seat = SEATS[e.seat];
      if (!seat) break;
      const gold = e.how === 'vip' || tierOf(e.i as Kind) === 'gold';
      sfx.coin(gold);
      const html =
        e.how === 'vip'
          ? `VIP tip +${yen(e.tip)}`
          : `+${yen(e.v)}${e.tip > 0 ? ` <small>+${yen(e.tip)} tip</small>` : ''}`;
      popAt(seat.x, seat.y, 2.0, 'coin', html);
      scene.sparkle(seat.dish.x, seat.dish.y, 1.1, gold ? '#f2b324' : '#ffffff');
      break;
    }
    case 'happy':
      break;
    case 'angry': {
      seen.angry++;
      sfx.angry();
      const seat = SEATS[e.seat];
      if (seat) popAt(seat.x, seat.y, 2.2, 'mood', '💢');
      hud.teach('angry');
      break;
    }
    case 'stars':
      hud.stars(e.d > 0 ? 'gain' : 'hit');
      sfx.stars(e.d > 0);
      if (e.d > 0) hud.toast('A perfect day: ★ back!', 'gold');
      break;
    case 'stale':
      seen.stale++;
      sfx.stale();
      hud.teach('stale');
      break;
    case 'smoke':
      sfx.smoke();
      hud.toast('The gyoza is smoking!', 'bad');
      break;
    case 'burn':
      hud.teach('burnt');
      break;
    case 'cooked':
      sfx.cooked();
      break;
    case 'bin':
      if (e.p === mySlot) sfx.put();
      break;
    case 'wash':
      if (e.p === mySlot) sfx.wash();
      break;
    case 'delivery':
      hud.toast('📦 The fish truck dropped a delivery at the back door', 'good');
      break;
    case 'restock':
      hud.toast('Crates restocked', 'good');
      break;
    case 'full':
      hud.toast('🏮 Full house!', 'gold');
      break;
    case 'bonk':
      if (e.p === mySlot) {
        seen.bonks++;
        sfx.bonk();
      }
      break;
    case 'vote': {
      const card = e.card;
      hud.toast(`Tonight's upgrade: ${card}`, 'gold');
      break;
    }
    case 'phase':
      break;
    default:
      break;
  }
}

// --- patches ----------------------------------------------------------------------------------------------------
function onPatch(t: number) {
  if (!net) return;
  const st = net.state;
  if (!st?.players) return;
  const serverMs = st.tick * DT * 1000;
  clock.observe(serverMs, t);
  const ps: [string, { x: number; y: number; vx: number; vy: number }][] = [];
  st.players.forEach((p, id) => ps.push([id, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }]));
  chefBuf.push(serverMs, ps);
  const cs: [string, { x: number; y: number }][] = [];
  st.customers.forEach((c, id) => cs.push([id, { x: c.x, y: c.y }]));
  custBuf.push(serverMs, cs);
  belt.s = st.beltS;
  belt.at = t;
  belt.speed = st.beltSpeed;
  const mine = st.players.get(me);
  predictor.rttMs = net.rttMs ?? 0;
  const owned = new Set(st.owned.split(',').map((s) => s.split(':')[0]));
  if (mine && PREDICT && shouldPredict(st.phase)) {
    predictor.rebase(
      { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, speed: owned.has('sandals') ? 1.12 : 1, zones: st.zones },
      clock.server.toLocal(serverMs),
      t,
    );
  } else {
    predictor.reset();
  }
  if (!playable && mine) {
    playable = true;
    loading(1, 'Joining your crew');
    ui.loading.hidden = true;
  }
  const key = (() => {
    const parts: string[] = [`${st.day}:${st.served}`];
    st.players.forEach((p, id) => parts.push(`${id}:${p.name}:${p.uid}:${p.connected}`));
    return parts.join('|');
  })();
  if (key !== lastPlayersKey) {
    lastPlayersKey = key;
    sendPlayers(st);
  }
}

// --- the frame ----------------------------------------------------------------------------------------------------
function beltNow(now: number, st: SushiStateView): number {
  if (st.phase === 'night' || st.phase === 'over') return belt.s;
  return (belt.s + belt.speed * Math.min(0.25, Math.max(0, now - belt.at) / 1000)) % BELT_LENGTH;
}

function frame(dt: number) {
  if (!scene) return; // the icons render before the restaurant exists
  scene.update(dt);
  sfx.frame();
  if (!net) return;
  const now = performance.now();
  const st = net.state;
  if (!st?.players) return;
  const mine = st.players.get(me);
  if (controls.used) hud.hideHint();
  const bs = beltNow(now, st);
  const world = worldOf(st, bs);

  // Zones (the dining room, the alley, the terrace) and the camera's framing.
  if (st.zones !== lastZones) {
    scene.frame(st.zones, lastZones < 0);
    lastZones = st.zones;
  }
  if (st.phase !== lastPhase) {
    lastPhase = st.phase;
    if (st.phase === 'open') hud.toast('The doors are open!', 'good');
  }

  // Where we are drawn: predicted while we move, else interpolated.
  const renderAt = clock.renderTime(now);
  const predicting = PREDICT && !!mine && shouldPredict(st.phase);
  const myPos = mine
    ? ((predicting ? predictor.sample(now) : null) ??
      (renderAt === null ? null : chefBuf.sampleAt(me, renderAt)) ?? { x: mine.x, y: mine.y, vx: 0, vy: 0 })
    : null;

  // Input: the stick, the button and the target it will use → the server (on change, ≤ 20 Hz) and the predictor.
  const live = !!mine && inputLive() && shouldPredict(st.phase);
  const move: Vec2 = live ? controls.move : { x: 0, y: 0 };
  if (Math.hypot(move.x, move.y) > 0.2) myFace = Math.atan2(move.y, move.x);
  const held = mine ? decodeItem(mine.held) : null;
  target = live && myPos ? pickTarget(world, { x: myPos.x, y: myPos.y, face: myFace, held }) : -1;
  const sent = net.offer({ move, button: live && controls.button, presses: controls.presses, target }, now);
  if (sent) predictor.recordStick(now, { x: sent.mx, y: sent.my });

  // The button: what a tap / a hold will do, and the progress of the work under it.
  const act = target >= 0 ? actionFor(world, held, target) : null;
  const work = target >= 0 ? workFor(world, held, target) : null;
  const label = actionLabel(act, work);
  const workProgress = work && target < 100 ? (st.stations[target]?.progress ?? 0) / 100 : 0;
  hud.setAction(label.label, label.icon, mine && mine.act !== ChefAct.none ? workProgress : 0, !label.label);
  // The knife's tick while our chef chops, a soft scrub while washing.
  if (mine && (mine.act === ChefAct.chop || mine.act === ChefAct.wash) && now - lastWorkSound > 230) {
    lastWorkSound = now;
    if (mine.act === ChefAct.chop) sfx.chop();
    else sfx.wash();
  }
  scene.highlight(gameSettings.highlight || controls.button ? target : -1, bs);

  // Chefs.
  const present = new Set<string>();
  labels.begin();
  const cheer = st.phase === 'night' || st.phase === 'over';
  st.players.forEach((p, id) => {
    present.add(id);
    const isMe = id === me;
    const s = (isMe && myPos ? myPos : null) ??
      (renderAt === null ? null : chefBuf.sampleAt(id, renderAt)) ?? { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    const speed = Math.hypot(s.vx ?? 0, s.vy ?? 0);
    const face = isMe ? myFaceFor(p, s, speed) : p.face;
    scene.setChef(id, {
      x: s.x,
      y: s.y,
      face,
      slot: p.slot,
      held: decodeItem(p.held),
      act: p.act,
      speed,
      cheer,
      me: isMe,
    });
    if (scene.toScreen(s.x, s.y, 2.05, tmpScreen)) {
      const el = labels.get(`chef:${id}`, `name-tag${isMe ? ' me' : ''}`, tmpScreen.x, tmpScreen.y);
      const text = isMe ? 'You' : p.bot ? `${p.name} · BOT` : p.name;
      if (el.textContent !== text) el.textContent = text;
      el.style.setProperty('--c', SLOT_COLORS[p.slot % 4]!);
      el.style.opacity = p.connected ? '1' : '0.45';
    }
  });
  for (const id of chefsDrawn) if (!present.has(id)) scene.removeChef(id);
  chefsDrawn = present;

  // Customers.
  const custPresent = new Set<string>();
  st.customers.forEach((c, id) => {
    custPresent.add(id);
    const s = (renderAt === null ? null : custBuf.sampleAt(id, renderAt)) ?? { x: c.x, y: c.y };
    const state = customerState(c.state);
    const seat = SEATS[c.seat];
    const prev = custLast.get(id);
    let face = prev?.face ?? -Math.PI / 2;
    const walking = state === 'walkIn' || state === 'walkOut';
    if (walking && prev && Math.hypot(s.x - prev.x, s.y - prev.y) > 0.002)
      face = Math.atan2(s.y - prev.y, s.x - prev.x);
    else if (!walking && seat) face = seat.face;
    custLast.set(id, { x: s.x, y: s.y, face });
    const mood =
      state === 'walkIn' || state === 'walkOut'
        ? 'walk'
        : state === 'sit'
          ? 'sit'
          : state === 'eat'
            ? 'eat'
            : state === 'happy'
              ? 'happy'
              : state === 'angry'
                ? 'angry'
                : 'wait';
    scene.setCustomer(id, { x: s.x, y: s.y, face, look: c.look, vip: c.vip, mood, waving: c.waving });
    // The order bubble while waiting.
    if (state === 'wait' && scene.toScreen(s.x, s.y, 2.0, tmpScreen)) {
      const orders = (c.vip ? [c.o0, c.o1, c.o2] : [c.o0]) as Kind[];
      const p = c.patience / 100;
      const el = labels.get(`order:${id}`, `order${c.vip ? ' vip' : ''}`, tmpScreen.x, tmpScreen.y);
      const key = `${orders.join(',')}:${c.course}:${Math.round(p * 50)}:${gameSettings.orderHints}:${hud.icons.size}`;
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.dataset.dish = String(orders[c.vip ? c.course : 0]);
        el.innerHTML = orderHtml(hud.icons, orders, c.vip ? c.course : 0, p, gameSettings.orderHints);
        el.style.setProperty('--pc', patienceColor(p));
      }
      el.classList.toggle('wave', c.waving);
    }
  });
  for (const id of custDrawn) {
    if (!custPresent.has(id)) {
      scene.removeCustomer(id);
      custLast.delete(id);
    }
  }
  custDrawn = custPresent;

  // Stations, the belt, the seats.
  for (let i = 0; i < STATIONS.length; i++) {
    const v = st.stations[i];
    if (!v) continue;
    scene.setStation(i, v, world);
    stationLabel(i, v, world, st);
  }
  const slots = [];
  for (let i = 0; i < BELT_SLOTS; i++) {
    const s = st.slots[i];
    slots.push({ item: s ? decodeItem(s.item) : null, stale: s?.stale ?? false, age: (s?.age ?? 0) / 100 });
    if (s?.stale) {
      const p = beltPoint(bs + (i * BELT_LENGTH) / BELT_SLOTS);
      if (scene.toScreen(p.x, p.y, 1.55, tmpScreen))
        labels.get(`stale:${i}`, 'stale-tag', tmpScreen.x, tmpScreen.y).textContent = '🪰';
    }
  }
  scene.setBelt(NOSCROLL ? 0 : bs, slots);
  for (let i = 0; i < SEATS.length; i++) {
    const v = st.seats[i];
    if (v) scene.setSeat(i, v.dirty, v.eating as Kind);
  }
  if (NOLABELS) labels.begin();
  labels.end();

  hud.render(st, me, resultDay === `${st.run}:${st.day}` || st.phase === 'over' ? lastResult : 'pending');
  controls.draw();
}

let lastWorkSound = 0;
let chefsDrawn = new Set<string>();
let custDrawn = new Set<string>();
const custLast = new Map<string, { x: number; y: number; face: number }>();

/** Our chef faces its stick while moving, what it works on, else the station it would use. */
function myFaceFor(p: { act: number; face: number }, at: { x: number; y: number }, speed: number): number {
  if (p.act !== ChefAct.none) return p.face;
  if (speed > 0.3 || target < 0 || !net) return myFace;
  const t = targetPoint(worldOf(net.state), target);
  return t ? Math.atan2(t.y - at.y, t.x - at.x) : myFace;
}

/** Progress rings and chips over the stations. */
function stationLabel(
  i: number,
  v: { item: number; mat: number; state: number; count: number; progress: number },
  world: ReturnType<typeof worldOf>,
  st: SushiStateView,
) {
  const def = STATIONS[i]!;
  if (def.zone && !(st.zones & def.zone)) return;
  const type = stationType(def, world);
  const at = (h: number) => scene.toScreen(def.x, def.y, h, tmpScreen);
  const ring = (key: string, p: number, color: string, text = '', warn = false) => {
    if (!at(1.55)) return;
    const el = labels.get(key, 'prog', tmpScreen.x, tmpScreen.y);
    el.style.setProperty('--p', String(Math.round(p * 100)));
    el.style.setProperty('--pc', color);
    el.classList.toggle('warn', warn);
    if (el.textContent !== text) el.textContent = text;
  };
  const chip = (key: string, text: string, bad = false, h = 1.45) => {
    if (!at(h)) return;
    const el = labels.get(key, `chip${bad ? ' bad' : ''}`, tmpScreen.x, tmpScreen.y);
    if (el.textContent !== text) el.textContent = text;
  };
  switch (type) {
    case 'board':
    case 'sink':
      if (v.progress > 0) ring(`st:${i}`, v.progress / 100, '#6fcf7a');
      if (type === 'sink' && v.count > 0) chip(`ct:${i}`, `${v.count} to wash`, false, 1.9);
      return;
    case 'mat': {
      if (v.progress > 0) ring(`st:${i}`, v.progress / 100, '#6fcf7a');
      const items = matItems(v.mat);
      if (items.length && !v.item) {
        const r = matchRecipe(items, st.day);
        if (r && at(1.5)) {
          const el = labels.get(`mat:${i}`, 'matbox', tmpScreen.x, tmpScreen.y);
          const url = hud.icons.get(r.dish);
          const html = url ? `<span class="result" style="background-image:url(${url})"></span>` : esc(String(r.dish));
          if (el.innerHTML !== html) el.innerHTML = html;
        }
      }
      return;
    }
    case 'rice':
    case 'pot':
    case 'steamer':
      if (v.state === Cook.cooking) ring(`st:${i}`, v.progress / 100, '#f2b324', '🔥');
      else if (v.state === Cook.ready) chip(`ct:${i}`, `×${v.count}`);
      return;
    case 'pan':
      if (v.state === Pan.cooking) ring(`st:${i}`, v.progress / 100, '#f2b324', '🔥');
      else if (v.state === Pan.done) chip(`ct:${i}`, 'Ready!');
      else if (v.state === Pan.smoking) ring(`st:${i}`, 1, '#e0453a', '!', true);
      else if (v.state === Pan.burnt) chip(`ct:${i}`, 'Burnt', true);
      return;
    case 'plates':
      if (v.count >= 0 && v.count <= 4) chip(`ct:${i}`, v.count ? `${v.count} plates` : 'No plates!', true, 1.6);
      return;
    case 'crate':
      // Delivery days: only the crates running low say so (the rest would crowd the counter).
      if (v.count >= 0 && v.count <= 2 && def.crate !== undefined)
        chip(`ct:${i}`, v.count ? `${v.count} left` : 'Empty', true, 1.35);
      return;
    case 'drop':
      if (v.count > 0) chip(`ct:${i}`, '📦 Delivery!', false, 1.2);
      return;
    default:
      return;
  }
}
app.on('update', (dt: number) => frame(dt));

// --- telemetry -------------------------------------------------------------------------------------------------
function collect() {
  const f = metrics.snapshot();
  const gd = app.graphicsDevice;
  return {
    fps: f.fps,
    frameMs: f.frameMs,
    p95Ms: f.p95Ms,
    worstMs: f.worstMs,
    wsRttMs: net?.rttMs ?? -1,
    chefs: net?.state?.players?.size ?? 0,
    customers: net?.state?.customers?.size ?? 0,
    day: net?.state.day ?? 0,
    phase: net?.state.phase ?? 'none',
    graphics,
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    readyMs,
    heapMb: jsHeapMb() ?? -1,
  };
}
setInterval(() => rally.telemetry.report('sushi', collect()), TELEMETRY_MS);

// --- boot ----------------------------------------------------------------------------------------------------------
function reportReconnection() {
  if (!rally.isHosted || !net) return;
  void rally.session
    .reportReconnection({ roomId: net.room.roomId, token: net.room.reconnectionToken, ttlSec: RECONNECT_TTL_SEC })
    .catch(() => {});
}

const netSent = { count: 0, last: '' };
function netStatus(state: 'connected' | 'reconnecting' | 'disconnected') {
  netSent.count++;
  netSent.last = state;
  if (!rally.isHosted) return;
  const rtt = net?.rttMs;
  rally.net.status(state, state === 'connected' && rtt !== null && rtt !== undefined ? rtt : undefined);
}

function toWs(url: string) {
  return url.replace(/^http/, 'ws').replace(/\/+$/, '');
}

/** Keep the HUD out of the host's menu button (its rect, else safe-area + 56 px). */
function reserveMenuButton(rect: { x: number; y: number; width: number; height: number } | undefined) {
  if (!rect) return;
  document.documentElement.style.setProperty('--menu-w', `${Math.ceil(rect.x + rect.width + 6)}px`);
  document.documentElement.style.setProperty('--menu-h', `${Math.ceil(rect.y + rect.height + 6)}px`);
}

async function boot() {
  const models = await loadSushiModels(app, (f, label) => loading(0.04 + f * 0.6, label));
  loading(0.66, 'Setting up the restaurant');
  app.start();
  const built = await createSceneSafe(app, onResize, models, LOWFX ? renderQuality('low') : renderQuality(graphics));
  scene = built.scene;
  hud.setIcons(built.icons);
  loading(0.82, 'Setting up the restaurant');
  let username = params.get('name') ?? 'chef';
  if (rally.isHosted) {
    const ctx = await rally.ready();
    applySafeAreaVars(safeArea(ctx.device.safeArea));
    reserveMenuButton(ctx.device.menuButton);
    username = ctx.user.username;
    applySettings(rally.settings);
  } else {
    applySafeAreaVars(safeArea());
  }
  void defineMenu();
  readyMs = Math.round(performance.now() - bootStart);
  if (exiting) return;
  loading(0.88, 'Connecting to the server');
  joining = (async () => {
    if (import.meta.env.DEV && ART) {
      const art = await import('./art.ts');
      if (!art.isArtShot(ART)) throw new Error(`?art=${ART}: expected one of ${art.ART_SHOTS.join(', ')}`);
      return art.stageArt(ART, { app, scene, hud });
    }
    if (rally.isHosted) {
      const { endpoint, seatReservation } = await rally.session.join();
      loading(0.94, 'Joining your crew');
      return connect(endpoint, { seatReservation });
    }
    const endpoint = toWs(params.get('colyseus') ?? `ws://${location.hostname || 'localhost'}:2567`);
    loading(0.94, 'Joining your crew');
    return connect(endpoint, {
      roomName: 'sushi',
      options: { username, ...(params.has('private') ? { private: true } : {}) },
    });
  })();
  let joined: Net;
  try {
    joined = await joining;
  } catch (err) {
    if (exiting) return;
    ui.loading.hidden = true;
    loading(1);
    hud.setMessage("Couldn't join", err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (exiting) {
    await joined.leave().catch(() => {});
    return;
  }
  net = joined;
  me = net.sessionId;
  hud.setMessage(null);
  net.room.send(ClientMessage.profile, { username });
  net.onPatch(onPatch);
  net.onFx(onFx);
  net.onResult((r) => {
    lastResult = r;
    const st = net?.state;
    resultDay = st ? `${st.run}:${st.day}` : '';
  });
  reportReconnection();
  // The connection for the host's ping bars and its own "Reconnecting…" banner (ours only in a plain browser).
  let connected = true;
  netStatus('connected');
  setInterval(() => {
    if (connected && !exiting) netStatus('connected');
  }, 2000);
  net.room.onDrop(() => {
    connected = false;
    netStatus('reconnecting');
    if (!rally.isHosted) hud.setMessage('Connection lost', 'Reconnecting…');
  });
  net.room.onReconnect(() => {
    connected = true;
    netStatus('connected');
    hud.setMessage(null);
    reportReconnection();
  });
  net.room.onLeave((code) => {
    connected = false;
    netStatus('disconnected');
    if (!exiting && !rally.isHosted) hud.setMessage('Disconnected', `The server closed the connection (${code}).`);
  });
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
  loading(1);
});

// Dev-only probe for the Playwright e2e, perf and art scripts (stripped from production builds).
if (import.meta.env.DEV) {
  const find = (name: string) => {
    let found: { id: string; p: ReturnType<SushiStateView['players']['get']> } | null = null;
    net?.state?.players?.forEach((p, id) => {
      if (p.name === name) found = { id, p };
    });
    return found as { id: string; p: NonNullable<ReturnType<SushiStateView['players']['get']>> } | null;
  };
  (window as unknown as { __sushi: unknown }).__sushi = {
    get joined() {
      return net !== null && playable;
    },
    get lowfx() {
      return LOWFX;
    },
    get me() {
      return me;
    },
    get roomId() {
      return net?.room.roomId ?? '';
    },
    get phase() {
      return net?.state.phase ?? null;
    },
    get day() {
      return net?.state.day ?? 0;
    },
    get zones() {
      return net?.state.zones ?? 0;
    },
    get stars() {
      return net?.state.stars ?? 0;
    },
    get money() {
      return net?.state.money ?? 0;
    },
    get served() {
      return net?.state.served ?? 0;
    },
    get tips() {
      return net?.state.tips ?? 0;
    },
    get code() {
      return net?.state.code ?? '';
    },
    get target() {
      return target;
    },
    get action() {
      return (document.getElementById('action-label')?.textContent ?? '').trim();
    },
    get held() {
      const p = net?.state.players.get(me);
      return p ? (decodeItem(p.held)?.kind ?? 0) : 0;
    },
    get heldPlated() {
      const p = net?.state.players.get(me);
      return p ? (decodeItem(p.held)?.plated ?? false) : false;
    },
    get seen() {
      return { ...seen, fx: [...seen.fx] };
    },
    get result() {
      return lastResult;
    },
    get resultLine() {
      const el = document.querySelector<HTMLElement>('[data-role="result"]');
      return el ? { kind: el.dataset.kind ?? '', text: el.textContent ?? '' } : null;
    },
    get nightVisible() {
      return !(document.getElementById('night') as HTMLElement).hidden;
    },
    get cards() {
      return net?.state.cards ?? '';
    },
    get menu() {
      return { ...menuSent };
    },
    get netStatus() {
      return { ...netSent };
    },
    get fps() {
      return metrics.snapshot();
    },
    get stats() {
      const s = app.stats as unknown as { drawCalls: { total: number; shadow: number } };
      return { draws: s.drawCalls.total, shadowDraws: s.drawCalls.shadow };
    },
    get drawn() {
      return { chefs: scene?.drawnChefs ?? 0, customers: scene?.drawnCustomers ?? 0 };
    },
    names() {
      const out: string[] = [];
      net?.state?.players?.forEach((p) => out.push(p.name));
      return out.sort();
    },
    player(name: string) {
      const f = find(name);
      return f ? { x: f.p.x, y: f.p.y, held: decodeItem(f.p.held), act: f.p.act, bot: f.p.bot, slot: f.p.slot } : null;
    },
    station(id: number) {
      const s = net?.state.stations[id];
      return s
        ? { item: decodeItem(s.item), mat: matItems(s.mat), state: s.state, count: s.count, progress: s.progress }
        : null;
    },
    slots() {
      const out: { i: number; kind: number; stale: boolean }[] = [];
      const st = net?.state;
      if (!st) return out;
      for (let i = 0; i < BELT_SLOTS; i++) {
        const s = st.slots[i];
        if (s?.item) out.push({ i, kind: decodeItem(s.item)!.kind, stale: s.stale });
      }
      return out;
    },
    /** Belt slot `i`'s position now (sim units). */
    slotPos(i: number) {
      const st = net?.state;
      return st ? beltPoint(beltNow(performance.now(), st) + (i * BELT_LENGTH) / BELT_SLOTS) : null;
    },
    customers() {
      const out: { id: string; seat: number; state: string; order: number; patience: number }[] = [];
      net?.state.customers.forEach((c, id) =>
        out.push({ id, seat: c.seat, state: customerState(c.state), order: c.o0, patience: c.patience }),
      );
      return out;
    },
    /** Order bubbles drawn (their dish kinds). */
    bubbles() {
      return [...document.querySelectorAll<HTMLElement>('#labels .order')].map((e) => Number(e.dataset.dish));
    },
    staleTags() {
      return document.querySelectorAll('#labels .stale-tag').length;
    },
    screenOf(x: number, y: number, h = 0) {
      const out = { x: 0, y: 0 };
      scene.toScreen(x, y, h, out);
      const r = ui.canvas.getBoundingClientRect();
      return { x: out.x + r.left, y: out.y + r.top };
    },
    dev(cmd: DevCommand) {
      net?.dev(cmd);
    },
    lessons: Object.keys(LESSONS),
  };
}
