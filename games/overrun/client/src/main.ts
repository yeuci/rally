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
import { rally } from '@rally/sdk';
import {
  ClientMessage,
  DT,
  PATCH_MS,
  WEAPONS,
  type DevCommand,
  type FxBatch,
  type FxEvent,
  type OverrunStateView,
  type Vec2,
} from '@rally/game-overrun-server';
import { createControls, cycleWeapon } from './controls.ts';
import { ammoOf, createHud, esc } from './hud.ts';
import { LocalGun, shotAngles, tracerLength } from './localgun.ts';
import { applyLowFx } from './lowfx.ts';
import { connect, type Net } from './net.ts';
import { Predictor, shouldPredict } from './predict.ts';
import { RunResultView } from './result.ts';
import { LEAD, createOverrunScene, zombieRadius } from './scene.ts';
import { createSfx } from './sfx.ts';

const TELEMETRY_MS = 10_000;
/** Reconnection grace the room grants (RallyRoom.reconnectSeconds); reported to the host for "Rejoin match?". */
const RECONNECT_TTL_SEC = 60;
/** How long a hit zombie is drawn white. */
const FLASH_MS = 90;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  stickMove: $('stick-move'),
  stickAim: $('stick-aim'),
  paused: $('paused'),
  exit: $<HTMLButtonElement>('exit'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
};
const params = new URLSearchParams(location.search);
/** `?predict=0` draws your own player interpolated like everyone else (to compare). */
const PREDICT = params.get('predict') !== '0';
/** Dev only: `?art=<shot>` stages a frozen scene for the store art (src/art.ts). */
const ART = import.meta.env.DEV ? params.get('art') : null;
/**
 * Dev only: `?lowfx=1` draws at most 15 fps at DPR 1, without clustered lighting, MSAA, shadows, decals or blood
 * bursts (src/lowfx.ts). The Playwright e2e opens every page with it.
 */
const LOWFX = import.meta.env.DEV && !ART && params.has('lowfx') && params.get('lowfx') !== '0';

function loading(progress: number) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (rally.isHosted) void rally.ui.loading(progress).catch(() => {});
}

const bootStart = performance.now();
loading(0.05);

// --- engine, scene, HUD, input -----------------------------------------------------------------------
const { app, onResize } = createApp({
  canvas: ui.canvas,
  ...(ART ? { maxPixelRatio: 3 } : {}),
  ...(LOWFX ? { maxPixelRatio: 1, antialias: false } : {}),
  // Dev-only render knobs for perf measurements (test/perf.cjs PERF_QUERY): ?noaa, ?noshadow, ?nofx.
  ...(import.meta.env.DEV && params.has('noaa') ? { antialias: false } : {}),
});
if (LOWFX) applyLowFx(app);
const scene = createOverrunScene(
  app,
  (fn) => onResize(fn),
  LOWFX
    ? { shadows: false, effects: false }
    : {
        shadows: !(import.meta.env.DEV && params.has('noshadow')),
        effects: !(import.meta.env.DEV && params.has('nofx')),
      },
);
const hud = createHud();
const controls = createControls(ui.canvas, ui.stickMove, ui.stickAim);
const audio = createAudio();
const sfx = createSfx(audio);
const metrics = createFrameMetrics(2000);
app.on('frameend', () => metrics.tick());
loading(0.5);

// --- netcode state -------------------------------------------------------------------------------------
let net: Net | null = null;
let joining: Promise<Net> | null = null;
let me = '';
let readyMs = -1;
let exiting = false;
/**
 * Everything remote is drawn on the SERVER's timeline (`tick` × DT), 2–3 patch intervals behind the estimated server
 * time (game-kit netclock): players on Hermite curves through positions and velocities, zombies and globs linearly.
 * Effects arrive with their tick and play when the render time reaches it, so a zombie's blood and its disappearance
 * line up.
 */
const clock = new RenderClock({ intervalMs: PATCH_MS });
const playersBuf = new SnapshotBuffer({
  fields: ['x', 'y', 'vx', 'vy'] as const,
  rates: { x: 'vx', y: 'vy' },
  extrapolateMs: PATCH_MS,
});
const zombiesBuf = new SnapshotBuffer({ fields: ['x', 'y', 'kind'] as const, capacity: 24 });
const projBuf = new SnapshotBuffer({ fields: ['x', 'y', 'h', 'tx', 'ty'] as const, capacity: 24 });
const predictor = new Predictor();
const gun = new LocalGun();
const results = new RunResultView();
const fxQueue: FxBatch[] = [];
const facing = new Map<number, number>();
const flashUntil = new Map<number, number>();
const labels = new Map<string, HTMLElement>();
let lastResult: unknown = null;
let lastRun = -1;
let lastPhase = '';
let wantWeapon = 0;
let aimDir: Vec2 = { x: 0, y: -1 };
let mySlot = -1;
const kills = { seen: 0 };
/** Rendered zombies of the last frame (local tracers stop on them). */
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
    controls.enabled = false;
    releaseInput();
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
hud.onWeaponButton(() => {
  const mine = net?.state.players?.get(me);
  if (!mine || !net) return;
  wantWeapon = cycleWeapon(mine.weapon, 1, net.state.unlocked, [Infinity, mine.a1, mine.a2, mine.a3, mine.a4]);
});

// --- effects ---------------------------------------------------------------------------------------------
const nameOfSlot = (st: OverrunStateView, slot: number) => {
  let name = '';
  st.players.forEach((p, id) => {
    if (p.slot === slot) name = id === me ? 'You' : p.name;
  });
  return name || 'Someone';
};

/** Effects that matter to you right now are played on arrival; the rest wait for the render time (playFx). */
function onFx(batch: FxBatch) {
  const st = net?.state;
  for (const e of batch.e) {
    if (e.k === 'hurt' && e.p === mySlot) {
      hud.hurt(100 - e.hp);
      sfx.hurt();
      scene.shake(0.12);
    } else if (e.k === 'unlock') {
      hud.toast(`${WEAPONS[e.w]?.icon ?? ''} ${WEAPONS[e.w]?.name ?? 'Weapon'} unlocked`, 'unlock');
      sfx.unlock();
    } else if (e.k === 'wave') {
      sfx.wave();
    } else if (e.k === 'clear') {
      sfx.clear();
    } else if (e.k === 'over') {
      sfx.over();
    } else if (e.k === 'down' && st) {
      if (e.p !== mySlot) hud.toast(`${nameOfSlot(st, e.p)} is down!`, 'bad');
      sfx.down(e.p === mySlot);
    } else if (e.k === 'revive' && st) {
      hud.toast(e.p === mySlot ? 'You are back up' : `${nameOfSlot(st, e.p)} is back up`, 'good');
      sfx.revive();
    }
  }
  fxQueue.push(batch);
  if (fxQueue.length > 120) fxQueue.splice(0, fxQueue.length - 120);
}

function playFx(e: FxEvent, now: number, myPos: Vec2 | null) {
  switch (e.k) {
    case 'shot': {
      if (e.p === mySlot) break; // ours were drawn when we fired
      for (let i = 0; i + 3 < e.r.length; i += 4) scene.tracer(e.r[i]!, e.r[i + 1]!, e.r[i + 2]!, e.r[i + 3]!, e.w);
      if (e.r.length >= 4) scene.muzzle(e.r[0]!, e.r[1]!, Math.atan2(e.r[3]! - e.r[1]!, e.r[2]! - e.r[0]!), e.w);
      sfx.shot(e.w, false);
      break;
    }
    case 'hit':
      flashUntil.set(e.z, now + FLASH_MS);
      scene.blood(e.x, e.y, 0.3, e.z * 7 + Math.round(now));
      sfx.hit();
      break;
    case 'kill':
      scene.blood(e.x, e.y, e.kind === 1 ? 1.6 : 1, e.z * 31);
      sfx.kill(e.m);
      kills.seen++;
      break;
    case 'boom': {
      const near = myPos ? Math.hypot(myPos.x - e.x, myPos.y - e.y) < 9 : true;
      scene.explosion(e.x, e.y, e.r);
      scene.shake(near ? 0.55 : 0.2);
      sfx.boom(near);
      break;
    }
    case 'splash':
      scene.splash(e.x, e.y, Math.round(e.x * 131 + e.y * 7));
      sfx.splash();
      break;
    case 'spit':
      sfx.spit();
      break;
    case 'place':
      if (e.p === mySlot) sfx.place();
      break;
    case 'pickup':
      if (e.p === mySlot) sfx.pickup();
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
  if (st.run !== lastRun) {
    // A new run: everyone respawned, the yard is clean.
    playersBuf.clear();
    zombiesBuf.clear();
    projBuf.clear();
    facing.clear();
    scene.clearDecals();
    gun.reset();
    lastRun = st.run;
  }
  const serverMs = st.tick * DT * 1000;
  clock.observe(serverMs, t);
  const ps: [string, { x: number; y: number; vx: number; vy: number }][] = [];
  st.players.forEach((p, id) => ps.push([id, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }]));
  playersBuf.push(serverMs, ps);
  const zs: [string, { x: number; y: number; kind: number }][] = [];
  st.zombies.forEach((z, id) => zs.push([id, { x: z.x, y: z.y, kind: z.kind }]));
  zombiesBuf.push(serverMs, zs);
  const pr: [string, { x: number; y: number; h: number; tx: number; ty: number }][] = [];
  st.projectiles.forEach((p, id) => pr.push([id, { x: p.x, y: p.y, h: p.h, tx: p.tx, ty: p.ty }]));
  projBuf.push(serverMs, pr);
  const mine = st.players.get(me);
  mySlot = mine?.slot ?? -1;
  predictor.rttMs = net.rttMs ?? 0;
  if (mine && PREDICT && shouldPredict(st.phase, mine.active)) {
    predictor.rebase(
      { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, down: mine.down },
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
    return len > 1e-3 ? { x: dx / len, y: dy / len } : null;
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

  // Weapon choice: wheel / Q E, number keys, the HUD button (handled on click).
  const step = controls.takeWeaponStep();
  const pick = controls.takeWeaponPick();
  if (mine) {
    const ammo = [Infinity, mine.a1, mine.a2, mine.a3, mine.a4];
    if (step) wantWeapon = cycleWeapon(mine.weapon, step, st.unlocked, ammo);
    if (pick !== null && pick < st.unlocked && (pick === 0 || (ammo[pick] ?? 0) > 0)) wantWeapon = pick;
    if (wantWeapon >= st.unlocked) wantWeapon = 0;
  }

  // Where we are drawn: predicted when we move on the server, else interpolated.
  const renderAt = clock.renderTime(now);
  const predicting = PREDICT && !!mine && shouldPredict(st.phase, mine.active);
  const myPos: Vec2 | null = mine
    ? ((predicting ? predictor.sample(now) : null) ??
      (renderAt === null ? null : playersBuf.sampleAt(me, renderAt)) ?? { x: mine.x, y: mine.y })
    : null;

  // Input: aim, move, trigger, weapon → the server (on change, ≤ 20 Hz) and the predictor.
  const live = !!mine && mine.active && !lifecycle.isPaused && !exiting;
  const aim = live && myPos ? aimFromControls(myPos) : null;
  if (aim) aimDir = aim;
  const firing = live && controls.fire && !mine.down && st.phase !== 'over';
  const sent = net.offer(
    { move: live ? controls.move : { x: 0, y: 0 }, aim: aim, fire: firing, weapon: wantWeapon },
    now,
  );
  if (sent) predictor.recordStick(now, { x: sent.mx, y: sent.my });

  // Our own shots: flash, tracer and sound at once (hits come from the server).
  if (mine && myPos) {
    const weapon = mine.weapon;
    const loaded = weapon === 0 || ammoOf(mine, weapon) > 0;
    const shots = gun.update(now, firing && loaded, weapon);
    const angle = Math.atan2(aimDir.y, aimDir.x);
    for (let s = 0; s < shots; s++) {
      for (const a of shotAngles(weapon, angle, Math.random() * 2 - 1)) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const ox = myPos.x + dx * 0.35;
        const oy = myPos.y + dy * 0.35;
        const len = tracerLength(ox, oy, dx, dy, WEAPONS[weapon]!.range, drawnTargets);
        scene.tracer(ox, oy, ox + dx * len, oy + dy * len, weapon);
      }
      scene.muzzle(myPos.x, myPos.y, angle, weapon);
      sfx.shot(weapon, true);
    }
  }

  // Phase cues.
  if (st.phase !== lastPhase) {
    if (st.phase === 'breather' && lastPhase === 'wave') hud.toast(`Wave ${st.wave - 1} cleared`, 'good');
    lastPhase = st.phase;
  }

  // Players.
  const seen = new Set<string>();
  st.players.forEach((p, id) => {
    seen.add(id);
    const isMe = id === me;
    const s = (isMe && myPos ? { ...myPos, vx: p.vx, vy: p.vy } : null) ??
      (renderAt === null ? null : playersBuf.sampleAt(id, renderAt)) ?? { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    const sp = isMe && predicting ? predictor.sample(now) : null;
    scene.setPlayer(id, {
      x: s.x,
      y: s.y,
      vx: sp?.vx ?? s.vx,
      vy: sp?.vy ?? s.vy,
      aim: isMe ? Math.atan2(aimDir.y, aimDir.x) : p.aim,
      slot: p.slot,
      down: p.down,
      me: isMe,
      visible: p.active,
      weapon: p.weapon,
    });
    let label = labels.get(id);
    if (!label) {
      label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = '<span class="n"></span><b class="hp"><s></s></b><em class="rv"><s></s></em>';
      ui.labels.appendChild(label);
      labels.set(id, label);
    }
    label.classList.toggle('me', isMe);
    label.classList.toggle('down', p.down);
    const n = label.firstElementChild as HTMLElement;
    if (n.textContent !== p.name) n.textContent = p.name;
    (label.children[1]!.firstElementChild as HTMLElement).style.width = `${p.down ? 0 : p.hp}%`;
    (label.children[2]!.firstElementChild as HTMLElement).style.width = `${p.down ? p.revive : 0}%`;
    if (p.active && st.phase !== 'over' && scene.labelAnchor(id, anchor)) {
      label.style.opacity = '1';
      label.style.transform = `translate(${anchor.x}px, ${anchor.y}px) translate(-50%, -100%)`;
    } else {
      label.style.opacity = '0';
    }
  });
  for (const [id, el] of labels) {
    if (seen.has(id)) continue;
    el.remove();
    labels.delete(id);
    scene.removePlayer(id);
  }

  // Zombies: the ones in the snapshot at the render time, where they were then.
  scene.beginZombies();
  drawnTargets.length = 0;
  if (renderAt !== null) {
    for (const key of zombiesBuf.idsAt(renderAt)) {
      const s = zombiesBuf.sampleAt(key, renderAt);
      if (!s) continue;
      const id = Number.parseInt(key, 36);
      const back = zombiesBuf.sampleAt(key, renderAt - 120);
      let f = facing.get(id);
      if (back) {
        const dx = s.x - back.x;
        const dy = s.y - back.y;
        if (dx * dx + dy * dy > 0.0004) {
          const want = Math.atan2(dx, dy);
          f = f === undefined ? want : f + Math.atan2(Math.sin(want - f), Math.cos(want - f)) * Math.min(1, dt * 10);
        }
      }
      if (f === undefined && myPos) f = Math.atan2(myPos.x - s.x, myPos.y - s.y);
      facing.set(id, f ?? 0);
      const kind = Math.round(s.kind);
      const until = flashUntil.get(id);
      scene.zombie(id, kind, s.x, s.y, f ?? 0, until !== undefined && until > now);
      drawnTargets.push({ x: s.x, y: s.y, r: zombieRadius(kind) });
    }
  }
  scene.endZombies();
  if (facing.size > 400) for (const id of [...facing.keys()].slice(0, 200)) facing.delete(id);
  for (const [id, until] of flashUntil) if (until < now) flashUntil.delete(id);

  // Spit globs (interpolated), explosives and pickups (as they are now).
  if (renderAt !== null) {
    for (const key of projBuf.idsAt(renderAt)) {
      const s = projBuf.sampleAt(key, renderAt);
      if (s) scene.setProjectile(key, s.x, s.y, s.h, s.tx, s.ty);
    }
  }
  st.explosives.forEach((e, id) => scene.setExplosive(id, e.kind, e.x, e.y, e.armed));
  st.pickups.forEach((p, id) => scene.setPickup(id, p.kind, p.x, p.y));
  scene.prune();

  // Effects due at the render time.
  while (fxQueue.length && (renderAt === null || fxQueue[0]!.t * DT * 1000 <= renderAt)) {
    const batch = fxQueue.shift()!;
    for (const e of batch.e) playFx(e, now, myPos);
  }

  // Camera: on us, or on a teammate while we wait to spawn.
  let follow: Vec2 | null = mine?.active && myPos ? myPos : null;
  if (!follow) {
    st.players.forEach((p, id) => {
      if (!follow && p.active) follow = (renderAt === null ? null : playersBuf.sampleAt(id, renderAt)) ?? p;
    });
  }
  const f = follow ?? { x: 0, y: 0 };
  // Mouse: lead by where the cursor is on screen (aiming at a ground point that moves with the camera would feed back).
  const cursor = controls.device === 'mouse' ? controls.mouse : null;
  const rect = ui.canvas.getBoundingClientRect();
  const lead =
    cursor && rect.width > 0
      ? {
          x: Math.max(-1, Math.min(1, (cursor.x - rect.width / 2) / (rect.width / 2))) * LEAD,
          y: Math.max(-1, Math.min(1, (cursor.y - rect.height / 2) / (rect.height / 2))) * LEAD * 0.7,
        }
      : undefined;
  scene.focus(f.x, f.y, mine?.active ? aimDir : null, false, mine?.active ? lead : undefined);

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
    zombies: scene.drawnZombies,
    phase: net?.state.phase ?? 'none',
    wave: net?.state.wave ?? 0,
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    readyMs,
    heapMb: jsHeapMb() ?? -1,
  };
}
setInterval(() => rally.telemetry.report('overrun', collect()), TELEMETRY_MS);

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

  if (exiting) return;
  hud.setMessage('Joining…');
  joining = (async () => {
    if (import.meta.env.DEV && ART) {
      const art = await import('./art.ts');
      if (!art.isArtShot(ART)) throw new Error(`?art=${ART}: expected one of ${art.ART_SHOTS.join(', ')}`);
      return art.stageArt(ART, { app, scene, hud });
    }
    if (rally.isHosted) {
      const { endpoint, seatReservation } = await rally.session.join();
      return connect(endpoint, { seatReservation });
    }
    const endpoint = toWs(params.get('colyseus') ?? `ws://${location.hostname || 'localhost'}:2567`);
    return connect(endpoint, {
      roomName: 'overrun',
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

// Dev-only probe for the Playwright e2e, perf and art scripts (stripped from production builds).
if (import.meta.env.DEV) {
  const find = (name: string) => {
    let found: { id: string; p: OverrunStateView['players'] extends { get(k: string): infer V } ? V : never } | null =
      null;
    net?.state?.players?.forEach((p, id) => {
      if (p.name === name) found = { id, p: p as never };
    });
    return found as {
      id: string;
      p: {
        x: number;
        y: number;
        hp: number;
        down: boolean;
        active: boolean;
        revive: number;
        kills: number;
        connected: boolean;
        weapon: number;
      };
    } | null;
  };
  (window as unknown as { __overrun: unknown }).__overrun = {
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
    get wave() {
      return net?.state.wave ?? 0;
    },
    get run() {
      return net?.state.run ?? 0;
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
    get reconnectionToken() {
      return net?.room.reconnectionToken ?? '';
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
    get teamKills() {
      return net?.state.teamKills ?? 0;
    },
    /** Kill effects this page has played (at its render time). */
    get killsSeen() {
      return kills.seen;
    },
    get drawnZombies() {
      return scene.drawnZombies;
    },
    get fps() {
      return metrics.snapshot();
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
    get banner() {
      const b = document.getElementById('banner');
      return b && !b.hidden ? (document.getElementById('banner-title')?.textContent ?? '') : '';
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
            down: f.p.down,
            active: f.p.active,
            revive: f.p.revive,
            kills: f.p.kills,
            connected: f.p.connected,
            weapon: f.p.weapon,
          }
        : null;
    },
    pickups() {
      const out: { id: string; kind: number; x: number; y: number }[] = [];
      net?.state?.pickups?.forEach((p, id) => out.push({ id, kind: p.kind, x: p.x, y: p.y }));
      return out;
    },
    zombies() {
      const out: { id: string; kind: number; x: number; y: number; hp: number }[] = [];
      net?.state?.zombies?.forEach((z, id) => out.push({ id, kind: z.kind, x: z.x, y: z.y, hp: z.hp }));
      return out;
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
