import { hexRgb } from '@rally/game-kit';
import {
  BLEND_ADDITIVEALPHA,
  BLEND_NORMAL,
  Color,
  Entity,
  MeshInstance,
  SHADOW_PCF1_32F,
  StandardMaterial,
  Vec3,
  type Application,
} from 'playcanvas';
import {
  AREAS,
  BELT_LENGTH,
  BELT_SLOTS,
  BELT_TOP,
  COUNTER_TOP,
  CRATE_DAY,
  Cook,
  Kind,
  Pan,
  SEATS,
  SEAT_TARGET,
  SLOT_TARGET,
  STATIONS,
  Zone,
  beltPoint,
  decodeItem,
  matItems,
  stationType,
  type Item,
  type StationStateView,
  type WorldView,
} from '@rally/game-sushi-server';
import { KIND_MODEL, kindSize } from './catalog.ts';
import {
  SLOT_COLORS,
  createChef,
  createCustomer,
  itemEntity,
  type ChefRig,
  type CustomerMood,
  type CustomerRig,
} from './characters.ts';
import { buildLevel, type Level } from './level.ts';
import type { Models, PropModel } from './models.ts';

/**
 * Rendering only. Sim coordinates (x right, y toward the camera) map to world (x, height, y). A fixed three-quarter
 * camera from the dining side frames everything that is open (it eases back as the restaurant grows), the warm light
 * of the pack's preview, the restaurant (level.ts), and everything that changes: what sits on each station, the plates
 * riding the belt (wilting grey as they go stale), dishes and dirty plates at the seats, chefs and customers, the
 * highlight on the station a press would use, steam, smoke and sparkles.
 */

const CLEAR = new Color(0.17, 0.11, 0.08);
const PITCH_DEG = 50;
const FOV_DEG = 32;
/** Room for the HUD: fraction of the screen kept free at the top and bottom of the framing. */
const MARGIN_TOP = 0.09;
const MARGIN_BOTTOM = 0.04;
const MARGIN_SIDE = 0.02;

export interface SceneOptions {
  shadows?: boolean;
  /** Steam, smoke and sparkles. */
  effects?: boolean;
  /** Customers cast shadows (high quality only). */
  crowdShadows?: boolean;
}

export interface ChefView {
  x: number;
  y: number;
  face: number;
  slot: number;
  held: Item | null;
  act: number;
  speed: number;
  cheer: boolean;
  me: boolean;
}

export interface CustomerPose {
  x: number;
  y: number;
  face: number;
  look: number;
  vip: boolean;
  mood: CustomerMood;
  waving: boolean;
}

export interface SushiScene {
  /** Frame the open zones (eases there unless `snap`). */
  frame(zones: number, snap?: boolean): void;
  /** Frame a box instead (store art close-ups), at once. */
  frameBox(box: { x0: number; y0: number; x1: number; y1: number }): void;
  setZones(zones: number): void;
  setStation(id: number, view: StationStateView, world: WorldView): void;
  setBelt(beltS: number, slots: readonly { item: Item | null; stale: boolean; age: number }[]): void;
  setSeat(id: number, dirty: number, eating: Kind): void;
  setChef(id: string, v: ChefView): void;
  removeChef(id: string): void;
  setCustomer(id: string, v: CustomerPose): void;
  removeCustomer(id: string): void;
  /** The target a press would use (-1: none). */
  highlight(target: number, beltS: number): void;
  sparkle(x: number, y: number, h: number, color: string): void;
  puff(x: number, y: number, h: number, kind: 'steam' | 'smoke'): void;
  /** Screen position (CSS px) of a world point (sim x, y at height h); false when behind the camera. */
  toScreen(x: number, y: number, h: number, out: { x: number; y: number }): boolean;
  update(dt: number): void;
  trim(): void;
  setQuality(o: { shadows: boolean; effects: boolean; crowdShadows: boolean }): void;
  readonly camera: Entity;
  readonly level: Level;
  readonly drawnChefs: number;
  readonly drawnCustomers: number;
}

function glow(color: Color, opacity = 1, additive = true): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = new Color(0, 0, 0);
  m.emissive = color;
  m.useLighting = false;
  m.blendType = additive ? BLEND_ADDITIVEALPHA : BLEND_NORMAL;
  m.depthWrite = false;
  m.opacity = opacity;
  m.update();
  return m;
}

const rgb = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return new Color(r / 255, g / 255, b / 255);
};

/** Sim angle → PlayCanvas yaw (degrees) that turns a model's front (+z) that way. */
export const yawOf = (a: number) => (Math.atan2(Math.cos(a), Math.sin(a)) * 180) / Math.PI;

/** The camera distance and target that frame a box (sim units, with walls `wallH` tall at its back) on screen. */
export function frameBox(
  box: { x0: number; y0: number; x1: number; y1: number },
  aspect: number,
  wallH = 2.6,
): { tx: number; tz: number; d: number } {
  const P = (PITCH_DEG * Math.PI) / 180;
  const tanV = Math.tan((FOV_DEG * Math.PI) / 360);
  const tanH = tanV * aspect;
  const corners: [number, number, number][] = [];
  for (const x of [box.x0, box.x1]) {
    corners.push([x, 0, box.y0], [x, wallH, box.y0], [x, 0, box.y1], [x, 0.9, box.y1]);
  }
  const project = (tx: number, tz: number, d: number) => {
    const cy = Math.sin(P) * d;
    const cz = tz + Math.cos(P) * d;
    let ok = true;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const [x, h, z] of corners) {
      const rx = x - tx;
      const ry = h - cy;
      const rz = z - cz;
      const depth = -ry * Math.sin(P) - rz * Math.cos(P);
      const up = ry * Math.cos(P) - rz * Math.sin(P);
      if (depth <= 0.1) return { ok: false, ymin, ymax };
      const nx = rx / (depth * tanH);
      const ny = up / (depth * tanV);
      if (Math.abs(nx) > 1 - MARGIN_SIDE) ok = false;
      ymin = Math.min(ymin, ny);
      ymax = Math.max(ymax, ny);
    }
    const fits = ok && ymax <= 1 - MARGIN_TOP * 2 && ymin >= -1 + MARGIN_BOTTOM * 2;
    return { ok: fits, ymin, ymax };
  };
  const tx = (box.x0 + box.x1) / 2;
  let tz = (box.y0 + box.y1) / 2;
  let d = 20;
  for (let iter = 0; iter < 4; iter++) {
    let lo = 4;
    let hi = 80;
    for (let k = 0; k < 28; k++) {
      const mid = (lo + hi) / 2;
      if (project(tx, tz, mid).ok) hi = mid;
      else lo = mid;
    }
    d = hi;
    // Centre vertically inside the margins: move the target along z by the NDC imbalance.
    const r = project(tx, tz, d);
    const want = (1 - MARGIN_TOP * 2 + (-1 + MARGIN_BOTTOM * 2)) / 2;
    const off = (r.ymin + r.ymax) / 2 - want;
    tz -= off * d * Math.tan((FOV_DEG * Math.PI) / 360) * 1.3;
  }
  return { tx, tz, d };
}

/** The open floor for the camera (the main room plus what has opened). */
export function openBox(zones: number) {
  const b = { x0: AREAS.main.x0 - 0.2, y0: AREAS.main.y0, x1: AREAS.main.x1 + 0.2, y1: AREAS.main.y1 + 0.3 };
  if (zones & Zone.dining) b.x1 = AREAS.dining.x1 + 0.2;
  if (zones & Zone.alley) b.x0 = AREAS.alley.x0 + 0.6;
  if (zones & Zone.terrace) b.y1 = AREAS.terrace.y1 + 0.4;
  return b;
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
  grow: number;
}

interface StationRig {
  /** The item on it (counter, board, pan, mat result), keyed by item code. */
  item: Entity | null;
  itemKey: string;
  /** The mat's ingredients. */
  matKey: string;
  mat: Entity | null;
  /** Pots: the filled / empty model. */
  pot: { full: Entity; empty: Entity } | null;
  /** A stack (plates, the sink's dirty plates). */
  stack: Entity[];
  stackKey: string;
  /** The crate's ingredient on top. */
  crate: Entity | null;
  steamT: number;
}

export function createSushiScene(
  app: Application,
  onResize: (fn: (w: number, h: number) => void) => void,
  models: Models,
  options: SceneOptions = {},
): SushiScene {
  let shadows = options.shadows ?? true;
  let effects = options.effects ?? true;
  let crowdShadows = options.crowdShadows ?? true;
  const device = app.graphicsDevice;
  app.scene.ambientLight = new Color(0.58, 0.48, 0.4);
  app.scene.clusteredLightingEnabled = false;

  // --- camera ---------------------------------------------------------------------------------------------
  const camera = new Entity('camera');
  camera.addComponent('camera', { clearColor: CLEAR, fov: FOV_DEG, nearClip: 1, farClip: 120 });
  app.root.addChild(camera);
  const P = (PITCH_DEG * Math.PI) / 180;
  let zonesNow = 0;
  const want = { tx: 0, tz: 0, d: 20 };
  const at = { tx: 0, tz: 0, d: 20 };
  let framed = false;
  const reframe = (snap = false) => {
    // The back wall's top may tuck under the HUD: frame its lower part only.
    const f = frameBox(openBox(zonesNow), device.width / Math.max(1, device.height), 1.3);
    Object.assign(want, f);
    if (snap || !framed) {
      Object.assign(at, f);
      framed = true;
    }
  };
  onResize(() => reframe(true));

  const sun = new Entity('sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.9, 0.76),
    intensity: 1.15,
    castShadows: shadows,
    shadowType: SHADOW_PCF1_32F,
    shadowBias: 0.25,
    normalOffsetBias: 0.05,
    shadowResolution: 2048,
    shadowDistance: 40,
    shadowIntensity: 0.45,
  });
  sun.setEulerAngles(58, -30, 0);
  app.root.addChild(sun);

  // --- the restaurant ---------------------------------------------------------------------------------------
  const vertexMat = new StandardMaterial();
  vertexMat.diffuseVertexColor = true;
  vertexMat.useMetalness = false;
  vertexMat.specular = new Color(0.05, 0.05, 0.05);
  vertexMat.gloss = 0.2;
  vertexMat.update();
  const staleMat = vertexMat.clone();
  staleMat.diffuse = new Color(0.55, 0.6, 0.5);
  staleMat.update();
  const level = buildLevel(app, models, vertexMat, shadows);

  const propEntity = (name: PropModel, x: number, h: number, y: number, rot = 0, cast = true) => {
    const e = new Entity(name);
    e.addComponent('render', {
      meshInstances: [new MeshInstance(models.props[name].mesh, vertexMat)],
      castShadows: cast && shadows,
      receiveShadows: true,
    });
    e.setPosition(x, h, y);
    e.setEulerAngles(0, rot, 0);
    app.root.addChild(e);
    return e;
  };

  // Station fixtures: boards, mats, pots, the pan, the steamer, the bin, the plate shelf.
  const mamboo = new StandardMaterial();
  mamboo.diffuse = rgb('#c7b27a');
  mamboo.useMetalness = false;
  mamboo.update();
  const binMat = new StandardMaterial();
  binMat.diffuse = rgb('#4a4f55');
  binMat.useMetalness = false;
  binMat.gloss = 0.4;
  binMat.update();
  const rigs: StationRig[] = STATIONS.map(() => ({
    item: null,
    itemKey: '',
    matKey: '',
    mat: null,
    pot: null,
    stack: [],
    stackKey: '',
    crate: null,
    steamT: 0,
  }));
  const fixtures: { id: number; type: string; e: Entity }[] = [];
  /** Height items sit at on each station. */
  const surface = STATIONS.map((s) =>
    s.type === 'pan' ? 1.17 : s.type === 'bin' || s.type === 'drop' ? 0.3 : COUNTER_TOP,
  );
  for (const s of STATIONS) {
    const r = rigs[s.id]!;
    if (s.type === 'rice' || s.type === 'pot') {
      const name = s.type === 'rice' ? 'Pot_1' : 'Pot_2';
      r.pot = {
        full: propEntity(`${name}_Filled` as PropModel, s.x, COUNTER_TOP, s.y),
        empty: propEntity(`${name}_Empty` as PropModel, s.x, COUNTER_TOP, s.y),
      };
    } else if (s.type === 'steamer') {
      fixtures.push({ id: s.id, type: s.type, e: propEntity('ChukamanSteamer', s.x, COUNTER_TOP, s.y) });
    } else if (s.type === 'pan') {
      fixtures.push({ id: s.id, type: s.type, e: propEntity('Pan', s.x, 1.11, s.y - 0.12, 180) });
    } else if (s.type === 'bin') {
      const e = new Entity('bin');
      e.addComponent('render', { type: 'cylinder', material: binMat, castShadows: shadows });
      e.setLocalScale(0.56, 0.62, 0.56);
      e.setPosition(s.x, 0.31, s.y);
      app.root.addChild(e);
      fixtures.push({ id: s.id, type: s.type, e });
    }
  }
  // Boards and mats follow the upgrades (a spare counter becomes one): drawn per frame from the world view.
  const boardModels = new Map<number, Entity>();
  const matModels = new Map<number, Entity>();
  const ensureBoard = (id: number) => {
    let e = boardModels.get(id);
    if (!e) {
      const s = STATIONS[id]!;
      e = propEntity('CuttingTable', s.x + 0.1, COUNTER_TOP, s.y - 0.12, 0, false);
      boardModels.set(id, e);
    }
    return e;
  };
  const ensureMat = (id: number) => {
    let e = matModels.get(id);
    if (!e) {
      const s = STATIONS[id]!;
      e = new Entity('mat');
      e.addComponent('render', { type: 'box', material: mamboo, castShadows: false });
      e.setLocalScale(0.62, 0.025, 0.5);
      e.setPosition(s.x, COUNTER_TOP + 0.012, s.y);
      app.root.addChild(e);
      matModels.set(id, e);
    }
    return e;
  };

  const placeItem = (r: StationRig, key: string, it: Item | null, x: number, h: number, y: number) => {
    if (key === r.itemKey) return;
    r.itemKey = key;
    r.item?.destroy();
    r.item = null;
    if (!it) return;
    const e = itemEntity(models, vertexMat, it);
    e.setPosition(x, h, y);
    e.setEulerAngles(0, 20, 0);
    app.root.addChild(e);
    r.item = e;
  };

  // --- the belt's plates --------------------------------------------------------------------------------------
  const slotRigs = Array.from({ length: BELT_SLOTS }, () => ({ e: null as Entity | null, key: '' }));
  const slotTmp = { x: 0, y: 0, a: 0 };

  // --- seats: dishes being eaten, dirty plates ---------------------------------------------------------------
  const seatRigs = SEATS.map(() => ({ e: null as Entity | null, key: '' }));

  // --- chefs and customers ----------------------------------------------------------------------------------
  const ringMats = SLOT_COLORS.map((c) => glow(rgb(c), 0.55, false));
  const meRing = glow(new Color(1, 1, 1), 0.6, false);
  const chefs = new Map<string, { rig: ChefRig; ring: Entity; slot: number }>();
  const customers = new Map<string, { rig: CustomerRig; vipRing: Entity | null; look: number }>();
  const vipMat = glow(rgb('#f2b324'), 0.6, false);

  // --- the highlight ------------------------------------------------------------------------------------------
  const hiMat = glow(new Color(1, 0.85, 0.35), 0.5);
  const highlight = new Entity('highlight');
  highlight.addComponent('render', { type: 'cylinder', material: hiMat, castShadows: false });
  highlight.setLocalScale(0.7, 0.02, 0.7);
  highlight.enabled = false;
  app.root.addChild(highlight);

  // --- effects ---------------------------------------------------------------------------------------------
  const effectPool = (n: number, mat: StandardMaterial): Effect[] =>
    Array.from({ length: n }, () => {
      const e = new Entity();
      const m = mat.clone();
      m.update();
      e.addComponent('render', { type: 'sphere', material: m, castShadows: false, receiveShadows: false });
      e.enabled = false;
      app.root.addChild(e);
      return { e, mat: m, age: 0, life: 1, live: false, vx: 0, vy: 0, vz: 0, size: 0.1, grow: 0 };
    });
  const sparks = effectPool(40, glow(new Color(1, 0.9, 0.5)));
  const puffs = effectPool(30, glow(new Color(0.95, 0.95, 0.95), 0.5, false));
  const take = (list: Effect[]) => {
    let best = list[0]!;
    for (const f of list) {
      if (!f.live) return f;
      if (f.age / f.life > best.age / best.life) best = f;
    }
    return best;
  };

  let clock = 0;
  const tmp = new Vec3();
  const out3 = new Vec3();
  let drawnChefs = 0;

  const scene: SushiScene = {
    camera,
    level,
    get drawnChefs() {
      return drawnChefs;
    },
    get drawnCustomers() {
      return customers.size;
    },
    frame(zones, snap = false) {
      zonesNow = zones;
      reframe(snap);
    },
    frameBox(box) {
      const f = frameBox(box, device.width / Math.max(1, device.height), 1);
      Object.assign(want, f);
      Object.assign(at, f);
    },
    setZones(zones) {
      level.setZones(zones, zones & Zone.dining ? 1 : 0);
    },
    setStation(id, v, world) {
      const def = STATIONS[id];
      const r = rigs[id];
      if (!def || !r) return;
      const type = stationType(def, world);
      const it = decodeItem(v.item);
      const h = surface[id]!;
      // Boards and mats appear where the upgrades put them.
      if (type === 'board') ensureBoard(id).enabled = true;
      else if (boardModels.has(id)) boardModels.get(id)!.enabled = false;
      if (type === 'mat') ensureMat(id).enabled = true;
      else if (matModels.has(id)) matModels.get(id)!.enabled = false;
      switch (type) {
        case 'crate': {
          const open = def.crate !== undefined && (CRATE_DAY[def.crate] ?? 99) <= world.day && v.count !== 0;
          if (!r.crate && def.crate !== undefined) {
            const e = itemEntity(models, vertexMat, { kind: def.crate, plated: false, n: 1 });
            e.setLocalScale(0.85, 0.85, 0.85);
            e.setPosition(def.x, COUNTER_TOP + 0.2, def.y);
            e.setEulerAngles(0, 70, 0);
            app.root.addChild(e);
            r.crate = e;
          }
          if (r.crate) r.crate.enabled = open;
          return;
        }
        case 'rice':
        case 'pot':
          if (r.pot) {
            r.pot.full.enabled = v.state !== Cook.idle;
            r.pot.empty.enabled = v.state === Cook.idle;
          }
          if (v.state === Cook.cooking && effects) {
            r.steamT += 1;
            if (r.steamT % 9 === 0) scene.puff(def.x, def.y, COUNTER_TOP + 0.55, 'steam');
          }
          return;
        case 'steamer':
          if (v.state === Cook.cooking && effects) {
            r.steamT += 1;
            if (r.steamT % 9 === 0) scene.puff(def.x, def.y, COUNTER_TOP + 0.4, 'steam');
          }
          return;
        case 'pan':
          placeItem(r, `${v.item}`, it, def.x, h, def.y);
          if (effects && (v.state === Pan.smoking || v.state === Pan.burnt)) {
            r.steamT += 1;
            if (r.steamT % 5 === 0) scene.puff(def.x, def.y, h + 0.25, 'smoke');
          } else if (effects && v.state === Pan.cooking) {
            r.steamT += 1;
            if (r.steamT % 14 === 0) scene.puff(def.x, def.y, h + 0.2, 'steam');
          }
          return;
        case 'plates':
        case 'sink': {
          // Plates: a stack of clean white ones (6 while nobody counts them); the sink: dirty ones in the basin.
          const n = type === 'plates' ? (v.count < 0 ? 6 : Math.min(8, v.count)) : Math.min(8, v.count);
          const key = `${type}:${n}`;
          if (key === r.stackKey) return;
          r.stackKey = key;
          for (const e of r.stack) e.destroy();
          r.stack = [];
          const food = models.food[type === 'plates' ? 'PlateWhite' : 'PlateDirty'];
          const sc = 0.5 / (food.max[0]! - food.min[0]!);
          for (let i = 0; i < n; i++) {
            const plate = new Entity('plate');
            plate.addComponent('render', {
              meshInstances: [new MeshInstance(food.mesh, vertexMat)],
              castShadows: false,
            });
            plate.setLocalScale(sc, sc, sc);
            plate.setPosition(def.x, (type === 'plates' ? COUNTER_TOP : COUNTER_TOP - 0.12) + i * 0.05, def.y);
            app.root.addChild(plate);
            r.stack.push(plate);
          }
          return;
        }
        case 'mat': {
          placeItem(r, `${v.item}`, it, def.x, h + 0.03, def.y);
          const items = matItems(v.mat);
          const key = items.join(',');
          if (key === r.matKey) return;
          r.matKey = key;
          r.mat?.destroy();
          r.mat = null;
          if (!items.length) return;
          const group = new Entity('mat-items');
          items.forEach((k, i) => {
            const e = itemEntity(models, vertexMat, { kind: k, plated: false, n: 1 });
            e.setLocalScale(0.72, 0.72, 0.72);
            const n = items.length;
            e.setLocalPosition((i - (n - 1) / 2) * 0.17, 0, (i % 2) * 0.08 - 0.04);
            group.addChild(e);
          });
          group.setPosition(def.x, h + 0.03, def.y);
          app.root.addChild(group);
          r.mat = group;
          return;
        }
        case 'drop':
          placeItem(r, `${v.count}`, v.count > 0 ? { kind: Kind.Tuna, plated: false, n: 1 } : null, def.x, 0.12, def.y);
          return;
        default:
          placeItem(r, `${v.item}`, it, def.x, h + (type === 'board' ? 0.08 : 0), def.y);
      }
    },
    setBelt(beltS, slots) {
      level.setBelt(beltS);
      for (let i = 0; i < BELT_SLOTS; i++) {
        const s = slots[i];
        const rig = slotRigs[i]!;
        const key = s?.item ? `${s.item.kind}:${s.stale ? 1 : 0}` : '';
        if (key !== rig.key) {
          rig.key = key;
          rig.e?.destroy();
          rig.e = null;
          if (s?.item) {
            const e = itemEntity(models, s.stale ? staleMat : vertexMat, s.item);
            app.root.addChild(e);
            rig.e = e;
          }
        }
        if (!rig.e || !s) continue;
        beltPoint(beltS + (i * BELT_LENGTH) / BELT_SLOTS, slotTmp);
        // Wilting: a stale plate droops and greys (the material), a nearly stale one sinks a little.
        const wilt = s.stale ? 0.6 : 1 - Math.max(0, s.age - 0.7) * 0.6;
        rig.e.setPosition(slotTmp.x, BELT_TOP, slotTmp.y);
        rig.e.setLocalScale(1, wilt, 1);
        rig.e.setEulerAngles(0, (slotTmp.a * 180) / Math.PI, s.stale ? 8 : 0);
      }
    },
    setSeat(id, dirty, eating) {
      const seat = SEATS[id];
      const rig = seatRigs[id];
      if (!seat || !rig) return;
      const key = `${dirty}:${eating}`;
      if (key === rig.key) return;
      rig.key = key;
      rig.e?.destroy();
      rig.e = null;
      if (!dirty && !eating) return;
      const group = new Entity('seat-dish');
      if (dirty) {
        const e = itemEntity(models, vertexMat, { kind: Kind.DirtyPlate, plated: false, n: dirty });
        e.setLocalPosition(eating ? 0.18 : 0, 0, 0);
        group.addChild(e);
      }
      if (eating) {
        const plated = KIND_MODEL[eating] !== undefined && eating >= Kind.Onigiri && eating <= Kind.UnagiNigiri;
        const e = itemEntity(models, vertexMat, { kind: eating, plated, n: 1 });
        e.setLocalScale(0.9, 0.9, 0.9);
        group.addChild(e);
      }
      const h = seat.kind === 'stool' ? 0.9 : 0.78;
      group.setPosition(seat.dish.x, h, seat.dish.y);
      app.root.addChild(group);
      rig.e = group;
    },
    setChef(id, v) {
      let c = chefs.get(id);
      if (c && c.slot !== v.slot) {
        c.rig.destroy();
        chefs.delete(id);
        c = undefined;
      }
      if (!c) {
        const rig = createChef(app, models, v.slot, vertexMat, shadows);
        const ring = new Entity('ring');
        ring.addComponent('render', { type: 'cylinder', material: ringMats[v.slot % 4]!, castShadows: false });
        ring.setLocalScale(0.85, 0.015, 0.85);
        ring.setLocalPosition(0, 0.012, 0);
        rig.root.addChild(ring);
        app.root.addChild(rig.root);
        c = { rig, ring, slot: v.slot };
        chefs.set(id, c);
      }
      c.rig.root.setPosition(v.x, 0, v.y);
      c.rig.root.setEulerAngles(0, yawOf(v.face), 0);
      c.ring.render!.meshInstances[0]!.material = v.me ? meRing : ringMats[v.slot % 4]!;
      c.rig.update({ speed: v.speed, act: v.act, held: v.held, cheer: v.cheer });
    },
    removeChef(id) {
      chefs.get(id)?.rig.destroy();
      chefs.delete(id);
    },
    setCustomer(id, v) {
      let c = customers.get(id);
      if (!c) {
        const rig = createCustomer(app, models, v.look, vertexMat, crowdShadows && shadows);
        let vipRing: Entity | null = null;
        if (v.vip) {
          vipRing = new Entity('vip');
          vipRing.addComponent('render', { type: 'cylinder', material: vipMat, castShadows: false });
          vipRing.setLocalScale(0.9, 0.015, 0.9);
          vipRing.setLocalPosition(0, 0.012, 0);
          rig.root.addChild(vipRing);
        }
        app.root.addChild(rig.root);
        c = { rig, vipRing, look: v.look };
        customers.set(id, c);
      }
      const seated = v.mood !== 'walk';
      c.rig.root.setPosition(v.x, seated ? 0.02 : 0, v.y);
      c.rig.root.setEulerAngles(0, yawOf(v.face), 0);
      c.rig.update(v.mood, v.waving);
    },
    removeCustomer(id) {
      customers.get(id)?.rig.destroy();
      customers.delete(id);
    },
    highlight(target, beltS) {
      if (target < 0) {
        highlight.enabled = false;
        return;
      }
      let x = 0;
      let y = 0;
      let h = COUNTER_TOP + 0.01;
      let size = 0.7;
      if (target >= SLOT_TARGET) {
        beltPoint(beltS + ((target - SLOT_TARGET) * BELT_LENGTH) / BELT_SLOTS, slotTmp);
        x = slotTmp.x;
        y = slotTmp.y;
        h = BELT_TOP + 0.01;
        size = 0.62;
      } else if (target >= SEAT_TARGET) {
        const s = SEATS[target - SEAT_TARGET]!;
        x = s.dish.x;
        y = s.dish.y;
        h = s.kind === 'stool' ? 0.91 : 0.79;
      } else {
        const s = STATIONS[target]!;
        x = s.x;
        y = s.y;
        h = s.type === 'bin' ? 0.64 : s.type === 'drop' ? 0.05 : s.type === 'pan' ? 1.13 : h;
        size = s.type === 'crate' ? 0.5 : 0.72;
      }
      highlight.enabled = true;
      const pulse = 1 + Math.sin(clock * 8) * 0.06;
      highlight.setPosition(x, h, y);
      highlight.setLocalScale(size * pulse, 0.02, size * pulse);
    },
    sparkle(x, y, h, color) {
      if (!effects) return;
      const c = rgb(color);
      for (let i = 0; i < 8; i++) {
        const f = take(sparks);
        f.live = true;
        f.age = 0;
        f.life = 0.55 + (i % 3) * 0.1;
        const a = (i / 8) * Math.PI * 2 + clock * 5;
        f.vx = Math.cos(a) * 1.4;
        f.vz = Math.sin(a) * 1.4;
        f.vy = 2.2 + (i % 3) * 0.6;
        f.size = 0.08 + (i % 2) * 0.04;
        f.grow = 0;
        f.e.enabled = true;
        f.e.setPosition(x, h, y);
        f.mat.emissive = i % 2 ? c : new Color(1, 0.95, 0.7);
        f.mat.update();
      }
    },
    puff(x, y, h, kind) {
      if (!effects) return;
      const f = take(puffs);
      f.live = true;
      f.age = 0;
      f.life = kind === 'smoke' ? 1.4 : 1.1;
      f.vx = (Math.random() - 0.5) * 0.2;
      f.vz = (Math.random() - 0.5) * 0.2;
      f.vy = kind === 'smoke' ? 0.9 : 0.7;
      f.size = kind === 'smoke' ? 0.22 : 0.14;
      f.grow = kind === 'smoke' ? 0.5 : 0.35;
      f.e.enabled = true;
      f.e.setPosition(x + (Math.random() - 0.5) * 0.15, h, y + (Math.random() - 0.5) * 0.15);
      f.mat.emissive = kind === 'smoke' ? new Color(0.22, 0.2, 0.19) : new Color(0.96, 0.96, 0.96);
      f.mat.opacity = kind === 'smoke' ? 0.75 : 0.45;
      f.mat.update();
    },
    toScreen(x, y, h, out) {
      tmp.set(x, h, y);
      camera.camera!.worldToScreen(tmp, out3);
      out.x = out3.x;
      out.y = out3.y;
      return out3.z > 0;
    },
    update(dt) {
      clock += dt;
      drawnChefs = chefs.size;
      const k = 1 - Math.exp(-dt * 3);
      at.tx += (want.tx - at.tx) * k;
      at.tz += (want.tz - at.tz) * k;
      at.d += (want.d - at.d) * k;
      camera.setPosition(at.tx, Math.sin(P) * at.d, at.tz + Math.cos(P) * at.d);
      camera.lookAt(at.tx, 0, at.tz);
      // The screens slide over a second when the dining room opens.
      const slideWant = zonesNow & Zone.dining ? 1 : 0;
      slide += (slideWant - slide) * Math.min(1, dt * 1.6);
      if (Math.abs(slideWant - slide) < 0.002) slide = slideWant;
      level.setZones(zonesNow, slide);
      for (const f of sparks) {
        if (!f.live) continue;
        f.age += dt;
        if (f.age >= f.life) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        f.vy -= 7 * dt;
        const p = f.e.getPosition();
        f.e.setPosition(p.x + f.vx * dt, p.y + f.vy * dt, p.z + f.vz * dt);
        const s = f.size * (1 - f.age / f.life);
        f.e.setLocalScale(s, s, s);
      }
      for (const f of puffs) {
        if (!f.live) continue;
        f.age += dt;
        const u = f.age / f.life;
        if (u >= 1) {
          f.live = false;
          f.e.enabled = false;
          continue;
        }
        const p = f.e.getPosition();
        f.e.setPosition(p.x + f.vx * dt, p.y + f.vy * dt, p.z + f.vz * dt);
        const s = f.size + f.grow * u;
        f.e.setLocalScale(s, s, s);
        f.mat.opacity = (1 - u) * 0.55;
        f.mat.update();
      }
    },
    trim() {
      for (const f of [...sparks, ...puffs]) {
        f.live = false;
        f.e.enabled = false;
      }
    },
    setQuality(o) {
      shadows = o.shadows;
      effects = o.effects;
      crowdShadows = o.crowdShadows;
      sun.light!.castShadows = shadows;
      if (!effects) scene.trim();
    },
  };
  let slide = 0;
  void kindSize;
  void fixtures;
  return scene;
}
