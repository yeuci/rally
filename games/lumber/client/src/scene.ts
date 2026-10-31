import {
  type Application,
  BLEND_NORMAL,
  Color,
  Entity,
  GAMMA_SRGB,
  type GraphicsDevice,
  MeshInstance,
  PROJECTION_ORTHOGRAPHIC,
  SHADOW_PCF5_16F,
  StandardMaterial,
  TONEMAP_NEUTRAL,
  Vec3,
} from 'playcanvas';
import { roundedBox } from './meshes.ts';
import {
  BOUNDS,
  CASH_ZONE,
  COUNTER,
  CUSTOMER_EXIT,
  DROP_ZONE,
  MILL_BOXES,
  MILL_CAP,
  MILL_TRAYS,
  REGISTER_ZONE,
  TICK,
  UNLOCKS,
  type LumberSim,
  type Mover,
  type UnlockId,
  type Vec2,
} from './sim.ts';

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export const PALETTE = {
  sky: '#9fd4e8',
  grass: '#79b25a',
  deck: '#dcb57f',
  deckEdge: '#c49a62',
  road: '#d7b98c',
  fence: '#8a5a35',
  leaves: '#3f8a4f',
  leaves2: '#58a85c',
  leavesRound: '#6cb85a',
  trunk: '#6b4428',
  log: '#9a6538',
  logEnd: '#e2b07a',
  mill: '#b5533c',
  millRoof: '#6e3a2b',
  blade: '#d4d8de',
  plank: '#f0c98f',
  plank2: '#e3b878',
  counter: '#a8723f',
  register: '#4d5562',
  cash: '#4cc46a',
  cashDark: '#2f9a4c',
  cashBand: '#e9f7ec',
  zone: '#fff4df',
  padBase: '#3a2a1d',
  padFill: '#5fd27a',
  skin: '#f1c7a1',
  pants: '#3b4a5e',
  boots: '#4a3426',
  eyes: '#2b2b2b',
  player: '#d64532',
  playerHat: '#2f6fb3',
  hauler: '#3e8ed0',
  cashier: '#f2b632',
  hardhat: '#ffcc33',
  cart: '#4a90d9',
  shirts: ['#e67e22', '#5d9cec', '#9b59b6', '#16a085', '#e74c3c', '#7f8c8d'],
} as const;

/** Plank thickness on stacks. */
const PLANK_H = 0.11;
/** Cash bundle thickness on the pile. */
const CASH_H = 0.12;
/** Dollars per bundle on the floor pile. */
export const CASH_PER_BUNDLE = 10;
const MAX_CASH_BUNDLES = 60;
const LEG_SWING = 34;
/** Seconds for a new plank / bundle to pop in. */
const POP_TIME = 0.2;
/** Carried stack spring: how stiff it is and how quickly the wobble dies down. */
const STACK_STIFFNESS = 70;
const STACK_DAMPING = 7;
/** How far the top of a carried stack lags per unit of speed (offset per height², local units). */
const STACK_LAG = 0.0065;
/** Turn speed (1/s) for characters' smoothed facing. */
const TURN_RATE = 14;

/** Set by `createLumberScene`; the builders below need it for generated meshes. */
let device: GraphicsDevice;

const materials = new Map<string, StandardMaterial>();

/** Shared matte material per colour. */
function mat(color: string, opacity = 1): StandardMaterial {
  const key = `${color}/${opacity}`;
  let m = materials.get(key);
  if (!m) {
    m = new StandardMaterial();
    m.diffuse = hex(color);
    m.specular = new Color(0, 0, 0);
    m.gloss = 0;
    m.useMetalness = false;
    if (opacity < 1) {
      m.opacity = opacity;
      m.blendType = BLEND_NORMAL;
      m.depthWrite = false;
    }
    m.update();
    materials.set(key, m);
  }
  return m;
}

type Shape = 'box' | 'cylinder' | 'sphere' | 'cone' | 'capsule' | 'plane';
type V3 = [number, number, number];

interface PartOptions {
  rot?: V3;
  shadows?: boolean;
  opacity?: number;
  name?: string;
  /** Boxes are rounded by default; this sets the corner radius (default: a soft bevel for the size). */
  radius?: number;
  /** A plain sharp box, sized by scale (thin lines, or boxes rescaled at runtime). */
  sharp?: boolean;
}

/**
 * One coloured primitive. Boxes come out rounded (a generated mesh at the real size, so `size` is not a scale);
 * other shapes are PlayCanvas primitives scaled to `size`.
 */
function part(parent: Entity, shape: Shape, color: string, pos: V3, size: V3, opts: PartOptions = {}): Entity {
  const e = new Entity(opts.name ?? shape);
  const shadows = opts.shadows ?? true;
  if (shape === 'box' && !opts.sharp) {
    const [w, h, d] = size;
    const r = opts.radius ?? Math.min(0.08, Math.min(w, h, d) * 0.35);
    e.addComponent('render', { castShadows: shadows, receiveShadows: true });
    e.render!.meshInstances = [new MeshInstance(roundedBox(device, w, h, d, r), mat(color, opts.opacity))];
    e.render!.castShadows = shadows;
    e.render!.receiveShadows = true;
  } else {
    e.addComponent('render', {
      type: shape,
      material: mat(color, opts.opacity),
      castShadows: shadows,
      receiveShadows: true,
    });
    e.setLocalScale(...size);
  }
  e.setLocalPosition(...pos);
  if (opts.rot) e.setLocalEulerAngles(...opts.rot);
  parent.addChild(e);
  return e;
}

/** easeOutBack: 0 → 1 with a little overshoot. */
function popIn(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = Math.min(1, t) - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/**
 * A pool of identical meshes laid out by index; `set(n)` shows the first n (new ones pop in), `update` animates the
 * pop and optionally bends the pile (a carried stack swaying: each item shifts by bend × its height²).
 */
interface Pile {
  set(n: number): void;
  update(dt: number, bendX?: number, bendZ?: number): void;
  readonly root: Entity;
  readonly shown: number;
}

function pile(
  parent: Entity,
  count: number,
  layout: (i: number) => V3,
  make: (root: Entity, i: number) => Entity,
): Pile {
  const root = new Entity('pile');
  parent.addChild(root);
  const items: { e: Entity; base: V3; age: number }[] = [];
  for (let i = 0; i < count; i++) {
    const e = make(root, i);
    const base = layout(i);
    e.setLocalPosition(...base);
    e.enabled = false;
    items.push({ e, base, age: POP_TIME });
  }
  const y0 = items[0]?.base[1] ?? 0;
  let shown = 0;
  let bent = false;
  return {
    root,
    get shown() {
      return shown;
    },
    set(n) {
      n = Math.max(0, Math.min(count, n));
      if (n === shown) return;
      for (let i = 0; i < count; i++) {
        const it = items[i]!;
        const on = i < n;
        if (on && !it.e.enabled) {
          it.age = 0;
          it.e.setLocalScale(0.01, 0.01, 0.01);
        }
        it.e.enabled = on;
      }
      shown = n;
    },
    update(dt, bendX = 0, bendZ = 0) {
      const bend = Math.abs(bendX) > 1e-4 || Math.abs(bendZ) > 1e-4;
      for (let i = 0; i < shown; i++) {
        const it = items[i]!;
        if (it.age < POP_TIME) {
          it.age += dt;
          const s = Math.max(0.01, popIn(it.age / POP_TIME));
          it.e.setLocalScale(s, s, s);
        }
        if (bend || bent) {
          const h = it.base[1] - y0;
          const k = h * h;
          it.e.setLocalPosition(it.base[0] + bendX * k, it.base[1], it.base[2] + bendZ * k);
          // Tilt along the curve's slope (2·bend·h), in degrees.
          it.e.setLocalEulerAngles(bendZ * h * 115, 0, -bendX * h * 115);
        }
      }
      bent = bend;
    },
  };
}

const plankMesh = (root: Entity, i: number, size: V3) =>
  part(root, 'box', i % 3 === 1 ? PALETTE.plank2 : PALETTE.plank, [0, 0, 0], size, { radius: 0.035 });

/** A rounded, slightly chibi person: swinging legs and arms, a torso that bobs and leans, a big head, a hat. */
interface Rig {
  root: Entity;
  torso: Entity;
  legs: [Entity, Entity];
  arms: [Entity, Entity];
  carry: Pile | null;
  walk: number;
  /** Smoothed facing (radians). */
  yaw: number;
  /** Carried-stack spring (local x / z offsets per height² and their velocities). */
  bendX: number;
  bendZ: number;
  bendVX: number;
  bendVZ: number;
}

function makeRig(
  parent: Entity,
  opts: { shirt: string; hat: 'beanie' | 'hardhat'; hatColor: string; carry?: number },
): Rig {
  const root = new Entity('rig');
  parent.addChild(root);
  const legPivot = (x: number) => {
    const pivot = new Entity('hip');
    pivot.setLocalPosition(x, 0.38, 0);
    root.addChild(pivot);
    part(pivot, 'capsule', PALETTE.pants, [0, -0.17, 0], [0.17, 0.19, 0.17]);
    part(pivot, 'box', PALETTE.boots, [0, -0.33, 0.04], [0.18, 0.1, 0.26], { radius: 0.045 });
    return pivot;
  };
  const legs: [Entity, Entity] = [legPivot(-0.11), legPivot(0.11)];

  const torso = new Entity('torso');
  root.addChild(torso);
  part(torso, 'box', opts.shirt, [0, 0.62, 0], [0.5, 0.5, 0.36], { radius: 0.16 });
  const armPivot = (x: number) => {
    const pivot = new Entity('shoulder');
    pivot.setLocalPosition(x, 0.8, 0);
    torso.addChild(pivot);
    part(pivot, 'capsule', opts.shirt, [0, -0.15, 0], [0.14, 0.17, 0.14]);
    part(pivot, 'sphere', PALETTE.skin, [0, -0.32, 0], [0.14, 0.14, 0.14]);
    return pivot;
  };
  const arms: [Entity, Entity] = [armPivot(-0.31), armPivot(0.31)];
  part(torso, 'sphere', PALETTE.skin, [0, 1.12, 0], [0.5, 0.48, 0.48]);
  // Eyes, so you can tell which way they face.
  part(torso, 'sphere', PALETTE.eyes, [-0.09, 1.14, 0.22], [0.065, 0.085, 0.04], { shadows: false });
  part(torso, 'sphere', PALETTE.eyes, [0.09, 1.14, 0.22], [0.065, 0.085, 0.04], { shadows: false });
  if (opts.hat === 'beanie') {
    part(torso, 'sphere', opts.hatColor, [0, 1.23, -0.01], [0.53, 0.36, 0.52]);
    part(torso, 'sphere', '#ffffff', [0, 1.42, -0.02], [0.14, 0.14, 0.14]);
  } else {
    part(torso, 'sphere', opts.hatColor, [0, 1.25, 0], [0.54, 0.32, 0.54]);
    part(torso, 'cylinder', opts.hatColor, [0, 1.2, 0.03], [0.62, 0.035, 0.62]);
  }
  const carry =
    opts.carry !== undefined
      ? pile(
          torso,
          opts.carry,
          (i) => [Math.sin(i * 1.7) * 0.015, 0.56 + i * PLANK_H, -0.36],
          (r, i) => plankMesh(r, i, [0.72, PLANK_H * 0.92, 0.3]),
        )
      : null;
  return { root, torso, legs, arms, carry, walk: 0, yaw: 0, bendX: 0, bendZ: 0, bendVX: 0, bendVZ: 0 };
}

/** Shortest signed angle from a to b (radians). */
function angleTo(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/**
 * Place a rig at an interpolated mover position; turn it smoothly towards `heading`; animate legs, arms, torso bob and
 * lean; and spring its carried stack so it lags behind and wobbles when they start, stop or turn.
 */
function poseRig(rig: Rig, m: Mover, alpha: number, heading: number | null, dt: number) {
  const x = m.px + (m.x - m.px) * alpha;
  const z = m.pz + (m.z - m.pz) * alpha;
  rig.root.setLocalPosition(x, 0, z);
  if (heading !== null) rig.yaw += angleTo(rig.yaw, heading) * (dt > 0 ? 1 - Math.exp(-dt * TURN_RATE) : 1);
  rig.root.setLocalEulerAngles(0, (rig.yaw * 180) / Math.PI, 0);

  // Velocity (units/s) in the rig's own frame: +z forward, +x to its left-hand side as seen from behind.
  const vx = (m.x - m.px) / TICK;
  const vz = (m.z - m.pz) / TICK;
  const sin = Math.sin(rig.yaw);
  const cos = Math.cos(rig.yaw);
  const forward = vx * sin + vz * cos;
  const side = vx * cos - vz * sin;
  const speed = Math.hypot(vx, vz);
  const moving = speed > 0.05;

  rig.walk = moving ? rig.walk + dt * (6 + speed * 1.6) : rig.walk * Math.max(0, 1 - dt * 10);
  const amp = moving ? Math.min(1, speed / 3) : Math.min(1, Math.abs(Math.sin(rig.walk)));
  const swing = Math.sin(rig.walk) * LEG_SWING * amp;
  rig.legs[0].setLocalEulerAngles(swing, 0, 0);
  rig.legs[1].setLocalEulerAngles(-swing, 0, 0);
  const carrying = (rig.carry?.shown ?? 0) > 0;
  // Carrying: hands reach back to hold the stack; otherwise arms swing against the legs.
  rig.arms[0].setLocalEulerAngles(carrying ? -40 : -swing * 0.8, 0, carrying ? 10 : 6);
  rig.arms[1].setLocalEulerAngles(carrying ? -40 : swing * 0.8, 0, carrying ? -10 : -6);
  const bob = Math.abs(Math.sin(rig.walk)) * 0.045 * amp;
  rig.torso.setLocalPosition(0, bob, 0);
  rig.torso.setLocalEulerAngles(Math.max(-4, Math.min(8, forward * 1.6)), 0, 0);

  if (rig.carry) {
    if (dt > 0) {
      // Damped spring towards "lagging behind the motion"; a stop lets it swing forward and settle.
      const tx = -side * STACK_LAG;
      const tz = -forward * STACK_LAG;
      rig.bendVX += ((tx - rig.bendX) * STACK_STIFFNESS - rig.bendVX * STACK_DAMPING) * dt;
      rig.bendVZ += ((tz - rig.bendZ) * STACK_STIFFNESS - rig.bendVZ * STACK_DAMPING) * dt;
      rig.bendX += rig.bendVX * dt;
      rig.bendZ += rig.bendVZ * dt;
    }
    rig.carry.update(dt, rig.bendX, rig.bendZ);
  }
}

function pineTree(parent: Entity, x: number, z: number, size: number, alt: boolean) {
  const t = new Entity('pine');
  t.setLocalPosition(x, 0, z);
  parent.addChild(t);
  part(t, 'cylinder', PALETTE.trunk, [0, 0.4 * size, 0], [0.22 * size, 0.8 * size, 0.22 * size]);
  part(t, 'cone', alt ? PALETTE.leaves2 : PALETTE.leaves, [0, 1.2 * size, 0], [1.35 * size, 1.3 * size, 1.35 * size]);
  part(t, 'cone', alt ? PALETTE.leaves : PALETTE.leaves2, [0, 1.85 * size, 0], [1.0 * size, 1.1 * size, 1.0 * size]);
  part(
    t,
    'sphere',
    alt ? PALETTE.leaves : PALETTE.leaves2,
    [0, 2.38 * size, 0],
    [0.32 * size, 0.32 * size, 0.32 * size],
  );
}

function roundTree(parent: Entity, x: number, z: number, size: number) {
  const t = new Entity('round-tree');
  t.setLocalPosition(x, 0, z);
  parent.addChild(t);
  part(t, 'cylinder', PALETTE.trunk, [0, 0.45 * size, 0], [0.24 * size, 0.9 * size, 0.24 * size]);
  part(t, 'sphere', PALETTE.leavesRound, [0, 1.35 * size, 0], [1.4 * size, 1.25 * size, 1.4 * size]);
  part(t, 'sphere', PALETTE.leaves2, [0.38 * size, 1.15 * size, 0.2 * size], [0.85 * size, 0.8 * size, 0.85 * size]);
  part(
    t,
    'sphere',
    PALETTE.leavesRound,
    [-0.3 * size, 1.75 * size, -0.1 * size],
    [0.8 * size, 0.75 * size, 0.8 * size],
  );
}

/** A horizontal log (along x) at (x, y, z). */
function log(parent: Entity, x: number, y: number, z: number, len: number, r: number) {
  part(parent, 'cylinder', PALETTE.log, [x, y, z], [r * 2, len, r * 2], { rot: [0, 0, 90] });
  for (const end of [-1, 1]) {
    part(parent, 'cylinder', PALETTE.logEnd, [x + end * (len / 2 + 0.005), y, z], [r * 1.8, 0.02, r * 1.8], {
      rot: [0, 0, 90],
      shadows: false,
    });
  }
}

/** Thin outline square on the ground. */
function outline(parent: Entity, at: Vec2, size: number, color: string, opacity = 0.85) {
  const g = new Entity('outline');
  g.setLocalPosition(at.x, 0.02, at.z);
  parent.addChild(g);
  const w = 0.08;
  const o = { shadows: false, opacity, radius: 0.01 };
  part(g, 'box', color, [0, 0, -size / 2], [size, 0.02, w], o);
  part(g, 'box', color, [0, 0, size / 2], [size, 0.02, w], o);
  part(g, 'box', color, [-size / 2, 0, 0], [w, 0.02, size - w], o);
  part(g, 'box', color, [size / 2, 0, 0], [w, 0.02, size - w], o);
  return g;
}

interface MillView {
  root: Entity;
  body: Entity;
  blade: Entity;
  tray: Pile;
  feed: Entity;
  /** Seconds since the last plank came out (drives a little squash). */
  thump: number;
  lastStock: number;
}

function makeMill(parent: Entity, i: number): MillView {
  const b = MILL_BOXES[i]!;
  const t = MILL_TRAYS[i]!;
  const root = new Entity(`mill-${i}`);
  parent.addChild(root);
  const m = new Entity('body');
  m.setLocalPosition(b.x, 0, b.z);
  root.addChild(m);
  part(m, 'box', PALETTE.mill, [0, 0.55, 0], [b.w, 1.1, b.d], { radius: 0.14 });
  part(m, 'box', PALETTE.millRoof, [0, 1.22, 0], [b.w + 0.3, 0.32, b.d + 0.3], { radius: 0.12 });
  part(m, 'box', '#f3e2c0', [0.2, 0.75, b.d / 2], [0.8, 0.32, 0.06], { shadows: false, radius: 0.03 });
  // Saw blade spinning on the front.
  const blade = new Entity('blade');
  blade.setLocalPosition(-b.w / 2 + 0.45, 0.65, b.d / 2 + 0.12);
  m.addChild(blade);
  part(blade, 'cylinder', PALETTE.blade, [0, 0, 0], [0.7, 0.05, 0.7], { rot: [90, 0, 0] });
  part(blade, 'box', '#8e949c', [0, 0, 0.03], [0.62, 0.08, 0.03], { shadows: false, radius: 0.015 });
  // A log riding in from the yard.
  const feed = new Entity('feed');
  m.addChild(feed);
  log(feed, 0, 0, 0, 1.2, 0.18);
  // Output tray + its planks.
  const tray = new Entity('tray');
  tray.setLocalPosition(t.x, 0, t.z);
  root.addChild(tray);
  part(tray, 'box', PALETTE.counter, [0, 0.12, -0.35], [1.35, 0.24, 0.85], { radius: 0.07 });
  const planks = pile(
    tray,
    MILL_CAP,
    (k) => [0, 0.3 + Math.floor(k / 2) * PLANK_H, k % 2 === 0 ? -0.55 : -0.17],
    (r, k) => plankMesh(r, k, [1.1, PLANK_H * 0.92, 0.34]),
  );
  outline(root, t, 1.6, PALETTE.zone);
  return { root, body: m, blade, tray: planks, feed, thump: 1, lastStock: 0 };
}

export interface LumberScene {
  /** Rebuild per-shift state (customers, helpers, unlocked buildings) from a fresh sim. */
  reset(sim: LumberSim): void;
  /** Per-frame: interpolate movers, update piles, pads, camera. `dt` is game time (0 while paused). */
  sync(sim: LumberSim, dt: number): void;
  /** A burst at a world point (unlocks, sales). */
  burst(at: Vec2, color: string): void;
  /** World → CSS px on the canvas (orthographic: every point is in front of the camera). */
  project(x: number, y: number, z: number, out: { x: number; y: number }): void;
  /** Camera framing: follow the player, or pull back over the whole camp after the shift. */
  setOverview(on: boolean): void;
  /** Drop non-essential work (lowMemory). */
  trim(): void;
  readonly entityCount: number;
}

interface Burst {
  e: Entity;
  age: number;
}

/** `shadows: false` for the dev-only low-render mode (see lowfx.ts). */
export function createLumberScene(app: Application, opts: { shadows?: boolean } = {}): LumberScene {
  device = app.graphicsDevice;
  // Linear lighting with sRGB output and a neutral tone curve: softer light falloff and gentler shadows than shading
  // in gamma space, with the palette's colours kept (they are authored in sRGB).
  app.scene.ambientLight = new Color(0.46, 0.48, 0.55);

  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: hex(PALETTE.sky),
    projection: PROJECTION_ORTHOGRAPHIC,
    orthoHeight: 7,
    nearClip: 0.5,
    farClip: 120,
    gammaCorrection: GAMMA_SRGB,
    toneMapping: TONEMAP_NEUTRAL,
  });
  app.root.addChild(camera);
  /** Camera offset from what it looks at: from the south, 45° down. */
  const CAM = new Vec3(0, 13, 13);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.96, 0.88),
    intensity: 1.15,
    castShadows: opts.shadows ?? true,
    shadowType: SHADOW_PCF5_16F,
    shadowBias: 0.2,
    normalOffsetBias: 0.05,
    shadowResolution: 2048,
    shadowDistance: 45,
    shadowIntensity: 0.32,
  });
  sun.setEulerAngles(52, 35, 0);
  app.root.addChild(sun);

  const world = new Entity('world');
  app.root.addChild(world);

  // --- static camp ---------------------------------------------------------------------------------
  part(world, 'plane', PALETTE.grass, [0, -0.07, 0], [80, 1, 80], { shadows: false });
  const deckW = BOUNDS.maxX - BOUNDS.minX + 1.2;
  const deckD = BOUNDS.maxZ - BOUNDS.minZ + 1.4;
  const deckZ = (BOUNDS.maxZ + BOUNDS.minZ) / 2 - 0.1;
  part(world, 'box', PALETTE.deckEdge, [0, -0.05, deckZ], [deckW + 0.24, 0.08, deckD + 0.24], {
    shadows: false,
    radius: 0.04,
  });
  part(world, 'box', PALETTE.deck, [0, -0.03, deckZ], [deckW, 0.06, deckD], { shadows: false, radius: 0.03 });
  for (let x = BOUNDS.minX; x <= BOUNDS.maxX + 0.01; x += 1.2) {
    part(world, 'box', PALETTE.deckEdge, [x, 0.002, deckZ], [0.03, 0.004, deckD], {
      shadows: false,
      opacity: 0.5,
      sharp: true,
    });
  }
  // Road the customers come in on.
  part(world, 'box', PALETTE.road, [2.5, -0.05, 8.4], [14, 0.04, 2.4], { shadows: false, radius: 0.02 });

  // Log fence along the west and east edges: posts and a rail.
  const fence = new Entity('fence');
  world.addChild(fence);
  const west = BOUNDS.minX - 0.65;
  const east = BOUNDS.maxX + 0.65;
  const fenceFrom = BOUNDS.minZ - 1;
  const fenceTo = BOUNDS.maxZ + 0.3;
  for (let z = fenceFrom; z <= fenceTo; z += 0.9) {
    part(fence, 'capsule', PALETTE.fence, [west, 0.38, z], [0.24, 0.38, 0.24]);
    if (z < 5.6) part(fence, 'capsule', PALETTE.fence, [east, 0.38, z], [0.24, 0.38, 0.24]);
  }
  part(fence, 'box', PALETTE.fence, [west, 0.48, (fenceFrom + fenceTo) / 2], [0.14, 0.14, fenceTo - fenceFrom], {
    radius: 0.06,
  });
  part(fence, 'box', PALETTE.fence, [east, 0.48, (fenceFrom + 5.5) / 2], [0.14, 0.14, 5.5 - fenceFrom], {
    radius: 0.06,
  });

  // Log yard behind the mills.
  const yard = new Entity('yard');
  world.addChild(yard);
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < 7 - row; k++) {
      log(yard, -4.2 + k * 1.3 + row * 0.65, 0.28 + row * 0.42, -6.6, 1.2, 0.22);
      log(yard, -4.2 + k * 1.3 + row * 0.65 + 0.2, 0.28 + row * 0.42, -7.1, 1.2, 0.22);
    }
  }

  const trees = new Entity('trees');
  world.addChild(trees);
  const r = (n: number) => Math.abs(Math.sin(n * 91.7 + 13.1));
  for (let i = 0; i < 26; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (7.4 + r(i) * 4.5);
    const z = -9 + (i / 26) * 22 + r(i + 40) * 1.5;
    if (side > 0 && z > 5.5 && z < 10) continue; // keep the road clear
    const size = 0.8 + r(i + 7) * 0.5;
    if (i % 4 === 1) roundTree(trees, x, z, size);
    else pineTree(trees, x, z, size, i % 3 === 0);
  }
  for (let i = 0; i < 9; i++) {
    const x = -7 + i * 1.8 + r(i + 3);
    const z = -8.6 - r(i + 9) * 1.5;
    if (i % 3 === 2) roundTree(trees, x, z, 0.9 + r(i) * 0.3);
    else pineTree(trees, x, z, 0.9 + r(i) * 0.4, i % 2 === 0);
  }

  // Counter, register and the planks on the counter.
  const counter = new Entity('counter');
  counter.setLocalPosition(COUNTER.x, 0, COUNTER.z);
  world.addChild(counter);
  part(counter, 'box', PALETTE.counter, [0, 0.44, 0], [COUNTER.w, 0.88, COUNTER.d], { radius: 0.1 });
  part(counter, 'box', PALETTE.deckEdge, [0, 0.92, 0], [COUNTER.w + 0.18, 0.1, COUNTER.d + 0.18], { radius: 0.05 });
  const reg = REGISTER_ZONE.x - COUNTER.x;
  part(counter, 'box', PALETTE.register, [reg, 1.12, 0], [0.56, 0.3, 0.46], { radius: 0.08 });
  part(counter, 'box', '#8fd6ff', [reg, 1.3, -0.1], [0.4, 0.18, 0.06], { shadows: false, radius: 0.03 });
  const counterPlanks = pile(
    counter,
    40,
    (k) => [-1.2 + (k % 4) * 0.62, 1.03 + Math.floor(k / 4) * PLANK_H, 0],
    (root, k) => plankMesh(root, k, [0.56, PLANK_H * 0.92, 0.72]),
  );
  outline(world, DROP_ZONE, 1.6, PALETTE.zone);
  outline(world, REGISTER_ZONE, 1.4, PALETTE.zone);

  // Cash pile on the floor beside the counter: bundles with a paper band.
  const cashRoot = new Entity('cash');
  cashRoot.setLocalPosition(CASH_ZONE.x, 0, CASH_ZONE.z);
  world.addChild(cashRoot);
  const cashPile = pile(
    cashRoot,
    MAX_CASH_BUNDLES,
    (k) => {
      const col = k % 6;
      return [-0.3 + (col % 2) * 0.6, CASH_H / 2 + Math.floor(k / 6) * CASH_H, -0.4 + Math.floor(col / 2) * 0.4];
    },
    (root, k) => {
      const b = part(root, 'box', k % 2 ? PALETTE.cash : PALETTE.cashDark, [0, 0, 0], [0.52, CASH_H * 0.88, 0.32], {
        radius: 0.035,
      });
      part(b, 'box', PALETTE.cashBand, [0, 0, 0], [0.1, CASH_H * 0.9, 0.33], { radius: 0.01, shadows: false });
      return b;
    },
  );
  outline(world, CASH_ZONE, 1.6, PALETTE.cash, 0.7);

  const mills = [makeMill(world, 0), makeMill(world, 1)];

  // Unlock pads (one per unlock; shown while they are among the next ones to buy).
  const pads = new Map<UnlockId, { root: Entity; fill: Entity }>();
  for (const u of UNLOCKS) {
    const root = new Entity(`pad-${u.id}`);
    root.setLocalPosition(u.x, 0.01, u.z);
    world.addChild(root);
    part(root, 'box', PALETTE.padBase, [0, 0.01, 0], [1.5, 0.03, 1.5], { shadows: false, opacity: 0.5, radius: 0.015 });
    const fill = part(root, 'box', PALETTE.padFill, [0, 0.02, 0], [1.5, 0.03, 1.5], {
      shadows: false,
      opacity: 0.85,
      sharp: true,
    });
    outline(root, { x: 0, z: 0 }, 1.5, '#ffffff', 0.95).setLocalPosition(0, 0.02, 0);
    root.enabled = false;
    pads.set(u.id, { root, fill });
  }

  // --- people ----------------------------------------------------------------------------------------
  const actors = new Entity('actors');
  world.addChild(actors);
  const player = makeRig(actors, { shirt: PALETTE.player, hat: 'beanie', hatColor: PALETTE.playerHat, carry: 28 });
  const cashier = makeRig(actors, { shirt: PALETTE.cashier, hat: 'beanie', hatColor: '#c0392b' });
  cashier.root.setLocalPosition(REGISTER_ZONE.x, 0, REGISTER_ZONE.z + 0.15);
  cashier.root.enabled = false;
  const cashierSpot: Mover = {
    x: REGISTER_ZONE.x,
    z: REGISTER_ZONE.z + 0.15,
    px: REGISTER_ZONE.x,
    pz: REGISTER_ZONE.z + 0.15,
  };
  const haulers: Rig[] = [];
  const customers = new Map<number, Rig>();

  const bursts: Burst[] = [];

  let overview = false;
  const projectTmp = new Vec3();
  let camZ = 0;
  let orthoH = 7;
  let shadowsLow = false;
  let time = 0;

  function frame(width: number, height: number) {
    const aspect = width / Math.max(1, height);
    // The whole camp (and its fences) across in portrait; never closer than 6.2 on wide screens.
    return Math.max(6.2, 5.2 / aspect);
  }

  function makeCustomer(kind: 'builder' | 'cart', id: number): Rig {
    const rig = makeRig(actors, {
      shirt: PALETTE.shirts[id % PALETTE.shirts.length]!,
      hat: 'hardhat',
      hatColor: PALETTE.hardhat,
      carry: kind === 'cart' ? undefined : 4,
    });
    if (kind === 'cart') {
      const cart = new Entity('cart');
      cart.setLocalPosition(0, 0, 0.75);
      rig.root.addChild(cart);
      part(cart, 'box', PALETTE.cart, [0, 0.45, 0.1], [0.92, 0.36, 0.98], { radius: 0.1 });
      part(cart, 'cylinder', '#2b2b2b', [-0.48, 0.2, 0.1], [0.38, 0.08, 0.38], { rot: [0, 0, 90] });
      part(cart, 'cylinder', '#2b2b2b', [0.48, 0.2, 0.1], [0.38, 0.08, 0.38], { rot: [0, 0, 90] });
      rig.carry = pile(
        cart,
        12,
        (k) => [k % 2 === 0 ? -0.2 : 0.2, 0.68 + Math.floor(k / 2) * PLANK_H, 0.1],
        (r2, k) => plankMesh(r2, k, [0.38, PLANK_H * 0.92, 0.85]),
      );
    }
    return rig;
  }

  const scene: LumberScene = {
    get entityCount() {
      return customers.size * 16 + haulers.length * 24 + bursts.length + 450;
    },
    reset(sim) {
      for (const rig of customers.values()) rig.root.destroy();
      customers.clear();
      for (const h of haulers) h.root.destroy();
      haulers.length = 0;
      for (const b of bursts) b.e.destroy();
      bursts.length = 0;
      overview = false;
      camZ = sim.player.z;
      player.yaw = sim.player.heading;
      player.bendX = player.bendZ = player.bendVX = player.bendVZ = 0;
      scene.sync(sim, 0);
    },
    sync(sim, dt) {
      time += dt;
      const a = sim.alpha;

      // Player + helpers.
      player.carry!.set(sim.player.carry);
      poseRig(player, sim.player, a, sim.player.heading, dt);
      cashier.root.enabled = sim.cashierHired;
      if (cashier.root.enabled) poseRig(cashier, cashierSpot, 1, 0, dt);
      while (haulers.length < sim.haulers.length) {
        haulers.push(makeRig(actors, { shirt: PALETTE.hauler, hat: 'beanie', hatColor: '#f39c12', carry: 6 }));
      }
      sim.haulers.forEach((h, i) => {
        const rig = haulers[i]!;
        rig.carry!.set(h.carry);
        poseRig(rig, h, a, h.heading, dt);
      });

      // Customers: create / pose / remove.
      const seen = new Set<number>();
      for (const c of sim.customers) {
        seen.add(c.id);
        let rig = customers.get(c.id);
        if (!rig) {
          rig = makeCustomer(c.kind, c.id);
          customers.set(c.id, rig);
          rig.yaw = Math.atan2(c.x - CUSTOMER_EXIT.x, c.z - CUSTOMER_EXIT.z) + Math.PI;
        }
        rig.carry?.set(c.got);
        const leaving = c.state !== 'queue';
        const dx = leaving ? CUSTOMER_EXIT.x - c.x : c.x - c.px;
        const dz = leaving ? CUSTOMER_EXIT.z - c.z : c.z - c.pz;
        // Queued customers face the counter (north) once they stop.
        const heading = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : Math.PI;
        poseRig(rig, c, a, heading, dt);
      }
      for (const [id, rig] of customers) {
        if (!seen.has(id)) {
          rig.root.destroy();
          customers.delete(id);
        }
      }

      // Mills, counter, cash.
      sim.mills.forEach((m, i) => {
        const v = mills[i]!;
        v.root.enabled = m.built;
        if (!m.built) return;
        if (m.stock > v.lastStock) v.thump = 0;
        v.lastStock = m.stock;
        v.tray.set(m.stock);
        v.tray.update(dt);
        const running = m.stock < MILL_CAP;
        if (running) v.blade.rotateLocal(0, 0, -dt * 720);
        // A small squash each time a plank comes out.
        v.thump += dt;
        const squash = v.thump < 0.25 ? Math.sin((v.thump / 0.25) * Math.PI) * 0.045 : 0;
        v.body.setLocalScale(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
        const p = running ? Math.min(1, m.timer / m.period) : 1;
        const b = MILL_BOXES[i]!;
        v.feed.setLocalPosition(-b.w / 2 + 0.45, 0.3, -1.6 + p * 1.2);
        v.feed.enabled = running;
      });
      counterPlanks.set(sim.counter);
      counterPlanks.update(dt);
      cashPile.set(Math.min(MAX_CASH_BUNDLES, Math.ceil(sim.cash / CASH_PER_BUNDLE)));
      cashPile.update(dt);

      // Pads.
      const visible = new Set(sim.visiblePads.map((p) => p.def.id));
      for (const p of sim.pads) {
        const v = pads.get(p.def.id)!;
        v.root.enabled = visible.has(p.def.id);
        if (!v.root.enabled) continue;
        const k = Math.max(0.001, p.paid / p.def.cost);
        v.fill.setLocalScale(1.5, 0.03, 1.5 * k);
        v.fill.setLocalPosition(0, 0.02, 0.75 - 0.75 * k);
        // Breathe slightly so pads read as interactive.
        const s = 1 + Math.sin(time * 3 + p.def.x) * 0.025;
        v.root.setLocalScale(s, 1, s);
      }

      // Bursts.
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]!;
        b.age += dt;
        const t = Math.min(1, b.age / 0.5);
        const s = 0.4 + (1 - (1 - t) * (1 - t)) * 2.2;
        b.e.setLocalScale(s, 0.04, s);
        const m = b.e.render!.meshInstances[0]!.material as StandardMaterial;
        m.opacity = (1 - t) * 0.7;
        m.update();
        if (t >= 1) {
          b.e.destroy();
          m.destroy();
          bursts.splice(i, 1);
        }
      }

      // Camera.
      const gd = app.graphicsDevice;
      const base = frame(gd.width, gd.height);
      const k = dt > 0 ? 1 - Math.exp(-dt * 6) : 1;
      // The whole camp fits across, so the camera only follows the player up and down.
      const pz = sim.player.pz + (sim.player.z - sim.player.pz) * a;
      const wantZ = overview ? 0.6 : Math.max(-2.4, Math.min(3.6, pz + 0.6));
      const wantH = overview ? Math.max(base, 9.5) : base;
      camZ += (wantZ - camZ) * k;
      orthoH += (wantH - orthoH) * k;
      if (camera.camera!.orthoHeight !== orthoH) camera.camera!.orthoHeight = orthoH;
      camera.setPosition(CAM.x, CAM.y, camZ + CAM.z);
      camera.lookAt(0, 0, camZ);
    },
    burst(at, color) {
      const m = new StandardMaterial();
      m.diffuse = hex(color);
      m.emissive = hex(color);
      m.useLighting = false;
      m.blendType = BLEND_NORMAL;
      m.depthWrite = false;
      m.opacity = 0.7;
      m.update();
      const e = new Entity('burst');
      e.addComponent('render', { type: 'cylinder', material: m, castShadows: false });
      e.setLocalPosition(at.x, 0.12, at.z);
      world.addChild(e);
      bursts.push({ e, age: 0 });
    },
    project(x, y, z, out) {
      const s = camera.camera!.worldToScreen(projectTmp.set(x, y, z));
      out.x = s.x;
      out.y = s.y;
    },
    setOverview(on) {
      overview = on;
    },
    trim() {
      if (shadowsLow) return;
      shadowsLow = true;
      sun.light!.shadowResolution = 1024;
      trees.enabled = false;
    },
  };

  return scene;
}
