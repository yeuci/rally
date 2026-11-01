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
import { DEFAULT_SETTINGS, rally, type GameSettingValue, type MenuPlayer, type PlayerSettings } from '@rally/sdk';
import {
  Action,
  ClientMessage,
  DT,
  ESCAPE_FROM_NIGHT,
  GUNS,
  ITEMS,
  Item,
  LIFE,
  LOOT_SPOTS,
  PATCH_MS,
  SAFE,
  SOCKETS,
  TRUCK_FUEL,
  TRUCK_SCRAP,
  TRUCK_WHEELS,
  ZOMBIES,
  chooseAction,
  fromFx,
  type DevCommand,
  type FxBatch,
  type FxEvent,
  type NorthdalePlayerView,
  type NorthdaleStateView,
  type Vec2,
} from '@rally/game-northdale-server';
import { createControls } from './controls.ts';
import { createHud, esc, peopleDetail, type ContextView } from './hud.ts';
import { skyAt } from './lighting.ts';
import { LocalGun, gunOf, meleeOf, shotAngles, tracerLength } from './localgun.ts';
import { applyLowFx } from './lowfx.ts';
import { loadNorthdaleModels } from './models.ts';
import { connect, type Net } from './net.ts';
import { Predictor, shouldPredict } from './predict.ts';
import { MatchResultView } from './result.ts';
import { CAMERA_LEAD, createNorthdaleScene, type NorthdaleScene, type Quality } from './scene.ts';
import { createSfx } from './sfx.ts';

const TELEMETRY_MS = 10_000;
/** Reconnection grace the room grants (RallyRoom.reconnectSeconds); reported to the host for "Rejoin match?". */
const RECONNECT_TTL_SEC = 60;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('stage'),
  labels: $('labels'),
  paused: $('paused'),
  exit: $<HTMLButtonElement>('exit'),
  loading: $('loading'),
  loadingBar: $('loading-bar'),
  loadingLabel: $('loading-label'),
};
const params = new URLSearchParams(location.search);
const PREDICT = params.get('predict') !== '0';
/** Dev only: `?art=<shot>` stages a frozen scene for the store art (src/art.ts). */
const ART = import.meta.env.DEV ? params.get('art') : null;
/** Dev only: `?lowfx=1` draws ≤ 15 fps at DPR 1 without MSAA, light pools, bursts or shake (the e2e). */
const LOWFX = import.meta.env.DEV && !ART && params.has('lowfx') && params.get('lowfx') !== '0';

/** Boot progress with a short, user-facing label: the host keeps its loading screen up until 1 (playable). */
function loading(progress: number, label?: string) {
  ui.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (label) ui.loadingLabel.textContent = label;
  if (rally.isHosted) void rally.ui.loading(progress, label).catch(() => {});
}

const bootStart = performance.now();
loading(0.02, 'Downloading Northdale');

// --- settings from the host's game menu ------------------------------------------------------------------------------
/** The game's own settings in the host's menu (`rally.menu.define`). */
const GAME_SETTINGS = [
  { type: 'slider' as const, key: 'cameraShake', label: 'Camera shake', min: 0, max: 1, step: 0.1, default: 1 },
  { type: 'toggle' as const, key: 'minimap', label: 'Minimap', default: true },
  { type: 'toggle' as const, key: 'labels', label: 'Names over teammates', default: true },
];
/** "How to play" in the host's menu (titles ≤ 40, texts ≤ 240 characters). */
const HELP = [
  {
    title: 'Controls',
    text: 'Left thumb moves, right thumb aims and fires (swap sides in Controls). 🗡️ swings your melee weapon. Hold ✋ to open, search, pick up, build, repair or revive. Tap an item slot to use it.',
  },
  {
    title: 'Day and night',
    text: 'By day the streets are quiet: loot chests, wrecks and trash bags, and bring home scrap. At dusk a siren warns you. At night the dead pour in from the edge of town and hunt you down.',
  },
  {
    title: 'Every night is worse',
    text: 'Zombies get tougher, harder-hitting and faster every night. Crawlers join on night 2, bursting chubbies on night 3, rock-throwing brutes on night 4. Every 5th night is a Blood Moon: a double horde.',
  },
  {
    title: 'Down, not out',
    text: 'At 0 HP you go down and crawl. A teammate holding ✋ next to you for 3 s gets you up. Alone, you get one second wind per night. Dawn heals everyone and brings the fallen back at the safehouse.',
  },
  {
    title: 'The dog',
    text: 'A stray German Shepherd waits in the Back Alleys (south-east). Pet it and it follows you, barks when zombies come (watch the minimap) and bites them. It can be downed but never dies.',
  },
  {
    title: 'Fix the truck, escape',
    text: 'Carry 2 wheels (Junction, Container Yard) and 2 fuel barrels (Pipe Works) to the armored truck and add 60 scrap. From night 4, start it, hold out 60 s, and drive out through the Northdale gantry.',
  },
];
const gameSettings: Record<string, GameSettingValue> = Object.fromEntries(GAME_SETTINGS.map((s) => [s.key, s.default]));
let settings: PlayerSettings = rally.settings;
/** The player's graphics quality ('low' close to `?lowfx`, without its frame cap). */
/** The shared control settings, with defaults for a host that predates them. */
const controlsOf = (s: PlayerSettings) => ({
  ...DEFAULT_SETTINGS.controls,
  ...(s.controls as Partial<PlayerSettings['controls']> | undefined),
});
const qualityOf = (s: PlayerSettings): Quality => (LOWFX ? 'low' : s.graphics);
const dprFor = (q: Quality) => (ART ? 3 : LOWFX || q === 'low' ? 1 : q === 'medium' ? 1.5 : 2);

// --- netcode state -----------------------------------------------------------------------------------------------------
let net: Net | null = null;
let joining: Promise<Net> | null = null;
let me = '';
let readyMs = -1;
let exiting = false;
let menuOpen = false;
let paused = false;
let scene!: NorthdaleScene;
const clock = new RenderClock({ intervalMs: PATCH_MS });
const playersBuf = new SnapshotBuffer({
  fields: ['x', 'y', 'vx', 'vy'] as const,
  rates: { x: 'vx', y: 'vy' },
  extrapolateMs: PATCH_MS,
});
const zombiesBuf = new SnapshotBuffer({ fields: ['x', 'y', 'kind'] as const, capacity: 24 });
const rocksBuf = new SnapshotBuffer({ fields: ['x', 'y', 'h'] as const, capacity: 24 });
const misc = new SnapshotBuffer({ fields: ['x', 'y'] as const, capacity: 24 });
const predictor = new Predictor();
const gun = new LocalGun();
const results = new MatchResultView();
const fxQueue: FxBatch[] = [];
const labels = new Map<string, HTMLElement>();
const arrows = new Map<string, HTMLElement>();
const swings = new Map<string, number>();
const firedAt = new Map<string, number>();
let lastResult: unknown = null;
let lastRun = -1;
let lastPhase = '';
let aimDir: Vec2 = { x: 0, y: -1 };
let aimed = false;
let mySlot = -1;
let localSwings = 0;
let lastPeople = '';
let menuPlayersSent: MenuPlayer[] = [];
let menuValues: Record<string, GameSettingValue> | null = null;
let contextLabel = '';
const seen = { kills: 0, fx: [] as string[] };

const hud = createHud();
const controls = createControls(ui.canvas, {
  moveStick: $('stick-move'),
  aimStick: $('stick-aim'),
  melee: $('melee'),
  act: $('act'),
  slots: [$('slot-0'), $('slot-1')],
});
const audio = createAudio();
const sfx = createSfx(audio);
const metrics = createFrameMetrics(2000);

function releaseInput() {
  const now = performance.now();
  const sent = net?.release(now);
  if (sent) predictor.recordStick(now, { x: 0, y: 0 });
}
function inputEnabled() {
  controls.enabled = !paused && !menuOpen && !exiting;
}

function applySettings(s: PlayerSettings) {
  settings = s;
  sfx.volume = s.volume.master * s.volume.effects;
  Object.assign(gameSettings, s.game);
  // The host's shared control settings (swap sides, stick size and opacity); aim assist is read where it applies.
  const c = controlsOf(s);
  controls.configure({ swap: c.swapSticks, size: c.stickSize, opacity: c.stickOpacity });
  if (!scene) return;
  const q = qualityOf(s);
  scene.setQuality(q);
  scene.setShakeScale(Number(gameSettings.cameraShake ?? 1));
  hud.setMinimap(gameSettings.minimap !== false);
  ui.labels.classList.toggle('no-names', gameSettings.labels === false);
  applyDpr(q);
}
let applyDpr: (q: Quality) => void = () => {};

// --- effects -------------------------------------------------------------------------------------------------------------
const bySlot = (st: NorthdaleStateView, slot: number): [string, NorthdalePlayerView] | null => {
  let found: [string, NorthdalePlayerView] | null = null;
  st.players.forEach((p, id) => {
    if (p.slot === slot) found = [id, p];
  });
  return found;
};

/** Effects that matter to you right now play on arrival; the rest wait for the render time (playFx). */
function onFx(batch: FxBatch) {
  const st = net?.state;
  for (const e of batch.e) {
    if (e.k === 'hurt' && e.p === mySlot && e.d > 0) {
      hud.hurt(e.d);
      sfx.hurt();
      scene.shake(0.15);
      if (rally.isHosted && settings.haptics) void rally.haptics('light').catch(() => {});
    } else if (e.k === 'down' && e.p === mySlot) {
      sfx.down(true);
      if (rally.isHosted && settings.haptics) void rally.haptics('heavy').catch(() => {});
    } else if (e.k === 'phase' && e.phase === 'dusk') {
      hud.banner('Dusk', 'The dead are coming. Get to the safehouse.', 'dusk');
      sfx.siren();
    } else if (e.k === 'night') {
      hud.banner(
        e.blood ? 'Blood Moon' : `Night ${e.n}`,
        e.blood ? 'A double horde, stronger than ever' : 'Survive until dawn',
        e.blood ? 'blood' : 'night',
      );
      sfx.night(e.blood);
    } else if (e.k === 'dawn') {
      hud.banner('Dawn', `You survived night ${e.n}`, 'dawn');
      sfx.dawn();
    } else if (e.k === 'holdout') {
      hud.banner('Hold out!', 'The truck is warming up: 60 seconds', 'blood');
      sfx.engine();
    } else if (e.k === 'escape') {
      hud.banner('Go go go!', 'Through the Northdale gantry', 'good');
      sfx.escape();
    } else if (e.k === 'over') {
      sfx.over(e.e);
    } else if (e.k === 'loot' && e.p === mySlot) {
      const it = ITEMS[e.i];
      if (it)
        hud.toast(it.kind === 'scrap' ? '+5 scrap' : `${it.icon} ${it.name}`, it.kind === 'part' ? 'part' : 'good');
      sfx.loot();
    } else if (e.k === 'broke' && e.p === mySlot) {
      hud.toast(`${ITEMS[e.i]?.name ?? 'Weapon'} broke!`, 'bad');
      sfx.broke();
    } else if (e.k === 'part') {
      const who = st ? bySlot(st, e.p) : null;
      hud.toast(
        `${e.i === Item.wheel ? '🛞 Wheel fitted' : '🛢️ Fuel in'} ${who && who[0] !== me ? `by ${who[1].name}` : ''}`,
        'part',
      );
      sfx.part();
    } else if (e.k === 'dog' && e.s === 1 && e.p >= 0) {
      hud.toast('🐕 The dog is with you', 'good');
      sfx.bark();
    } else if (e.k === 'empty' && e.p === mySlot) {
      sfx.empty();
    }
  }
  fxQueue.push(batch);
  if (fxQueue.length > 150) fxQueue.splice(0, fxQueue.length - 150);
}

function playFx(e: FxEvent, st: NorthdaleStateView, myPos: Vec2 | null) {
  const near = (x: number, y: number) => (myPos ? Math.hypot(myPos.x - x, myPos.y - y) < 12 : true);
  seen.fx.push(e.k);
  if (seen.fx.length > 60) seen.fx.shift();
  switch (e.k) {
    case 'shot': {
      if (e.p === mySlot || e.r.length < 4) break;
      const who = bySlot(st, e.p);
      const ends: number[] = [];
      for (let i = 0; i + 3 < e.r.length; i += 4) ends.push(fromFx(e.r[i + 2]!), fromFx(e.r[i + 3]!));
      const x0 = fromFx(e.r[0]!);
      const y0 = fromFx(e.r[1]!);
      scene.shot(
        who?.[0] ?? null,
        x0,
        y0,
        Math.atan2(fromFx(e.r[3]!) - y0, fromFx(e.r[2]!) - x0),
        ends,
        e.w === Item.shotgun || e.w === Item.rifle,
      );
      if (who) firedAt.set(who[0], performance.now());
      sfx.shot(e.w, false);
      break;
    }
    case 'swing': {
      if (e.p === mySlot) break;
      const who = bySlot(st, e.p);
      if (who) swings.set(who[0], (swings.get(who[0]) ?? 0) + 1);
      scene.swing(fromFx(e.x), fromFx(e.y), e.a / 1000, meleeOf(e.w).arc > 1, e.n > 0);
      sfx.swing(e.n > 0, false);
      break;
    }
    case 'hit':
      scene.horde.hit(e.z);
      scene.blood(fromFx(e.x), fromFx(e.y), 0.4);
      sfx.hit(near(fromFx(e.x), fromFx(e.y)));
      break;
    case 'kill':
      seen.kills++;
      scene.blood(fromFx(e.x), fromFx(e.y), 1);
      sfx.kill(e.p === mySlot, e.kind >= 2);
      break;
    case 'windup':
      scene.horde.windup(e.z);
      scene.telegraph(fromFx(e.x), fromFx(e.y), 2.0);
      sfx.growl();
      break;
    case 'rock':
      scene.dust(fromFx(e.x), fromFx(e.y), 2.2);
      scene.shake(near(fromFx(e.x), fromFx(e.y)) ? 0.45 : 0.1);
      sfx.thud(near(fromFx(e.x), fromFx(e.y)));
      break;
    case 'goo':
      scene.dust(fromFx(e.x), fromFx(e.y), 1.6);
      sfx.goo();
      break;
    case 'bark':
      hud.ping(fromFx(e.x), fromFx(e.y));
      sfx.bark();
      break;
    case 'open':
      sfx.open();
      break;
    case 'build':
      sfx.build();
      break;
    case 'breach':
      scene.dust(SOCKETS[e.s]?.x ?? 0, SOCKETS[e.s]?.y ?? 0, 1.8);
      sfx.breach();
      break;
    case 'revive':
      sfx.revive();
      break;
    case 'down':
      if (e.p !== mySlot) sfx.down(false);
      break;
    case 'use':
      sfx.use();
      break;
    default:
      break;
  }
}

// --- patches -------------------------------------------------------------------------------------------------------------
function onPatch(t: number) {
  if (!net) return;
  const st = net.state;
  if (!st?.players) return;
  if (st.run !== lastRun) {
    playersBuf.clear();
    zombiesBuf.clear();
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
  const rs: [string, { x: number; y: number; h: number }][] = [];
  st.rocks.forEach((r, id) => rs.push([id, { x: r.x, y: r.y, h: r.h }]));
  rocksBuf.push(serverMs, rs);
  misc.push(serverMs, [
    ['dog', { x: st.dogX, y: st.dogY }],
    ['truck', { x: st.truckX, y: st.truckY }],
  ]);
  const mine = st.players.get(me);
  mySlot = mine?.slot ?? -1;
  predictor.rttMs = net.rttMs ?? 0;
  if (mine && PREDICT && shouldPredict(st.phase, mine.life)) {
    const goo: Vec2[] = [];
    st.goo.forEach((g) => goo.push({ x: g.x, y: g.y }));
    predictor.rebase(
      {
        x: mine.x,
        y: mine.y,
        vx: mine.vx,
        vy: mine.vy,
        speed: mine.life === LIFE.down ? 0.18 : mine.carry ? 0.62 : 1,
        goo,
      },
      clock.server.toLocal(serverMs),
      t,
    );
  } else {
    predictor.reset();
  }
}

// --- the frame -----------------------------------------------------------------------------------------------------------
const anchor = { x: 0, y: 0 };
const screenTmp = { x: 0, y: 0 };

function aimFromControls(myPos: Vec2, st: NorthdaleStateView): Vec2 | null {
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
    scene.toScreen(myPos.x, myPos.y, 1, screenTmp);
    const g = scene.toGround(screenTmp.x + d.x * 80, screenTmp.y + d.y * 80);
    if (!g) return null;
    const dx = g.x - myPos.x;
    const dy = g.y - myPos.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return null;
    const dir = { x: dx / len, y: dy / len };
    return controlsOf(settings).aimAssist ? assist(dir, myPos, st) : dir;
  }
  const m = controls.move;
  const len = Math.hypot(m.x, m.y);
  return len > 0.2 ? { x: m.x / len, y: m.y / len } : null;
}

/** Aim assist (touch): the aim bends to the nearest zombie within 14° and in range. */
function assist(dir: Vec2, from: Vec2, _st: NorthdaleStateView): Vec2 {
  let best: Vec2 | null = null;
  let bestScore = Infinity;
  for (const t of scene.horde.drawnTargets) {
    const dx = t.x - from.x;
    const dy = t.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.5 || d > 13) continue;
    const off = Math.acos(Math.max(-1, Math.min(1, (dx * dir.x + dy * dir.y) / d)));
    if (off > 0.25) continue;
    const score = off * 4 + d * 0.05;
    if (score < bestScore) [bestScore, best] = [score, { x: dx / d, y: dy / d }];
  }
  return best ?? dir;
}

/** What the context button would do now (the server decides; this labels the button). */
function contextFor(st: NorthdaleStateView, mine: NorthdalePlayerView, pos: Vec2): ContextView | null {
  const pickups: { id: number; kind: number; x: number; y: number }[] = [];
  st.pickups.forEach((p, id) => pickups.push({ id: Number.parseInt(id, 36), kind: p.kind, x: p.x, y: p.y }));
  const others: { id: string; name: string; x: number; y: number; down: boolean }[] = [];
  let runners = 0;
  st.players.forEach((p, id) => {
    if (p.inRun) runners++;
    if (id !== me && p.inRun && p.life !== LIFE.dead)
      others.push({ id, name: p.name, x: p.x, y: p.y, down: p.life === LIFE.down });
  });
  const sockets = SOCKETS.map((_, i) => st.barricades.get(String(i))?.tier ?? 0);
  const repaired = st.wheels >= TRUCK_WHEELS && st.fuel >= TRUCK_FUEL && st.truckScrap >= TRUCK_SCRAP;
  const choice = chooseAction({
    me: {
      x: pos.x,
      y: pos.y,
      alive: mine.life === LIFE.alive,
      down: mine.life === LIFE.down,
      carry: mine.carry,
      items: [mine.i0, mine.i1],
      secondWind: mine.wind && runners === 1,
    },
    others,
    dog: { x: st.dogX, y: st.dogY, state: st.dogState },
    opened: (id) => st.opened[id] === '1',
    pickups,
    sockets,
    scrap: st.scrap,
    truck: { wheels: st.wheels, fuel: st.fuel, scrap: st.truckScrap },
    canStart: repaired && st.night >= ESCAPE_FROM_NIGHT && ['day', 'dusk', 'night'].includes(st.phase),
  });
  if (!choice) return null;
  const progress = mine.actKind === choice.kind ? mine.act / 100 : 0;
  return { label: choice.label, progress };
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
  const renderAt = clock.renderTime(now);
  const predicting = PREDICT && !!mine && shouldPredict(st.phase, mine.life);
  const myPos: Vec2 | null = mine
    ? ((predicting ? predictor.sample(now) : null) ??
      (renderAt === null ? null : playersBuf.sampleAt(me, renderAt)) ?? { x: mine.x, y: mine.y })
    : null;

  // Input.
  const live =
    !!mine &&
    mine.life !== LIFE.dead &&
    !paused &&
    !menuOpen &&
    !exiting &&
    st.phase !== 'over' &&
    st.phase !== 'escape';
  const alive = live && mine!.life === LIFE.alive;
  const aim = alive && myPos ? aimFromControls(myPos, st) : null;
  if (aim) {
    aimDir = aim;
    aimed = true;
  } else if (!aimed && mine) {
    aimDir = { x: Math.cos(mine.aim), y: Math.sin(mine.aim) };
  }
  const firing = alive && controls.fire;
  const meleeing = alive && controls.melee;
  const acting = live && controls.act;
  const renderTick = renderAt === null ? st.tick : renderAt / (DT * 1000);
  const sent = net.offer(
    {
      move: live ? controls.move : { x: 0, y: 0 },
      aim,
      fire: firing,
      melee: meleeing,
      act: acting,
      use: controls.use,
      slot: controls.slot,
      rt: renderTick,
    },
    now,
  );
  if (sent) predictor.recordStick(now, { x: sent.mx, y: sent.my });

  // Your own shots and swings at once.
  if (mine && myPos) {
    const g = gunOf(mine.gun);
    const ammo = g ? [mine.a0, mine.a1, mine.a2, mine.a3][g.ammo]! : 0;
    const usable = g && ammo > 0 && !mine.carry ? g : null;
    const { shots, swings: sw } = gun.update(now, usable, meleeOf(mine.melee), firing, meleeing && !mine.carry);
    const angle = Math.atan2(aimDir.y, aimDir.x);
    for (let s = 0; s < shots && usable; s++) {
      const ends: number[] = [];
      for (const a of shotAngles(usable, angle, Math.random() * 2 - 1)) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const ox = myPos.x + dx * 0.35;
        const oy = myPos.y + dy * 0.35;
        const len = tracerLength(ox, oy, dx, dy, usable.range, scene.horde.drawnTargets, usable.pierce);
        ends.push(ox + dx * len, oy + dy * len);
      }
      scene.shot(me, myPos.x, myPos.y, angle, ends, usable.item === Item.shotgun || usable.item === Item.rifle);
      firedAt.set(me, now);
      sfx.shot(usable.item, true);
    }
    if (sw) {
      localSwings++;
      const spec = meleeOf(mine.melee);
      scene.swing(myPos.x, myPos.y, angle, spec.arc > 1, false);
      sfx.swing(false, true);
    }
  }

  // Phase cues.
  if (st.phase !== lastPhase) {
    lastPhase = st.phase;
    scene.setGantryOpen(st.phase === 'escape');
  }

  // Survivors, labels, off-screen arrows.
  const present = new Set<string>();
  const w = window.innerWidth;
  const h = window.innerHeight;
  st.players.forEach((p, id) => {
    present.add(id);
    const isMe = id === me;
    let s = (isMe && myPos ? { ...myPos, vx: p.vx, vy: p.vy } : null) ??
      (renderAt === null ? null : playersBuf.sampleAt(id, renderAt)) ?? { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    if (Math.hypot(s.x - p.x, s.y - p.y) > 4) s = { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    const sp = isMe && predicting ? predictor.sample(now) : null;
    const g = gunOf(p.gun);
    const loaded = !!g && [p.a0, p.a1, p.a2, p.a3][g.ammo]! > 0;
    const visible = p.life !== LIFE.dead && st.phase !== 'escape' && !(st.phase === 'over' && st.truckY < -150);
    scene.setPlayer(id, {
      x: s.x,
      y: s.y,
      vx: sp?.vx ?? s.vx,
      vy: sp?.vy ?? s.vy,
      aim: isMe && alive ? Math.atan2(aimDir.y, aimDir.x) : p.aim,
      slot: p.slot,
      life: p.life,
      gun: p.gun,
      loaded,
      melee: p.melee,
      carry: p.carry,
      me: isMe,
      firing: now - (firedAt.get(id) ?? -1e9) < 400 || (isMe && firing),
      swings: isMe ? localSwings : (swings.get(id) ?? 0),
      celebrating: false,
      visible,
    });
    let label = labels.get(id);
    if (!label) {
      label = document.createElement('div');
      label.className = 'label';
      label.innerHTML = '<span class="n"></span><b class="hp"><s></s></b><b class="rv"><s></s></b>';
      ui.labels.appendChild(label);
      labels.set(id, label);
    }
    label.classList.toggle('me', isMe);
    label.classList.toggle('down', p.life === LIFE.down);
    const n = label.firstElementChild as HTMLElement;
    const text = isMe ? 'You' : p.name;
    if (n.textContent !== text) n.textContent = text;
    (label.children[1]!.firstElementChild as HTMLElement).style.width = `${p.life === LIFE.alive ? p.hp : 0}%`;
    (label.children[2]!.firstElementChild as HTMLElement).style.width = `${p.revive}%`;
    const onScreen =
      visible && scene.labelAnchor(id, anchor) && anchor.x > 0 && anchor.x < w && anchor.y > 0 && anchor.y < h;
    const showLabel =
      onScreen && st.phase !== 'over' && (isMe || gameSettings.labels !== false || p.life === LIFE.down);
    label.style.opacity = showLabel ? '1' : '0';
    if (showLabel) label.style.transform = `translate(${anchor.x}px, ${anchor.y}px) translate(-50%, -100%)`;
    // A teammate off screen: an arrow at the edge pointing at them, in their colour.
    let arrow = arrows.get(id);
    if (!isMe && visible && !onScreen && myPos) {
      if (!arrow) {
        arrow = document.createElement('div');
        arrow.className = 'arrow';
        ui.labels.appendChild(arrow);
        arrows.set(id, arrow);
      }
      scene.toScreen(s.x, s.y, 1, screenTmp);
      const cx = w / 2;
      const cy = h / 2;
      const ang = Math.atan2(screenTmp.y - cy, screenTmp.x - cx);
      const r =
        Math.min(w / 2 - 24, h / 2 - 24) /
        Math.max(Math.abs(Math.cos(ang)) * ((h / 2 - 24) / (w / 2 - 24)), Math.abs(Math.sin(ang)), 1e-3);
      const ax = cx + Math.cos(ang) * Math.min(r, w / 2 - 24);
      const ay = cy + Math.sin(ang) * Math.min(r, h / 2 - 24);
      arrow.style.borderBottomColor = ['#ff5a5f', '#3fa7ff', '#ffc23f', '#46d37a'][p.slot % 4]!;
      arrow.style.opacity = '1';
      arrow.style.transform = `translate(${ax - 9}px, ${ay - 8}px) rotate(${(ang * 180) / Math.PI + 90}deg)`;
    } else if (arrow) arrow.style.opacity = '0';
  });
  for (const [id, el] of labels) {
    if (present.has(id)) continue;
    el.remove();
    labels.delete(id);
    arrows.get(id)?.remove();
    arrows.delete(id);
    scene.removePlayer(id);
  }

  // The horde, at the render time (a killed zombie vanishes when its death is drawn).
  scene.horde.begin(now / 1000);
  if (renderAt !== null) {
    const survivors: Vec2[] = [];
    st.players.forEach((p) => {
      if (p.life === LIFE.alive) survivors.push(p);
    });
    for (const key of zombiesBuf.idsAt(renderAt)) {
      const z = zombiesBuf.sampleAt(key, renderAt);
      if (!z) continue;
      const kind = Math.round(z.kind);
      const r = (ZOMBIES[kind]?.radius ?? 0.4) + 0.9;
      const nearTarget = survivors.some((p) => Math.hypot(p.x - z.x, p.y - z.y) < r);
      scene.horde.zombie(Number.parseInt(key, 36), kind, z.x, z.y, nearTarget);
    }
  }
  scene.horde.end();

  // The dog, the truck, pickups, rocks, goo, barricades, loot sparkles.
  const dogAt = (renderAt !== null ? misc.sampleAt('dog', renderAt) : null) ?? { x: st.dogX, y: st.dogY };
  const dogSpeed = renderAt !== null ? speedOf(misc, 'dog', renderAt) : 0;
  scene.setDog(dogAt.x, dogAt.y, st.dogFacing, st.dogState, dogSpeed, st.dogBite);
  const truckAt =
    st.phase === 'escape' && renderAt !== null
      ? (misc.sampleAt('truck', renderAt) ?? { x: st.truckX, y: st.truckY })
      : { x: st.truckX, y: st.truckY };
  const repaired = st.wheels >= TRUCK_WHEELS && st.fuel >= TRUCK_FUEL && st.truckScrap >= TRUCK_SCRAP;
  scene.setTruck(truckAt.x, truckAt.y, st.truckYaw, repaired, st.phase === 'holdout' || st.phase === 'escape');
  st.pickups.forEach((p, id) => scene.setPickup(id, p.kind, p.x, p.y));
  if (renderAt !== null) {
    for (const key of rocksBuf.idsAt(renderAt)) {
      const r = rocksBuf.sampleAt(key, renderAt);
      if (r) scene.setRock(key, r.x, r.y, r.h);
    }
  }
  st.goo.forEach((g, id) => scene.setGoo(id, g.x, g.y));
  SOCKETS.forEach((_, i) => scene.setBarricade(i, st.barricades.get(String(i))?.tier ?? 0));
  scene.prune();
  if (myPos) {
    const marks: { x: number; y: number; special: boolean }[] = [];
    for (const s of LOOT_SPOTS) {
      if (st.opened[s.id] === '1' || s.kind === 'search') continue;
      if (Math.abs(s.x - myPos.x) > 16 || Math.abs(s.y - myPos.y) > 12) continue;
      marks.push({ x: s.x, y: s.y, special: s.kind === 'special' });
      if (marks.length >= 14) break;
    }
    scene.setMarkers(marks);
  }

  // Effects due at the render time.
  while (fxQueue.length && (renderAt === null || fxQueue[0]!.t * DT * 1000 <= renderAt)) {
    const batch = fxQueue.shift()!;
    for (const e of batch.e) playFx(e, st, myPos);
  }

  // The sky, your flashlight, the camera.
  const progress = st.length > 0 ? 1 - st.timer / st.length : 0;
  const sky = skyAt(st.phase, progress, st.blood, st.night > 0);
  scene.setSky(sky, st.blood && st.phase === 'night');
  if (myPos && mine)
    scene.setFlashlight(
      myPos.x,
      myPos.y,
      Math.atan2(aimDir.y, aimDir.x),
      mine.life === LIFE.alive ? Math.max(0, sky.night - 0.3) / 0.7 : 0,
    );
  const f = st.phase === 'escape' ? truckAt : (myPos ?? { x: 0, y: 0 });
  const cursor = controls.device === 'mouse' ? controls.mouse : null;
  const rect = ui.canvas.getBoundingClientRect();
  const lead =
    cursor && rect.width > 0
      ? {
          x: Math.max(-1, Math.min(1, (cursor.x - rect.width / 2) / (rect.width / 2))) * CAMERA_LEAD,
          y: Math.max(-1, Math.min(1, (cursor.y - rect.height / 2) / (rect.height / 2))) * CAMERA_LEAD * 0.7,
        }
      : undefined;
  scene.focus(f.x, f.y, alive ? aimDir : null, false, alive ? lead : undefined);

  // HUD.
  const ctx = mine && myPos ? contextFor(st, mine, myPos) : null;
  contextLabel = ctx?.label ?? '';
  results.observe(st.phase, now);
  hud.render(st, me, ctx, results.current());
  controls.draw();
  updatePeople(st);
}

/** Ground speed of a buffered entity at the render time (for the dog's gait). */
function speedOf(buf: SnapshotBuffer<'x' | 'y'>, id: string, at: number): number {
  const a = buf.sampleAt(id, at - 100);
  const b = buf.sampleAt(id, at);
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y) / 0.1;
}

/** The host menu's People list: sent on join and whenever the group or a score changes. */
function updatePeople(st: NorthdaleStateView) {
  const list: MenuPlayer[] = [];
  st.players.forEach((p, id) => {
    list.push({
      name: p.name.slice(0, 32) || 'Survivor',
      ...(p.uid ? { userId: p.uid } : {}),
      detail: peopleDetail(p),
      ...(id === me ? { you: true } : {}),
    });
  });
  const key = JSON.stringify(list);
  if (key === lastPeople) return;
  lastPeople = key;
  menuPlayersSent = list;
  if (rally.isHosted) rally.menu.players(list);
}

// --- boot ---------------------------------------------------------------------------------------------------------------
/** How often the connection (with its round-trip time) is reported to the host while connected. */
const NET_STATUS_MS = 2000;
let netState: 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
function netStatus(state: typeof netState) {
  netState = state;
  if (!rally.isHosted) return;
  const rtt = net?.rttMs;
  rally.net.status(state, state === 'connected' ? (rtt ?? undefined) : undefined);
}

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
  let username = params.get('name') ?? 'player';
  // The handshake first: the player's settings (graphics quality decides MSAA and the pixel ratio), the safe area and
  // the host's menu button. The host keeps its loading screen up (labels were sent) until progress 1.
  if (rally.isHosted) {
    const ctx = await rally.ready();
    applySafeAreaVars(safeArea(ctx.device.safeArea));
    const mb = ctx.device.menuButton;
    if (mb) hud.reserveCorner(mb.x + mb.width + 4, mb.y + mb.height + 4);
    username = ctx.user.username;
    settings = rally.settings;
  } else {
    applySafeAreaVars(safeArea());
    // A plain browser: the template's own small exit button (the host's menu has Leave).
    ui.exit.hidden = false;
  }
  const quality = qualityOf(settings);
  const { app, onResize } = createApp({
    canvas: ui.canvas,
    maxPixelRatio: dprFor(quality),
    antialias: !LOWFX && quality !== 'low',
    ...(import.meta.env.DEV && params.has('noaa') ? { antialias: false } : {}),
  });
  if (LOWFX) applyLowFx(app);
  else app.scene.clusteredLightingEnabled = false;
  // Later quality changes: the pixel-ratio cap follows (MSAA stays as booted).
  let dprCap = dprFor(quality);
  applyDpr = (q) => {
    const cap = dprFor(q);
    if (cap === dprCap) return;
    dprCap = cap;
    app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, cap);
    app.resizeCanvas();
  };
  onResize(() => {
    const want = Math.min(window.devicePixelRatio || 1, dprCap);
    if (app.graphicsDevice.maxPixelRatio !== want) {
      app.graphicsDevice.maxPixelRatio = want;
      app.resizeCanvas();
    }
  });
  app.on('frameend', () => metrics.tick());
  setupLifecycle(app);

  const models = await loadNorthdaleModels(app, (f, label) => loading(0.05 + f * 0.6, label));
  loading(0.68, 'Building the town');
  await new Promise((r) => setTimeout(r, 0));
  scene = createNorthdaleScene(app, (fn) => onResize(fn), models, { effects: !LOWFX, pools: !LOWFX });
  applySettings(settings);
  app.on('update', (dt: number) => frame(dt));
  app.start();
  await new Promise<void>((resolve) => {
    app.once('frameend', () => resolve());
    setTimeout(resolve, 1000);
  });
  readyMs = Math.round(performance.now() - bootStart);
  // The host's game menu: our settings and "How to play".
  try {
    menuValues = await rally.menu.define({ settings: GAME_SETTINGS, help: HELP });
    Object.assign(gameSettings, menuValues);
    applySettings(settings);
  } catch (err) {
    console.warn('menu.define', err);
  }
  rally.on('settingsChanged', (s) => applySettings(s));
  rally.on('menu', ({ open }) => {
    menuOpen = open;
    if (open) {
      controls.release();
      releaseInput();
    }
    inputEnabled();
  });

  if (exiting) return;
  loading(0.8, 'Connecting to the server');
  joining = (async () => {
    if (import.meta.env.DEV && ART) {
      const art = await import('./art.ts');
      if (!art.isArtShot(ART)) throw new Error(`?art=${ART}: expected one of ${art.ART_SHOTS.join(', ')}`);
      return art.stageArt(ART, { app, scene, hud });
    }
    if (rally.isHosted) {
      const { endpoint, seatReservation } = await rally.session.join();
      loading(0.9, 'Joining your group');
      return connect(endpoint, { seatReservation });
    }
    const endpoint = toWs(params.get('colyseus') ?? `ws://${location.hostname || 'localhost'}:2567`);
    loading(0.9, 'Joining your group');
    return connect(endpoint, {
      roomName: 'northdale',
      options: { username, ...(params.has('private') ? { private: true } : {}) },
    });
  })();
  let joined: Net;
  try {
    joined = await joining;
  } catch (err) {
    if (exiting) return;
    ui.loading.hidden = true;
    hud.setMessage("Couldn't join", err instanceof Error ? err.message : String(err));
    // Our own error UI is up: the host may take its loading screen down.
    loading(1);
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
  // The connection, for the host's ping bars and its own "Reconnecting…" banner (hosted, ours stays off).
  netStatus('connected');
  net.room.onDrop(() => {
    netStatus('reconnecting');
    if (!rally.isHosted) hud.setMessage('Connection lost', 'Reconnecting…');
  });
  net.room.onReconnect(() => {
    netStatus('connected');
    hud.setMessage(null);
    reportReconnection();
  });
  net.room.onLeave((code) => {
    netStatus('disconnected');
    if (!exiting) hud.setMessage('Disconnected', `The server closed the connection (${code}).`);
  });
  setInterval(() => {
    if (netState === 'connected') netStatus('connected');
  }, NET_STATUS_MS);
  // Playable: the first state is in.
  await new Promise<void>((resolve) => {
    if (net?.state?.players) return resolve();
    net?.onPatch(() => resolve());
    setTimeout(resolve, 3000);
  });
  ui.loading.hidden = true;
  loading(1);
}

function setupLifecycle(app: Parameters<typeof createLifecycle>[1]) {
  const lifecycle = createLifecycle(rally, app, {
    onPause: () => {
      paused = true;
      ui.paused.hidden = false;
      inputEnabled();
      releaseInput();
      audio.suspend();
    },
    onResume: () => {
      paused = false;
      ui.paused.hidden = true;
      inputEnabled();
      audio.resume();
      metrics.reset();
    },
    onExitRequested: async () => {
      exiting = true;
      inputEnabled();
      releaseInput();
      const j = net ?? (await joining?.catch(() => null));
      await j?.leave().catch(() => {});
      if (!rally.isHosted) hud.setMessage('You left the game', 'Reload to play again');
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
  hud.onStart(() => net?.start());
  setInterval(() => rally.telemetry.report('northdale', collect(app)), TELEMETRY_MS);
}

function collect(app: Parameters<typeof createLifecycle>[1]) {
  const f = metrics.snapshot();
  const gd = (app as unknown as { graphicsDevice: { maxPixelRatio: number; width: number; height: number } })
    .graphicsDevice;
  return {
    fps: f.fps,
    frameMs: f.frameMs,
    p95Ms: f.p95Ms,
    worstMs: f.worstMs,
    wsRttMs: net?.rttMs ?? -1,
    players: net?.state?.players?.size ?? 0,
    zombies: net?.state?.zombies?.size ?? 0,
    phase: net?.state.phase ?? 'none',
    night: net?.state.night ?? 0,
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    graphics: qualityOf(settings),
    readyMs,
    heapMb: jsHeapMb() ?? -1,
  };
}

boot().catch((err) => {
  console.error(err);
  rally.reportError(err);
  ui.loading.hidden = true;
  loading(1);
});

// Dev-only probe for the Playwright e2e, perf and art scripts (stripped from production builds).
if (import.meta.env.DEV) {
  const find = (name: string): { id: string; p: NorthdalePlayerView } | null => {
    let found: { id: string; p: NorthdalePlayerView } | null = null;
    net?.state?.players?.forEach((p, id) => {
      if (p.name === name) found = { id, p };
    });
    return found;
  };
  (window as unknown as { __northdale: unknown }).__northdale = {
    get joined() {
      return net !== null && !!net.state?.players;
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
    get night() {
      return net?.state.night ?? 0;
    },
    get nights() {
      return net?.state.nights ?? 0;
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
    get scrap() {
      return net?.state.scrap ?? 0;
    },
    get truck() {
      const s = net?.state;
      return s ? { wheels: s.wheels, fuel: s.fuel, scrap: s.truckScrap } : null;
    },
    get dog() {
      return net?.state.dogState ?? 0;
    },
    get opened() {
      return [...(net?.state.opened ?? '')].filter((c) => c === '1').length;
    },
    get pickups() {
      return net?.state.pickups.size ?? 0;
    },
    /** Pickups lying within `r` of you. */
    pickupsNear(r: number) {
      const mine = net?.state.players.get(me);
      let n = 0;
      net?.state.pickups.forEach((p) => {
        if (mine && Math.hypot(p.x - mine.x, p.y - mine.y) <= r) n++;
      });
      return n;
    },
    /** The safehouse's chest (if still closed). */
    chest() {
      const s = LOOT_SPOTS.find(
        (l) =>
          l.kind === 'chest' &&
          l.x > SAFE.x0 &&
          l.x < SAFE.x1 &&
          l.y > SAFE.y0 &&
          l.y < SAFE.y1 &&
          net?.state.opened[l.id] !== '1',
      );
      return s ? { id: s.id, x: s.x, y: s.y } : null;
    },
    get truckAt() {
      return { x: net?.state.truckX ?? 0, y: net?.state.truckY ?? 0 };
    },
    get killsSeen() {
      return seen.kills;
    },
    get fxSeen() {
      return [...seen.fx];
    },
    get result() {
      return lastResult;
    },
    get resultLine() {
      const el = document.querySelector<HTMLElement>('[data-role="result"]');
      return el ? { kind: el.dataset.kind ?? '', text: el.textContent ?? '' } : null;
    },
    get centerTitle() {
      const c = document.getElementById('center');
      return c && !c.hidden ? (document.getElementById('center-title')?.textContent ?? '') : '';
    },
    get banner() {
      const b = document.getElementById('banner');
      return b && !b.hidden ? (document.getElementById('banner-title')?.textContent ?? '') : '';
    },
    get context() {
      return contextLabel;
    },
    get menuDefined() {
      return menuValues;
    },
    get menuPlayers() {
      return menuPlayersSent;
    },
    get menuOpen() {
      return menuOpen;
    },
    get settings() {
      return { ...settings, game: { ...gameSettings } };
    },
    get drawnZombies() {
      return scene?.horde.drawn ?? 0;
    },
    get fps() {
      return metrics.snapshot();
    },
    get stats() {
      const app = (scene?.camera as unknown as { _app?: unknown })?._app;
      void app;
      return { town: scene?.town.stats };
    },
    get aim() {
      return aimDir;
    },
    get stick() {
      return controls.move;
    },
    get melee() {
      return controls.melee;
    },
    get firing() {
      return controls.fire;
    },
    get acting() {
      return controls.act;
    },
    names() {
      const out: string[] = [];
      net?.state?.players?.forEach((p) => out.push(p.name));
      return out.sort();
    },
    player(name: string) {
      const f = find(name);
      if (!f) return null;
      const p = f.p;
      return {
        x: p.x,
        y: p.y,
        hp: p.hp,
        life: p.life,
        gun: p.gun,
        melee: p.melee,
        dur: p.dur,
        ammo: [p.a0, p.a1, p.a2, p.a3],
        items: [p.i0, p.i1],
        carry: p.carry,
        kills: p.kills,
        revive: p.revive,
        inRun: p.inRun,
        connected: p.connected,
      };
    },
    zombies() {
      const out: { id: string; kind: number; x: number; y: number; hp: number }[] = [];
      net?.state?.zombies?.forEach((z, id) => out.push({ id, kind: z.kind, x: z.x, y: z.y, hp: z.hp }));
      return out;
    },
    screenOf(x: number, y: number) {
      const out = { x: 0, y: 0 };
      scene.toScreen(x, y, 1, out);
      const r = ui.canvas.getBoundingClientRect();
      return { x: out.x + r.left, y: out.y + r.top };
    },
    dev(cmd: DevCommand) {
      net?.dev(cmd);
    },
    labelText() {
      return [...labels.values()].map((l) => esc(l.textContent ?? ''));
    },
    guns: GUNS,
    Action,
  };
}
