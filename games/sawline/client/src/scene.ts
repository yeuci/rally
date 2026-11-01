import {
  type Application,
  BLEND_NORMAL,
  Color,
  Entity,
  GAMMA_SRGB,
  type GraphicsDevice,
  Mat4,
  Mesh,
  MeshInstance,
  PROJECTION_ORTHOGRAPHIC,
  Quat,
  SHADOW_PCF5_16F,
  StandardMaterial,
  TONEMAP_NEUTRAL,
  TorusGeometry,
  Vec3,
  VertexBuffer,
  VertexFormat,
} from 'playcanvas';
import { roundedBox } from './meshes.ts';
import type { Models, PropName } from './models.ts';
import {
  BAY_SPOTS,
  DEBARKER_Z,
  INFEED_Z,
  LINE_END_Z,
  LINE_X,
  LOG_LEN,
  LOG_RADIUS,
  PILE,
  ROAD_Z,
  SAW_COOLDOWN,
  SAW_Z,
  SPLITTER_Z,
  TRUNK_RADIUS,
  rng,
  type Item,
  type SawlineSim,
  type SimEvent,
  type Truck,
} from './sim.ts';
import {
  type Look,
  WALK_STRIDE,
  type Worker,
  makeWorker,
  oneShot,
  play,
  resetWorker,
  vertexMaterial,
} from './workers.ts';

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export const PALETTE = {
  sky: '#a8dcef',
  grass: '#7cc95a',
  grassDark: '#62b04a',
  concrete: '#c9c4d3',
  concreteEdge: '#aaa4b8',
  road: '#6f6b7e',
  roadLine: '#f2efe6',
  frame: '#5d6474',
  belt: '#3f82e0',
  beltStripe: '#6ea6f0',
  rail: '#f5c533',
  machine: '#d8402f',
  machineDark: '#9c2a1f',
  steel: '#d9dde3',
  steelDark: '#8e949c',
  laser: '#55f0ff',
  bark: '#5a3a28',
  barkDark: '#45291b',
  wood: '#d79a5a',
  woodEnd: '#f0cf9c',
  mark: '#7a4320',
  glow: '#ffd23f',
  plank: '#e8b273',
  plank2: '#d9a062',
  truckCab: '#f4f4f2',
  truckBed: '#f28b2e',
  truckBedDark: '#cc6e1c',
  tyre: '#2d2d33',
  window: '#7fc6ef',
  bay: '#8c879a',
  bayLine: '#f2efe6',
  forklift: '#f2c230',
  leaves: '#4fae4f',
  leaves2: '#68c25a',
  trunk: '#6b4428',
  desk: '#4b5160',
  button: '#ff3b30',
  crate: '#c98b4f',
  vest: '#ff7a1a',
  vestLoader: '#c6e82c',
  hardHat: '#ffd23f',
  hardHatWhite: '#f4f4f2',
  skins: ['#f1c7a1', '#c68642', '#e0ac69', '#8d5524', '#ffdbac', '#a8714a', '#d9a273'],
} as const;

const PILE_MAX = 700;
const MAX_CHIPS = 48;
const BRANCHES_PER_TRUNK = 4;
const MAX_MARKS = 6;
const BELT_STRIPE_GAP = 0.7;
const TRUCK_TURN_RATE = 9;

let device: GraphicsDevice;
const materials = new Map<string, StandardMaterial>();

function mat(color: string, opts: { opacity?: number; emissive?: boolean } = {}): StandardMaterial {
  const opacity = opts.opacity ?? 1;
  const key = `${color}/${opacity}/${opts.emissive ? 1 : 0}`;
  let m = materials.get(key);
  if (!m) {
    m = new StandardMaterial();
    m.diffuse = hex(color);
    m.specular = new Color(0, 0, 0);
    m.gloss = 0;
    m.useMetalness = false;
    if (opts.emissive) {
      m.emissive = hex(color);
      m.useLighting = false;
    }
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
  emissive?: boolean;
  radius?: number;
  sharp?: boolean;
  name?: string;
}

/** One coloured primitive; boxes are rounded meshes at their real size (see Lumber Camp's scene). */
function part(parent: Entity, shape: Shape, color: string, pos: V3, size: V3, opts: PartOptions = {}): Entity {
  const e = new Entity(opts.name ?? shape);
  const shadows = opts.shadows ?? true;
  const material = mat(color, opts);
  if (shape === 'box' && !opts.sharp) {
    const [w, h, d] = size;
    const r = opts.radius ?? Math.min(0.08, Math.min(w, h, d) * 0.35);
    e.addComponent('render', { castShadows: shadows, receiveShadows: true });
    e.render!.meshInstances = [new MeshInstance(roundedBox(device, w, h, d, r), material)];
    e.render!.castShadows = shadows;
  } else {
    e.addComponent('render', { type: shape, material, castShadows: shadows, receiveShadows: true });
    e.setLocalScale(...size);
  }
  e.setLocalPosition(...pos);
  if (opts.rot) e.setLocalEulerAngles(...opts.rot);
  parent.addChild(e);
  return e;
}

/** A torus standing upright across the line (its hole along z). */
function ring(parent: Entity, color: string, z: number, ringRadius: number, tubeRadius: number, y = 0.75): Entity {
  const e = new Entity('ring');
  const mesh = Mesh.fromGeometry(device, new TorusGeometry({ ringRadius, tubeRadius, segments: 36, sides: 12 }));
  e.addComponent('render', { castShadows: true, receiveShadows: true });
  e.render!.meshInstances = [new MeshInstance(mesh, mat(color))];
  e.setLocalPosition(LINE_X, y, z);
  e.setLocalEulerAngles(90, 0, 0);
  parent.addChild(e);
  return e;
}

/** A cylinder lying along z (length along the line). */
function rod(parent: Entity, color: string, pos: V3, radius: number, length: number, opts: PartOptions = {}) {
  return part(parent, 'cylinder', color, pos, [radius * 2, length, radius * 2], { ...opts, rot: [90, 0, 0] });
}

function angleTo(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Everything that can be on the belt, built once per item; `pose` shows the parts for its current state. */
interface ItemView {
  root: Entity;
  wood: Entity;
  bark: Entity;
  capFront: Entity;
  capBack: Entity;
  branches: { e: Entity; at: number }[];
  marks: Entity[];
  glow: Entity;
  planks: Entity[];
}

function makeItemView(parent: Entity, item: Item): ItemView {
  const root = new Entity(`item-${item.id}`);
  parent.addChild(root);
  const wood = rod(root, PALETTE.wood, [0, 0, 0], LOG_RADIUS, 1);
  const bark = rod(root, PALETTE.bark, [0, 0, 0], TRUNK_RADIUS, 1);
  const capFront = rod(root, PALETTE.woodEnd, [0, 0, 0], LOG_RADIUS * 0.93, 0.02, { shadows: false });
  const capBack = rod(root, PALETTE.woodEnd, [0, 0, 0], LOG_RADIUS * 0.93, 0.02, { shadows: false });
  const r = rng(item.seed);
  const branches: { e: Entity; at: number }[] = [];
  for (let i = 0; i < BRANCHES_PER_TRUNK; i++) {
    const at = item.length * (0.2 + 0.7 * r());
    const around = (r() - 0.5) * 220;
    const pivot = new Entity('branch');
    pivot.setLocalPosition(0, 0, -at);
    pivot.setLocalEulerAngles(r() * 30 - 15, 0, around);
    root.addChild(pivot);
    const len = 0.5 + r() * 0.5;
    part(pivot, 'cylinder', PALETTE.barkDark, [0, TRUNK_RADIUS + len / 2 - 0.05, 0], [0.09, len, 0.09], {
      rot: [r() * 40 - 20, 0, 0],
    });
    part(pivot, 'cylinder', PALETTE.barkDark, [0.1, TRUNK_RADIUS + len * 0.7, 0], [0.05, len * 0.5, 0.05], {
      rot: [0, 0, -40],
    });
    branches.push({ e: pivot, at });
  }
  const marks: Entity[] = [];
  for (let i = 0; i < MAX_MARKS; i++)
    marks.push(rod(root, PALETTE.mark, [0, 0, 0], LOG_RADIUS + 0.012, 0.035, { shadows: false }));
  const glow = rod(root, PALETTE.glow, [0, 0, 0], LOG_RADIUS + 0.03, 0.06, { shadows: false, emissive: true });
  const planks: Entity[] = [];
  for (let i = 0; i < 9; i++) {
    const e = part(root, 'box', i % 2 ? PALETTE.plank2 : PALETTE.plank, [0, 0, 0], [0.2, 0.13, 1], { radius: 0.025 });
    planks.push(e);
  }
  return { root, wood, bark, capFront, capBack, branches, marks, glow, planks };
}

/** Lay a length-1 rod / plank between `from` and `to` (local z, both ≤ 0) by scaling along z. */
function span(e: Entity, from: number, to: number, x = 0, y = 0) {
  const len = Math.max(0.001, to - from);
  e.enabled = to - from > 0.002;
  e.setLocalPosition(x, y, (from + to) / 2);
  const s = e.getLocalScale();
  if (e.render?.type === 'cylinder') e.setLocalScale(s.x, len, s.z);
  else e.setLocalScale(1, 1, len);
}

function poseItem(v: ItemView, item: Item, front: number, underSaw: boolean) {
  const y = TRUNK_RADIUS + 0.28;
  v.root.setLocalPosition(LINE_X, y, front);
  const L = item.length;
  const isTrunk = item.kind === 'trunk';
  // Split part: past the splitter, the log is a bundle of planks.
  const split = item.kind === 'bundle' ? L : item.kind === 'log' ? Math.max(0, Math.min(L, front - SPLITTER_Z)) : 0;
  const debarked = isTrunk ? item.debarked : L;
  span(v.wood, -debarked, -split);
  span(v.bark, -L, -debarked);
  v.capFront.enabled = split === 0 && debarked > 0;
  v.capFront.setLocalPosition(0, 0, 0);
  v.capBack.enabled = split < L;
  v.capBack.setLocalPosition(0, 0, -L);
  for (const b of v.branches) b.e.enabled = isTrunk && b.at > debarked + 0.05 && b.at < L;
  // Cut marks every log length along the debarked wood; the next one glows while it rides up to the saw.
  let shown = 0;
  if (isTrunk) {
    for (let k = 1; k <= MAX_MARKS; k++) {
      const at = k * LOG_LEN;
      const m = v.marks[k - 1]!;
      m.enabled = at < Math.min(debarked, L - 0.05);
      if (m.enabled) {
        m.setLocalPosition(0, 0, -at);
        shown++;
      }
    }
  }
  for (let k = shown; k < MAX_MARKS; k++) v.marks[k]!.enabled = false;
  v.glow.enabled = isTrunk && underSaw && LOG_LEN < debarked;
  if (v.glow.enabled) v.glow.setLocalPosition(0, 0, -LOG_LEN);
  // Planks: a 3×3 bundle over the split length.
  v.planks.forEach((p, i) => {
    if (split <= 0.01) {
      p.enabled = false;
      return;
    }
    const col = (i % 3) - 1;
    const row = Math.floor(i / 3) - 1;
    span(p, -split, 0, col * 0.22, row * 0.14);
  });
}

interface TruckView {
  root: Entity;
  load: Entity;
  yaw: number;
}

function makeTruck(parent: Entity): TruckView {
  const root = new Entity('truck');
  parent.addChild(root);
  // Forward is +z: the cab leads.
  part(root, 'box', PALETTE.frame, [0, 0.32, 0], [0.9, 0.18, 2.1], { radius: 0.06 });
  part(root, 'box', PALETTE.truckCab, [0, 0.78, 0.68], [0.95, 0.8, 0.7], { radius: 0.14 });
  part(root, 'box', PALETTE.window, [0, 0.95, 1.03], [0.78, 0.3, 0.04], { radius: 0.02, shadows: false });
  part(root, 'box', PALETTE.truckBed, [0, 0.72, -0.4], [1.0, 0.6, 1.35], { radius: 0.1 });
  part(root, 'box', PALETTE.truckBedDark, [0, 0.98, -0.4], [0.86, 0.1, 1.2], { radius: 0.04, shadows: false });
  for (const [x, z] of [
    [-0.5, 0.65],
    [0.5, 0.65],
    [-0.5, -0.65],
    [0.5, -0.65],
  ] as const) {
    part(root, 'cylinder', PALETTE.tyre, [x, 0.22, z], [0.42, 0.18, 0.42], { rot: [0, 0, 90] });
  }
  const load = part(root, 'box', PALETTE.plank, [0, 1.0, -0.4], [0.8, 1, 1.1], { sharp: true });
  return { root, load, yaw: -Math.PI / 2 };
}

/** Where a seated driver's root goes on the forklift (the SitDown clip ends sitting on a seat this high). */
const SEAT: V3 = [0, 0.05, -0.2];

/** A forklift with an open roof frame (so its driver shows from above); forward is +z, the forks lead. */
function makeForklift(parent: Entity): { root: Entity; load: Entity } {
  const root = new Entity('forklift');
  parent.addChild(root);
  part(root, 'box', PALETTE.forklift, [0, 0.27, 0], [0.62, 0.3, 0.86], { radius: 0.09 });
  part(root, 'box', PALETTE.frame, [0, 0.5, -0.38], [0.6, 0.3, 0.2], { radius: 0.07 });
  part(root, 'box', PALETTE.desk, [0, 0.44, -0.16], [0.32, 0.05, 0.28], { radius: 0.02 });
  for (const [x, z] of [
    [-0.29, 0.28],
    [0.29, 0.28],
    [-0.29, -0.3],
    [0.29, -0.3],
  ] as const) {
    part(root, 'cylinder', PALETTE.tyre, [x, 0.13, z], [0.26, 0.12, 0.26], { rot: [0, 0, 90] });
  }
  for (const x of [-0.28, 0.28]) {
    for (const z of [0.2, -0.36]) {
      part(root, 'box', PALETTE.frame, [x, 0.86, z], [0.04, 0.84, 0.04], { radius: 0.015 });
    }
    part(root, 'box', PALETTE.frame, [x, 1.28, -0.08], [0.05, 0.05, 0.62], { radius: 0.02 });
  }
  part(root, 'box', PALETTE.frame, [0, 1.28, 0.2], [0.6, 0.05, 0.05], { radius: 0.02 });
  part(root, 'box', PALETTE.frame, [0, 1.28, -0.36], [0.6, 0.05, 0.05], { radius: 0.02 });
  // Mast and forks.
  for (const x of [-0.16, 0.16]) {
    part(root, 'box', PALETTE.steelDark, [x, 0.6, 0.47], [0.05, 1.05, 0.05], { radius: 0.02 });
    part(root, 'box', PALETTE.steelDark, [x * 0.8, 0.07, 0.72], [0.06, 0.03, 0.5], { radius: 0.01, shadows: false });
  }
  const load = part(root, 'box', PALETTE.plank, [0, 0.16, 0.72], [0.4, 0.14, 0.46], { radius: 0.03 });
  return { root, load };
}

interface V2 {
  x: number;
  z: number;
}

/**
 * A loader's walk from the pile to their bay's truck: out to a lane just behind the trucks (so nobody walks through
 * one), along it, and down the truck's left side to its bed. Forklifts drive the same route.
 */
function loaderPath(bay: number): V2[] {
  const b = BAY_SPOTS[bay]!;
  const laneZ = PILE.z - 1.1;
  const x = b.x - 0.85;
  return [
    { x: PILE.x + 1.25, z: laneZ },
    { x, z: laneZ },
    { x, z: b.z + 0.35 },
  ];
}

function pathLength(path: V2[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
  return len;
}

/** The point `s` along `path`, and the direction of its segment (unit, path order). */
function along(path: V2[], s: number): { x: number; z: number; dx: number; dz: number } {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (s <= len || i === path.length - 1) {
      const k = len > 0 ? Math.max(0, Math.min(1, s / len)) : 0;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
    }
    s -= len;
  }
  const p = path[0]!;
  return { x: p.x, z: p.z, dx: 0, dz: 1 };
}

/** One per loading bay: walks planks from the pile to the truck, then drives a forklift once they are bought. */
interface Loader {
  w: Worker;
  path: V2[];
  len: number;
  /** Distance along the path (0 at the pile, `len` beside the truck). */
  s: number;
  /** Heading for the truck (+1, loaded) or back to the pile (-1). */
  dir: 1 | -1;
  carrying: boolean;
  picking: boolean;
  /** The planks in their arms. */
  load: Entity;
  forklift: Entity;
  forkLoad: Entity;
  forkYaw: number;
  riding: boolean;
}

const WALK_SPEED = 1.3;
const FORKLIFT_SPEED = 2.6;
const PUNCH_SPEED = 1.8;
const PICKUP_SPEED = 1.7;
const WORKER_TURN_RATE = 12;

/** One Survival Pack prop (CC0, Quaternius; see models.ts), standing on y = 0 at `pos`. */
function prop(parent: Entity, models: Models, name: PropName, pos: V3, yaw = 0, tilt: V3 = [0, 0, 0]): Entity {
  const e = new Entity(`prop-${name}`);
  e.addComponent('render', { castShadows: true, receiveShadows: true });
  e.render!.meshInstances = [new MeshInstance(models.props[name], vertexMaterial())];
  e.render!.castShadows = true;
  e.setLocalPosition(...pos);
  e.setLocalEulerAngles(tilt[0], yaw + tilt[1], tilt[2]);
  parent.addChild(e);
  return e;
}

/** One plank's world transform per pile slot, in drop order: a sand-pile heap growing from the middle. */
function pileTransforms(): Float32Array {
  const out = new Float32Array(PILE_MAX * 16);
  const r = rng(424242);
  const CELL = 0.22;
  const N = 17;
  const heights = new Float32Array(N * N);
  const m = new Mat4();
  const q = new Quat();
  const p = new Vec3();
  const s = new Vec3(1, 1, 1);
  for (let i = 0; i < PILE_MAX; i++) {
    // Drop near the middle (where bundles fall), then roll downhill until settled.
    let cx = Math.round(N / 2 - 0.5 + (r() + r() - 1) * 2.2);
    let cz = Math.round(N / 2 - 0.5 + (r() + r() - 1) * 2.2);
    for (let tries = 0; tries < 20; tries++) {
      let best = -1;
      let bestH = heights[cz * N + cx]! - 0.13;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const h = heights[nz * N + nx]!;
        if (h < bestH) {
          bestH = h;
          best = nz * N + nx;
        }
      }
      if (best < 0) break;
      cx = best % N;
      cz = Math.floor(best / N);
    }
    const h = heights[cz * N + cx]!;
    heights[cz * N + cx] = h + 0.085;
    p.set(
      PILE.x + (cx - N / 2) * CELL + (r() - 0.5) * 0.12,
      h + 0.06,
      PILE.z + (cz - N / 2) * CELL + (r() - 0.5) * 0.12,
    );
    q.setFromEulerAngles((r() - 0.5) * 22, r() * 180, (r() - 0.5) * 22);
    m.setTRS(p, q, s);
    out.set(m.data, i * 16);
  }
  return out;
}

interface Chip {
  e: Entity;
  vel: Vec3;
  age: number;
  life: number;
}

export interface SawlineScene {
  reset(sim: SawlineSim): void;
  /** Per frame: interpolate, animate machines, update piles and trucks. `dt` is game time (0 while paused). */
  sync(sim: SawlineSim, dt: number): void;
  /** Sawdust / chips burst at a world point. */
  burst(x: number, y: number, z: number, color: string, n: number, speed?: number): void;
  project(x: number, y: number, z: number, out: { x: number; y: number }): void;
  setOverview(on: boolean): void;
  trim(): void;
  /** A sim event the workers react to (the sawyer hits the button on a manual cut). */
  event(e: SimEvent): void;
  readonly entityCount: number;
}

/** `models`: the workers (see models.ts). `shadows: false` for the dev-only low-render mode (see lowfx.ts). */
export function createSawlineScene(app: Application, models: Models, opts: { shadows?: boolean } = {}): SawlineScene {
  device = app.graphicsDevice;
  app.scene.ambientLight = new Color(0.48, 0.5, 0.58);

  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: hex(PALETTE.sky),
    projection: PROJECTION_ORTHOGRAPHIC,
    orthoHeight: 10,
    nearClip: 0.5,
    farClip: 150,
    gammaCorrection: GAMMA_SRGB,
    toneMapping: TONEMAP_NEUTRAL,
  });
  app.root.addChild(camera);
  /** From the south and a little west, ~50° down: the line runs down the screen at a slant, the yard beside it. */
  const CAM = new Vec3(-2.6, 17, 12);
  const LOOK = new Vec3(0.9, 0, 0.4);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.97, 0.9),
    intensity: 1.15,
    castShadows: opts.shadows ?? true,
    shadowType: SHADOW_PCF5_16F,
    shadowBias: 0.2,
    normalOffsetBias: 0.05,
    shadowResolution: 2048,
    shadowDistance: 60,
    shadowIntensity: 0.32,
  });
  sun.setEulerAngles(55, 20, 0);
  app.root.addChild(sun);

  const world = new Entity('world');
  app.root.addChild(world);

  // --- ground, yard, road --------------------------------------------------------------------------
  part(world, 'plane', PALETTE.grass, [0, -0.06, 0], [120, 1, 120], { shadows: false });
  part(world, 'box', PALETTE.concreteEdge, [0.9, -0.05, -2.2], [10.6, 0.08, 19.6], { shadows: false, radius: 0.04 });
  part(world, 'box', PALETTE.concrete, [0.9, -0.03, -2.2], [10.4, 0.06, 19.4], { shadows: false, radius: 0.03 });
  part(world, 'box', PALETTE.road, [0, -0.04, ROAD_Z], [60, 0.06, 1.9], { shadows: false, radius: 0.02 });
  for (let x = -24; x < 24; x += 2.2) {
    part(world, 'box', PALETTE.roadLine, [x, 0.0, ROAD_Z], [1.1, 0.01, 0.1], { shadows: false, sharp: true });
  }

  // Loading bays: painted pads (dim until bought).
  const bayPads = BAY_SPOTS.map((b) => {
    const g = new Entity('bay');
    g.setLocalPosition(b.x, 0.005, b.z);
    world.addChild(g);
    const base = part(g, 'box', PALETTE.bay, [0, 0, 0], [1.4, 0.02, 2.6], { shadows: false, radius: 0.01 });
    part(g, 'box', PALETTE.bayLine, [-0.72, 0.012, 0], [0.07, 0.02, 2.6], { shadows: false, sharp: true });
    part(g, 'box', PALETTE.bayLine, [0.72, 0.012, 0], [0.07, 0.02, 2.6], { shadows: false, sharp: true });
    return { g, base };
  });
  let shownBays = -1;

  // Trees around the yard.
  const trees = new Entity('trees');
  world.addChild(trees);
  const tr = rng(77);
  for (let i = 0; i < 90; i++) {
    const x = -16 + tr() * 32;
    const z = -20 + tr() * 36;
    const inYard = x > -4.6 && x < 6.4 && z > -12.2 && z < 9.3;
    const onRoad = Math.abs(z - ROAD_Z) < 1.6;
    if (inYard || onRoad) continue;
    const s = 0.8 + tr() * 0.5;
    const t = new Entity('tree');
    t.setLocalPosition(x, 0, z);
    trees.addChild(t);
    part(t, 'cylinder', PALETTE.trunk, [0, 0.3 * s, 0], [0.2 * s, 0.6 * s, 0.2 * s]);
    part(t, 'cone', i % 2 ? PALETTE.leaves : PALETTE.leaves2, [0, 1.1 * s, 0], [1.3 * s, 1.4 * s, 1.3 * s]);
    part(t, 'cone', i % 2 ? PALETTE.leaves2 : PALETTE.leaves, [0, 1.75 * s, 0], [0.95 * s, 1.0 * s, 0.95 * s]);
  }

  // --- the line ------------------------------------------------------------------------------------
  const line = new Entity('line');
  world.addChild(line);
  const lineFrom = INFEED_Z - 4;
  const lineLen = LINE_END_Z - lineFrom;
  const lineMid = (LINE_END_Z + lineFrom) / 2;
  part(line, 'box', PALETTE.frame, [LINE_X, 0.14, lineMid], [1.7, 0.28, lineLen], { radius: 0.08 });
  part(line, 'box', PALETTE.belt, [LINE_X, 0.3, lineMid], [1.3, 0.06, lineLen], { radius: 0.02, shadows: false });
  for (const side of [-1, 1]) {
    part(line, 'box', PALETTE.rail, [LINE_X + side * 0.78, 0.4, lineMid], [0.09, 0.1, lineLen], { radius: 0.03 });
  }
  const stripes: Entity[] = [];
  for (let z = lineFrom; z < LINE_END_Z; z += BELT_STRIPE_GAP) {
    stripes.push(
      part(line, 'box', PALETTE.beltStripe, [LINE_X, 0.335, z], [1.2, 0.01, 0.12], { shadows: false, sharp: true }),
    );
  }
  // Chute from the end of the line down to the pile.
  part(line, 'box', PALETTE.steelDark, [LINE_X + 0.15, 0.2, LINE_END_Z + 0.55], [1.3, 0.08, 1.2], {
    rot: [18, 0, 0],
    radius: 0.03,
  });

  // Debarker: a spiked ring on a frame.
  const debarker = new Entity('debarker');
  line.addChild(debarker);
  for (const side of [-1, 1]) {
    part(debarker, 'box', PALETTE.machineDark, [LINE_X + side * 0.95, 0.75, DEBARKER_Z], [0.22, 1.5, 0.4], {
      radius: 0.08,
    });
  }
  part(debarker, 'box', PALETTE.machineDark, [LINE_X, 1.55, DEBARKER_Z], [2.1, 0.22, 0.4], { radius: 0.08 });
  const debarkRing = ring(debarker, PALETTE.machine, DEBARKER_Z, 0.62, 0.11, TRUNK_RADIUS + 0.28);
  for (let i = 0; i < 10; i++) {
    // Steel teeth around the inside of the ring, pointing at its centre (in the ring's own plane).
    const pivot = new Entity('tooth');
    pivot.setLocalEulerAngles(0, (i / 10) * 360, 0);
    debarkRing.addChild(pivot);
    part(pivot, 'cone', PALETTE.steel, [0.5, 0, 0], [0.1, 0.18, 0.1], { rot: [0, 0, 90], shadows: false });
  }

  // Cross-cut saw: a gantry and a guillotine blade.
  const saw = new Entity('saw');
  line.addChild(saw);
  for (const side of [-1, 1]) {
    part(saw, 'box', PALETTE.machine, [LINE_X + side * 0.98, 1.05, SAW_Z], [0.2, 2.1, 0.28], { radius: 0.08 });
  }
  part(saw, 'box', PALETTE.machine, [LINE_X, 2.1, SAW_Z], [2.2, 0.24, 0.32], { radius: 0.09 });
  const blade = new Entity('blade');
  saw.addChild(blade);
  part(blade, 'box', PALETTE.steel, [0, 0, 0], [1.7, 0.5, 0.06], { radius: 0.02 });
  part(blade, 'box', PALETTE.machineDark, [0, 0.28, 0], [1.8, 0.1, 0.12], { radius: 0.03 });
  const BLADE_UP = 1.65;
  const BLADE_DOWN = 0.45;
  blade.setLocalPosition(LINE_X, BLADE_UP, SAW_Z);
  // The cut line on the belt.
  part(saw, 'box', '#ff4d3a', [LINE_X, 0.345, SAW_Z], [1.3, 0.01, 0.05], {
    shadows: false,
    sharp: true,
    emissive: true,
  });

  // Laser splitter: a ring with a glowing grid.
  const splitter = new Entity('splitter');
  line.addChild(splitter);
  for (const side of [-1, 1]) {
    part(splitter, 'box', PALETTE.machineDark, [LINE_X + side * 0.95, 0.7, SPLITTER_Z], [0.22, 1.4, 0.36], {
      radius: 0.08,
    });
  }
  ring(splitter, PALETTE.machine, SPLITTER_Z, 0.58, 0.1, TRUNK_RADIUS + 0.28);
  const laserMat = new StandardMaterial();
  laserMat.diffuse = hex(PALETTE.laser);
  laserMat.emissive = hex(PALETTE.laser);
  laserMat.useLighting = false;
  laserMat.blendType = BLEND_NORMAL;
  laserMat.depthWrite = false;
  laserMat.opacity = 0.35;
  laserMat.update();
  const laser = new Entity('laser');
  laser.addComponent('render', { type: 'cylinder', material: laserMat, castShadows: false });
  laser.setLocalScale(1.0, 0.02, 1.0);
  laser.setLocalEulerAngles(90, 0, 0);
  laser.setLocalPosition(LINE_X, TRUNK_RADIUS + 0.28, SPLITTER_Z);
  splitter.addChild(laser);

  // --- plank pile (one instanced draw call) -----------------------------------------------------------
  const pileMesh = roundedBox(device, 0.22, 0.09, 1.0, 0.03);
  const pileInstance = new MeshInstance(pileMesh, mat(PALETTE.plank));
  const pileVb = new VertexBuffer(device, VertexFormat.getDefaultInstancingFormat(device), PILE_MAX, {
    data: pileTransforms(),
  });
  pileInstance.setInstancing(pileVb);
  pileInstance.instancingCount = 0;
  pileInstance.cull = false;
  const pileEntity = new Entity('pile');
  pileEntity.addComponent('render', { castShadows: true, receiveShadows: true });
  pileEntity.render!.meshInstances = [pileInstance];
  world.addChild(pileEntity);

  // --- dynamic things ----------------------------------------------------------------------------------
  const itemsRoot = new Entity('items');
  world.addChild(itemsRoot);
  const itemViews = new Map<number, ItemView>();
  const trucksRoot = new Entity('trucks');
  world.addChild(trucksRoot);
  const truckViews = new Map<number, TruckView>();

  // --- the crew ------------------------------------------------------------------------------------------
  // Two operators at desks beside the debarker and the saw, and a loader per bay who carries planks from the pile to
  // the truck and later drives a forklift. The debarker sits down on a crate once the ring runs itself; the sawyer keeps
  // standing (taps still make perfect cuts with the auto saw) and hits the button on every manual cut.
  const crew = new Entity('crew');
  world.addChild(crew);
  const OP_X = LINE_X + 1.85;
  const CRATE_H = 0.34;
  const stations = [
    {
      z: DEBARKER_Z + 1.0,
      look: { body: 'worker_m', vest: PALETTE.vest, hat: PALETTE.hardHat, skin: PALETTE.skins[1] },
    },
    { z: SAW_Z + 1.0, look: { body: 'worker_f', vest: PALETTE.vest, hat: PALETTE.hardHat, skin: PALETTE.skins[4] } },
  ] as const;
  const [debarkOp, sawyer] = stations.map(({ z, look }, i) => {
    part(crew, 'box', PALETTE.desk, [OP_X - 0.48, 0.33, z], [0.3, 0.66, 0.5], { radius: 0.06 });
    part(crew, 'box', PALETTE.steelDark, [OP_X - 0.46, 0.68, z], [0.36, 0.05, 0.54], { radius: 0.02 });
    part(crew, 'cylinder', PALETTE.button, [OP_X - 0.44, 0.72, z + 0.12], [0.13, 0.05, 0.13], { shadows: false });
    if (i === 0)
      part(crew, 'box', PALETTE.crate, [OP_X + 0.3, CRATE_H / 2, z], [0.36, CRATE_H, 0.36], { radius: 0.03 });
    const w = makeWorker(app, models, crew, look, i ? 'sawyer' : 'debarker');
    w.root.setLocalPosition(OP_X, 0, z);
    w.root.setLocalEulerAngles(0, -90, 0);
    return w;
  }) as [Worker, Worker];

  // --- yard props (Survival Pack): the log deck by the infeed, a fuel corner, the operators' odds and ends ---------
  const decor = new Entity('decor');
  world.addChild(decor);
  const deck = { x: LINE_X + 2.3, z: INFEED_Z - 0.7 };
  const LOG_D = 0.75;
  const dr = rng(911);
  [
    [-1, 0],
    [0, 0],
    [1, 0],
    [-0.5, 1],
    [0.5, 1],
    [0, 2],
  ].forEach(([col, row]) => {
    // WoodLog lies along x: turned to lie along the line, stacked three, two, one.
    const at: V3 = [deck.x + col! * LOG_D * 1.02, row! * LOG_D * 0.86, deck.z + (dr() - 0.5) * 0.3];
    prop(decor, models, 'WoodLog', at, 90 + (dr() - 0.5) * 6);
  });
  // Stakes at the corners keep the stack from rolling.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      part(decor, 'box', PALETTE.trunk, [deck.x + sx * 1.6 * LOG_D, 0.45, deck.z + sz * 0.9], [0.11, 0.9, 0.11], {
        radius: 0.03,
      });
    }
  }
  prop(decor, models, 'Axe', [deck.x + 1.65, 0, deck.z + 0.7], 75, [0, 0, 18]);
  prop(decor, models, 'Shovel', [deck.x + 1.5, 0.02, deck.z - 0.9], 30, [-90, 0, 0]);
  prop(decor, models, 'PropaneTank', [5.7, 0, 2.6], 10);
  prop(decor, models, 'PropaneTank', [5.75, 0, 3.15], -25);
  prop(decor, models, 'PropaneTank', [5.25, 0, 2.75], 40);
  prop(decor, models, 'GasCan', [4.85, 0, 2.6], 25);
  prop(decor, models, 'GasCan', [4.95, 0, 3.0], -15);
  prop(decor, models, 'Trashcan', [OP_X + 0.2, 0, SAW_Z + 1.75], 15);
  prop(decor, models, 'FirstAidKit_Hard', [OP_X + 0.55, 0, SAW_Z + 1.95], -20);
  const deskTop = 0.705;
  prop(decor, models, 'Radio', [OP_X - 0.46, deskTop, stations[1].z - 0.14], 90);
  prop(decor, models, 'WaterBottle_1', [OP_X - 0.5, deskTop, stations[0].z - 0.16], 0);

  const LOADER_LOOKS: Look[] = [
    { body: 'worker_m', vest: PALETTE.vestLoader, hat: PALETTE.hardHat, skin: PALETTE.skins[3] },
    { body: 'worker_f', vest: PALETTE.vestLoader, hat: PALETTE.hardHatWhite, skin: PALETTE.skins[0] },
    { body: 'worker_m', vest: PALETTE.vestLoader, hat: PALETTE.hardHatWhite, skin: PALETTE.skins[5] },
  ];
  const loaders: Loader[] = BAY_SPOTS.map((_, i) => {
    const w = makeWorker(app, models, crew, LOADER_LOOKS[i]!, `loader-${i}`);
    const load = new Entity('arms-load');
    w.root.addChild(load);
    for (let k = 0; k < 3; k++) {
      part(
        load,
        'box',
        k % 2 ? PALETTE.plank2 : PALETTE.plank,
        [Math.sin(k * 1.7) * 0.02, 0.58 + k * 0.065, 0.27],
        [0.62, 0.06, 0.2],
        { radius: 0.02 },
      );
    }
    load.enabled = false;
    const fork = makeForklift(world);
    fork.root.enabled = false;
    const path = loaderPath(i);
    const len = pathLength(path);
    return {
      w,
      path,
      len,
      s: len,
      dir: 1,
      carrying: false,
      picking: false,
      load,
      forklift: fork.root,
      forkLoad: fork.load,
      forkYaw: 0,
      riding: false,
    };
  });

  function updateLoader(l: Loader, i: number, sim: SawlineSim, dt: number) {
    const on = i < sim.bays;
    const hasForklift = sim.upgrades.has('forklift');
    l.forklift.enabled = on && hasForklift;
    if (!l.riding) l.w.root.enabled = on;
    if (!on) return;
    if (hasForklift && !l.riding) {
      // Onto the forklift: the driver rides it from now on.
      l.riding = true;
      l.carrying = l.picking = false;
      l.load.enabled = false;
      l.w.root.reparent(l.forklift);
      l.w.root.setLocalPosition(...SEAT);
      l.w.root.setLocalEulerAngles(0, 0, 0);
      l.w.root.enabled = true;
      play(l.w, 'Sit', time, true);
    }
    const truck = sim.trucks.find(
      (tk) => tk.state === 'bay' && tk.slot === i && Math.abs(tk.z - BAY_SPOTS[i]!.z) < 0.01,
    );
    const playing = sim.phase === 'playing';
    const busy = playing && truck !== undefined && sim.pile > 0;
    let moved = 0;
    if (dt > 0 && playing) {
      const speed = l.riding ? FORKLIFT_SPEED : WALK_SPEED;
      if (l.picking) {
        if (time >= l.w.busyUntil) {
          l.picking = false;
          l.carrying = true;
          l.dir = 1;
        }
      } else if (busy || l.s < l.len) {
        // Busy: back and forth. Otherwise: back to the bay to wait for the next truck.
        const dir = busy ? l.dir : 1;
        const s = Math.max(0, Math.min(l.len, l.s + dir * speed * dt));
        moved = s - l.s;
        l.s = s;
        if (s >= l.len) {
          l.carrying = false;
          if (busy) l.dir = -1;
        } else if (s <= 0) {
          l.dir = 1;
          if (!l.riding) {
            l.picking = true;
            oneShot(l.w, models, 'PickUp', time, PICKUP_SPEED);
          }
        }
      }
    }
    const p = along(l.path, l.s);
    const k = dt > 0 ? 1 - Math.exp(-dt * WORKER_TURN_RATE) : 1;
    if (l.riding) {
      // Forks first towards the truck, reversing back to the pile.
      l.forklift.setLocalPosition(p.x, 0, p.z);
      l.forkYaw += angleTo(l.forkYaw, Math.atan2(p.dx, p.dz)) * k;
      l.forklift.setLocalEulerAngles(0, (l.forkYaw * 180) / Math.PI, 0);
      l.forkLoad.enabled = busy && l.dir > 0;
      play(l.w, 'Sit', time);
      return;
    }
    l.w.root.setLocalPosition(p.x, 0, p.z);
    const want =
      moved !== 0
        ? Math.atan2(p.dx * Math.sign(moved), p.dz * Math.sign(moved))
        : l.picking
          ? Math.atan2(PILE.x - p.x, PILE.z - p.z)
          : l.s >= l.len
            ? Math.PI / 2
            : null;
    if (want !== null) l.w.yaw += angleTo(l.w.yaw, want) * k;
    l.w.root.setLocalEulerAngles(0, (l.w.yaw * 180) / Math.PI, 0);
    l.load.enabled = l.carrying;
    const state =
      sim.phase === 'over' ? 'Victory' : moved !== 0 ? (l.carrying ? 'Carry' : 'Walk') : l.carrying ? 'Hold' : 'Idle';
    play(l.w, state, time);
    if (moved !== 0 && time >= l.w.busyUntil) l.w.model.anim!.speed = WALK_SPEED / WALK_STRIDE;
  }

  const chips: Chip[] = [];
  const chipPool: Entity[] = [];
  const chipsRoot = new Entity('chips');
  world.addChild(chipsRoot);

  let time = 0;
  let beltTravel = 0;
  let overview = false;
  let orthoH = 10;
  let lowFx = false;
  const tmp = new Vec3();

  function frame(width: number, height: number) {
    const aspect = width / Math.max(1, height);
    // Fit the line and the yard across a portrait screen; never closer than 8 on wide screens.
    return Math.max(8, 6.2 / aspect);
  }

  const scene: SawlineScene = {
    get entityCount() {
      return itemViews.size * 40 + truckViews.size * 14 + chips.length + 700;
    },
    reset(sim) {
      for (const v of itemViews.values()) v.root.destroy();
      itemViews.clear();
      for (const v of truckViews.values()) v.root.destroy();
      truckViews.clear();
      for (const c of chips) c.e.enabled = false;
      chipPool.push(...chips.map((c) => c.e));
      chips.length = 0;
      overview = false;
      resetWorker(debarkOp);
      resetWorker(sawyer);
      for (const l of loaders) {
        if (l.riding) {
          l.w.root.reparent(crew);
          l.riding = false;
        }
        l.s = l.len;
        l.dir = 1;
        l.carrying = l.picking = false;
        l.w.yaw = Math.PI / 2;
        resetWorker(l.w);
      }
      scene.sync(sim, 0);
    },
    sync(sim, dt) {
      time += dt;
      const a = sim.alpha;

      // Belt chevrons slide with the belt.
      if (sim.phase === 'playing') beltTravel = (beltTravel + sim.beltSpeed * dt) % BELT_STRIPE_GAP;
      stripes.forEach((s, i) => s.setLocalPosition(LINE_X, 0.335, lineFrom + i * BELT_STRIPE_GAP + beltTravel));

      // Machines.
      debarkRing.rotateLocal(0, sim.ringRunning ? dt * 540 : 0, 0);
      const t = 1 - sim.sawCooldown / SAW_COOLDOWN;
      const drop = sim.sawCooldown > 0 ? Math.sin(Math.min(1, t) * Math.PI) : 0;
      blade.setLocalPosition(LINE_X, BLADE_UP - (BLADE_UP - BLADE_DOWN) * drop, SAW_Z);
      const lasers = (sim.upgrades.has('laser1') ? 1 : 0) + (sim.upgrades.has('laser2') ? 1 : 0);
      const splitting = sim.items.some(
        (it) => it.kind === 'log' && it.front > SPLITTER_Z && it.front - it.length < SPLITTER_Z,
      );
      laserMat.opacity = (splitting ? 0.55 + Math.sin(time * 40) * 0.15 : 0.22) + lasers * 0.12;
      laserMat.update();

      // Items on the belt.
      const under = sim.underSaw;
      const seen = new Set<number>();
      for (const it of sim.items) {
        seen.add(it.id);
        let v = itemViews.get(it.id);
        if (!v) {
          v = makeItemView(itemsRoot, it);
          itemViews.set(it.id, v);
        }
        const front = it.prevFront + (it.front - it.prevFront) * a;
        poseItem(v, it, front, it === under);
      }
      for (const [id, v] of itemViews) {
        if (!seen.has(id)) {
          v.root.destroy();
          itemViews.delete(id);
        }
      }

      // Debarking throws bark chips; the splitter a few shavings.
      if (dt > 0 && sim.debarking && !lowFx && Math.random() < dt * 40) {
        scene.burst(
          LINE_X,
          TRUNK_RADIUS + 0.5,
          DEBARKER_Z + 0.1,
          Math.random() < 0.5 ? PALETTE.bark : PALETTE.barkDark,
          1,
          2.6,
        );
      }
      if (dt > 0 && splitting && !lowFx && Math.random() < dt * 25) {
        scene.burst(LINE_X, TRUNK_RADIUS + 0.4, SPLITTER_Z + 0.1, PALETTE.woodEnd, 1, 1.8);
      }

      // Pile.
      pileInstance.instancingCount = Math.min(PILE_MAX, sim.pile);

      // Bays and trucks.
      if (sim.bays !== shownBays) {
        shownBays = sim.bays;
        bayPads.forEach(
          (g, i) =>
            (g.base.render!.meshInstances[0]!.material = mat(i < shownBays ? PALETTE.bay : PALETTE.concreteEdge)),
        );
      }
      const seenTrucks = new Set<number>();
      for (const truck of sim.trucks) {
        seenTrucks.add(truck.id);
        let v = truckViews.get(truck.id);
        if (!v) {
          v = makeTruck(trucksRoot);
          truckViews.set(truck.id, v);
        }
        poseTruck(v, truck, a, dt);
      }
      for (const [id, v] of truckViews) {
        if (!seenTrucks.has(id)) {
          v.root.destroy();
          truckViews.delete(id);
        }
      }

      // The crew.
      const over = sim.phase === 'over';
      play(debarkOp, over ? 'Victory' : sim.autoDebark ? 'Sit' : sim.ringRunning ? 'Press' : 'Idle', time);
      play(sawyer, over ? 'Victory' : 'Idle', time);
      loaders.forEach((l, i) => updateLoader(l, i, sim, dt));

      // Chips.
      for (let i = chips.length - 1; i >= 0; i--) {
        const c = chips[i]!;
        c.age += dt;
        c.vel.y -= 14 * dt;
        const p = c.e.getLocalPosition();
        let y = p.y + c.vel.y * dt;
        if (y < 0.36 && Math.abs(p.x - LINE_X) < 0.8) y = Math.max(y, 0.36);
        c.e.setLocalPosition(p.x + c.vel.x * dt, Math.max(0.02, y), p.z + c.vel.z * dt);
        c.e.rotateLocal(dt * 400, dt * 250, 0);
        if (c.age >= c.life) {
          c.e.enabled = false;
          chipPool.push(c.e);
          chips.splice(i, 1);
        }
      }

      // Camera.
      const gd = app.graphicsDevice;
      const base = frame(gd.width, gd.height);
      const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
      orthoH += ((overview ? base * 1.08 : base) - orthoH) * k;
      if (camera.camera!.orthoHeight !== orthoH) camera.camera!.orthoHeight = orthoH;
      camera.setPosition(LOOK.x + CAM.x, LOOK.y + CAM.y, LOOK.z + CAM.z);
      camera.lookAt(LOOK);
    },
    burst(x, y, z, color, n, speed = 3) {
      if (lowFx) n = Math.min(n, 2);
      for (let i = 0; i < n; i++) {
        let e = chipPool.pop();
        if (!e) {
          if (chips.length >= MAX_CHIPS) return;
          e = part(chipsRoot, 'box', color, [0, 0, 0], [0.12, 0.05, 0.08], { sharp: true, shadows: false });
        }
        e.render!.meshInstances[0]!.material = mat(color);
        e.enabled = true;
        e.setLocalPosition(x, y, z);
        const ang = Math.random() * Math.PI * 2;
        const sp = speed * (0.4 + Math.random() * 0.6);
        chips.push({
          e,
          vel: new Vec3(Math.cos(ang) * sp, 2 + Math.random() * speed, Math.sin(ang) * sp * 0.6),
          age: 0,
          life: 0.6 + Math.random() * 0.4,
        });
      }
    },
    project(x, y, z, out) {
      const s = camera.camera!.worldToScreen(tmp.set(x, y, z));
      out.x = s.x;
      out.y = s.y;
    },
    setOverview(on) {
      overview = on;
    },
    event(e) {
      // A manual cut: the sawyer slams the button (a little jump every 5th perfect in a row).
      if (e.type !== 'cut' || e.auto) return;
      if (e.quality === 'perfect' && e.combo > 0 && e.combo % 5 === 0) oneShot(sawyer, models, 'Jump', time, 1.4);
      else oneShot(sawyer, models, 'Punch', time, PUNCH_SPEED);
    },
    trim() {
      if (lowFx) return;
      lowFx = true;
      sun.light!.shadowResolution = 1024;
      trees.enabled = false;
      decor.enabled = false;
    },
  };

  function poseTruck(v: TruckView, truck: Truck, a: number, dt: number) {
    const x = truck.px + (truck.x - truck.px) * a;
    const z = truck.pz + (truck.z - truck.pz) * a;
    const dx = truck.x - truck.px;
    const dz = truck.z - truck.pz;
    if (Math.hypot(dx, dz) > 1e-4) {
      const want = Math.atan2(dx, dz);
      v.yaw += angleTo(v.yaw, want) * (dt > 0 ? 1 - Math.exp(-dt * TRUCK_TURN_RATE) : 1);
    }
    v.root.setLocalPosition(x, 0, z);
    v.root.setLocalEulerAngles(0, (v.yaw * 180) / Math.PI, 0);
    const k = Math.min(1, truck.loaded / truck.want);
    v.load.enabled = k > 0;
    if (k > 0) {
      v.load.setLocalScale(0.8, 0.05 + 0.55 * k, 1.1);
      v.load.setLocalPosition(0, 0.98 + (0.05 + 0.55 * k) / 2, -0.4);
    }
  }

  return scene;
}
