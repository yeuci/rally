import { hexRgb, readMeshData, toLinear, type MeshData, type Rgb } from '@rally/game-kit';
import {
  BLEND_ADDITIVEALPHA,
  BLEND_NORMAL,
  Color,
  Entity,
  FILTER_LINEAR,
  FOG_LINEAR,
  Mat4,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  PRIMITIVE_TRIANGLES,
  Quat,
  StandardMaterial,
  Texture,
  Vec3,
  type Application,
  type GraphicsDevice,
} from 'playcanvas';
import {
  BARRICADES,
  GANTRY,
  GOO_RADIUS,
  Item,
  PALETTE,
  PROP_BOUNDS,
  ROCK_RADIUS,
  SAFE_CENTER,
  SOCKETS,
  TOWN_HALF,
  TRUCK,
  itemKind,
  type PropName,
  type Vec2,
} from '@rally/game-northdale-server';
import { createDog, createSurvivor, weaponName, type DogRig, type Survivor } from './characters.ts';
import { createHorde, type Horde } from './horde.ts';
import type { Sky } from './lighting.ts';
import type { Models } from './models.ts';
import { Batch, buildTown, type Town } from './townmesh.ts';

/**
 * Rendering only. Simulation coordinates (x east, y south) map to world (x, 0, y); the camera looks down at 58° from
 * the south and follows the local survivor with a lead toward the aim. One directional light (sun or moon) and the
 * ambient carry the time of day; fog bounds the view at night; lamps, windows, eyes and flashlights are emissive or
 * additive fakes (no dynamic lights, no shadow maps: blob shadows under everyone who moves).
 */
export const CAMERA_PITCH_DEG = 58;
export const CAMERA_FOV_DEG = 30;
export const VIEW_HALF_W = 10.5;
export const VIEW_HALF_H = 6.2;
export const CAMERA_LEAD = 2;
const PITCH = (CAMERA_PITCH_DEG * Math.PI) / 180;
const TAN_V = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
/** Gun height: tracers, flashes, the aim plane. */
const GUN_Y = 1.0;
const MAX_TRACERS = 40;
const MAX_BURSTS = 48;
const MAX_DECALS = 24;

/** Camera distance from its focus for a viewport `aspect` (width / height). */
export function cameraDistance(aspect: number): number {
  return Math.max(VIEW_HALF_W / (TAN_V * aspect), (VIEW_HALF_H * Math.sin(PITCH)) / TAN_V);
}

export interface PlayerPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  slot: number;
  life: number;
  gun: number;
  loaded: boolean;
  melee: number;
  carry: number;
  me: boolean;
  firing: boolean;
  swings: number;
  celebrating: boolean;
  visible: boolean;
}

export interface SceneOptions {
  /** Bursts, blood decals, camera shake. */
  effects: boolean;
  /** Light pools under the lamps. */
  pools: boolean;
}

export type Quality = 'low' | 'medium' | 'high';

export interface NorthdaleScene {
  focus(x: number, y: number, aim: Vec2 | null, snap?: boolean, lead?: Vec2): void;
  setPlayer(id: string, pose: PlayerPose): void;
  removePlayer(id: string): void;
  readonly horde: Horde;
  setDog(x: number, y: number, facing: number, state: number, speed: number, biting: boolean): void;
  /** The truck: where, which way, how far repaired (0…1), and whether its engine runs. */
  setTruck(x: number, y: number, yaw: number, repaired: boolean, running: boolean): void;
  setPickup(key: string, kind: number, x: number, y: number): void;
  setRock(key: string, x: number, y: number, h: number): void;
  setGoo(key: string, x: number, y: number): void;
  /** Barricade in socket `i` (tier 0 = none). */
  setBarricade(i: number, tier: number): void;
  /** Unopened loot near the survivor (sparkles). */
  setMarkers(list: readonly { x: number; y: number; special: boolean }[]): void;
  /** Remove pickups, rocks and goo not set since the last call. */
  prune(): void;
  /** A shot: the flash at the shooter's muzzle (or (x, y) at gun height) and a tracer to each ray's end. */
  shot(shooter: string | null, x: number, y: number, angle: number, ends: readonly number[], heavy: boolean): void;
  /** A melee swing: the arc in front, the swinger's arms play it (via their pose). */
  swing(x: number, y: number, angle: number, wide: boolean, hit: boolean): void;
  /** Blood: a burst and a stain on the street. */
  blood(x: number, y: number, amount: number): void;
  /** Where a rock will land (the brute's wind-up): a ring until it does. */
  telegraph(x: number, y: number, seconds: number): void;
  dust(x: number, y: number, r: number): void;
  shake(amount: number): void;
  setSky(sky: Sky, blood: boolean): void;
  /** The local survivor's flashlight (night only). */
  setFlashlight(x: number, y: number, angle: number, on: number): void;
  setQuality(q: Quality): void;
  /** Camera shake strength (the game setting, 0…1). */
  setShakeScale(k: number): void;
  /** The highway barricade is gone (the escape). */
  setGantryOpen(open: boolean): void;
  labelAnchor(id: string, out: { x: number; y: number }): boolean;
  toScreen(x: number, y: number, h: number, out: { x: number; y: number }): void;
  toGround(sx: number, sy: number): Vec2 | null;
  update(dt: number): void;
  setZoom(k: number): void;
  trim(): void;
  readonly drawnPlayers: number;
  readonly camera: Entity;
  readonly town: Town;
}

function material(color: Color, opts: { vertex?: boolean; gloss?: number } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = color;
  m.useMetalness = false;
  m.specular = new Color(0.05, 0.05, 0.05);
  m.gloss = opts.gloss ?? 0.25;
  if (opts.vertex) m.diffuseVertexColor = true;
  m.update();
  return m;
}

function glow(color: Color, opts: { additive?: boolean; opacity?: number; map?: Texture } = {}): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = new Color(0, 0, 0);
  m.emissive = color;
  if (opts.map) {
    m.opacityMap = opts.map;
    m.opacityMapChannel = 'a';
  }
  m.useLighting = false;
  m.blendType = opts.additive === false ? BLEND_NORMAL : BLEND_ADDITIVEALPHA;
  m.depthWrite = false;
  m.opacity = opts.opacity ?? 1;
  m.update();
  return m;
}

const rgb = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return new Color(r / 255, g / 255, b / 255);
};
const lin = (hex: string): Rgb => toLinear(hexRgb(hex));

/** The truck's lamps, one glow part in the pack: warm headlights at the nose (+z), red lamps at the back. */
function truckLights(device: GraphicsDevice, g: MeshData): Mesh {
  const front: number[] = [];
  const back: number[] = [];
  for (let t = 0; t < g.count; t += 3) {
    const z = (g.positions[t * 3 + 2]! + g.positions[t * 3 + 5]! + g.positions[t * 3 + 8]!) / 3;
    (z > 0 ? front : back).push(t, t + 1, t + 2);
  }
  const subset = (ids: number[]): MeshData => ({
    count: ids.length,
    positions: Float32Array.from(
      ids.flatMap((i) => [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!]),
    ),
    normals: Float32Array.from(ids.flatMap((i) => [g.normals[i * 3]!, g.normals[i * 3 + 1]!, g.normals[i * 3 + 2]!])),
    colors: new Uint8Array(ids.length * 4),
    uvs: null,
  });
  const b = new Batch();
  b.add(subset(front), new Mat4(), [255, 236, 190]);
  b.add(subset(back), new Mat4(), [255, 34, 24]);
  return b.build(device)!;
}

function canvasTexture(device: GraphicsDevice, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new Texture(device, {
    width: size,
    height: size,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
  });
  t.setSource(c);
  return t;
}

/** A flat quad on the ground, `w` × `l`, with uvs (centre at the origin, +z forward). */
function groundQuad(device: GraphicsDevice, w: number, l: number, z0 = -l / 2): Mesh {
  const m = new Mesh(device);
  m.setPositions([-w / 2, 0, z0, w / 2, 0, z0, w / 2, 0, z0 + l, -w / 2, 0, z0 + l]);
  m.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
  m.setNormals([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  m.setIndices([0, 2, 1, 0, 3, 2]);
  m.update(PRIMITIVE_TRIANGLES);
  m.incRefCount();
  return m;
}

interface Rig {
  survivor: Survivor;
  ring: Entity;
  blob: Entity;
  x: number;
  y: number;
  visible: boolean;
  life: number;
}

interface Effect {
  e: Entity;
  mat: StandardMaterial;
  age: number;
  life: number;
  live: boolean;
  vx: number;
  vy: number;
  vz: number;
  size: number;
}

export function createNorthdaleScene(
  app: Application,
  onResize: (fn: (w: number, h: number) => void) => void,
  models: Models,
  options: SceneOptions,
): NorthdaleScene {
  const device = app.graphicsDevice;
  app.scene.clusteredLightingEnabled = false;
  app.scene.ambientLight = new Color(0.5, 0.5, 0.56);
  const fog = app.scene.fog;
  fog.type = FOG_LINEAR;
  fog.color = new Color(0.6, 0.66, 0.74);
  fog.start = 55;
  fog.end = 150;
  let effects = options.effects;
  let shakeScale = 1;

  // --- camera and light -------------------------------------------------------------------------------------------
  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(0.55, 0.65, 0.78),
    fov: CAMERA_FOV_DEG,
    nearClip: 1,
    farClip: 110,
  });
  app.root.addChild(camera);
  let dist = 22;
  let zoom = 1;
  const focusAt = new Vec3();
  const focusWant = new Vec3();
  let focusSet = false;
  const frame = (w: number, h: number) => (dist = cameraDistance(w / Math.max(1, h)));
  frame(device.width, device.height);
  onResize(frame);
  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.95, 0.84),
    intensity: 1.2,
    castShadows: false,
  });
  sun.setEulerAngles(55, 30, 0);
  app.root.addChild(sun);

  // --- materials ----------------------------------------------------------------------------------------------------
  const vertexMat = material(new Color(1, 1, 1), { vertex: true, gloss: 0.3 });
  // Survivors and zombies glow faintly in their own colours at night (readable silhouettes in the dark).
  const charMat = material(new Color(1, 1, 1), { vertex: true, gloss: 0.3 });
  charMat.emissive = new Color(1, 1, 1);
  charMat.emissiveVertexColor = true;
  charMat.emissiveIntensity = 0.04;
  charMat.update();
  const zombieMat = charMat.clone();
  zombieMat.update();
  const town = buildTown(app, models, { lowfx: !options.pools });

  // --- shared shapes and textures -----------------------------------------------------------------------------------
  const soft = canvasTexture(device, 64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
  const ringTex = canvasTexture(device, 64, (g, s) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = s * 0.08;
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
    g.stroke();
  });
  const coneTex = canvasTexture(device, 128, (g, s) => {
    // A flashlight's beam on the ground: bright near the survivor, fading and widening away (+v = forward).
    const img = g.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const fwd = y / s;
        const side = Math.abs(x / s - 0.5) * 2;
        const width = 0.18 + fwd * 0.82;
        const edge = Math.max(0, 1 - side / width);
        const a = Math.pow(edge, 1.4) * (1 - fwd) ** 1.3 * Math.min(1, fwd * 6);
        const o = (y * s + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
  const disc = groundQuad(device, 1, 1);
  const shadowMat = new StandardMaterial();
  shadowMat.diffuse = new Color(0, 0, 0);
  shadowMat.opacityMap = soft;
  shadowMat.opacityMapChannel = 'a';
  shadowMat.opacity = 0.45;
  shadowMat.useLighting = false;
  shadowMat.blendType = BLEND_NORMAL;
  shadowMat.depthWrite = false;
  shadowMat.update();
  const blob = (size: number) => {
    const e = new Entity('blob');
    e.addComponent('render', { meshInstances: [new MeshInstance(disc, shadowMat)], castShadows: false });
    e.setLocalScale(size, 1, size);
    e.setLocalPosition(0, 0.15, 0);
    return e;
  };

  // --- survivors ----------------------------------------------------------------------------------------------------
  const teamMats = PALETTE.map((c) => glow(rgb(c), { map: ringTex, opacity: 0.9 }));
  const meRingMat = glow(new Color(1, 1, 1), { map: ringTex, opacity: 0.95 });
  const partMeshes: Record<number, Mesh> = {
    [Item.wheel]: models.props.Wheel.mesh,
    [Item.fuel]: models.props.Barrel.mesh,
  };
  const players = new Map<string, Rig>();
  let drawnPlayers = 0;
  function makePlayer(slot: number): Rig {
    const survivor = createSurvivor(app, models, slot, charMat, partMeshes);
    const ring = new Entity('ring');
    ring.addComponent('render', {
      meshInstances: [new MeshInstance(disc, teamMats[slot % teamMats.length]!)],
      castShadows: false,
    });
    ring.setLocalScale(1.5, 1, 1.5);
    ring.setLocalPosition(0, 0.16, 0);
    const b = blob(1.3);
    const holder = new Entity('holder');
    holder.addChild(b);
    holder.addChild(ring);
    survivor.root.addChild(holder);
    app.root.addChild(survivor.root);
    return { survivor, ring, blob: b, x: 0, y: 0, visible: true, life: 0 };
  }

  // --- the horde, the dog, the truck --------------------------------------------------------------------------------
  const horde = createHorde(app, models, zombieMat, false);
  let dog: DogRig | null = null;
  const dogBlob = blob(1.1);
  const truck = new Entity('truck');
  {
    const body = new Entity('truck-body');
    body.addComponent('render', {
      meshInstances: [new MeshInstance(models.props.Vehicle_Truck_Armored.mesh, vertexMat)],
      castShadows: false,
    });
    truck.addChild(body);
    const lightsMat = glow(new Color(1, 1, 1), { additive: false });
    lightsMat.emissiveVertexColor = true;
    lightsMat.emissiveIntensity = 0;
    lightsMat.update();
    const lights = new Entity('truck-lights');
    lights.addComponent('render', {
      meshInstances: [new MeshInstance(truckLights(device, models.props.Vehicle_Truck_Armored.glow!.data), lightsMat)],
      castShadows: false,
    });
    truck.addChild(lights);
    truck.addChild(blob(4.2));
    // Its headlight beams on the road (when it runs).
    const beams = new Entity('beams');
    beams.addComponent('render', {
      meshInstances: [
        new MeshInstance(groundQuad(device, 5, 14, 2.4), glow(new Color(1, 0.92, 0.7), { map: coneTex, opacity: 0 })),
      ],
      castShadows: false,
    });
    beams.setLocalPosition(0, 0.06, 0);
    truck.addChild(beams);
    // Cinder blocks under the front while it is broken down.
    const jack = new Batch();
    const cb = models.props.CinderBlock.data;
    const jm = new Mat4();
    for (const [x, z, h] of [
      [-0.9, 1.6, 0],
      [0.9, 1.6, 0],
      [-0.9, 1.6, 0.23],
      [0.9, 1.6, 0.23],
    ] as const) {
      jm.setTRS(new Vec3(x, h, z), new Quat(), new Vec3(1, 1, 1));
      jack.add(cb, jm);
    }
    const jackE = new Entity('jack');
    jackE.addComponent('render', {
      meshInstances: [new MeshInstance(jack.build(device)!, vertexMat)],
      castShadows: false,
    });
    truck.addChild(jackE);
    truck.setPosition(TRUCK.x, 0, TRUCK.y);
    truck.setEulerAngles(0, (TRUCK.yaw * 180) / Math.PI, 0);
    app.root.addChild(truck);
    (truck as Entity & { parts?: unknown }).parts = { body, lightsMat, beams, jackE };
  }
  const truckParts = (
    truck as Entity & { parts: { body: Entity; lightsMat: StandardMaterial; beams: Entity; jackE: Entity } }
  ).parts;

  // The safehouse beacon: a pale column of light you can see from across town at night.
  const beaconMat = glow(new Color(0.55, 0.85, 1), { opacity: 0 });
  const beacon = new Entity('beacon');
  {
    const m = new Mesh(device);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k < 2; k++) {
      const a = (k * Math.PI) / 2;
      const c = Math.cos(a) * 0.9;
      const s = Math.sin(a) * 0.9;
      const b = pos.length / 3;
      pos.push(-c, 0, -s, c, 0, s, c, 40, s, -c, 40, -s);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2);
    }
    m.setPositions(pos);
    m.setUvs(0, uv);
    m.setIndices(idx);
    m.update(PRIMITIVE_TRIANGLES);
    beaconMat.opacityMap = canvasTexture(device, 32, (g, sz) => {
      const grad = g.createLinearGradient(0, 0, sz, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, sz, sz);
    });
    beaconMat.update();
    beacon.addComponent('render', { meshInstances: [new MeshInstance(m, beaconMat)], castShadows: false });
    beacon.setPosition(SAFE_CENTER.x - 6, 0, SAFE_CENTER.y - 1);
    app.root.addChild(beacon);
  }

  // The highway barricade (hidden once the truck breaks through).
  const gantryBarricade = new Entity('gantry-barricade');
  {
    const b = new Batch();
    const m = new Mat4();
    for (const [dx, name] of [
      [-3.2, 'TrafficBarrier_2'],
      [-1.1, 'TrafficBarrier_2'],
      [1.0, 'TrafficBarrier_2'],
      [3.1, 'TrafficBarrier_2'],
    ] as const) {
      m.setTRS(new Vec3(GANTRY.x + dx, 0, -TOWN_HALF - 2.6), new Quat(), new Vec3(1, 1, 1));
      b.add(models.props[name as PropName].data, m);
    }
    gantryBarricade.addComponent('render', {
      meshInstances: [new MeshInstance(b.build(device)!, vertexMat)],
      castShadows: false,
    });
    app.root.addChild(gantryBarricade);
  }

  // --- pickups, barricades, rocks, goo, markers ----------------------------------------------------------------------
  const pickupMeshes = new Map<number, Mesh>();
  const tinted = (name: PropName, color: Rgb | undefined, m: Mat4) => {
    const b = new Batch();
    b.add(models.props[name].data, m, color);
    return b;
  };
  const crate = (w: number, h: number, d: number, side: Rgb, band?: Rgb) => {
    const b = new Batch();
    b.box(-w / 2, 0, -d / 2, w / 2, h, d / 2, side);
    if (band) b.box(-w / 2 - 0.01, h * 0.35, -d / 2 - 0.01, w / 2 + 0.01, h * 0.65, d / 2 + 0.01, band);
    return b;
  };
  const AMMO_BAND: Record<number, string> = {
    [Item.ammo_pistol]: '#f2c94c',
    [Item.ammo_smg]: '#4aa3ff',
    [Item.ammo_shells]: '#e8553b',
    [Item.ammo_rifle]: '#6fcf62',
  };
  const pickupMesh = (kind: number): Mesh => {
    let mesh = pickupMeshes.get(kind);
    if (mesh) return mesh;
    const k = itemKind(kind);
    const id = new Mat4();
    let b: Batch;
    if (k === 'gun' || k === 'melee') {
      const w = models.weapons[weaponName(kind)!];
      b = new Batch();
      const m = new Mat4().setTRS(
        new Vec3(0, 0.08, 0),
        new Quat().setFromEulerAngles(90, 0, 0),
        new Vec3(1.25, 1.25, 1.25),
      );
      const wm = new Batch();
      void wm;
      b.add({ ...readWeapon(w.mesh) }, m);
    } else if (kind === Item.wheel) {
      b = tinted(
        'Wheel',
        undefined,
        new Mat4().setTRS(new Vec3(0, 0.42, 0), new Quat().setFromEulerAngles(90, 0, 0), new Vec3(1.45, 1.45, 1.45)),
      );
    } else if (kind === Item.fuel) {
      b = tinted('Barrel', lin('#b8402e'), id);
      b.box(-0.36, 0.5, -0.36, 0.36, 0.66, 0.36, lin('#f2c230'));
    } else if (k === 'ammo') {
      b = crate(0.42, 0.26, 0.3, lin('#4b5232'), lin(AMMO_BAND[kind] ?? '#ffffff'));
    } else if (kind === Item.scrap) {
      b = new Batch();
      b.box(-0.25, 0, -0.1, 0.1, 0.12, 0.2, lin('#8a8f96'));
      b.box(-0.05, 0, -0.25, 0.28, 0.18, 0.05, lin('#6c7178'));
      b.box(-0.15, 0.12, -0.1, 0.15, 0.22, 0.1, lin('#a0a5ab'));
    } else if (kind === Item.bandage || kind === Item.medkit) {
      const s = kind === Item.medkit ? 1.3 : 0.8;
      b = crate(0.42 * s, 0.24 * s, 0.32 * s, lin('#f2f2ee'));
      b.box(-0.06 * s, 0.24 * s, -0.12 * s, 0.06 * s, 0.25 * s, 0.12 * s, lin('#d8322b'));
      b.box(-0.16 * s, 0.24 * s, -0.04 * s, 0.16 * s, 0.25 * s, 0.04 * s, lin('#d8322b'));
    } else if (kind === Item.armor) {
      b = crate(0.5, 0.18, 0.42, lin('#3a4a5c'), lin('#25303d'));
    } else {
      // Barricade kits: striped crates.
      b = crate(0.55, 0.3, 0.4, lin('#e8823a'), lin('#f4f1e8'));
    }
    mesh = b.build(device)!;
    mesh.incRefCount();
    pickupMeshes.set(kind, mesh);
    return mesh;
  };
  const partRingMat = glow(new Color(1, 0.78, 0.25), { map: ringTex, opacity: 0.9 });
  const itemRingMat = glow(new Color(0.9, 0.9, 0.8), { map: ringTex, opacity: 0.5 });
  const beamMat = glow(new Color(1, 0.8, 0.3), { opacity: 0.35, map: beaconMat.opacityMap! });
  interface Thing {
    e: Entity;
    seen: boolean;
    kind: number;
    spin: Entity;
  }
  const things = new Map<string, Thing>();
  const thing = (key: string, make: () => Thing): Thing => {
    let t = things.get(key);
    if (!t) things.set(key, (t = make()));
    t.seen = true;
    return t;
  };
  const rockMat = material(rgb('#8b8378'));
  const gooMat = glow(new Color(0.45, 0.85, 0.25), { additive: false, opacity: 0.55, map: soft });
  const markerMat = glow(new Color(1, 0.9, 0.5), { map: soft, opacity: 0.9 });
  const specialMarkerMat = glow(new Color(0.75, 0.55, 1), { map: soft, opacity: 0.95 });
  const markers: Entity[] = [];
  for (let i = 0; i < 14; i++) {
    const e = new Entity('marker');
    e.addComponent('render', { meshInstances: [new MeshInstance(disc, markerMat)], castShadows: false });
    e.enabled = false;
    app.root.addChild(e);
    markers.push(e);
  }
  const barricades: { tier: number; e: Entity | null; wobble: number }[] = SOCKETS.map(() => ({
    tier: 0,
    e: null,
    wobble: 0,
  }));
  const barricadeMesh = (i: number, tier: number): Mesh => {
    const s = SOCKETS[i]!;
    const b = new Batch();
    const m = new Mat4();
    const yaw = s.horizontal ? 0 : 90;
    const place = (name: PropName, along: number, h: number, ex = 0, ey = 0, ez = 0) => {
      const ax = s.horizontal ? along : 0;
      const az = s.horizontal ? 0 : along;
      m.setTRS(new Vec3(s.x + ax, h, s.y + az), new Quat().setFromEulerAngles(ex, yaw + ey, ez), new Vec3(1, 1, 1));
      b.add(models.props[name].data, m);
    };
    if (tier === 1) for (const a of [-1.02, 0, 1.02]) place('PlasticBarrier', a, 0);
    else if (tier === 2) for (const a of [-0.76, 0.76]) place('TrafficBarrier_1', a, 0);
    else if (tier === 3) {
      for (const a of [-1.0, 0, 1.0]) {
        place('Pallet', a, 0.45, 0, 90, 90);
        place('Pallet', a + 0.08, 1.33, 0, 90, 90);
      }
    } else {
      for (let row = 0; row < 5; row++)
        for (let k = 0; k < 6; k++) place('CinderBlock', -1.25 + k * 0.48 + (row % 2) * 0.12, row * 0.23);
    }
    return b.build(device)!;
  };

  // --- effects --------------------------------------------------------------------------------------------------------
  function pool(n: number, make: () => Effect): Effect[] {
    return Array.from({ length: n }, make);
  }
  function effectEntity(type: 'box' | 'sphere' | 'cylinder' | 'plane', mat: StandardMaterial): Effect {
    const e = new Entity();
    const m = mat.clone();
    m.update();
    e.addComponent('render', { type, material: m, castShadows: false, receiveShadows: false });
    e.enabled = false;
    app.root.addChild(e);
    return { e, mat: m, age: 0, life: 1, live: false, vx: 0, vy: 0, vz: 0, size: 1 };
  }
  const tracers = pool(MAX_TRACERS, () => effectEntity('box', glow(new Color(1, 0.86, 0.45))));
  const muzzles = pool(8, () => effectEntity('sphere', glow(new Color(1, 0.75, 0.3))));
  const bursts = pool(MAX_BURSTS, () => effectEntity('box', material(new Color(0.42, 0.03, 0.04))));
  const arcs = pool(6, () => effectEntity('plane', glow(new Color(1, 1, 0.92), { map: ringTex, opacity: 0.8 })));
  const rings = pool(6, () => effectEntity('plane', glow(new Color(1, 0.25, 0.15), { map: ringTex, opacity: 0.9 })));
  const dusts = pool(6, () => effectEntity('sphere', material(new Color(0.55, 0.5, 0.45))));
  const BLOOD = ['Blood_1', 'Blood_2', 'Blood_3'] as const;
  const bloodMat = material(new Color(1, 1, 1), { vertex: true, gloss: 0.6 });
  // A faint red of its own, so a splat still reads as blood (not a black hole) at night.
  bloodMat.emissive = new Color(0.16, 0.01, 0.01);
  bloodMat.update();
  const decals: { e: Entity; age: number; live: boolean; size: number; extent: number }[] = [];
  for (let i = 0; i < MAX_DECALS; i++) {
    const name = BLOOD[i % 3]!;
    const e = new Entity('blood');
    e.addComponent('render', {
      meshInstances: [new MeshInstance(models.props[name].mesh, bloodMat)],
      castShadows: false,
    });
    e.enabled = false;
    app.root.addChild(e);
    const [x0, z0, x1, z1] = PROP_BOUNDS[name];
    decals.push({ e, age: 0, live: false, size: 1, extent: Math.max(x1 - x0, z1 - z0) });
  }
  let decalNext = 0;
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

  // The local survivor's flashlight.
  const flashMat = glow(new Color(1, 0.95, 0.8), { map: coneTex, opacity: 0 });
  const flash = new Entity('flashlight');
  flash.addComponent('render', {
    meshInstances: [new MeshInstance(groundQuad(device, 7, 11, 0.1), flashMat)],
    castShadows: false,
  });
  app.root.addChild(flash);
  let flashQuality = 1;

  let shakeAmp = 0;
  let clock = 0;
  const camPos = new Vec3();
  const tmp = new Vec3();
  const ray0 = new Vec3();
  const ray1 = new Vec3();
  const muzzleAt = new Vec3();
  let night = 0;

  return {
    camera,
    town,
    horde,
    get drawnPlayers() {
      return drawnPlayers;
    },
    focus(x, y, aim, snap = false, lead) {
      const lx = lead ? lead.x : aim ? aim.x * CAMERA_LEAD : 0;
      const ly = lead ? lead.y : aim ? aim.y * CAMERA_LEAD * 0.7 : 0;
      focusWant.set(x + lx, 0, y + ly);
      if (snap || !focusSet) {
        focusAt.copy(focusWant);
        focusSet = true;
      }
    },
    setPlayer(id, v) {
      let r = players.get(id);
      if (!r) players.set(id, (r = makePlayer(v.slot)));
      r.survivor.setVisible(v.visible);
      r.visible = v.visible;
      if (!v.visible) return;
      r.x = v.x;
      r.y = v.y;
      r.life = v.life;
      r.survivor.root.setPosition(v.x, 0, v.y);
      if (v.life === 0)
        r.survivor.root.setEulerAngles(0, (Math.atan2(Math.cos(v.aim), Math.sin(v.aim)) * 180) / Math.PI, 0);
      const speed = Math.hypot(v.vx, v.vy);
      const back = speed > 0.3 && (v.vx * Math.cos(v.aim) + v.vy * Math.sin(v.aim)) / speed < -0.2;
      r.survivor.update({
        speed,
        back,
        life: v.life,
        gun: v.gun,
        loaded: v.loaded,
        melee: v.melee,
        carry: v.carry,
        firing: v.firing,
        swings: v.swings,
        celebrating: v.celebrating,
      });
      const mi = r.ring.render!.meshInstances[0]!;
      const want = v.me ? meRingMat : teamMats[v.slot % teamMats.length]!;
      if (mi.material !== want) mi.material = want;
      r.ring.enabled = v.life !== 2;
    },
    removePlayer(id) {
      const r = players.get(id);
      if (!r) return;
      r.survivor.destroy();
      players.delete(id);
    },
    setDog(x, y, facing, state, speed, biting) {
      if (!dog) {
        dog = createDog(app, models, charMat);
        dog.root.addChild(dogBlob);
      }
      dog.root.setPosition(x, 0, y);
      if (state !== 2) dog.root.setEulerAngles(0, (Math.atan2(Math.cos(facing), Math.sin(facing)) * 180) / Math.PI, 0);
      dog.update(state, speed, biting);
    },
    setTruck(x, y, yaw, repaired, running) {
      truck.setPosition(x, 0, y);
      truck.setEulerAngles(repaired ? 0 : -2.5, (yaw * 180) / Math.PI, 0);
      truckParts.jackE.enabled = !repaired;
      const k = running ? 1.6 : 0;
      if (truckParts.lightsMat.emissiveIntensity !== k) {
        truckParts.lightsMat.emissiveIntensity = k;
        truckParts.lightsMat.update();
      }
      const beam = truckParts.beams.render!.meshInstances[0]!.material as StandardMaterial;
      const op = running ? 0.55 : 0;
      if (beam.opacity !== op) {
        beam.opacity = op;
        beam.update();
      }
    },
    setPickup(key, kind, x, y) {
      const t = thing(`p${key}`, () => {
        const e = new Entity('pickup');
        const spin = new Entity('spin');
        spin.addComponent('render', {
          meshInstances: [new MeshInstance(pickupMesh(kind), vertexMat)],
          castShadows: false,
        });
        e.addChild(spin);
        const part = itemKind(kind) === 'part';
        const ring = new Entity('ring');
        ring.addComponent('render', {
          meshInstances: [new MeshInstance(disc, part ? partRingMat : itemRingMat)],
          castShadows: false,
        });
        ring.setLocalScale(part ? 2.2 : 1.1, 1, part ? 2.2 : 1.1);
        ring.setLocalPosition(0, 0.14, 0);
        e.addChild(ring);
        if (part) {
          // A column of light: parts are found from afar.
          const beam = new Entity('beam');
          beam.addComponent('render', {
            meshInstances: [
              beacon.render!.meshInstances[0]!.mesh
                ? new MeshInstance(beacon.render!.meshInstances[0]!.mesh, beamMat)
                : new MeshInstance(disc, beamMat),
            ],
            castShadows: false,
          });
          beam.setLocalScale(0.5, 0.35, 0.5);
          e.addChild(beam);
        }
        app.root.addChild(e);
        return { e, seen: true, kind, spin };
      });
      t.e.setPosition(x, 0.12, y);
      const k = itemKind(kind);
      if (k !== 'part') {
        t.spin.setLocalEulerAngles(0, clock * 70 + x * 30, 0);
        t.spin.setLocalPosition(0, 0.12 + Math.sin(clock * 3 + x) * 0.06, 0);
      }
    },
    setRock(key, x, y, h) {
      const t = thing(`r${key}`, () => {
        const e = new Entity('rock');
        const spin = new Entity('spin');
        spin.addComponent('render', { type: 'sphere', material: rockMat, castShadows: false });
        spin.setLocalScale(0.7, 0.55, 0.65);
        e.addChild(spin);
        app.root.addChild(e);
        return { e, seen: true, kind: 0, spin };
      });
      t.e.setPosition(x, h, y);
      t.spin.setLocalEulerAngles(clock * 400, clock * 200, 0);
    },
    setGoo(key, x, y) {
      const t = thing(`g${key}`, () => {
        const e = new Entity('goo');
        const spin = new Entity('spin');
        spin.addComponent('render', { meshInstances: [new MeshInstance(disc, gooMat)], castShadows: false });
        spin.setLocalScale(GOO_RADIUS * 2.2, 1, GOO_RADIUS * 2.2);
        e.addChild(spin);
        app.root.addChild(e);
        return { e, seen: true, kind: 0, spin };
      });
      t.e.setPosition(x, 0.13, y);
    },
    setBarricade(i, tier) {
      const b = barricades[i];
      if (!b || b.tier === tier) return;
      b.e?.destroy();
      b.e = null;
      b.tier = tier;
      if (tier > 0 && tier <= BARRICADES.length) {
        const e = new Entity('barricade');
        e.addComponent('render', {
          meshInstances: [new MeshInstance(barricadeMesh(i, tier), vertexMat)],
          castShadows: false,
        });
        app.root.addChild(e);
        b.e = e;
        this.dust(SOCKETS[i]!.x, SOCKETS[i]!.y, 1.2);
      }
    },
    setMarkers(list) {
      markers.forEach((m, i) => {
        const p = list[i];
        m.enabled = !!p;
        if (!p) return;
        const s = 0.55 + Math.sin(clock * 4 + i) * 0.12;
        m.setPosition(p.x, 1.1 + Math.sin(clock * 2.5 + i) * 0.12, p.y);
        m.setLocalScale(s, 1, s);
        m.setEulerAngles(90 - CAMERA_PITCH_DEG, 0, 0);
        const mi = m.render!.meshInstances[0]!;
        const want = p.special ? specialMarkerMat : markerMat;
        if (mi.material !== want) mi.material = want;
      });
    },
    prune() {
      for (const [key, t] of things) {
        if (t.seen) {
          t.seen = false;
          continue;
        }
        t.e.destroy();
        things.delete(key);
      }
    },
    shot(shooter, x, y, angle, ends, heavy) {
      const r = shooter ? players.get(shooter) : undefined;
      const from = r?.survivor.muzzle(muzzleAt)
        ? muzzleAt
        : tmp.set(x + Math.cos(angle) * 0.7, GUN_Y, y + Math.sin(angle) * 0.7);
      const f = take(muzzles);
      start(f, 0.05);
      f.size = heavy ? 0.55 : 0.35;
      f.e.setPosition(from.x, from.y, from.z);
      f.e.setLocalScale(f.size, f.size, f.size);
      for (let i = 0; i + 1 < ends.length; i += 2) {
        const ex = ends[i]!;
        const ey = ends[i + 1]!;
        const len = Math.hypot(ex - from.x, ey - from.z);
        if (len < 0.1) continue;
        const t = take(tracers);
        start(t, heavy ? 0.08 : 0.06);
        t.e.setPosition((from.x + ex) / 2, (from.y + GUN_Y) / 2, (from.z + ey) / 2);
        t.e.setEulerAngles(0, (Math.atan2(ex - from.x, ey - from.z) * 180) / Math.PI, 0);
        t.size = heavy ? 0.06 : 0.04;
        t.e.setLocalScale(t.size, t.size, len);
      }
    },
    swing(x, y, angle, wide, hit) {
      const f = take(arcs);
      start(f, 0.16);
      f.size = wide ? 3.6 : 2.4;
      f.e.setPosition(x + Math.cos(angle) * 0.6, 0.9, y + Math.sin(angle) * 0.6);
      f.e.setEulerAngles(0, (Math.atan2(Math.cos(angle), Math.sin(angle)) * 180) / Math.PI, 0);
      f.mat.emissive = hit ? new Color(1, 0.6, 0.45) : new Color(1, 1, 0.92);
      f.mat.update();
    },
    blood(x, y, amount) {
      if (effects) {
        const n = amount >= 1 ? 6 : 2;
        for (let i = 0; i < n; i++) {
          const b = take(bursts);
          start(b, 0.5);
          const a = Math.random() * Math.PI * 2;
          const sp = 1.5 + Math.random() * 2.5;
          b.vx = Math.cos(a) * sp;
          b.vz = Math.sin(a) * sp;
          b.vy = 3 + Math.random() * 2;
          b.size = 0.09 + Math.random() * 0.06;
          b.e.setPosition(x, 0.9, y);
          b.e.setLocalScale(b.size, b.size, b.size);
        }
      }
      if (amount >= 1 && effects) {
        const d = decals[decalNext++ % decals.length]!;
        d.live = true;
        d.age = 0;
        // A splat 0.9–1.4 units across, whichever of the three meshes it is.
        d.size = (0.9 + Math.random() * 0.5) / d.extent;
        d.e.enabled = true;
        d.e.setPosition(x, 0.13 + (decalNext % 7) * 0.002, y);
        d.e.setEulerAngles(0, Math.random() * 360, 0);
        d.e.setLocalScale(d.size, 1, d.size);
      }
    },
    telegraph(x, y, seconds) {
      const f = take(rings);
      start(f, seconds);
      f.size = ROCK_RADIUS * 2;
      f.e.setPosition(x, 0.15, y);
    },
    dust(x, y, r) {
      const f = take(dusts);
      start(f, 0.5);
      f.size = r;
      f.e.setPosition(x, 0.4, y);
    },
    shake(amount) {
      if (!effects) return;
      shakeAmp = Math.min(0.8, Math.max(shakeAmp, amount * shakeScale));
    },
    setSky(sky, blood) {
      night = sky.night;
      app.scene.ambientLight.set(sky.ambient[0], sky.ambient[1], sky.ambient[2]);
      const l = sun.light!;
      l.color = new Color(sky.sun[0], sky.sun[1], sky.sun[2]);
      l.intensity = sky.sunIntensity;
      sun.setEulerAngles(sky.sunPitch, sky.sunYaw, 0);
      fog.color.set(sky.fog[0], sky.fog[1], sky.fog[2]);
      fog.start = sky.fogStart;
      fog.end = sky.fogEnd;
      camera.camera!.clearColor = new Color(sky.sky[0], sky.sky[1], sky.sky[2]);
      town.setNight(sky.night, sky.flicker ? 1 : 0);
      horde.setNight(sky.night);
      const glowK = Math.round(sky.night * 20) / 20;
      const want = 0.04 + glowK * 0.22;
      if (Math.abs(charMat.emissiveIntensity - want) > 1e-3) {
        charMat.emissiveIntensity = want;
        charMat.update();
      }
      const beaconOp = (Math.round(sky.night * 20) / 20) * (blood ? 0.25 : 0.4);
      if (beaconMat.opacity !== beaconOp) {
        beaconMat.opacity = beaconOp;
        beaconMat.emissive = blood ? new Color(1, 0.4, 0.35) : new Color(0.55, 0.85, 1);
        beaconMat.update();
      }
    },
    setFlashlight(x, y, angle, on) {
      const op = (Math.round(on * 20) / 20) * (0.55 + 0.25 * flashQuality);
      if (flashMat.opacity !== op) {
        flashMat.opacity = op;
        flashMat.update();
      }
      flash.enabled = op > 0.01;
      flash.setPosition(x, 0.07, y);
      flash.setEulerAngles(0, (Math.atan2(Math.cos(angle), Math.sin(angle)) * 180) / Math.PI, 0);
      const s = 0.85 + 0.15 * flashQuality;
      flash.setLocalScale(s, 1, s);
    },
    setQuality(q) {
      effects = options.effects && q !== 'low';
      flashQuality = q === 'low' ? 0 : q === 'medium' ? 0.6 : 1;
      camera.camera!.farClip = q === 'low' ? 75 : 110;
    },
    setShakeScale(k) {
      shakeScale = Math.max(0, Math.min(1, k));
    },
    setGantryOpen(open) {
      gantryBarricade.enabled = !open;
    },
    labelAnchor(id, out) {
      const r = players.get(id);
      if (!r || !r.visible) return false;
      tmp.set(r.x, r.life === 0 ? 2.05 : 0.9, r.y);
      camera.camera!.worldToScreen(tmp, ray0);
      out.x = ray0.x;
      out.y = ray0.y;
      return ray0.z > 0;
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
      const t = (GUN_Y - ray0.y) / dy;
      if (t < 0) return null;
      return { x: ray0.x + (ray1.x - ray0.x) * t, y: ray0.z + (ray1.z - ray0.z) * t };
    },
    update(dt) {
      clock += dt;
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
      } else shakeAmp = 0;
      camera.setPosition(camPos);
      camera.lookAt(focusAt.x, 0, focusAt.z);
      town.update(focusAt.x, focusAt.z, dt);
      drawnPlayers = 0;
      for (const r of players.values()) if (r.visible) drawnPlayers++;
      // Effects.
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
      for (const f of arcs) {
        if (!f.live) continue;
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        const s = f.size * (0.6 + 0.4 * u);
        f.e.setLocalScale(s, 1, s * 0.6);
        f.mat.opacity = 0.8 * (1 - u);
        f.mat.update();
      }
      for (const f of rings) {
        if (!f.live) continue;
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        const s = f.size * (1.3 - 0.3 * u);
        f.e.setLocalScale(s, 1, s);
        f.mat.opacity = 0.5 + 0.5 * Math.abs(Math.sin(clock * 14));
        f.mat.update();
      }
      for (const f of dusts) {
        if (!f.live) continue;
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        const s = f.size * (0.5 + u);
        f.e.setLocalScale(s, s * 0.5, s);
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
        const yy = Math.max(0.15, p.y + f.vy * dt);
        f.e.setPosition(p.x + f.vx * dt, yy, p.z + f.vz * dt);
        if (yy <= 0.15) {
          f.vx *= 0.6;
          f.vz *= 0.6;
        }
      }
      // Blood stains shrink away after a while.
      for (const dd of decals) {
        if (!dd.live) continue;
        dd.age += dt;
        const fade = Math.max(0, dd.age - 14) / 3;
        if (fade >= 1) {
          dd.live = false;
          dd.e.enabled = false;
          continue;
        }
        const s = dd.size * (1 - fade);
        dd.e.setLocalScale(s, 1, s);
      }
      for (const b of barricades) {
        if (b.e && b.wobble > 0) b.wobble = Math.max(0, b.wobble - dt);
      }
      void night;
    },
    setZoom(kz) {
      zoom = kz;
    },
    trim() {
      for (const list of [tracers, muzzles, bursts, arcs, rings, dusts]) {
        for (const f of list) {
          f.live = false;
          f.e.enabled = false;
        }
      }
      horde.trim();
    },
  };
}

/** A weapon mesh's vertex data (pickups lying on the street draw the same model as the hand). */
function readWeapon(mesh: Mesh) {
  return readMeshDataCached(mesh);
}
const weaponData = new WeakMap<Mesh, MeshData>();
function readMeshDataCached(mesh: Mesh) {
  let d = weaponData.get(mesh);
  if (!d) weaponData.set(mesh, (d = readMeshData(mesh)));
  return d;
}
