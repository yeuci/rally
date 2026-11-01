import type { Room } from '@colyseus/sdk';
import type { Application } from 'playcanvas';
import {
  DT,
  Item,
  LIFE,
  NorthdaleMatch,
  SAFE,
  SAFE_CENTER,
  TOWN_HALF,
  ZombieKind,
  alongPath,
  ESCAPE_PATH,
  JUNCTION,
  PART_SPOTS,
  DOG_SPOT,
  type MapLike,
  type NorthdalePlayerView,
  type NorthdaleStateView,
  type ResultMessage,
  type ZombieView,
} from '@rally/game-northdale-server';
import type { Hud } from './hud.ts';
import type { Net } from './net.ts';
import type { NorthdaleScene } from './scene.ts';

/**
 * Dev-only `?art=<shot>` mode: stages one deterministic scene with the game's own renderer, HUD and frame loop for the
 * store art that games/northdale/scripts/art.ts captures (main.ts imports this only behind `import.meta.env.DEV`).
 * Every pose comes from the shared rules (`NorthdaleMatch`, the code the server runs) with a fixed seed: survivors,
 * zombies, the dog and the truck are put where the shot needs them, effects are staged on top and time is stopped.
 * - `icon`: a survivor swinging the guitar into a zombie under a street lamp (close up, no HUD).
 * - `cover`: the group holding a street at night against the horde, a brute winding up, the dog biting (no HUD).
 * - `day`: scavenging the Junction by day: a chest, a wreck, the wheel to take home (HUD).
 * - `night`: night 3 at the safehouse barricades, flashlights and a horde with chubbies (HUD).
 * - `escape`: the armored truck racing for the Northdale gantry (HUD).
 * - `town`, `townnight`: overviews for iterating on the map (not store art).
 */
export const ART_SHOTS = ['icon', 'cover', 'day', 'night', 'escape', 'town', 'townnight'] as const;
export type ArtShot = (typeof ART_SHOTS)[number];

export const isArtShot = (s: string | null): s is ArtShot => ART_SHOTS.includes(s as ArtShot);

const NAMES = ['Lis', 'matt', 'Sam', 'shaun'];

class FixedMap<V> implements MapLike<V> {
  private readonly m = new Map<string, V>();
  set(k: string, v: V) {
    this.m.set(k, v);
  }
  get(k: string) {
    return this.m.get(k);
  }
  forEach(fn: (v: V, k: string) => void) {
    this.m.forEach(fn);
  }
  get size() {
    return this.m.size;
  }
}

/** A frozen copy of the synced state, as the client reads it from Colyseus. */
export function view(m: NorthdaleMatch, over: Partial<NorthdaleStateView> = {}): NorthdaleStateView {
  const players = new FixedMap<NorthdalePlayerView>();
  for (const p of m.playerList) {
    players.set(p.id, {
      name: p.name,
      slot: p.slot,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      aim: p.aim,
      hp: Math.ceil(p.hp),
      armor: p.armor,
      life: p.life === 'alive' ? LIFE.alive : p.life === 'down' ? LIFE.down : LIFE.dead,
      revive: 0,
      actKind: 0,
      act: 0,
      gun: p.gun,
      melee: p.melee,
      dur: p.durability,
      a0: p.ammo[0]!,
      a1: p.ammo[1]!,
      a2: p.ammo[2]!,
      a3: p.ammo[3]!,
      i0: p.items[0]!,
      i1: p.items[1]!,
      carry: p.carry,
      kills: p.kills,
      wind: false,
      downFor: 0,
      inRun: true,
      connected: true,
      guest: false,
      uid: '',
      ack: 0,
    });
  }
  const zombies = new FixedMap<ZombieView>();
  for (const z of m.zombies.values()) zombies.set(z.id.toString(36), { kind: z.kind, x: z.x, y: z.y, hp: 100 });
  const pickups = new FixedMap<{ kind: number; x: number; y: number }>();
  for (const pk of m.pickups.values()) pickups.set(pk.id.toString(36), { kind: pk.kind, x: pk.x, y: pk.y });
  const barricades = new FixedMap<{ tier: number; hp: number }>();
  m.barricades.forEach((b, i) => {
    if (b) barricades.set(String(i), { tier: b.tier, hp: 100 });
  });
  const goo = new FixedMap<{ x: number; y: number }>();
  for (const g of m.goo.values()) goo.set(g.id.toString(36), { x: g.x, y: g.y });
  return {
    phase: m.phase,
    timer: m.timer,
    length: m.phaseLength,
    night: m.night,
    day: m.day,
    nights: m.nightsSurvived,
    blood: m.blood,
    run: 3,
    tick: m.tick,
    kills: m.teamKills,
    scrap: m.scrap,
    wheels: m.truck.wheels,
    fuel: m.truck.fuel,
    truckScrap: m.truck.scrap,
    truckX: m.truck.x,
    truckY: m.truck.y,
    truckYaw: m.truck.yaw,
    opened: m.opened.map((o) => (o ? '1' : '0')).join(''),
    dogX: m.dog.x,
    dogY: m.dog.y,
    dogState: m.dog.state,
    dogHp: 100,
    dogFacing: m.dog.facing,
    dogBite: m.dog.biting > 0,
    code: '',
    isPrivate: false,
    maxPlayers: 4,
    players,
    zombies,
    pickups,
    rocks: new FixedMap(),
    goo,
    barricades,
    ...over,
  };
}

interface Pose {
  state: NorthdaleStateView;
  me: string;
  zoom: number;
  clean: boolean;
  /** Effects staged once everyone is drawn. */
  stage(scene: NorthdaleScene, hud: Hud): void;
}

/** A run of the real rules with `n` survivors, frozen at a phase. */
function run(seed: number, n: number): NorthdaleMatch {
  const m = new NorthdaleMatch({ seed, rules: { spawnScale: 0 } });
  for (let i = 0; i < n; i++) m.addPlayer(`p${i}`, NAMES[i]!);
  m.step(DT);
  return m;
}

function put(m: NorthdaleMatch, id: string, x: number, y: number, aim: number, gun: number, melee: number) {
  const p = m.players.get(id)!;
  m.place(id, x, y);
  p.aim = aim;
  p.gun = gun;
  p.melee = melee;
  p.ammo = [30, 90, 12, 10];
  p.vx = p.vy = 0;
}

const toward = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.atan2(b.y - a.y, b.x - a.x);

export function artPose(shot: ArtShot): Pose {
  switch (shot) {
    case 'icon': {
      const m = run(11, 1);
      m.skipToNight(2, []);
      const c = { x: 0, y: -60 };
      put(m, 'p0', c.x, c.y, toward(c, { x: c.x + 1.4, y: c.y + 0.5 }), Item.none, Item.guitar);
      const z = m.spawnZombie(ZombieKind.basic, c.x + 1.5, c.y + 0.4);
      z.facing = Math.PI;
      m.spawnZombie(ZombieKind.crawler, c.x + 2.6, c.y - 1.2).facing = Math.PI * 0.9;
      m.timer = 60;
      return {
        state: view(m),
        me: 'p0',
        zoom: 0.36,
        clean: true,
        stage(scene) {
          scene.swing(c.x, c.y, toward(c, { x: c.x + 1.4, y: c.y + 0.5 }), true, true);
          scene.blood(c.x + 1.5, c.y + 0.4, 1);
        },
      };
    }
    case 'cover':
    case 'night': {
      const m = run(shot === 'cover' ? 21 : 22, shot === 'cover' ? 4 : 3);
      m.skipToNight(3, []);
      m.timer = 64;
      const at = shot === 'cover' ? { x: corridor(3), y: -26 } : { x: SAFE_CENTER.x, y: SAFE.y0 + 3 };
      const guns = [Item.shotgun, Item.smg, Item.rifle, Item.pistol];
      const melees = [Item.guitar, Item.bat_barbed, Item.axe, Item.knife];
      const spots =
        shot === 'cover'
          ? [
              { x: -1.6, y: 1.4 },
              { x: 1.4, y: 0.8 },
              { x: -0.2, y: 3.2 },
              { x: 2.8, y: 3.4 },
            ]
          : [
              { x: -1.8, y: 0 },
              { x: 1.6, y: 0.2 },
              { x: 0, y: 1.6 },
            ];
      spots.forEach((s, i) =>
        put(m, `p${i}`, at.x + s.x, at.y + s.y, -Math.PI / 2 + (i - 1) * 0.35, guns[i]!, melees[i]!),
      );
      // The horde up the street.
      const horde: [number, number, number][] = [];
      for (let i = 0; i < 26; i++) {
        const row = Math.floor(i / 6);
        horde.push([
          at.x - 4.2 + (i % 6) * 1.7 + (row % 2) * 0.8,
          at.y - 6.5 - row * 2.1,
          i % 9 === 4 ? ZombieKind.chubby : i % 5 === 2 ? ZombieKind.crawler : ZombieKind.basic,
        ]);
      }
      for (const [x, y, k] of horde) {
        const z = m.spawnZombie(k as ZombieKind, x, y);
        z.facing = Math.PI / 2;
      }
      const brute = m.spawnZombie(ZombieKind.brute, at.x + 3.5, at.y - 13);
      brute.facing = Math.PI / 2 + 0.3;
      // The dog with the group, biting the nearest.
      m.dog.state = 1;
      m.dog.x = at.x - 3.2;
      m.dog.y = at.y - 2.6;
      m.dog.facing = -Math.PI / 2;
      m.dog.biting = 0.4;
      if (shot === 'night') {
        m.barricades[0] = { tier: 2, hp: 320, maxHp: 320 };
        m.barricades[1] = { tier: 4, hp: 820, maxHp: 820 };
        m.scrap = 35;
        m.truck.wheels = 1;
        m.truck.fuel = 2;
        m.truck.scrap = 40;
      }
      m.teamKills = 87;
      m.players.get('p0')!.kills = 31;
      return {
        state: view(m),
        me: 'p0',
        zoom: shot === 'cover' ? 0.78 : 1,
        clean: shot === 'cover',
        stage(scene) {
          for (const p of m.playerList) {
            const ends: number[] = [];
            const a = p.aim;
            ends.push(p.x + Math.cos(a) * 8, p.y + Math.sin(a) * 8);
            if (p.gun !== Item.rifle) scene.shot(p.id, p.x, p.y, a, ends, p.gun === Item.shotgun);
          }
          scene.telegraph(at.x + 0.6, at.y + 1.2, 3);
          scene.horde.windup(brute.id);
          scene.blood(at.x - 1, at.y - 6.6, 1);
          scene.blood(at.x + 2, at.y - 6.4, 1);
        },
      };
    }
    case 'day': {
      const m = run(31, 3);
      m.timer = 70;
      const j = JUNCTION;
      put(
        m,
        'p0',
        j.x + 6.5,
        j.y - 8.6,
        toward({ x: j.x + 6.5, y: j.y - 8.6 }, PART_SPOTS[3]!),
        Item.pistol,
        Item.bat_saw,
      );
      put(m, 'p1', j.x - 3, j.y + 2.4, -0.4, Item.smg, Item.knife);
      put(m, 'p2', j.x - 6, j.y - 4.5, -2.2, Item.none, Item.axe);
      const z1 = m.spawnZombie(ZombieKind.basic, j.x + 9, j.y + 6, false);
      z1.facing = -2.4;
      m.spawnZombie(ZombieKind.basic, j.x - 12, j.y + 9, false).facing = -0.7;
      m.give('p0', Item.medkit);
      m.scrap = 25;
      return {
        state: view(m),
        me: 'p0',
        zoom: 1,
        clean: false,
        stage(scene) {
          scene.swing(j.x - 6, j.y - 4.5, -2.2, true, false);
        },
      };
    }
    case 'escape': {
      const m = run(41, 3);
      m.skipToNight(5, []);
      m.truck.wheels = 2;
      m.truck.fuel = 2;
      m.truck.scrap = 60;
      m.phase = 'escape';
      m.timer = 2;
      m.phaseLength = 8;
      const at = alongPath(ESCAPE_PATH, 0.78);
      m.truck.x = at.x;
      m.truck.y = at.y;
      m.truck.yaw = at.yaw;
      for (const p of m.playerList) m.place(p.id, at.x, at.y);
      for (let i = 0; i < 14; i++) {
        const z = m.spawnZombie(
          i % 4 === 0 ? ZombieKind.crawler : ZombieKind.basic,
          at.x - 5 + (i % 7) * 1.6,
          at.y + 4 + Math.floor(i / 7) * 3,
        );
        z.facing = -Math.PI / 2;
      }
      return {
        state: view(m),
        me: 'p0',
        zoom: 1.15,
        clean: false,
        stage(scene, hud) {
          hud.banner('Go go go!', 'Through the Northdale gantry', 'good');
          scene.blood(at.x - 1, at.y + 3, 1);
          scene.blood(at.x + 1.5, at.y + 4, 1);
        },
      };
    }
    case 'town':
    case 'townnight': {
      const m = run(51, 1);
      if (shot === 'townnight') m.skipToNight(2, []);
      m.timer = m.phaseLength * 0.55;
      const p = new URLSearchParams(location.search);
      const x = Number(p.get('x') ?? SAFE_CENTER.x);
      const y = Number(p.get('y') ?? SAFE_CENTER.y - 6);
      put(m, 'p0', x, y, -Math.PI / 2, Item.pistol, Item.knife);
      if (p.has('dog')) {
        m.dog.x = DOG_SPOT.x;
        m.dog.y = DOG_SPOT.y;
      }
      return { state: view(m), me: 'p0', zoom: Number(p.get('zoom') ?? 1), clean: p.has('clean'), stage() {} };
    }
  }
}

const corridor = (i: number) => -TOWN_HALF + 6 + i * 44;

// --- staging in the page ---------------------------------------------------------------------------------------------

export interface ArtProbe {
  shot: ArtShot;
  ready: boolean;
}

const CLEAN_CSS = '#hud, #labels, .stick, #vignette { display: none !important; }';

/**
 * A `Net` look-alike that serves the frozen pose to main.ts' normal frame loop (interpolation, labels, HUD), then
 * stages the effects, freezes time and stops drawing. Sets `window.__northdaleArt` for the capture script.
 */
export function stageArt(shot: ArtShot, deps: { app: Application; scene: NorthdaleScene; hud: Hud }): Net {
  const { app, scene, hud } = deps;
  const pose = artPose(shot);
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
  (window as unknown as { __northdaleArt: ArtProbe }).__northdaleArt = probe;
  const frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : app.once('frameend', tick));
      app.once('frameend', tick);
    });
  void (async () => {
    await frames(20);
    pose.stage(scene, hud);
    await frames(3);
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
    state: pose.state,
    sessionId: pose.me,
    rttMs: 38,
    offer: () => null,
    release: () => null,
    onFx() {},
    onPatch(fn) {
      patchHandlers.push(fn);
      fn(performance.now());
    },
    onResult(_fn: (r: ResultMessage) => void) {},
    start() {},
    dev() {},
    leave: async () => {},
  };
}
