import type { Room } from '@colyseus/sdk';
import type { Application } from 'playcanvas';
import {
  BotDriver,
  DT,
  FINAL_TIER,
  GunRunMatch,
  LADDER,
  WEAPON_IDS,
  WEAPONS,
  type GunRunPlayerView,
  type GunRunStateView,
  type Phase,
  type ProjectileView,
  type ResultMessage,
  type WeaponId,
} from '@rally/game-gunrun-server';
import type { Hud } from './hud.ts';
import type { Net } from './net.ts';
import type { GunRunScene } from './scene.ts';

/**
 * Dev-only `?art=<shot>` mode: stages one deterministic scene with the game's own renderer, HUD and frame loop for the
 * store art that games/gunrun/scripts/art.ts captures. main.ts imports this module only behind `import.meta.env.DEV`,
 * so it is never part of a published build.
 *
 * Every pose comes from the shared rules (`GunRunMatch`, the code the server runs) with a fixed seed and bots playing
 * for a few seconds, then players are put where the shot needs them on the rungs it shows; tracers, rockets and blasts
 * are staged on top and time is stopped.
 * - `icon`: a knife lunge at a shotgunner, close up, no HUD.
 * - `cover`: six players across the yard, tracers, a rocket and a barrel going off; no HUD.
 * - `fight`: a six-player match in full swing (phone landscape, HUD, kill feed).
 * - `rocket`: a rocket on its way and a barrel chain going off (HUD).
 * - `winner`: the match-over banner, the winner waving (HUD).
 */
export const ART_SHOTS = ['icon', 'cover', 'fight', 'rocket', 'winner'] as const;
export type ArtShot = (typeof ART_SHOTS)[number];

export const isArtShot = (s: string | null): s is ArtShot => ART_SHOTS.includes(s as ArtShot);

const NAMES = ['Sam', 'mika', 'dex', 'rosa', 'Ace', 'jun', 'Bolt', 'kai'];
/** The bots among the names (they wear the BOT tag). */
const BOTS = new Set(['Ace', 'Bolt']);
const RTT_MS = 38;

export interface ArtPose {
  state: GunRunStateView;
  me: string;
  /** Explosions to stage: position, radius and how far into the blast (0…1). */
  booms: { x: number; y: number; r: number; age: number }[];
  /** Tracers in flight: shooter position, angle, length, weapon. */
  shots: { x: number; y: number; angle: number; len: number; weapon: WeaponId }[];
  /** Rockets in flight: which way each points (by projectile key, radians). */
  headings: Record<string, number>;
  /** The banner's result line (the winner shot). */
  result: ResultMessage | null;
  /** Kill feed entries (by player id; -1 weapon = a barrel). */
  feed: { killer: string | null; victim: string; weapon: WeaponId | 'barrel'; demote: boolean }[];
  /** Camera zoom (closer for the icon). */
  zoom: number;
  clean: boolean;
}

/** A frozen copy of the synced state, as the client reads it from Colyseus. */
export function view(
  m: GunRunMatch,
  over: Partial<GunRunStateView> = {},
  shells: ProjectileView[] = [],
): GunRunStateView {
  const players = new Map<string, GunRunPlayerView>();
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
      alive: p.alive,
      prot: false,
      respawn: 0,
      tier: p.tier,
      tk: p.tierKills,
      kills: p.kills,
      deaths: p.deaths,
      connected: true,
      guest: false,
      bot: p.bot,
      ack: 0,
    });
  }
  const projectiles = new Map<string, ProjectileView>();
  shells.forEach((s, i) => projectiles.set(`s${i}`, s));
  return {
    phase: m.phase as Phase,
    timer: m.elapsed,
    match: 3,
    winner: '',
    barrels: m.barrels,
    meds: m.meds,
    code: '',
    isPrivate: false,
    maxPlayers: 8,
    tick: m.tick,
    players,
    projectiles,
    ...over,
  };
}

/**
 * A match of the real rules: `n` players (bots driving everyone) for `seconds`, then `setup` puts players where the
 * shot needs them: [x, y, aim, rung, kills, deaths] per player.
 */
function fight(seed: number, n: number, seconds: number, setup: [number, number, number, number, number, number][]) {
  const m = new GunRunMatch({ seed, rules: { startingTime: 0.1, protectionTime: 0 } });
  for (let i = 0; i < n; i++) m.addPlayer(`p${i}`, NAMES[i]!, true);
  const bots = new BotDriver(m, seed);
  for (let t = 0; t < seconds / DT; t++) {
    bots.think(DT);
    m.step(DT);
    m.invulnerable = true;
  }
  setup.forEach(([x, y, aim, tier, kills, deaths], i) => {
    const p = m.players.get(`p${i}`)!;
    m.place(p.id, x, y, aim);
    p.alive = true;
    p.hp = 100 - ((i * 37) % 60);
    p.tier = tier;
    p.tierKills = (i * 2) % 3;
    p.kills = kills;
    p.deaths = deaths;
    p.bot = BOTS.has(p.name);
  });
  return m;
}

const toward = (from: [number, number], to: [number, number]) => Math.atan2(to[1] - from[1], to[0] - from[0]);
const tier = (id: WeaponId) => LADDER.indexOf(id);

export function artPose(shot: ArtShot): ArtPose {
  switch (shot) {
    case 'icon': {
      const a: [number, number] = [-1.2, 0.9];
      const b: [number, number] = [0.15, 0.35];
      const m = fight(5, 2, 1, [
        [a[0], a[1], toward(a, b), FINAL_TIER, 24, 3],
        [b[0], b[1], toward(b, a), tier('shotgun'), 10, 6],
      ]);
      return {
        state: view(m),
        me: 'p0',
        booms: [{ x: 2.6, y: -1.2, r: 2.4, age: 0.3 }],
        shots: [{ x: b[0], y: b[1], angle: toward(b, a) + 0.5, len: 3.5, weapon: 'shotgun' }],
        headings: {},
        result: null,
        feed: [],
        zoom: 0.4,
        clean: true,
      };
    }
    case 'cover': {
      const spots: [number, number][] = [
        [-3.4, 1.2],
        [2.6, 0.6],
        [-8.6, -1.2],
        [7.8, 3.4],
        [0.8, 5.8],
        [-8.0, 6.4],
      ];
      const tiers = [tier('rocket'), tier('ak'), tier('shotgun'), tier('sniper'), tier('smg'), tier('revolver')];
      const targets = [1, 0, 0, 1, 0, 0];
      const m = fight(
        12,
        6,
        2,
        spots.map((s, i) => [s[0], s[1], toward(s, spots[targets[i]!]!), tiers[i]!, 12, 4]),
      );
      return {
        state: view(m, { phase: 'playing', timer: 151 }, [{ kind: 0, x: -0.6, y: 0.9, h: 1.1 }]),
        me: 'p0',
        booms: [{ x: 7.4, y: -1.0, r: 3.2, age: 0.22 }],
        headings: { s0: toward([-3.4, 1.2], [2.6, 0.6]) },
        result: null,
        shots: m.playerList
          .filter((p) => p.tier !== tier('rocket'))
          .map((p) => ({ x: p.x, y: p.y, angle: p.aim, len: 4.5, weapon: LADDER[p.tier]! })),
        feed: [],
        zoom: 0.85,
        clean: true,
      };
    }
    case 'fight': {
      const spots: [number, number][] = [
        [-1.2, 1.0],
        [4.4, -0.6],
        [-6.4, 2.6],
        [2.8, 4.2],
        [-3.6, -6.4],
        [6.6, 2.2],
      ];
      const tiers = [tier('ak'), tier('shotgun'), tier('sniper'), tier('smg'), tier('revolver'), tier('grenade')];
      const targets = [1, 0, 0, 0, 2, 3];
      const m = fight(
        3,
        6,
        3,
        spots.map((s, i) => [s[0], s[1], toward(s, spots[targets[i]!]!), tiers[i]!, [14, 11, 17, 9, 5, 20][i]!, i]),
      );
      return {
        state: view(m, { phase: 'playing', timer: 187 }),
        me: 'p0',
        booms: [],
        headings: {},
        result: null,
        shots: m.playerList.map((p) => ({ x: p.x, y: p.y, angle: p.aim, len: 4.2, weapon: LADDER[p.tier]! })),
        feed: [
          { killer: 'p2', victim: 'p4', weapon: 'sniper', demote: false },
          { killer: 'p0', victim: 'p5', weapon: 'ak', demote: false },
          { killer: 'p5', victim: 'p3', weapon: 'grenade', demote: false },
        ],
        zoom: 1,
        clean: false,
      };
    }
    case 'rocket': {
      const me: [number, number] = [-7.0, 2.6];
      const mika: [number, number] = [2.8, 2.8];
      const m = fight(8, 5, 2, [
        [me[0], me[1], toward(me, mika), tier('rocket'), 21, 5],
        [mika[0], mika[1], toward(mika, me), tier('ak'), 18, 7],
        [-1.4, 7.8, -1.6, tier('grenade'), 19, 4],
        [5.8, -0.8, 2.5, tier('shotgun'), 11, 6],
        [-9.6, -2.4, 0.7, tier('sniper'), 15, 8],
      ]);
      // A chain of barrels along the south path: the first went off a moment ago, the second is going now.
      m.barrels &= ~((1 << 4) | (1 << 5));
      return {
        state: view(m, { phase: 'playing', timer: 263 }, [{ kind: 0, x: -1.6, y: 3.1, h: 1.1 }]),
        me: 'p0',
        booms: [
          { x: -3.6, y: 6.4, r: 3.2, age: 0.5 },
          { x: 3.6, y: 6.6, r: 3.2, age: 0.15 },
        ],
        headings: { s0: toward(me, mika) },
        result: null,
        shots: [{ x: mika[0], y: mika[1], angle: toward(mika, me) + 0.04, len: 5, weapon: 'ak' }],
        feed: [
          { killer: 'p0', victim: 'p3', weapon: 'barrel', demote: false },
          { killer: 'p2', victim: 'p4', weapon: 'grenade', demote: false },
        ],
        zoom: 1,
        clean: false,
      };
    }
    case 'winner': {
      const m = fight(4, 6, 2, [
        [-2.6, 0.6, Math.PI / 2, FINAL_TIER, 26, 3],
        [-4.8, 1.0, toward([-4.8, 1.0], [-2.6, 0.6]), tier('rocket'), 22, 7],
        [-0.4, 1.2, toward([-0.4, 1.2], [-2.6, 0.6]), tier('grenade'), 19, 6],
        [-3.8, -1.2, toward([-3.8, -1.2], [-2.6, 0.6]), tier('sniper'), 16, 9],
        [-1.0, -1.4, toward([-1.0, -1.4], [-2.6, 0.6]), tier('ak'), 12, 8],
        [-5.6, -0.8, toward([-5.6, -0.8], [-2.6, 0.6]), tier('shotgun'), 10, 11],
      ]);
      return {
        state: view(m, { phase: 'over', timer: 7.4, winner: 'p0' }),
        me: 'p0',
        booms: [],
        headings: {},
        result: {
          matchId: 'art:3',
          recorded: true,
          boards: { wins: { score: 12, rank: 3 }, kills: { score: 26, rank: 4 } },
          unlocked: [{ key: 'first_win', title: 'Top Gun', icon: '🏆' }],
        },
        shots: [],
        feed: [{ killer: 'p0', victim: 'p1', weapon: 'knife', demote: true }],
        zoom: 0.9,
        clean: false,
      };
    }
  }
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
 * then stages the effects, freezes time and stops drawing. Sets `window.__gunrunArt` for the capture script.
 */
export function stageArt(shot: ArtShot, deps: { app: Application; scene: GunRunScene; hud: Hud }): Net {
  const { app, scene, hud } = deps;
  const pose = artPose(shot);
  const state = pose.state;
  if (pose.clean) {
    const style = document.createElement('style');
    style.textContent = CLEAN_CSS;
    document.head.appendChild(style);
  }
  hud.hideHint();
  scene.setZoom(pose.zoom);

  const patchHandlers: ((t: number) => void)[] = [];
  const patch = () => patchHandlers.forEach((fn) => fn(performance.now()));
  setInterval(patch, 50);

  const probe: ArtProbe = { shot, ready: false };
  (window as unknown as { __gunrunArt: ArtProbe }).__gunrunArt = probe;

  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : app.once('frameend', tick));
      app.once('frameend', tick);
    });

  void (async () => {
    // Let the frame loop build everyone (and the render clock settle), then stage the effects and stop the clock.
    await frames(12);
    for (const f of pose.feed) {
      const victim = state.players.get(f.victim);
      if (!victim) continue;
      hud.feed({
        killer: f.killer ? (state.players.get(f.killer) ?? null) : null,
        victim,
        weapon: f.weapon === 'barrel' ? -1 : WEAPON_IDS.indexOf(f.weapon),
        demote: f.demote,
      });
    }
    // Explosions oldest first, each aged to its point in the blast when the next one starts.
    const booms = [...pose.booms].sort((p, q) => q.age - p.age);
    booms.forEach((b, i) => {
      scene.explosion(b.x, b.y, b.r);
      scene.update(0.5 * (b.age - (booms[i + 1]?.age ?? 0)));
    });
    for (const s of pose.shots) {
      const w = WEAPONS[s.weapon];
      if (w.kind !== 'hitscan') continue;
      const x0 = s.x + Math.cos(s.angle) * 0.4;
      const y0 = s.y + Math.sin(s.angle) * 0.4;
      scene.tracer(x0, y0, x0 + Math.cos(s.angle) * s.len, y0 + Math.sin(s.angle) * s.len, w);
      scene.muzzle(s.x, s.y, s.angle, w);
    }
    // A rocket points where it flies: set it a step back once, the frame loop puts it in place (and turns it).
    for (const [key, a] of Object.entries(pose.headings)) {
      const pr = state.projectiles.get(key);
      if (pr) scene.setProjectile(key, pr.kind, pr.x - Math.cos(a) * 0.3, pr.y - Math.sin(a) * 0.3, pr.h);
    }
    await frames(2);
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
      if (pose.result) setTimeout(() => fn(pose.result!), 200);
    },
    start() {},
    dev() {},
    leave: async () => {},
  };
}
