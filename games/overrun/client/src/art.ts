import type { Room } from '@colyseus/sdk';
import type { Application } from 'playcanvas';
import {
  DT,
  ExplosiveKind,
  OverrunMatch,
  ZOMBIES,
  ZombieKind,
  type OverrunPlayerView,
  type OverrunStateView,
  type Phase,
  type ResultMessage,
} from '@rally/game-overrun-server';
import type { Hud } from './hud.ts';
import type { Net } from './net.ts';
import type { OverrunScene } from './scene.ts';

/**
 * Dev-only `?art=<shot>` mode: stages one deterministic scene with the game's own renderer, HUD and frame loop for
 * the store art that games/overrun/scripts/art.ts captures. main.ts imports this module only behind
 * `import.meta.env.DEV`, so it is never part of a published build.
 *
 * Every pose comes from the shared rules (`OverrunMatch`, the code the server runs) with a fixed seed and scripted
 * players, frozen at a chosen moment; effects (explosions, blood) are staged on top and time is stopped.
 * - `icon`: two survivors back to back, the horde closing in, close up, no HUD.
 * - `cover`: three survivors in the plaza, a horde pouring in from the gates, a barrel going off; no HUD.
 * - `horde`: wave 6, a horde closing in on three players, combo x5 (phone landscape, HUD).
 * - `chain`: a chain of barrels going off through the horde (HUD).
 * - `banner`: the "Wave 7" breather banner over a blood-soaked yard (HUD).
 * - `closeup`: not store art, for tuning the models: four survivors (aiming, firing, backpedalling, down and up again
 *   2.6 s in) and zombies walking, running, punching and dying, with the props; time runs `?t=` seconds (default 2)
 *   before it stops.
 */
export const ART_SHOTS = ['icon', 'cover', 'horde', 'chain', 'banner', 'closeup'] as const;
export type ArtShot = (typeof ART_SHOTS)[number];

export const isArtShot = (s: string | null): s is ArtShot => ART_SHOTS.includes(s as ArtShot);

const NAMES = ['you', 'mika', 'dex', 'rosa'];
const RTT_MS = 41;

export interface ArtPose {
  state: OverrunStateView;
  me: string;
  /** Explosions to stage: position, radius and how far into the blast (0…1). */
  booms: { x: number; y: number; r: number; age: number }[];
  /** Blood splats already on the floor. */
  blood: { x: number; y: number; amount: number }[];
  /** Muzzle flashes / tracers in flight: shooter position and angle. */
  shots: { x: number; y: number; angle: number; len: number; weapon: number }[];
  /** Camera zoom (closer for the icon) and the aim the camera leads toward. */
  zoom: number;
  aim: { x: number; y: number };
  clean: boolean;
  /** Time runs `seconds` before it stops, `step` moving things `t` seconds in (the shots fire every 0.3 s). */
  live?: { seconds: number; step(state: OverrunStateView, t: number): void };
}

/** A frozen copy of the synced state, as the client reads it from Colyseus. */
export function view(m: OverrunMatch, over: Partial<OverrunStateView> = {}): OverrunStateView {
  const players = new Map<string, OverrunPlayerView>();
  for (const p of m.playerList) {
    players.set(p.id, {
      name: p.name,
      slot: p.slot,
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
      aim: p.aim,
      hp: Math.ceil(p.hp),
      down: p.down,
      revive: 0,
      weapon: p.weapon,
      a1: p.ammo[1] ?? 0,
      a2: p.ammo[2] ?? 0,
      a3: p.ammo[3] ?? 0,
      a4: p.ammo[4] ?? 0,
      score: p.score,
      kills: p.kills,
      revives: p.revives,
      connected: true,
      guest: false,
      active: p.active,
      ack: 0,
    });
  }
  const zombies = new Map<string, { kind: number; x: number; y: number; hp: number }>();
  for (const z of m.zombies.values()) {
    zombies.set(z.id.toString(36), { kind: z.kind, x: z.x, y: z.y, hp: Math.ceil((z.hp / z.maxHp) * 100) });
  }
  const projectiles = new Map<string, { x: number; y: number; h: number; tx: number; ty: number }>();
  for (const p of m.projectiles.values())
    projectiles.set(p.id.toString(36), { x: p.x, y: p.y, h: p.h, tx: p.tx, ty: p.ty });
  const explosives = new Map<string, { kind: number; x: number; y: number; armed: boolean }>();
  for (const e of m.explosives.values())
    explosives.set(e.id.toString(36), { kind: e.kind, x: e.x, y: e.y, armed: true });
  const pickups = new Map<string, { kind: number; x: number; y: number }>();
  for (const p of m.pickups.values()) pickups.set(p.id.toString(36), { kind: p.kind, x: p.x, y: p.y });
  return {
    phase: m.phase as Phase,
    timer: m.timer,
    wave: m.wave,
    reached: m.reached,
    remaining: m.remaining,
    teamScore: m.teamScore,
    teamKills: m.teamKills,
    combo: m.combo,
    comboLeft: Math.round(m.comboLeft * 100),
    unlocked: m.unlocked,
    run: 1,
    code: '',
    isPrivate: false,
    maxPlayers: 4,
    tick: m.tick,
    players,
    zombies,
    projectiles,
    explosives,
    pickups,
    ...over,
  };
}

/** Scripted survivors: aim at the nearest zombie and hold the trigger; drift away from the closest one. */
function steer(m: OverrunMatch, strafe = 0.35) {
  for (const p of m.playerList) {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const z of m.zombies.values()) {
      const d = Math.hypot(z.x - p.x, z.y - p.y);
      if (d < bd) [bd, best] = [d, z];
    }
    if (!best) {
      m.setInput(p.id, { move: { x: 0, y: 0 }, aim: null, fire: false, weapon: 0 });
      continue;
    }
    const ax = (best.x - p.x) / bd;
    const ay = (best.y - p.y) / bd;
    const away = bd < 3 ? { x: -ax * strafe, y: -ay * strafe } : { x: 0, y: 0 };
    m.setInput(p.id, { move: away, aim: { x: ax, y: ay }, fire: bd < 11, weapon: Math.min(2, m.unlocked - 1) });
  }
}

/** A run of the real rules: `players` survivors, wave `wave`, then `ring` zombies placed around them and stepped. */
function horde(
  seed: number,
  players: number,
  wave: number,
  ring: { n: number; r0: number; r1: number; brutes: number; spitters: number },
  seconds: number,
  place: [number, number][],
) {
  const m = new OverrunMatch({ seed, rules: { firstBreatherTime: 0.1, waveSize: 1, startWave: wave } });
  for (let i = 0; i < players; i++) m.addPlayer(`p${i}`, NAMES[i]!);
  for (let i = 0; i < 30 && m.phase !== 'wave'; i++) m.step(DT);
  m.clearZombies();
  m.unlocked = 3;
  for (const p of m.playerList) {
    p.ammo[1] = 160;
    p.ammo[2] = 24;
  }
  place.forEach(([x, y], i) => m.place(`p${i}`, x, y));
  for (let i = 0; i < ring.n; i++) {
    const a = (i / ring.n) * Math.PI * 2 + (i % 3) * 0.13;
    const r = ring.r0 + (((i * 7919) % 100) / 100) * (ring.r1 - ring.r0);
    const kind =
      i < ring.brutes ? ZombieKind.brute : i < ring.brutes + ring.spitters ? ZombieKind.spitter : ZombieKind.walker;
    m.spawnZombie(
      kind,
      Math.max(-23, Math.min(23, Math.cos(a) * r)),
      Math.max(-15, Math.min(15, Math.sin(a) * r * 0.75)),
    );
  }
  for (let t = 0; t < seconds / DT; t++) {
    steer(m);
    m.step(DT);
    for (const p of m.playerList) p.hp = Math.max(p.hp, 60);
  }
  return m;
}

/** `seconds`: how long the closeup's time runs (`?t=`). */
export function artPose(shot: ArtShot, seconds = 2): ArtPose {
  switch (shot) {
    case 'icon': {
      const m = horde(21, 2, 5, { n: 20, r0: 4.2, r1: 7.5, brutes: 1, spitters: 0 }, 0.7, [
        [-0.55, 0.2],
        [0.55, -0.2],
      ]);
      const [a, b] = m.playerList;
      a!.aim = Math.PI * 0.85;
      b!.aim = -Math.PI * 0.15;
      return {
        state: view(m, { combo: 1, comboLeft: 0 }),
        me: 'p0',
        booms: [],
        blood: scatter(9, 14, 5),
        shots: [
          { x: a!.x, y: a!.y, angle: a!.aim, len: 3.4, weapon: 2 },
          { x: b!.x, y: b!.y, angle: b!.aim, len: 4.5, weapon: 1 },
        ],
        zoom: 0.48,
        aim: { x: 0, y: 0 },
        clean: true,
      };
    }
    case 'cover': {
      const m = horde(33, 3, 7, { n: 70, r0: 7, r1: 17, brutes: 3, spitters: 3 }, 1.2, [
        [-1.2, 0.6],
        [1.3, 0.4],
        [0.1, -1.0],
      ]);
      return {
        state: view(m),
        me: 'p0',
        booms: [{ x: 6.5, y: -3.5, r: 3.6, age: 0.25 }],
        blood: scatter(4, 40, 9),
        shots: m.playerList.map((p) => ({ x: p.x, y: p.y, angle: p.aim, len: 6, weapon: p.slot === 1 ? 2 : 1 })),
        zoom: 0.9,
        aim: { x: 0, y: 0.2 },
        clean: true,
      };
    }
    case 'horde': {
      const m = horde(6, 3, 6, { n: 64, r0: 7, r1: 16, brutes: 2, spitters: 3 }, 1.3, [
        [-0.9, 0.9],
        [1.2, 0.7],
        [0.2, -0.9],
      ]);
      return {
        state: view(m, {
          combo: 5,
          comboLeft: 62,
          teamScore: 18420,
          teamKills: 236,
          remaining: 41,
          wave: 6,
          reached: 6,
        }),
        me: 'p0',
        booms: [],
        blood: scatter(11, 45, 8),
        shots: m.playerList.map((p) => ({ x: p.x, y: p.y, angle: p.aim, len: 5.5, weapon: p.slot === 2 ? 2 : 1 })),
        zoom: 1,
        aim: { x: 0.2, y: -0.4 },
        clean: false,
      };
    }
    case 'chain': {
      const m = horde(9, 3, 8, { n: 54, r0: 5.5, r1: 13, brutes: 2, spitters: 1 }, 1.0, [
        [-2.5, 1.5],
        [-1.0, 2.6],
        [-3.2, 3.2],
      ]);
      m.unlocked = 5;
      // A line of barrels through the horde (only the far ones are left: the near ones are mid-blast).
      const id = (x: number, y: number) => {
        m.explosives.set(1000 + m.explosives.size, {
          id: 1000 + m.explosives.size,
          kind: ExplosiveKind.barrel,
          x,
          y,
          owner: 'p0',
          trigger: null,
          armIn: 0,
          fuse: null,
        });
      };
      id(7.5, -4.6);
      id(9.2, -6.2);
      return {
        state: view(m, {
          combo: 8,
          comboLeft: 88,
          teamScore: 31760,
          teamKills: 402,
          remaining: 37,
          wave: 8,
          reached: 8,
          unlocked: 5,
        }),
        me: 'p0',
        booms: [
          { x: 1.8, y: 0.2, r: 3.6, age: 0.62 },
          { x: 3.7, y: -1.4, r: 3.6, age: 0.38 },
          { x: 5.7, y: -3.0, r: 3.6, age: 0.16 },
        ],
        blood: scatter(17, 60, 7),
        shots: [],
        zoom: 1,
        aim: { x: 0.7, y: -0.4 },
        clean: false,
      };
    }
    case 'banner': {
      const m = new OverrunMatch({ seed: 4, rules: { firstBreatherTime: 5, startWave: 7 } });
      for (let i = 0; i < 3; i++) m.addPlayer(`p${i}`, NAMES[i]!);
      for (let i = 0; i < 25; i++) m.step(DT);
      m.unlocked = 4;
      const pickups: [number, number, number][] = [
        [3.5, 2.2, 1],
        [-4.8, -1.4, 0],
        [6.2, -2.6, 2],
      ];
      pickups.forEach(([x, y, kind], i) => m.pickups.set(500 + i, { id: 500 + i, kind, x, y, ttl: 10 }));
      m.explosives.set(900, {
        id: 900,
        kind: ExplosiveKind.barrel,
        x: -2.4,
        y: 2.8,
        owner: 'p1',
        trigger: null,
        armIn: 0,
        fuse: null,
      });
      m.explosives.set(901, {
        id: 901,
        kind: ExplosiveKind.mine,
        x: 2.2,
        y: -2.6,
        owner: 'p2',
        trigger: null,
        armIn: 0,
        fuse: null,
      });
      [
        [-1.6, 0.4],
        [1.4, 1.2],
        [0.4, -1.5],
      ].forEach(([x, y], i) => m.place(`p${i}`, x!, y!));
      m.playerList.forEach((p, i) => (p.aim = [-0.4, 2.4, -1.9][i]!));
      return {
        state: view(m, { phase: 'breather', wave: 7, reached: 6, timer: 3.4, teamScore: 24910, teamKills: 318 }),
        me: 'p0',
        booms: [],
        blood: scatter(23, 120, 12),
        shots: [],
        zoom: 1,
        aim: { x: 0, y: 0 },
        clean: false,
      };
    }
    case 'closeup': {
      const m = horde(2, 4, 3, { n: 0, r0: 0, r1: 0, brutes: 0, spitters: 0 }, 0, [
        [0, 0.3],
        [-3.4, -0.4],
        [2.7, -0.3],
        [-1.6, 1.1],
      ]);
      // You aim the pistol, mika fires the shotgun, dex is down (until 2.6 s in), rosa backpedals.
      const [you, gunner, downed, back] = m.playerList;
      you!.aim = -0.5;
      gunner!.aim = -2.6;
      gunner!.weapon = 2;
      downed!.down = true;
      back!.aim = 2.2;
      const state = view(m, { combo: 1, comboLeft: 0 });
      // Zombies where they are when time stops (or when they die): id (its look), kind, position, velocity (units/s).
      const zombies: { id: number; kind: number; x: number; y: number; vx: number; vy: number; dies?: number }[] = [];
      const coming = (id: number, kind: number, x: number, y: number, to: { x: number; y: number }, dies?: number) => {
        const d = Math.hypot(to.x - x, to.y - y);
        const v = ZOMBIES[kind]!.speed;
        zombies.push({ id, kind, x, y, vx: ((to.x - x) / d) * v, vy: ((to.y - y) / d) * v, dies });
      };
      coming(3, ZombieKind.walker, 2.4, -2, you!);
      coming(4, ZombieKind.walker, 3.9, -0.4, you!);
      coming(5, ZombieKind.walker, -0.95, -0.25, you!);
      zombies[2]!.vx = zombies[2]!.vy = 0; // close enough to punch
      coming(6, ZombieKind.brute, -0.3, -2.8, you!);
      coming(7, ZombieKind.spitter, -5.6, -2.1, gunner!);
      coming(12, ZombieKind.walker, 1.8, -1.6, you!, 0.4);
      const backVel = { x: -Math.cos(back!.aim) * 1.6, y: -Math.sin(back!.aim) * 1.6 };
      const pickups = state.pickups as Map<string, { kind: number; x: number; y: number }>;
      [
        [1.3, 1.2],
        [3.9, 1.4],
        [4.7, 0.7],
        [-2.6, -1.4],
        [-1.9, -1.9],
      ].forEach(([x, y], kind) => pickups.set(`k${kind}`, { kind, x: x!, y: y! }));
      (state.explosives as Map<string, { kind: number; x: number; y: number; armed: boolean }>).set('e0', {
        kind: ExplosiveKind.barrel,
        x: 4.6,
        y: -1.9,
        armed: true,
      });
      return {
        state,
        me: 'p0',
        booms: [],
        blood: [],
        shots: [{ x: gunner!.x, y: gunner!.y, angle: gunner!.aim, len: 2.6, weapon: 2 }],
        zoom: 0.5,
        aim: { x: 0, y: 0 },
        clean: true,
        live: {
          seconds,
          step(st, t) {
            const zs = st.zombies as Map<string, { kind: number; x: number; y: number; hp: number }>;
            for (const z of zombies) {
              const key = z.id.toString(36);
              const dt = t - (z.dies ?? seconds);
              if (dt >= 0 && z.dies !== undefined) zs.delete(key);
              else zs.set(key, { kind: z.kind, x: z.x + z.vx * dt, y: z.y + z.vy * dt, hp: 100 });
            }
            const b = st.players.get('p3')!;
            Object.assign(b, { x: back!.x + backVel.x * (t - seconds), y: back!.y + backVel.y * (t - seconds) });
            Object.assign(b, { vx: backVel.x, vy: backVel.y });
            st.players.get('p2')!.down = t < 2.6;
          },
        },
      };
    }
  }
}

/** Deterministic blood around the plaza: `n` splats within `spread` units. */
function scatter(seed: number, n: number, spread: number): { x: number; y: number; amount: number }[] {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, () => {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * spread + 1.5;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.8, amount: 0.5 + rnd() * 0.9 };
  });
}

// --- staging in the page ---------------------------------------------------------------------------------

export interface ArtProbe {
  shot: ArtShot;
  /** True once the pose is on screen and time is frozen. */
  ready: boolean;
}

const CLEAN_CSS = '#hud, #labels, .stick, #vignette { display: none !important; }';

/**
 * Builds a `Net` look-alike that serves the frozen pose to main.ts' normal frame loop (interpolation, labels, HUD),
 * then stages the effects, freezes time and stops drawing. Sets `window.__overrunArt` for the capture script.
 */
export function stageArt(shot: ArtShot, deps: { app: Application; scene: OverrunScene; hud: Hud }): Net {
  const { app, scene, hud } = deps;
  const pose = artPose(shot, Number(new URLSearchParams(location.search).get('t')) || undefined);
  const state = pose.state;
  if (pose.clean) {
    const style = document.createElement('style');
    style.textContent = CLEAN_CSS;
    document.head.appendChild(style);
  }
  hud.hideHint();
  scene.setZoom(pose.zoom);

  const shoot = () => {
    for (const s of pose.shots) {
      const x1 = s.x + Math.cos(s.angle) * (0.35 + s.len);
      const y1 = s.y + Math.sin(s.angle) * (0.35 + s.len);
      scene.tracer(s.x + Math.cos(s.angle) * 0.35, s.y + Math.sin(s.angle) * 0.35, x1, y1, s.weapon);
      scene.muzzle(s.x, s.y, s.angle, s.weapon);
    }
  };
  // A live pose moves once the frame loop is going, until time stops, and the server clock ticks meanwhile. Its time is
  // the frames' (at most 1/30 s each, however slowly software GL draws), so `?t=` poses everyone alike every time.
  const live = pose.live;
  const tick0 = state.tick;
  const start = performance.now();
  let liveT = -1;
  let fired = 0;
  if (live) {
    app.maxDeltaTime = 1 / 30;
    live.step(state, 0);
    app.on('update', (dt: number) => {
      if (liveT >= 0 && liveT < live.seconds) liveT = Math.min(live.seconds, liveT + dt);
    });
  }
  const patchHandlers: ((t: number) => void)[] = [];
  const patch = () => {
    const now = performance.now();
    if (live && liveT < live.seconds) {
      state.tick = tick0 + Math.round((now - start) / 1000 / DT);
      if (liveT >= 0) live.step(state, liveT);
      if (liveT >= fired * 0.3) {
        fired++;
        shoot();
      }
    }
    patchHandlers.forEach((fn) => fn(now));
  };
  setInterval(patch, 50);

  const probe: ArtProbe = { shot, ready: false };
  (window as unknown as { __overrunArt: ArtProbe }).__overrunArt = probe;

  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : app.once('frameend', tick));
      app.once('frameend', tick);
    });

  void (async () => {
    // Let the frame loop build everyone (and the render clock settle), then stage the effects and stop the clock.
    await frames(12);
    if (live) {
      liveT = 0;
      while (liveT < live.seconds) await frames(1);
      live.step(state, live.seconds);
    }
    for (const b of pose.blood) scene.blood(b.x, b.y, b.amount, Math.round(b.x * 977 + b.y * 131) >>> 0);
    // Blood bursts fly off: let them land before freezing.
    if (pose.blood.length) scene.update(1);
    // (A live pose has been firing all along: no flash over the guns.)
    if (!live) shoot();
    // Explosions oldest first, each aged to its point in the blast (0.45 s long) when the next one starts.
    const booms = [...pose.booms].sort((p, q) => q.age - p.age);
    booms.forEach((b, i) => {
      scene.explosion(b.x, b.y, b.r);
      scene.update(0.45 * (b.age - (booms[i + 1]?.age ?? 0)));
    });
    app.timeScale = 0;
    await frames(10);
    app.autoRender = false;
    probe.ready = true;
  })();

  const room = {
    roomId: `art-${shot}`,
    reconnectionToken: '',
    send() {},
    onDrop() {},
    onReconnect() {},
    onLeave() {},
  } as unknown as Room;

  return {
    room,
    state,
    sessionId: pose.me,
    rttMs: RTT_MS,
    offer: () => null,
    release: () => null,
    onFx() {},
    onPatch(fn) {
      patchHandlers.push(fn);
      fn(performance.now());
    },
    onResult(fn: (r: ResultMessage) => void) {
      void fn;
    },
    start() {},
    dev() {},
    leave: async () => {},
  };
}
