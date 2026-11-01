import { MeshMerger, linearByte, type MeshData } from '@rally/game-kit';
import {
  ADDRESS_CLAMP_TO_EDGE,
  CULLFACE_NONE,
  Color,
  Entity,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  Mat4,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  Quat,
  StandardMaterial,
  Texture,
  Vec3,
  type Application,
} from 'playcanvas';
import {
  AREAS,
  BACK_Y,
  CHAIR_OFFSET,
  COUNTER_TOP,
  ISLAND_Y,
  PLACEMENTS,
  SEATS,
  STATIONS,
  TABLES,
  Zone,
  type Placement,
} from '@rally/game-sushi-server';
import { barMesh, beltMesh, beltTexture, BELT_TILE } from './belt.ts';
import type { Models, PropModel } from './models.ts';

/**
 * The restaurant, drawn: the static props (map.ts `PLACEMENTS`, the stools, tables and chairs, the crates) batched into
 * one vertex-coloured mesh per zone (the main room always; the dining room, the alley and the terrace shown when they
 * open), the shoji screens and the back door as their own entities (they slide away / disappear), the floor painted on
 * a canvas (warm wood planks, the kitchen's tiles, the alley's asphalt, the terrace's paving), the bar and its belt.
 */

/** The floor canvas covers this rectangle (sim units). */
const FLOOR = { x0: -14, y0: -7, x1: 16, y1: 12 } as const;
const PPU = 40;

const C = {
  street: '#3a302b',
  wood: '#d9a86a',
  woodDark: '#c48f55',
  seam: 'rgba(110, 66, 30, 0.35)',
  tileA: '#efe2c8',
  tileB: '#dccaa6',
  asphalt: '#4a4644',
  paver: '#b9ab97',
  grass: '#7aa35a',
};

/** The floor: planks for the dining floors, tiles behind the bar, asphalt in the alley, paving on the terrace. */
export function floorCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = (FLOOR.x1 - FLOOR.x0) * PPU;
  c.height = (FLOOR.y1 - FLOOR.y0) * PPU;
  const g = c.getContext('2d');
  if (!g) return c;
  const X = (x: number) => (x - FLOOR.x0) * PPU;
  const Y = (y: number) => (y - FLOOR.y0) * PPU;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.fillStyle = C.street;
  g.fillRect(0, 0, c.width, c.height);
  // Street cobbles.
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'}, ${0.04 + rnd() * 0.05})`;
    g.fillRect(rnd() * c.width, rnd() * c.height, 10 + rnd() * 16, 8 + rnd() * 10);
  }
  const planks = (x0: number, y0: number, x1: number, y1: number, tone: string) => {
    g.fillStyle = tone;
    g.fillRect(X(x0), Y(y0), (x1 - x0) * PPU, (y1 - y0) * PPU);
    // Boards run left to right, 0.5 wide, staggered joints.
    const w = 0.5;
    for (let y = y0, row = 0; y < y1; y += w, row++) {
      g.fillStyle = row % 2 ? 'rgba(255,240,210,0.07)' : 'rgba(90,50,20,0.06)';
      g.fillRect(X(x0), Y(y), (x1 - x0) * PPU, w * PPU);
      g.fillStyle = C.seam;
      g.fillRect(X(x0), Y(y), (x1 - x0) * PPU, 1.5);
      const len = 2 + (row % 3) * 0.7;
      for (let x = x0 + ((row * 1.3) % len); x < x1; x += len) g.fillRect(X(x), Y(y), 1.5, w * PPU);
      // Grain.
      for (let k = 0; k < (x1 - x0) * 1.5; k++) {
        g.fillStyle = `rgba(120,70,30,${0.05 + rnd() * 0.06})`;
        g.fillRect(X(x0 + rnd() * (x1 - x0)), Y(y + 0.08 + rnd() * (w - 0.16)), 6 + rnd() * 18, 1);
      }
    }
  };
  // The main room and the dining room: wood. Behind the bar: kitchen tiles.
  planks(AREAS.main.x0, AREAS.main.y0, AREAS.main.x1, AREAS.main.y1, C.wood);
  planks(AREAS.dining.x0, AREAS.dining.y0, AREAS.dining.x1, AREAS.dining.y1, C.woodDark);
  const t = 0.5;
  for (let y = AREAS.main.y0; y < -1.6; y += t) {
    for (let x = AREAS.main.x0; x < AREAS.main.x1; x += t) {
      g.fillStyle = (Math.round((x + y) / t) & 1) === 0 ? C.tileA : C.tileB;
      g.fillRect(X(x), Y(y), t * PPU + 0.5, t * PPU + 0.5);
    }
  }
  g.fillStyle = 'rgba(120, 80, 40, 0.5)';
  g.fillRect(X(AREAS.main.x0), Y(-1.6), (AREAS.main.x1 - AREAS.main.x0) * PPU, 3);
  // The alley: asphalt, a drain line.
  g.fillStyle = C.asphalt;
  g.fillRect(X(AREAS.alley.x0), Y(AREAS.alley.y0), (AREAS.alley.x1 - AREAS.alley.x0) * PPU, 8.5 * PPU);
  g.fillStyle = 'rgba(0, 0, 0, 0.25)';
  g.fillRect(X(AREAS.alley.x0 + 0.4), Y(AREAS.alley.y0), 0.12 * PPU, 8.5 * PPU);
  // The terrace: paving stones with grass at the sides.
  const ty = AREAS.terrace.y0;
  g.fillStyle = C.grass;
  g.fillRect(X(-8), Y(ty), 16 * PPU, 6 * PPU);
  for (let y = ty; y < AREAS.terrace.y1 + 0.2; y += 0.6) {
    for (let x = -6 + ((y * 1.7) % 0.6); x < 6; x += 0.6) {
      g.fillStyle = rnd() < 0.5 ? C.paver : '#c8bba6';
      g.fillRect(X(x) + 2, Y(y) + 2, 0.6 * PPU - 4, 0.6 * PPU - 4);
    }
  }
  // The doormat line at the entrance.
  g.fillStyle = '#7b3a2a';
  g.fillRect(X(-1.1), Y(AREAS.main.y1 - 0.25), 2.2 * PPU, 0.25 * PPU);
  return c;
}

/** A wooden crate as mesh data (non-indexed, flat), `w × h × d` on the origin, top open-looking with dark slats. */
function crateData(w: number, h: number, d: number): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const wood = [linearByte(186), linearByte(132), linearByte(78), 255];
  const dark = [linearByte(120), linearByte(80), linearByte(44), 255];
  const face = (corners: number[][], n: number[], color: number[]) => {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(...corners[k]!);
      nrm.push(...n);
      col.push(...color);
    }
  };
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  face(
    [
      [x0, 0, z1],
      [x1, 0, z1],
      [x1, h, z1],
      [x0, h, z1],
    ],
    [0, 0, 1],
    wood,
  );
  face(
    [
      [x1, 0, z0],
      [x0, 0, z0],
      [x0, h, z0],
      [x1, h, z0],
    ],
    [0, 0, -1],
    wood,
  );
  face(
    [
      [x0, 0, z0],
      [x0, 0, z1],
      [x0, h, z1],
      [x0, h, z0],
    ],
    [-1, 0, 0],
    wood,
  );
  face(
    [
      [x1, 0, z1],
      [x1, 0, z0],
      [x1, h, z0],
      [x1, h, z1],
    ],
    [1, 0, 0],
    wood,
  );
  face(
    [
      [x0, h, z1],
      [x1, h, z1],
      [x1, h, z0],
      [x0, h, z0],
    ],
    [0, 1, 0],
    dark,
  );
  // A slat across the front.
  face(
    [
      [x0, h * 0.45, z1 + 0.005],
      [x1, h * 0.45, z1 + 0.005],
      [x1, h * 0.62, z1 + 0.005],
      [x0, h * 0.62, z1 + 0.005],
    ],
    [0, 0, 1],
    dark,
  );
  const count = pos.length / 3;
  return {
    count,
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    colors: Uint8Array.from(col),
    uvs: null,
  };
}

/** World matrix of a placement (sim x, y → world x, h, z; yaw in degrees). */
export function placementMatrix(p: Pick<Placement, 'x' | 'y' | 'rot' | 'h' | 'scale'>): Mat4 {
  const s = p.scale ?? 1;
  return new Mat4().setTRS(
    new Vec3(p.x, p.h ?? 0, p.y),
    new Quat().setFromEulerAngles(0, p.rot ?? 0, 0),
    new Vec3(s, s, s),
  );
}

export interface Level {
  /** The batched props per zone (0 = always). */
  zones: Map<number, Entity>;
  /** The shoji screens (slide toward the back when the dining room opens) and the back door. */
  screens: Entity[];
  backDoor: Entity | null;
  belt: { entity: Entity; material: StandardMaterial };
  triangles: number;
  /** Show what is open; `t` 0…1 slides the screens (1 = open). */
  setZones(zones: number, slide: number): void;
  /** Scroll the belt's slats to its offset (units). */
  setBelt(s: number): void;
}

const ZONE_KEYS = [0, Zone.dining, Zone.alley, Zone.terrace] as const;

export function buildLevel(app: Application, models: Models, vertexMat: StandardMaterial, shadows: boolean): Level {
  const device = app.graphicsDevice;
  const mergers = new Map<number, MeshMerger>(ZONE_KEYS.map((z) => [z, new MeshMerger()]));
  const add = (zone: number, prop: PropModel, m: Mat4) => mergers.get(zone)!.add(models.props[prop].data, m);
  const screens: Entity[] = [];
  let backDoor: Entity | null = null;
  const single = (prop: PropModel, p: Placement) => {
    const e = new Entity(prop);
    e.addComponent('render', {
      meshInstances: [new MeshInstance(models.props[prop].mesh, vertexMat)],
      castShadows: shadows,
      receiveShadows: true,
    });
    const m = placementMatrix(p);
    e.setPosition(m.getTranslation());
    e.setEulerAngles(0, p.rot ?? 0, 0);
    app.root.addChild(e);
    return e;
  };
  for (const p of PLACEMENTS) {
    if (p.unless) {
      const e = single(p.prop as PropModel, p);
      if (p.unless === Zone.dining) screens.push(e);
      else backDoor = e;
      continue;
    }
    add(p.zone ?? 0, p.prop as PropModel, placementMatrix(p));
  }
  // Seating: every stool round the bar; tables with a chair each side (in their zones).
  for (const s of SEATS) {
    if (s.kind === 'stool') add(0, 'Stool', placementMatrix({ x: s.x, y: s.y }));
    else {
      const rot = (Math.atan2(Math.cos(s.face), Math.sin(s.face)) * 180) / Math.PI;
      add(s.zone, 'Chair2', placementMatrix({ x: s.x, y: s.y, rot }));
    }
  }
  for (const t of TABLES) add(t.zone, 'Table', placementMatrix({ x: t.x, y: t.y }));
  void CHAIR_OFFSET;
  // Crates on the counters (their ingredient is drawn on top by the scene, since it depends on the day).
  const crate = crateData(0.44, 0.2, 0.62);
  for (const s of STATIONS) {
    if (s.type !== 'crate') continue;
    const m = new Mat4().setTranslate(s.x, COUNTER_TOP, s.y);
    mergers.get(0)!.add(crate, m);
  }

  const levelMat = vertexMat.clone();
  levelMat.cull = CULLFACE_NONE;
  levelMat.update();
  const zones = new Map<number, Entity>();
  let triangles = 0;
  for (const [zone, merger] of mergers) {
    const mesh = merger.build(device);
    if (!mesh) continue;
    triangles += merger.vertexCount / 3;
    const e = new Entity(`zone-${zone}`);
    e.addComponent('render', {
      meshInstances: [new MeshInstance(mesh, levelMat)],
      castShadows: shadows,
      receiveShadows: true,
    });
    app.root.addChild(e);
    zones.set(zone, e);
  }

  // The floor.
  const floorTex = new Texture(device, {
    name: 'floor',
    format: PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    anisotropy: 4,
  });
  floorTex.setSource(floorCanvas());
  const floorMat = new StandardMaterial();
  floorMat.diffuseMap = floorTex;
  floorMat.useMetalness = false;
  floorMat.specular = new Color(0.05, 0.04, 0.03);
  floorMat.gloss = 0.25;
  floorMat.update();
  const floor = new Entity('floor');
  floor.addComponent('render', { type: 'plane', material: floorMat, castShadows: false, receiveShadows: true });
  floor.setLocalScale(FLOOR.x1 - FLOOR.x0, 1, FLOOR.y1 - FLOOR.y0);
  floor.setPosition((FLOOR.x0 + FLOOR.x1) / 2, 0, (FLOOR.y0 + FLOOR.y1) / 2);
  app.root.addChild(floor);

  // The bar and its belt.
  const bar = new Entity('bar');
  bar.addComponent('render', {
    meshInstances: [new MeshInstance(barMesh(device), levelMat)],
    castShadows: shadows,
    receiveShadows: true,
  });
  app.root.addChild(bar);
  const beltMat = new StandardMaterial();
  beltMat.diffuseMap = beltTexture(device);
  beltMat.useMetalness = false;
  beltMat.specular = new Color(0.35, 0.35, 0.35);
  beltMat.gloss = 0.55;
  beltMat.update();
  const belt = new Entity('belt');
  belt.addComponent('render', {
    meshInstances: [new MeshInstance(beltMesh(device), beltMat)],
    castShadows: false,
    receiveShadows: true,
  });
  app.root.addChild(belt);

  const screenHome = screens.map((e) => e.getPosition().clone());
  void BACK_Y;
  void ISLAND_Y;
  return {
    zones,
    screens,
    backDoor,
    belt: { entity: belt, material: beltMat },
    triangles,
    setZones(open, slide) {
      for (const [zone, e] of zones) e.enabled = zone === 0 || (open & zone) !== 0;
      // The screens slide back along the wall, stacking at the back corner, then vanish.
      screens.forEach((e, i) => {
        const home = screenHome[i]!;
        const k = open & Zone.dining ? slide : 0;
        e.setPosition(home.x, home.y, home.z + (-6.2 - home.z) * k * 0.92);
        e.enabled = k < 0.999;
      });
      if (backDoor) backDoor.enabled = (open & Zone.alley) === 0;
    },
    setBelt(s) {
      beltMat.diffuseMapOffset.set(-s / BELT_TILE, 0);
      beltMat.update();
    },
  };
}
