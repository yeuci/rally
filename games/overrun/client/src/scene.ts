import {
  ADDRESS_CLAMP_TO_EDGE,
  BLEND_ADDITIVEALPHA,
  BLEND_NORMAL,
  BUFFER_DYNAMIC,
  Color,
  Entity,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  Mat4,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  Quat,
  SHADOW_PCF1_32F,
  StandardMaterial,
  Texture,
  Vec3,
  VertexBuffer,
  VertexFormat,
  type Application,
  type Mesh,
} from 'playcanvas';
import {
  ARENA_HALF_H,
  ARENA_HALF_W,
  GATES,
  MAX_ALIVE_ZOMBIES,
  OBSTACLES,
  PALETTE,
  WEAPONS,
  ZOMBIES,
  type Vec2,
} from '@rally/game-overrun-server';
import { createDecalCanvas, type DecalCanvas } from './decals.ts';
import {
  BoxBatch,
  ZOMBIE_LOOKS,
  barrelModel,
  hex,
  mineModel,
  pickupModel,
  zombieModel,
  zombieVariant,
  type Rgb,
} from './models.ts';

/**
 * Rendering only. Simulation coordinates (x right, y down the screen) map to world (x, 0, y); the camera looks down
 * at ≈58° from the +z side and follows the local player with a lead toward where they aim.
 */
const BG = new Color(20 / 255, 17 / 255, 15 / 255);
const PITCH = (60 * Math.PI) / 180;
const FOV = 30;
/** Ground units visible across the screen (half), and down it (half) at least. */
const VIEW_HALF_W = 11.5;
const VIEW_HALF_H = 6.6;
/** Camera lead toward where you aim, units. */
export const LEAD = 2.2;
const MAX_FLASHED = 24;
const MAX_TRACERS = 40;
const MAX_BURSTS = 60;
const MAX_BOOMS = 8;

export interface PlayerPose {
  x: number;
  y: number;
  /** Aim angle (radians, sim axes). */
  aim: number;
  /** Velocity (legs swing with speed). */
  vx: number;
  vy: number;
  slot: number;
  down: boolean;
  me: boolean;
  visible: boolean;
  /** Weapon index (the gun model's size). */
  weapon: number;
}

export interface OverrunSceneOptions {
  /** The sun casts shadows. Default true. */
  shadows?: boolean;
  /** Floor decals, blood bursts, camera shake. Default true. */
  effects?: boolean;
}

export interface OverrunScene {
  /**
   * Point the camera at (x, y), led toward `aim` (unit, sim axes; touch and keys), or by `lead` (world units: the mouse,
   * from the cursor's offset from the screen centre, so the lead never feeds back into the aim). `snap` jumps.
   */
  focus(x: number, y: number, aim: Vec2 | null, snap?: boolean, lead?: Vec2): void;
  setPlayer(id: string, pose: PlayerPose): void;
  removePlayer(id: string): void;
  /** Start a frame's horde: then `zombie()` for each, then `endZombies()`. */
  beginZombies(): void;
  zombie(id: number, kind: number, x: number, y: number, facing: number, flash: boolean): void;
  endZombies(): void;
  setProjectile(id: string, x: number, y: number, h: number, tx: number, ty: number): void;
  setExplosive(id: string, kind: number, x: number, y: number, armed: boolean): void;
  setPickup(id: string, kind: number, x: number, y: number): void;
  /** Remove projectiles / explosives / pickups not seen since the last call. */
  prune(): void;
  tracer(x0: number, y0: number, x1: number, y1: number, weapon: number): void;
  muzzle(x: number, y: number, angle: number, weapon: number): void;
  explosion(x: number, y: number, radius: number): void;
  /** Blood: a splat on the floor and a little burst; `amount` ~ 1 for a kill. */
  blood(x: number, y: number, amount: number, seed: number): void;
  splash(x: number, y: number, seed: number): void;
  shake(amount: number): void;
  /** Forget the floor decals (a new run). */
  clearDecals(): void;
  /** Screen position (CSS px) above a player's head, for labels; false when hidden. */
  labelAnchor(id: string, out: { x: number; y: number }): boolean;
  /** Screen position (CSS px) of a ground point. */
  toScreen(x: number, y: number, h: number, out: { x: number; y: number }): void;
  /** The ground point (sim) under a screen position (CSS px), or null. */
  toGround(sx: number, sy: number): Vec2 | null;
  update(dt: number): void;
  /** Camera distance multiplier (store art: closer for the icon). Default 1. */
  setZoom(k: number): void;
  /** Drop pooled effects (lowMemory). */
  trim(): void;
  /** Zombies drawn last frame (instanced + flashed). */
  readonly drawnZombies: number;
  readonly camera: Entity;
}

function material(color: Color, opts: { gloss?: number; vertex?: boolean } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = color;
  m.useMetalness = false;
  m.specular = new Color(0.08, 0.08, 0.08);
  m.gloss = opts.gloss ?? 0.25;
  if (opts.vertex) m.diffuseVertexColor = true;
  m.update();
  return m;
}

function glow(color: Color, opts: { additive?: boolean } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = new Color(0, 0, 0);
  m.emissive = color;
  m.useLighting = false;
  m.blendType = opts.additive === false ? BLEND_NORMAL : BLEND_ADDITIVEALPHA;
  m.depthWrite = false;
  m.opacity = 1;
  m.update();
  return m;
}

const col = (c: Rgb) => new Color(c[0] / 255, c[1] / 255, c[2] / 255);

/** The yard's floor: concrete slabs, paint lines and stains, drawn once into a canvas texture. */
function floorCanvas(): HTMLCanvasElement {
  const ppu = 20;
  const c = document.createElement('canvas');
  c.width = ARENA_HALF_W * 2 * ppu;
  c.height = ARENA_HALF_H * 2 * ppu;
  const g = c.getContext('2d');
  if (!g) return c;
  g.fillStyle = '#4b4641';
  g.fillRect(0, 0, c.width, c.height);
  let s = 12345;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  // slabs
  for (let y = 0; y < ARENA_HALF_H * 2; y += 4) {
    for (let x = 0; x < ARENA_HALF_W * 2; x += 4) {
      const v = 66 + Math.floor(rnd() * 14);
      g.fillStyle = `rgb(${v + 6}, ${v + 2}, ${v - 4})`;
      g.fillRect(x * ppu + 2, y * ppu + 2, 4 * ppu - 4, 4 * ppu - 4);
    }
  }
  // stains
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(30, 26, 22, ${0.05 + rnd() * 0.12})`;
    g.beginPath();
    g.arc(rnd() * c.width, rnd() * c.height, (0.4 + rnd() * 2.2) * ppu, 0, Math.PI * 2);
    g.fill();
  }
  // the plaza ring and lane markings
  g.strokeStyle = 'rgba(232, 196, 82, 0.55)';
  g.lineWidth = 0.18 * ppu;
  g.setLineDash([0.8 * ppu, 0.5 * ppu]);
  g.beginPath();
  g.arc(c.width / 2, c.height / 2, 2.8 * ppu, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  // hazard stripes in front of every gate
  for (const gate of GATES) {
    const gx = (gate.x + ARENA_HALF_W) * ppu;
    const gy = (gate.y + ARENA_HALF_H) * ppu;
    g.save();
    g.translate(gx, gy);
    if (gate.ay !== 0) g.rotate(Math.PI / 2);
    for (let i = -4; i < 4; i++) {
      g.fillStyle = i % 2 ? 'rgba(232, 196, 82, 0.7)' : 'rgba(30, 26, 22, 0.7)';
      g.beginPath();
      g.moveTo(i * 0.5 * ppu, -1.1 * ppu);
      g.lineTo((i + 1) * 0.5 * ppu, -1.1 * ppu);
      g.lineTo((i + 0.5) * 0.5 * ppu, 1.1 * ppu);
      g.lineTo((i - 0.5) * 0.5 * ppu, 1.1 * ppu);
      g.fill();
    }
    g.restore();
  }
  return c;
}

/** Obstacles, the fence and the gate frames as one vertex-coloured mesh (one draw call for the whole level). */
function levelModel(): BoxBatch {
  const b = new BoxBatch();
  const look: Record<string, { side: Rgb; top: Rgb }> = {
    crate: { side: hex('#8a6239'), top: hex('#a8794a') },
    pillar: { side: hex('#7d7a74'), top: hex('#9b978f') },
    wall: { side: hex('#6e3b32'), top: hex('#8a4c40') },
  };
  for (const o of OBSTACLES) {
    const l = look[o.kind]!;
    const w = o.x1 - o.x0;
    const d = o.y1 - o.y0;
    b.box((o.x0 + o.x1) / 2, o.height / 2, (o.y0 + o.y1) / 2, w, o.height, d, l.side, { top: l.top });
    if (o.kind === 'crate') {
      // slats
      b.box((o.x0 + o.x1) / 2, o.height * 0.5, (o.y0 + o.y1) / 2, w + 0.04, 0.08, d + 0.04, hex('#5d4127'));
    }
  }
  // The fence: posts and rails around the yard, broken by the gates.
  const fence = hex('#3a3f45');
  const gap = 1.7;
  const H = 1.4;
  const gatesOn = (side: 'top' | 'bottom' | 'left' | 'right') =>
    GATES.filter((g) =>
      side === 'top'
        ? g.y === -ARENA_HALF_H
        : side === 'bottom'
          ? g.y === ARENA_HALF_H
          : side === 'left'
            ? g.x === -ARENA_HALF_W
            : g.x === ARENA_HALF_W,
    ).map((g) => (side === 'top' || side === 'bottom' ? g.x : g.y));
  const run = (from: number, to: number, fixed: number, horizontal: boolean, holes: number[]) => {
    const cuts = [from, ...holes.flatMap((h) => [h - gap, h + gap]), to].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length; i += 2) {
      const a = cuts[i]!;
      const c = cuts[i + 1]!;
      const mid = (a + c) / 2;
      const len = c - a;
      if (horizontal) b.box(mid, H / 2, fixed, len, H, 0.35, fence, { top: hex('#555b62') });
      else b.box(fixed, H / 2, mid, 0.35, H, len, fence, { top: hex('#555b62') });
    }
  };
  const ox = ARENA_HALF_W + 0.18;
  const oy = ARENA_HALF_H + 0.18;
  run(-ox, ox, -oy, true, gatesOn('top'));
  run(-ox, ox, oy, true, gatesOn('bottom'));
  run(-oy, oy, -ox, false, gatesOn('left'));
  run(-oy, oy, ox, false, gatesOn('right'));
  // Gate frames: striped posts and a lintel.
  for (const g of GATES) {
    const horizontal = g.ay === 0;
    const gx = g.x + (horizontal ? 0 : Math.sign(g.x) * 0.18);
    const gy = g.y + (horizontal ? Math.sign(g.y) * 0.18 : 0);
    for (const s of [-1, 1]) {
      const px = horizontal ? gx + s * gap : gx;
      const py = horizontal ? gy : gy + s * gap;
      b.box(px, 1.1, py, 0.45, 2.2, 0.45, hex('#c9a43b'), { top: hex('#e2c25a') });
      b.box(px, 0.6, py, 0.48, 0.25, 0.48, hex('#2b2b2b'));
      b.box(px, 1.5, py, 0.48, 0.25, 0.48, hex('#2b2b2b'));
    }
    b.box(gx, 2.3, gy, horizontal ? gap * 2 + 0.45 : 0.45, 0.3, horizontal ? 0.45 : gap * 2 + 0.45, hex('#c9a43b'));
    // darkness beyond the gate
    b.box(
      g.x + (horizontal ? 0 : Math.sign(g.x) * 1.2),
      0.02,
      g.y + (horizontal ? Math.sign(g.y) * 1.2 : 0),
      horizontal ? gap * 2 : 2,
      0.04,
      horizontal ? 2 : gap * 2,
      hex('#0c0a09'),
    );
  }
  return b;
}

interface PlayerRig {
  root: Entity;
  legs: Entity;
  legL: Entity;
  legR: Entity;
  torso: Entity;
  gun: Entity;
  ring: Entity;
  phase: number;
  slot: number;
  visible: boolean;
  downT: number;
}

interface Instanced {
  mesh: Mesh;
  mi: MeshInstance;
  data: Float32Array;
  vb: VertexBuffer;
  count: number;
}

interface Effect {
  e: Entity;
  mat: StandardMaterial;
  age: number;
  life: number;
  live: boolean;
  /** Per-kind state. */
  vx: number;
  vy: number;
  vz: number;
  size: number;
}

export function createOverrunScene(
  app: Application,
  onResize: (fn: (w: number, h: number) => void) => void,
  { shadows = true, effects = true }: OverrunSceneOptions = {},
): OverrunScene {
  const device = app.graphicsDevice;
  app.scene.ambientLight = new Color(0.4, 0.38, 0.42);
  // One directional light: clustered lighting buys nothing here and costs every fragment (a lot on weak GPUs).
  app.scene.clusteredLightingEnabled = false;

  // --- camera ---------------------------------------------------------------------------------------------
  const camera = new Entity('camera');
  camera.addComponent('camera', { clearColor: BG, fov: FOV, nearClip: 1, farClip: 120 });
  app.root.addChild(camera);
  let dist = 20;
  let zoom = 1;
  const focusAt = new Vec3();
  const focusWant = new Vec3();
  let focusSet = false;
  function frame(width: number, height: number) {
    const aspect = width / Math.max(1, height);
    const tanV = Math.tan((FOV * Math.PI) / 360);
    dist = Math.max(VIEW_HALF_W / (tanV * aspect), (VIEW_HALF_H * Math.sin(PITCH)) / tanV);
  }
  frame(device.width, device.height);
  onResize(frame);

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.9, 0.78),
    intensity: 1.05,
    castShadows: shadows,
    // Hard single-tap shadows suit the blocky look and cost a third less than PCF3 (measured in software GL).
    shadowType: SHADOW_PCF1_32F,
    shadowBias: 0.3,
    normalOffsetBias: 0.06,
    shadowResolution: 1024,
    shadowDistance: 32,
    shadowIntensity: 0.6,
  });
  sun.setEulerAngles(55, 35, 0);
  app.root.addChild(sun);

  // --- level ----------------------------------------------------------------------------------------------
  const floorTex = new Texture(device, {
    name: 'floor',
    format: PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  // The floor texture is the static floor plus the decal layer (blood, scorch marks) composited on top whenever the
  // decals change (at most 4 times a second): no extra transparent pass over the whole yard.
  const base = floorCanvas();
  const composite = document.createElement('canvas');
  composite.width = base.width;
  composite.height = base.height;
  const compositeCtx = composite.getContext('2d');
  compositeCtx?.drawImage(base, 0, 0);
  floorTex.setSource(composite);
  const floorMat = material(new Color(1, 1, 1), { gloss: 0.15 });
  floorMat.diffuseMap = floorTex;
  floorMat.update();
  const floor = new Entity('floor');
  floor.addComponent('render', { type: 'plane', material: floorMat, castShadows: false, receiveShadows: true });
  floor.setLocalScale(ARENA_HALF_W * 2, 1, ARENA_HALF_H * 2);
  app.root.addChild(floor);
  // Ground outside the fence.
  const outside = new Entity('outside');
  outside.addComponent('render', {
    type: 'plane',
    material: material(new Color(0.09, 0.08, 0.07)),
    castShadows: false,
  });
  outside.setLocalScale(140, 1, 120);
  outside.setPosition(0, -0.02, 0);
  app.root.addChild(outside);

  const vertexMat = material(new Color(1, 1, 1), { vertex: true, gloss: 0.2 });
  const level = new Entity('level');
  level.addComponent('render', {
    meshInstances: [new MeshInstance(levelModel().mesh(device), vertexMat)],
    castShadows: true,
    receiveShadows: true,
  });
  app.root.addChild(level);

  // --- decals ---------------------------------------------------------------------------------------------
  const decals: DecalCanvas | null = effects ? createDecalCanvas() : null;
  function compose() {
    if (!compositeCtx || !decals) return;
    compositeCtx.drawImage(base, 0, 0);
    compositeCtx.drawImage(decals.canvas, 0, 0, composite.width, composite.height);
    floorTex.upload();
  }

  // --- players --------------------------------------------------------------------------------------------
  const skin = material(col(hex('#e8b58c')));
  const pants = material(col(hex('#2f3441')));
  const gunMat = material(col(hex('#24262b')), { gloss: 0.5 });
  const shirts = PALETTE.map((c) => material(col(hex(c)), { gloss: 0.3 }));
  const ringMat = glow(new Color(1, 1, 1), { additive: false });
  ringMat.opacity = 0.55;
  ringMat.update();
  const players = new Map<string, PlayerRig>();
  const part = (
    parent: Entity,
    mat: StandardMaterial,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ) => {
    const e = new Entity();
    e.addComponent('render', { type: 'box', material: mat, castShadows: true, receiveShadows: true });
    e.setLocalScale(sx, sy, sz);
    e.setLocalPosition(x, y, z);
    parent.addChild(e);
    return e;
  };
  function makePlayer(slot: number): PlayerRig {
    const root = new Entity('player');
    const ring = new Entity('ring');
    ring.addComponent('render', { type: 'cylinder', material: ringMat, castShadows: false });
    ring.setLocalScale(1.25, 0.02, 1.25);
    ring.setLocalPosition(0, 0.015, 0);
    ring.enabled = false;
    root.addChild(ring);
    const legs = new Entity('legs');
    root.addChild(legs);
    const legL = new Entity('legL');
    legL.setLocalPosition(-0.13, 0.62, 0);
    legs.addChild(legL);
    part(legL, pants, 0, -0.31, 0, 0.18, 0.62, 0.2);
    const legR = new Entity('legR');
    legR.setLocalPosition(0.13, 0.62, 0);
    legs.addChild(legR);
    part(legR, pants, 0, -0.31, 0, 0.18, 0.62, 0.2);
    const torso = new Entity('torso');
    root.addChild(torso);
    const shirt = shirts[slot % shirts.length]!;
    part(torso, shirt, 0, 0.94, 0, 0.5, 0.6, 0.3);
    part(torso, skin, 0, 1.42, 0, 0.32, 0.32, 0.32);
    part(torso, shirt, 0, 1.6, 0, 0.36, 0.08, 0.36); // cap
    part(torso, skin, -0.3, 1.04, 0.22, 0.13, 0.13, 0.46);
    part(torso, skin, 0.3, 1.04, 0.22, 0.13, 0.13, 0.46);
    const gun = part(torso, gunMat, 0.12, 1.06, 0.55, 0.1, 0.12, 0.42);
    app.root.addChild(root);
    return { root, legs, legL, legR, torso, gun, ring, phase: 0, slot, visible: true, downT: 0 };
  }

  // --- zombies (hardware instancing) -----------------------------------------------------------------------
  const instFormat = VertexFormat.getDefaultInstancingFormat(device);
  const variants: Instanced[] = ZOMBIE_LOOKS.map((look) => {
    const mesh = zombieModel(look).mesh(device);
    const data = new Float32Array(MAX_ALIVE_ZOMBIES * 2 * 16);
    const vb = new VertexBuffer(device, instFormat, MAX_ALIVE_ZOMBIES * 2, { usage: BUFFER_DYNAMIC, data });
    const mi = new MeshInstance(mesh, vertexMat);
    mi.setInstancing(vb, false);
    mi.instancingCount = 0;
    const e = new Entity('horde');
    e.addComponent('render', { meshInstances: [mi], castShadows: shadows, receiveShadows: true });
    app.root.addChild(e);
    return { mesh, mi, data, vb, count: 0 };
  });
  // Zombies that were just hit are drawn white by a small pool of plain entities instead.
  const flashMat = glow(new Color(1, 0.95, 0.9), { additive: false });
  const flashPool: { e: Entity; variant: number }[] = [];
  let flashUsed = 0;
  const mat4 = new Mat4();
  const quat = new Quat();
  const pos = new Vec3();
  const scl = new Vec3(1, 1, 1);
  let clock = 0;
  let drawn = 0;

  // --- props: barrels, mines, pickups, globs ---------------------------------------------------------------
  const barrelMesh = barrelModel().mesh(device);
  const mineMesh = mineModel().mesh(device);
  const pickupMeshes = [0, 1, 2, 3, 4].map((k) => pickupModel(k).mesh(device));
  const mineLightOn = glow(new Color(1, 0.15, 0.1), { additive: false });
  const mineLightOff = material(new Color(0.3, 0.05, 0.05));
  const globMat = glow(new Color(0.6, 0.95, 0.2), { additive: false });
  const warnMat = glow(new Color(0.55, 0.85, 0.15));
  warnMat.opacity = 0.45;
  warnMat.update();
  interface Prop {
    e: Entity;
    kind: number;
    seen: boolean;
    light?: Entity;
    warn?: Entity;
  }
  const props = new Map<string, Prop>();
  const meshEntity = (mesh: Mesh, castShadows = true) => {
    const e = new Entity();
    e.addComponent('render', { meshInstances: [new MeshInstance(mesh, vertexMat)], castShadows, receiveShadows: true });
    app.root.addChild(e);
    return e;
  };
  function prop(key: string, make: () => Prop): Prop {
    let p = props.get(key);
    if (!p) props.set(key, (p = make()));
    p.seen = true;
    return p;
  }

  // --- effects -------------------------------------------------------------------------------------------
  function pool(n: number, make: () => Effect): Effect[] {
    return Array.from({ length: n }, make);
  }
  function effectEntity(type: 'box' | 'sphere' | 'cylinder', mat: StandardMaterial, castShadows = false): Effect {
    const e = new Entity();
    const m = mat.clone();
    m.update();
    e.addComponent('render', { type, material: m, castShadows, receiveShadows: false });
    e.enabled = false;
    app.root.addChild(e);
    return { e, mat: m, age: 0, life: 1, live: false, vx: 0, vy: 0, vz: 0, size: 1 };
  }
  const tracerBase = glow(new Color(1, 0.86, 0.45));
  const tracers = pool(MAX_TRACERS, () => effectEntity('box', tracerBase));
  const muzzleBase = glow(new Color(1, 0.75, 0.3));
  const muzzles = pool(8, () => effectEntity('sphere', muzzleBase));
  const fireBase = glow(new Color(1, 0.55, 0.15));
  const booms = pool(MAX_BOOMS, () => effectEntity('sphere', fireBase));
  const waveBase = glow(new Color(1, 0.8, 0.5));
  const shocks = pool(MAX_BOOMS, () => effectEntity('cylinder', waveBase));
  const bloodBase = material(new Color(0.5, 0.03, 0.05));
  const bursts = effects ? pool(MAX_BURSTS, () => effectEntity('box', bloodBase, false)) : [];
  const take = (list: Effect[]) => {
    let best = list[0]!;
    for (const f of list) {
      if (!f.live) return f;
      if (f.age / f.life > best.age / best.life) best = f;
    }
    return best;
  };
  const start = (f: Effect, life: number) => {
    f.live = true;
    f.age = 0;
    f.life = life;
    f.e.enabled = true;
  };

  let shakeAmp = 0;
  const camPos = new Vec3();
  const tmp = new Vec3();
  const ray0 = new Vec3();
  const ray1 = new Vec3();

  return {
    camera,
    get drawnZombies() {
      return drawn;
    },
    focus(x, y, aim, snap = false, lead) {
      const lx = lead ? lead.x : aim ? aim.x * LEAD : 0;
      const ly = lead ? lead.y : aim ? aim.y * LEAD * 0.7 : 0;
      // Keep the view inside the yard (plus a margin) when the arena is bigger than the screen.
      const aspect = device.width / Math.max(1, device.height);
      const tanV = Math.tan((FOV * Math.PI) / 360);
      const halfW = dist * tanV * aspect;
      const halfH = (dist * tanV) / Math.sin(PITCH);
      const mx = Math.max(0, ARENA_HALF_W + 2.5 - halfW);
      const my = Math.max(0, ARENA_HALF_H + 2 - halfH);
      focusWant.set(Math.max(-mx, Math.min(mx, x + lx)), 0, Math.max(-my, Math.min(my, y + ly)));
      if (snap || !focusSet) {
        focusAt.copy(focusWant);
        focusSet = true;
      }
    },
    setPlayer(id, v) {
      let r = players.get(id);
      if (!r) players.set(id, (r = makePlayer(v.slot)));
      r.root.enabled = v.visible;
      r.visible = v.visible;
      if (!v.visible) return;
      r.ring.enabled = v.me;
      r.root.setPosition(v.x, 0, v.y);
      const speed = Math.hypot(v.vx, v.vy);
      const aimYaw = (Math.atan2(Math.cos(v.aim), Math.sin(v.aim)) * 180) / Math.PI;
      if (v.down) {
        r.downT = Math.min(1, r.downT + 0.08);
        r.torso.setLocalEulerAngles(80 * r.downT, aimYaw, 0);
        r.torso.setLocalPosition(0, -0.75 * r.downT, 0);
        r.legs.enabled = false;
      } else {
        r.downT = 0;
        r.torso.setLocalEulerAngles(0, aimYaw, 0);
        r.torso.setLocalPosition(0, 0, 0);
        r.legs.enabled = true;
        const moveYaw = speed > 0.3 ? (Math.atan2(v.vx, v.vy) * 180) / Math.PI : aimYaw;
        r.legs.setLocalEulerAngles(0, moveYaw, 0);
        r.phase += speed * 0.05;
        const swing = speed > 0.3 ? Math.sin(r.phase * 2.2) * 38 : 0;
        r.legL.setLocalEulerAngles(swing, 0, 0);
        r.legR.setLocalEulerAngles(-swing, 0, 0);
      }
      const w = WEAPONS[v.weapon];
      const long = w?.id === 'shotgun' ? 0.62 : w?.id === 'uzi' ? 0.36 : 0.3;
      r.gun.setLocalScale(0.1, 0.12, long);
      r.gun.setLocalPosition(0.12, 1.06, 0.4 + long / 2);
      r.gun.enabled = w?.kind === 'gun';
    },
    removePlayer(id) {
      const r = players.get(id);
      if (!r) return;
      r.root.destroy();
      players.delete(id);
    },
    beginZombies() {
      for (const v of variants) v.count = 0;
      flashUsed = 0;
    },
    zombie(id, kind, x, y, facing, flash) {
      const variant = zombieVariant(kind, id);
      // Shamble: a bob and a side-to-side sway, out of phase per zombie.
      const ph = clock * (kind === 1 ? 4 : 6.5) + id * 1.7;
      const sway = Math.sin(ph) * (kind === 1 ? 4 : 7);
      pos.set(x, Math.abs(Math.cos(ph)) * 0.06, y);
      quat.setFromEulerAngles(0, (facing * 180) / Math.PI, sway);
      scl.set(1, 1, 1);
      if (flash && flashUsed < MAX_FLASHED) {
        let f = flashPool[flashUsed];
        if (!f) {
          const e = new Entity('flash');
          e.addComponent('render', {
            meshInstances: [new MeshInstance(variants[variant]!.mesh, flashMat)],
            castShadows: false,
          });
          app.root.addChild(e);
          f = { e, variant };
          flashPool.push(f);
        }
        if (f.variant !== variant) {
          f.e.render!.meshInstances = [new MeshInstance(variants[variant]!.mesh, flashMat)];
          f.variant = variant;
        }
        f.e.enabled = true;
        f.e.setPosition(pos);
        f.e.setRotation(quat);
        flashUsed++;
        return;
      }
      const v = variants[variant]!;
      if (v.count >= MAX_ALIVE_ZOMBIES * 2) return;
      mat4.setTRS(pos, quat, scl);
      v.data.set(mat4.data, v.count * 16);
      v.count++;
    },
    endZombies() {
      drawn = flashUsed;
      for (const v of variants) {
        v.mi.instancingCount = v.count;
        if (v.count > 0) v.vb.unlock(0, v.count * 64);
        drawn += v.count;
      }
      for (let i = flashUsed; i < flashPool.length; i++) flashPool[i]!.e.enabled = false;
    },
    setProjectile(id, x, y, h, tx, ty) {
      const p = prop(`p${id}`, () => {
        const e = new Entity('glob');
        e.addComponent('render', { type: 'sphere', material: globMat, castShadows: true });
        e.setLocalScale(0.36, 0.36, 0.36);
        app.root.addChild(e);
        const warn = new Entity('warn');
        warn.addComponent('render', { type: 'cylinder', material: warnMat, castShadows: false });
        warn.setLocalScale(2, 0.02, 2);
        app.root.addChild(warn);
        return { e, kind: -1, seen: true, warn };
      });
      p.e.setPosition(x, h + 0.2, y);
      p.warn?.setPosition(tx, 0.03, ty);
    },
    setExplosive(id, kind, x, y, armed) {
      const p = prop(`e${id}`, () => {
        const e = meshEntity(kind === 0 ? barrelMesh : mineMesh);
        let light: Entity | undefined;
        if (kind === 1) {
          light = new Entity('mine-light');
          light.addComponent('render', { type: 'box', material: mineLightOff, castShadows: false });
          light.setLocalScale(0.12, 0.08, 0.12);
          light.setLocalPosition(0, 0.18, 0);
          e.addChild(light);
        }
        return { e, kind, seen: true, light };
      });
      p.e.setPosition(x, 0, y);
      if (p.light) {
        const on = armed && Math.floor(clock * 3) % 2 === 0;
        p.light.render!.meshInstances[0]!.material = on ? mineLightOn : mineLightOff;
      }
    },
    setPickup(id, kind, x, y) {
      const p = prop(`k${id}`, () => ({ e: meshEntity(pickupMeshes[kind] ?? pickupMeshes[1]!), kind, seen: true }));
      p.e.setPosition(x, 0.15 + Math.sin(clock * 3 + x) * 0.08, y);
      p.e.setEulerAngles(0, clock * 90 + x * 40, 0);
    },
    prune() {
      for (const [key, p] of props) {
        if (p.seen) {
          p.seen = false;
          continue;
        }
        p.e.destroy();
        p.warn?.destroy();
        props.delete(key);
      }
    },
    tracer(x0, y0, x1, y1, weapon) {
      const f = take(tracers);
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.05) return;
      start(f, weapon === 2 ? 0.09 : 0.06);
      f.e.setPosition((x0 + x1) / 2, 1.05, (y0 + y1) / 2);
      f.e.setEulerAngles(0, (Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI, 0);
      f.size = weapon === 2 ? 0.035 : 0.05;
      f.e.setLocalScale(f.size, f.size, len);
    },
    muzzle(x, y, angle, weapon) {
      const f = take(muzzles);
      start(f, 0.05);
      const d = 0.75;
      f.e.setPosition(x + Math.cos(angle) * d, 1.06, y + Math.sin(angle) * d);
      f.size = weapon === 2 ? 0.75 : weapon === 1 ? 0.4 : 0.45;
      f.e.setLocalScale(f.size, f.size, f.size);
    },
    explosion(x, y, radius) {
      const f = take(booms);
      start(f, 0.45);
      f.size = radius * 1.1;
      f.e.setPosition(x, 0.6, y);
      const s = take(shocks);
      start(s, 0.35);
      s.size = radius * 2.2;
      s.e.setPosition(x, 0.08, y);
      decals?.scorch(x, y, radius * 0.6, Math.floor(x * 97 + y * 13) >>> 0);
      if (effects) {
        for (let i = 0; i < 8; i++) {
          const b = take(bursts);
          start(b, 0.6);
          const a = (i / 8) * Math.PI * 2;
          b.vx = Math.cos(a) * 6;
          b.vz = Math.sin(a) * 6;
          b.vy = 5;
          b.size = 0.16;
          b.e.setPosition(x, 0.5, y);
          b.e.setLocalScale(b.size, b.size, b.size);
          b.mat.diffuse = new Color(0.2, 0.17, 0.14);
          b.mat.update();
        }
      }
    },
    blood(x, y, amount, seed) {
      decals?.blood(x, y, amount, seed);
      if (!effects) return;
      const n = amount >= 1 ? 6 : 2;
      for (let i = 0; i < n; i++) {
        const b = take(bursts);
        start(b, 0.5);
        const a = ((seed % 360) / 360) * Math.PI * 2 + i * 1.1;
        const sp = 1.5 + ((seed >> (i % 8)) & 3);
        b.vx = Math.cos(a) * sp;
        b.vz = Math.sin(a) * sp;
        b.vy = 3 + (i % 3);
        b.size = 0.1 + (i % 2) * 0.05;
        b.e.setPosition(x, 0.8, y);
        b.e.setLocalScale(b.size, b.size, b.size);
        b.mat.diffuse = new Color(0.5, 0.03, 0.05);
        b.mat.update();
      }
    },
    splash(x, y, seed) {
      decals?.splash(x, y, seed);
    },
    shake(amount) {
      if (!effects) return;
      shakeAmp = Math.min(0.8, Math.max(shakeAmp, amount));
    },
    clearDecals() {
      decals?.clear();
      compose();
    },
    labelAnchor(id, out) {
      const r = players.get(id);
      if (!r || !r.visible) return false;
      const p = r.root.getPosition();
      tmp.set(p.x, r.downT > 0.5 ? 0.9 : 2.05, p.z);
      camera.camera!.worldToScreen(tmp, ray0);
      out.x = ray0.x;
      out.y = ray0.y;
      return true;
    },
    toScreen(x, y, h, out) {
      tmp.set(x, h, y);
      camera.camera!.worldToScreen(tmp, ray0);
      out.x = ray0.x;
      out.y = ray0.y;
    },
    toGround(sx, sy) {
      const cam = camera.camera!;
      cam.screenToWorld(sx, sy, cam.nearClip, ray0);
      cam.screenToWorld(sx, sy, cam.farClip, ray1);
      const dy = ray1.y - ray0.y;
      if (Math.abs(dy) < 1e-6) return null;
      const t = (1.0 - ray0.y) / dy; // the plane at gun height, so aim lines up with the tracer
      if (t < 0) return null;
      return { x: ray0.x + (ray1.x - ray0.x) * t, y: ray0.z + (ray1.z - ray0.z) * t };
    },
    update(dt) {
      clock += dt;
      // camera: ease toward the focus
      const k = 1 - Math.exp(-dt * 7);
      focusAt.x += (focusWant.x - focusAt.x) * k;
      focusAt.z += (focusWant.z - focusAt.z) * k;
      const d = dist * zoom;
      camPos.set(focusAt.x, Math.sin(PITCH) * d, focusAt.z + Math.cos(PITCH) * d);
      if (shakeAmp > 0.002) {
        camPos.x += (Math.random() - 0.5) * 2 * shakeAmp;
        camPos.y += (Math.random() - 0.5) * shakeAmp;
        camPos.z += (Math.random() - 0.5) * 2 * shakeAmp;
        shakeAmp *= Math.exp(-dt * 9);
      } else {
        shakeAmp = 0;
      }
      camera.setPosition(camPos);
      camera.lookAt(focusAt.x, 0, focusAt.z);
      // effects
      for (const f of tracers) {
        if (!f.live) continue;
        f.age += dt;
        if (f.age >= f.life) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        f.mat.opacity = 1 - f.age / f.life;
        f.mat.update();
      }
      for (const f of muzzles) {
        if (!f.live) continue;
        f.age += dt;
        if (f.age >= f.life) {
          f.live = false;
          f.e.enabled = false;
        }
      }
      for (const f of booms) {
        if (!f.live) continue;
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        const s = f.size * (0.35 + 0.9 * Math.sqrt(u));
        f.e.setLocalScale(s, s * 0.8, s);
        f.mat.opacity = 1 - u;
        f.mat.update();
      }
      for (const f of shocks) {
        if (!f.live) continue;
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        const s = f.size * (0.2 + u);
        f.e.setLocalScale(s, 0.03, s);
        f.mat.opacity = 0.8 * (1 - u);
        f.mat.update();
      }
      for (const f of bursts) {
        if (!f.live) continue;
        f.age += dt;
        if (f.age >= f.life) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        f.vy -= 18 * dt;
        const p = f.e.getPosition();
        const y = Math.max(0.05, p.y + f.vy * dt);
        f.e.setPosition(p.x + f.vx * dt, y, p.z + f.vz * dt);
        if (y <= 0.05) {
          f.vx *= 0.6;
          f.vz *= 0.6;
        }
      }
      if (decals?.tick(dt, performance.now())) compose();
    },
    setZoom(k) {
      zoom = k;
    },
    trim() {
      for (const list of [tracers, muzzles, booms, shocks, bursts]) {
        for (const f of list) {
          f.live = false;
          f.e.enabled = false;
        }
      }
      for (const f of flashPool.splice(0)) f.e.destroy();
    },
  };
}

/** Radius a zombie of `kind` is drawn and hit with (local tracers stop on it). */
export function zombieRadius(kind: number): number {
  return ZOMBIES[kind]?.radius ?? 0.42;
}
