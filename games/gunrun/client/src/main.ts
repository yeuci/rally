import {
  RenderClock,
  SnapshotBuffer,
  applySafeAreaVars,
  assistAim,
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
} from '@rally/game-kit';
import { rally, type MenuPlayer, type PlayerSettings } from '@rally/sdk';
import {
  CAMERA_LEAD,
  ClientMessage,
  DT,
  FINAL_TIER,
  KNIFE_SPEED,
  PATCH_MS,
  PLAYER_RADIUS,
  WEAPON_IDS,
  WEAPONS,
  fromFx,
  tierWeapon,
  type DevCommand,
  type FxBatch,
  type FxEvent,
  type GunRunPlayerView,
  type GunRunStateView,
  type Vec2,
} from '@rally/game-gunrun-server';
import { createControls } from './controls.ts';
import { createHud, esc } from './hud.ts';
import { LocalGun, shotAngles, tracerLength } from './localgun.ts';
import { applyLowFx } from './lowfx.ts';
import { loadGunRunModels } from './models.ts';
import { connect, type Net } from './net.ts';
import { Predictor, shouldPredict } from './predict.ts';
import { MatchResultView } from './result.ts';
import { createGunRunScene, type GunRunScene } from './scene.ts';
import { createSfx } from './sfx.ts';

const TELEMETRY_MS = 10_000;
/** Reconnection grace the room grants (RallyRoom.reconnectSeconds); reported to the host for "Rejoin match?". */
const RECONNECT_TTL_SEC = 60;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  stickMove: $('stick-move'),
  stickAim: $('stick-aim'),
  knife: $('knife'),
  paused: $('paused'),
  exit: $<HTMLButtonElement>('exit'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
  loadingLabel: $('loading-label'),
  loadingDetail: $('loading-detail'),
  hint: $('hint'),
};
const params = new URLSearchParams(location.search);
/** `?predict=0` draws your own player interpolated like everyone else (to compare). */
const PREDICT = params.get('predict') !== '0';
/** Dev only: `?art=<shot>` stages a frozen scene for the store art (src/art.ts). */
const ART = import.meta.env.DEV ? params.get('art') : null;
/**
 * Dev only: `?lowfx=1` draws at most 15 fps at DPR 1, without clustered lighting, MSAA, shadows, bursts or camera
 * shake (src/lowfx.ts). The Playwright e2e opens every page with it.
 */
const LOWFX = import.meta.env.DEV && !ART && params.has('lowfx') && params.get('lowfx') !== '0';

/**
 * Boot progress through the join, in the host's loading screen (labelled, so it stays up until `done()`: the player
 * lands in a joined match) and in the page's own veil (standalone / dev), with the same words in both. The models are
 * most of it, reported by the byte.
 */
const loader = createBootProgress({
  host: rally,
  veil: { root: ui.loading, bar: ui.loadingBar, label: ui.loadingLabel, detail: ui.loadingDetail },
  stages: [
    { id: 'start', label: 'Starting the game', weight: 1 },
    { id: 'models', label: 'Downloading characters and weapons', weight: 6 },
    { id: 'arena', label: 'Building the arena', weight: 1.5 },
    { id: 'match', label: 'Finding players', weight: 1.5 },
    { id: 'join', label: 'Joining the match', weight: 1 },
  ],
});

const bootStart = performance.now();

// --- engine, scene, HUD, input -----------------------------------------------------------------------
/**
 * The host's game menu sets the graphics quality (DPR, shadows, effects: live; MSAA from the quality chosen last time,
 * at boot). `?lowfx` (e2e), `?art` and the dev perf knobs keep their own settings.
 */
const PERF_KNOBS = import.meta.env.DEV && ['noaa', 'noshadow', 'nofx'].some((k) => params.has(k));
const FIXED_GRAPHICS = LOWFX || !!ART || PERF_KNOBS;
const bootGraphics = graphicsPreset(rememberedGraphics());
const { app, onResize, setMaxPixelRatio } = createApp({
  canvas: ui.canvas,
  ...(FIXED_GRAPHICS ? {} : { antialias: bootGraphics.antialias, maxPixelRatio: bootGraphics.maxPixelRatio }),
  ...(ART ? { maxPixelRatio: 3 } : {}),
  ...(LOWFX ? { maxPixelRatio: 1, antialias: false } : {}),
  // Dev-only render knobs for perf measurements (test/perf.cjs PERF_QUERY): ?noaa, ?noshadow, ?nofx.
  ...(import.meta.env.DEV && params.has('noaa') ? { antialias: false } : {}),
});
if (LOWFX) applyLowFx(app);
/** Built in boot(), once the models are in (≈ 600 KB gzipped): nothing draws before that. */
let scene!: GunRunScene;
const sceneOptions = LOWFX
  ? { shadows: false, effects: false }
  : FIXED_GRAPHICS
    ? {
        shadows: !(import.meta.env.DEV && params.has('noshadow')),
        effects: !(import.meta.env.DEV && params.has('nofx')),
      }
    : { shadows: bootGraphics.shadows, effects: bootGraphics.effects };
const hud = createHud();
const controls = createControls(ui.canvas, ui.stickMove, ui.stickAim, ui.knife);
const audio = createAudio();
const sfx = createSfx(audio);
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());
loader.progress(1);

// --- netcode state -------------------------------------------------------------------------------------
let net: Net | null = null;
let joining: Promise<Net> | null = null;
let me = '';
let readyMs = -1;
let exiting = false;
/**
 * Everything remote is drawn on the SERVER's timeline (`tick` × DT), 2–3 patch intervals behind the estimated server
 * time (game-kit netclock): players on Hermite curves through positions and velocities, rockets and grenades
 * linearly. Effects arrive with their tick and play when the render time reaches it, so a tracer, the hit sparks and
 * the kill line up with where the players are drawn. The render tick goes back to the server with every input: lag
 * compensation rewinds the others to it for our shots.
 */
const clock = new RenderClock({ intervalMs: PATCH_MS });
const playersBuf = new SnapshotBuffer({
  fields: ['x', 'y', 'vx', 'vy'] as const,
  rates: { x: 'vx', y: 'vy' },
  extrapolateMs: PATCH_MS,
});
const shellBuf = new SnapshotBuffer({ fields: ['x', 'y', 'h', 'kind'] as const, capacity: 24 });
const predictor = new Predictor();
const gun = new LocalGun();
const results = new MatchResultView();
const fxQueue: FxBatch[] = [];
const labels = new Map<string, HTMLElement>();
let lastResult: unknown = null;
let lastMatch = -1;
let lastPhase = '';
let aimDir: Vec2 = { x: 0, y: -1 };
/** Whether the controls aimed yet: until then we face (and shoot) the way the server has us facing. */
let aimed = false;
let mySlot = -1;
const seen = { kills: 0, tiers: 0, feed: [] as string[] };
/** Players as drawn last frame (local tracers stop on them). */
const drawnTargets: { x: number; y: number; r: number }[] = [];

function releaseInput() {
  const now = performance.now();
  const sent = net?.release(now);
  if (sent) predictor.recordStick(now, { x: 0, y: 0 });
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
    const joined = net ?? (await joining?.catch(() => null));
    await joined?.leave().catch(() => {});
    if (!rally.isHosted) hud.setMessage('You left the game', 'Reload to play again');
  },
  onLowMemory: () => {
    scene?.trim(); // not built yet while the models load
    audio.close();
  },
  // The host's game menu: the match keeps going underneath, but nothing we hold keeps moving or firing.
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
    { type: 'toggle' as const, key: 'showNames', label: 'Names over players', default: true },
    { type: 'toggle' as const, key: 'screenShake', label: 'Screen shake', default: true },
  ],
  help: [
    {
      title: 'Move and shoot',
      text: 'Left thumb moves. Right thumb aims and fires while held. On a computer: WASD and the mouse.',
    },
    {
      title: 'Climb the ladder',
      text: 'Every three kills promote you to the next gun, from pistol up to the rocket launcher.',
    },
    { title: 'Win with the knife', text: 'The last rung is the knife: one knife kill wins the match.' },
    {
      title: 'Stab to demote',
      text: 'Tap the knife button (right mouse, F or Shift) to stab. A stab sends the victim down a rung.',
    },
    { title: 'Barrels and med kits', text: 'Shoot red barrels to blow up anyone nearby. Grab med kits to heal.' },
    { title: 'Respawns', text: 'You come back a few seconds after going down, keeping your rung.' },
  ],
};
/** Aim assist, from the menu's touch controls. */
let aimAssist = true;
function applySettings(s: PlayerSettings) {
  audio.volume = effectsVolume(s);
  controls.configure(s.controls);
  aimAssist = s.controls.aimAssist;
  ui.labels.hidden = s.game.showNames === false;
  ui.hint.textContent = s.controls.swapSticks
    ? 'Right thumb: move · Left thumb: aim & fire · 🔪 knife'
    : 'Left thumb: move · Right thumb: aim & fire · 🔪 knife';
  const g = graphicsPreset(s.graphics);
  if (!FIXED_GRAPHICS) {
    setMaxPixelRatio(g.maxPixelRatio);
    if (rally.isHosted) rememberGraphics(s.graphics);
  }
  scene?.setQuality({
    shadows: FIXED_GRAPHICS ? sceneOptions.shadows : g.shadows,
    effects: FIXED_GRAPHICS ? sceneOptions.effects : g.effects,
    shake: s.game.screenShake !== false,
  });
}
const settings = bindSettings(rally, applySettings);
/** Connection for the host's ping bars and its Reconnecting / Connection lost banner. */
const netStatus = createNetStatus(rally, { rtt: () => net?.rttMs ?? null });
let playersKey = '';
/** Who is in the match, for the menu's People list: on join and whenever the roster, kills or rungs change. */
function reportPlayers() {
  if (!net?.state?.players || !rally.isHosted) return;
  const players: MenuPlayer[] = [];
  net.state.players.forEach((p, id) =>
    players.push({
      name: `${p.name.slice(0, 26) || 'Player'}${p.bot ? ' (bot)' : ''}`,
      detail: `${p.kills} ${p.kills === 1 ? 'kill' : 'kills'} · ${tierWeapon(p.tier).name}`.slice(0, 24),
      ...(id === me ? { you: true } : {}),
    }),
  );
  players.sort((a, b) => Number(!!b.you) - Number(!!a.you) || a.name.localeCompare(b.name));
  const key = JSON.stringify(players);
  if (key === playersKey) return;
  playersKey = key;
  rally.menu.players(players.slice(0, 16));
}
/** Touch aim gently snapped toward an opponent inside a narrow cone (aim assist). */
function assisted(dir: Vec2, myPos: Vec2): Vec2 {
  if (!aimAssist || !net?.state?.players) return dir;
  const targets: Vec2[] = [];
  net.state.players.forEach((p, id) => {
    if (id !== me && p.alive) targets.push({ x: p.x, y: p.y });
  });
  return assistAim(dir, myPos, targets, { range: 13, minRange: 0.6 });
}
const stopInput = () => {
  controls.release();
  releaseInput();
};
window.addEventListener('blur', stopInput);
window.addEventListener('pagehide', stopInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopInput();
});
hud.onStart(() => net?.start());

// --- effects ---------------------------------------------------------------------------------------------
const bySlot = (st: GunRunStateView, slot: number): GunRunPlayerView | null => {
  let found: GunRunPlayerView | null = null;
  st.players.forEach((p) => {
    if (p.slot === slot) found = p;
  });
  return found;
};
const weaponAt = (w: number) => WEAPONS[WEAPON_IDS[w] ?? 'pistol'];
const idOfSlot = (st: GunRunStateView, slot: number): string | null => {
  let found: string | null = null;
  st.players.forEach((p, id) => {
    if (p.slot === slot) found = id;
  });
  return found;
};

/** Effects that matter to you right now are played on arrival; the rest wait for the render time (playFx). */
function onFx(batch: FxBatch) {
  for (const e of batch.e) {
    if (e.k === 'hit' && e.p === mySlot && e.d > 0) {
      hud.hurt(e.d);
      sfx.hit(true);
      scene.shake(0.12);
    } else if (e.k === 'tier' && e.p === mySlot) {
      const w = tierWeapon(e.tier);
      if (e.up) {
        hud.toast(`${w.icon} ${e.tier >= FINAL_TIER ? 'Knife: one stab wins!' : `Promoted: ${w.name}`}`, 'up');
        sfx.promote();
        gun.ready();
      } else {
        hud.toast(`⬇ Knifed down to ${w.name}`, 'bad');
        sfx.demote();
      }
    } else if (e.k === 'kill' && e.p === mySlot) {
      sfx.died();
    } else if (e.k === 'phase' && e.phase === 'playing') {
      hud.toast('Go!', 'good');
      sfx.go();
    }
  }
  fxQueue.push(batch);
  if (fxQueue.length > 120) fxQueue.splice(0, fxQueue.length - 120);
}

function playFx(e: FxEvent, st: GunRunStateView, myPos: Vec2 | null) {
  switch (e.k) {
    case 'shot': {
      if (e.p === mySlot || e.r.length < 4) break; // ours were drawn when we fired
      const w = weaponAt(e.w);
      const ends: number[] = [];
      for (let i = 0; i + 3 < e.r.length; i += 4) ends.push(fromFx(e.r[i + 2]!), fromFx(e.r[i + 3]!));
      const [x0, y0, x1, y1] = e.r.slice(0, 4).map(fromFx) as [number, number, number, number];
      scene.shot(idOfSlot(st, e.p), x0, y0, Math.atan2(y1 - y0, x1 - x0), w, ends);
      sfx.shot(w.id, false);
      break;
    }
    case 'launch':
      if (e.p === mySlot) break;
      scene.shot(idOfSlot(st, e.p), fromFx(e.x), fromFx(e.y), e.a / 1000, weaponAt(e.w), []);
      sfx.launch(false);
      break;
    case 'stab':
      if (e.p !== mySlot) scene.stab(idOfSlot(st, e.p), fromFx(e.x), fromFx(e.y), e.a / 1000);
      if (e.hit || e.p !== mySlot) sfx.stab(e.hit);
      break;
    case 'hit':
      scene.hit(fromFx(e.x), fromFx(e.y), e.p);
      if (e.by === mySlot && e.p !== mySlot) sfx.hit(false);
      break;
    case 'kill': {
      seen.kills++;
      const victim = bySlot(st, e.p);
      const killer = e.by >= 0 ? bySlot(st, e.by) : null;
      if (victim) {
        hud.feed({ killer, victim, weapon: e.w, demote: e.demote });
        seen.feed.push(`${killer?.name ?? ''}>${victim.name}${e.demote ? ' demoted' : ''}`);
      }
      if (e.by === mySlot && e.p !== mySlot) sfx.kill(true);
      break;
    }
    case 'tier':
      seen.tiers++;
      break;
    case 'boom': {
      const x = fromFx(e.x);
      const y = fromFx(e.y);
      const near = myPos ? Math.hypot(myPos.x - x, myPos.y - y) < 9 : true;
      scene.explosion(x, y, e.r);
      scene.shake(near ? 0.5 : 0.18);
      sfx.boom(near);
      break;
    }
    case 'heal':
      if (e.p === mySlot) sfx.heal();
      break;
    case 'spawn':
      if (e.p === mySlot) sfx.spawn();
      break;
    case 'win':
      sfx.win(e.p === mySlot);
      break;
    default:
      break;
  }
}

// --- patches -------------------------------------------------------------------------------------------
function onPatch(t: number) {
  if (!net) return;
  const st = net.state;
  if (!st?.players) return;
  if (st.match !== lastMatch) {
    // A new match: everyone respawned on the first rung.
    playersBuf.clear();
    shellBuf.clear();
    gun.reset();
    lastMatch = st.match;
  }
  const serverMs = st.tick * DT * 1000;
  clock.observe(serverMs, t);
  const ps: [string, { x: number; y: number; vx: number; vy: number }][] = [];
  st.players.forEach((p, id) => ps.push([id, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }]));
  playersBuf.push(serverMs, ps);
  reportPlayers();
  const pr: [string, { x: number; y: number; h: number; kind: number }][] = [];
  st.projectiles.forEach((p, id) => pr.push([id, { x: p.x, y: p.y, h: p.h, kind: p.kind }]));
  shellBuf.push(serverMs, pr);
  const mine = st.players.get(me);
  mySlot = mine?.slot ?? -1;
  predictor.rttMs = net.rttMs ?? 0;
  if (mine && PREDICT && shouldPredict(st.phase, mine.alive)) {
    predictor.rebase(
      {
        x: mine.x,
        y: mine.y,
        vx: mine.vx,
        vy: mine.vy,
        speed: mine.tier >= FINAL_TIER ? KNIFE_SPEED : 1,
        barrels: st.barrels,
      },
      clock.server.toLocal(serverMs),
      t,
    );
  } else {
    predictor.reset();
  }
}

// --- the frame -------------------------------------------------------------------------------------------
const anchor = { x: 0, y: 0 };
const screenTmp = { x: 0, y: 0 };

/** World aim direction from the controls, relative to where our player is drawn. */
function aimFromControls(myPos: Vec2): Vec2 | null {
  if (controls.device === 'mouse' && controls.mouse) {
    const g = scene.toGround(controls.mouse.x, controls.mouse.y);
    if (!g) return null;
    const dx = g.x - myPos.x;
    const dy = g.y - myPos.y;
    const len = Math.hypot(dx, dy);
    return len > 0.2 ? { x: dx / len, y: dy / len } : null;
  }
  if (controls.device === 'touch') {
    const d = controls.touchAim;
    if (!d) return null;
    // The thumb's direction on screen → the ground direction it points at (the camera is tilted).
    scene.toScreen(myPos.x, myPos.y, 1, screenTmp);
    const g = scene.toGround(screenTmp.x + d.x * 80, screenTmp.y + d.y * 80);
    if (!g) return null;
    const dx = g.x - myPos.x;
    const dy = g.y - myPos.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-3 ? assisted({ x: dx / len, y: dy / len }, myPos) : null;
  }
  const m = controls.move;
  const len = Math.hypot(m.x, m.y);
  return len > 0.2 ? { x: m.x / len, y: m.y / len } : null;
}

function frame(dt: number) {
  scene.update(dt);
  sfx.frame();
  if (!net) return;
  const now = performance.now();
  const st = net.state;
  if (!st?.players) return;
  const mine = st.players.get(me);
  if (controls.used) hud.hideHint();

  // Where we are drawn: predicted while we move on the server, else interpolated.
  const renderAt = clock.renderTime(now);
  const predicting = PREDICT && !!mine && shouldPredict(st.phase, mine.alive);
  const myPos: Vec2 | null = mine
    ? ((predicting ? predictor.sample(now) : null) ??
      (renderAt === null ? null : playersBuf.sampleAt(me, renderAt)) ?? { x: mine.x, y: mine.y })
    : null;

  // Input: aim, move, trigger, knife → the server (on change, ≤ 20 Hz, with the render tick) and the predictor.
  const live = !!mine && mine.alive && !lifecycle.isPaused && !exiting && st.phase !== 'over';
  const aim = live && myPos ? aimFromControls(myPos) : null;
  if (aim) {
    aimDir = aim;
    aimed = true;
  } else if (!aimed && mine) {
    aimDir = { x: Math.cos(mine.aim), y: Math.sin(mine.aim) };
  }
  const combat = st.phase === 'waiting' || st.phase === 'playing';
  const firing = live && combat && controls.fire;
  const stabbing = live && combat && controls.melee;
  const renderTick = renderAt === null ? st.tick : renderAt / (DT * 1000);
  const sent = net.offer(
    { move: live ? controls.move : { x: 0, y: 0 }, aim, fire: firing, melee: stabbing, rt: renderTick },
    now,
  );
  if (sent) predictor.recordStick(now, { x: sent.mx, y: sent.my });

  // Our own attacks: flash, tracer, swing and sound at once (hits come from the server).
  if (mine && myPos) {
    const weapon = tierWeapon(mine.tier);
    const { shots, stabs } = gun.update(now, weapon, firing, stabbing);
    const angle = Math.atan2(aimDir.y, aimDir.x);
    for (let s = 0; s < shots; s++) {
      // Where each ray ends is decided as on the server (from the body, along the aim); the tracer is drawn from the
      // gun's muzzle to there.
      const ends: number[] = [];
      for (const a of shotAngles(weapon, angle, Math.random() * 2 - 1)) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const ox = myPos.x + dx * 0.4;
        const oy = myPos.y + dy * 0.4;
        const len = tracerLength(ox, oy, dx, dy, weapon.range, drawnTargets);
        ends.push(ox + dx * len, oy + dy * len);
      }
      scene.shot(me, myPos.x, myPos.y, angle, weapon, ends);
      if (weapon.kind === 'hitscan') sfx.shot(weapon.id, true);
      else sfx.launch(true);
    }
    if (stabs) {
      scene.stab(me, myPos.x, myPos.y, angle);
      sfx.stab(false);
    }
  }

  // Phase cues.
  if (st.phase !== lastPhase) {
    if (st.phase === 'starting') hud.toast('Get ready', 'good');
    lastPhase = st.phase;
  }

  // Players.
  const present = new Set<string>();
  drawnTargets.length = 0;
  st.players.forEach((p, id) => {
    present.add(id);
    const isMe = id === me;
    let s = (isMe && myPos ? { ...myPos, vx: p.vx, vy: p.vy } : null) ??
      (renderAt === null ? null : playersBuf.sampleAt(id, renderAt)) ?? { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    // A respawn is a teleport: never draw the slide from where they died.
    if (p.alive && Math.hypot(s.x - p.x, s.y - p.y) > 3) s = { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    const sp = isMe && predicting ? predictor.sample(now) : null;
    scene.setPlayer(id, {
      x: s.x,
      y: s.y,
      vx: sp?.vx ?? s.vx,
      vy: sp?.vy ?? s.vy,
      aim: isMe && live ? Math.atan2(aimDir.y, aimDir.x) : p.aim,
      slot: p.slot,
      alive: p.alive,
      prot: p.prot,
      me: isMe,
      tier: p.tier,
      celebrating: st.phase === 'over' && st.winner === id,
    });
    if (!isMe && p.alive) drawnTargets.push({ x: s.x, y: s.y, r: PLAYER_RADIUS });
    let label = labels.get(id);
    if (!label) {
      label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = '<span class="n"></span><b class="hp"><s></s></b>';
      ui.labels.appendChild(label);
      labels.set(id, label);
    }
    label.classList.toggle('me', isMe);
    label.classList.toggle('bot', p.bot);
    label.classList.toggle('dead', !p.alive);
    const n = label.firstElementChild as HTMLElement;
    const text = p.bot ? `${p.name} · BOT` : isMe ? 'You' : p.name;
    if (n.textContent !== text) n.textContent = text;
    (label.children[1]!.firstElementChild as HTMLElement).style.width = `${p.alive ? p.hp : 0}%`;
    if (p.alive && st.phase !== 'over' && scene.labelAnchor(id, anchor)) {
      label.style.opacity = '1';
      label.style.transform = `translate(${anchor.x}px, ${anchor.y}px) translate(-50%, -100%)`;
    } else {
      label.style.opacity = '0';
    }
  });
  for (const [id, el] of labels) {
    if (present.has(id)) continue;
    el.remove();
    labels.delete(id);
    scene.removePlayer(id);
  }

  // The yard's barrels and med kits (as they are now), rockets and grenades (interpolated).
  scene.setBarrels(st.barrels);
  scene.setMeds(st.meds);
  if (renderAt !== null) {
    for (const key of shellBuf.idsAt(renderAt)) {
      const s = shellBuf.sampleAt(key, renderAt);
      if (s) scene.setProjectile(key, Math.round(s.kind), s.x, s.y, s.h);
    }
  }
  scene.prune();

  // Effects due at the render time.
  while (fxQueue.length && (renderAt === null || fxQueue[0]!.t * DT * 1000 <= renderAt)) {
    const batch = fxQueue.shift()!;
    for (const e of batch.e) playFx(e, st, myPos);
  }

  // Camera: on us (where we fell while dead); on the winner while the banner is up, low on the screen under it.
  const winner = st.phase === 'over' ? st.players.get(st.winner) : undefined;
  const f = winner ? { x: winner.x, y: winner.y - 4.2 } : (myPos ?? { x: 0, y: 0 });
  // Mouse: lead by where the cursor is on screen (aiming at a ground point that moves with the camera would feed back).
  const cursor = controls.device === 'mouse' ? controls.mouse : null;
  const rect = ui.canvas.getBoundingClientRect();
  const lead =
    cursor && rect.width > 0
      ? {
          x: Math.max(-1, Math.min(1, (cursor.x - rect.width / 2) / (rect.width / 2))) * CAMERA_LEAD,
          y: Math.max(-1, Math.min(1, (cursor.y - rect.height / 2) / (rect.height / 2))) * CAMERA_LEAD * 0.7,
        }
      : undefined;
  scene.focus(f.x, f.y, live ? aimDir : null, false, live ? lead : undefined);

  results.observe(st.phase, now);
  hud.render(st, me, net.rttMs, results.current());
  controls.draw();
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
setInterval(() => rally.telemetry.report('gunrun', collect()), TELEMETRY_MS);

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
  loader.stage('models');
  const models = await loadGunRunModels(app, (f, bytes) => loader.progress(f, bytes));
  loader.stage('arena');
  scene = createGunRunScene(app, (fn) => onResize(fn), models, sceneOptions);
  settings.refresh();
  app.start();
  loader.progress(0.5);
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
      (err: unknown) => console.warn('[gunrun] menu.define failed', err),
    );
  } else {
    applySafeAreaVars(safeArea());
  }
  readyMs = Math.round(performance.now() - bootStart);

  if (exiting) return;
  hud.setMessage('Joining…');
  joining = (async () => {
    if (import.meta.env.DEV && ART) {
      const art = await import('./art.ts');
      if (!art.isArtShot(ART)) throw new Error(`?art=${ART}: expected one of ${art.ART_SHOTS.join(', ')}`);
      return art.stageArt(ART, { app, scene, hud });
    }
    if (rally.isHosted) {
      loader.stage('match', matchmakingLabel(rally.context));
      const { endpoint, seatReservation } = await rally.session.join();
      loader.stage('join');
      return connect(endpoint, { seatReservation });
    }
    loader.stage('match', 'Connecting to the server');
    const endpoint = toWs(params.get('colyseus') ?? `ws://${location.hostname || 'localhost'}:2567`);
    return connect(endpoint, {
      roomName: 'gunrun',
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

// Dev-only probe for the Playwright e2e, perf and art scripts (stripped from production builds).
if (import.meta.env.DEV) {
  const find = (name: string): { id: string; p: GunRunPlayerView } | null => {
    let found: { id: string; p: GunRunPlayerView } | null = null;
    net?.state?.players?.forEach((p, id) => {
      if (p.name === name) found = { id, p };
    });
    return found;
  };
  (window as unknown as { __gunrun: unknown }).__gunrun = {
    get joined() {
      return net !== null;
    },
    get lowfx() {
      return LOWFX;
    },
    get me() {
      return me;
    },
    get phase() {
      return net?.state.phase ?? null;
    },
    get match() {
      return net?.state.match ?? 0;
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
    get winner() {
      const w = net?.state.winner ? net.state.players.get(net.state.winner) : undefined;
      return w?.name ?? '';
    },
    get result() {
      return lastResult;
    },
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
    /** Kill and tier effects this page has played (at its render time); the feed as `killer>victim` lines. */
    get killsSeen() {
      return seen.kills;
    },
    get tiersSeen() {
      return seen.tiers;
    },
    get feed() {
      return [...seen.feed];
    },
    get drawnPlayers() {
      return scene.drawnPlayers;
    },
    get fps() {
      return metrics.snapshot();
    },
    /** Draw calls of the last frame (all passes, and the shadow pass's). */
    get stats() {
      const st = app.stats as unknown as { drawCalls: { total: number; shadow: number } };
      return { draws: st.drawCalls.total, shadowDraws: st.drawCalls.shadow };
    },
    get aim() {
      return aimDir;
    },
    get stick() {
      return controls.move;
    },
    get firing() {
      return controls.fire;
    },
    get melee() {
      return controls.melee;
    },
    get banner() {
      const b = document.getElementById('banner');
      return b && !b.hidden ? (document.getElementById('banner-title')?.textContent ?? '') : '';
    },
    get weapon() {
      const mine = net?.state.players.get(me);
      return mine ? tierWeapon(mine.tier).id : null;
    },
    names() {
      const out: string[] = [];
      net?.state?.players?.forEach((p) => out.push(p.name));
      return out.sort();
    },
    player(name: string) {
      const f = find(name);
      return f
        ? {
            x: f.p.x,
            y: f.p.y,
            hp: f.p.hp,
            alive: f.p.alive,
            prot: f.p.prot,
            tier: f.p.tier,
            tk: f.p.tk,
            kills: f.p.kills,
            deaths: f.p.deaths,
            bot: f.p.bot,
            connected: f.p.connected,
          }
        : null;
    },
    /** Screen position (CSS px, page coordinates) of a ground point at gun height: for aiming the mouse. */
    screenOf(x: number, y: number) {
      const out = { x: 0, y: 0 };
      scene.toScreen(x, y, 1, out);
      const r = ui.canvas.getBoundingClientRect();
      return { x: out.x + r.left, y: out.y + r.top };
    },
    /** Dev/test servers only (RALLY_DEV_RULES=1 or NODE_ENV=test): `DevCommand`. */
    dev(cmd: DevCommand) {
      net?.dev(cmd);
    },
    /** The labels' text (escaped names) for layout checks. */
    labelText() {
      return [...labels.values()].map((l) => esc(l.textContent ?? ''));
    },
  };
}
