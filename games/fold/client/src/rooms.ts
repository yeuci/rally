import { Entity, type GraphicsDevice, type Material, type Mesh, MeshInstance } from 'playcanvas';
import { Geo, hex, mix, NX, NY, NZ, PX, PY, type RGB, shade } from './geo.ts';
import { DOOR_H, ROOM_H, WALL_T, rng, type Obstacle, type Pit, type Room, type Stamp, type ZoneKind } from './sim.ts';
import {
  ART_CLOCK,
  ART_PAINTINGS,
  ART_WINDOWS,
  artCell,
  FLOOR_TILE_X,
  FLOOR_TILE_Z,
  fxCell,
  FX_DOT,
  THEMES,
  WALLPAPER_TILE,
} from './textures.ts';

/**
 * One room of the house as a few merged meshes: the shell (ceiling, cut-away slabs, skirting, panelling, stairwells),
 * the wallpaper, the floorboards, the furniture (which casts shadows), back-wall decor and its art, and the additive
 * glow of lamps and sconces. Only stamps and fan blades are entities of their own (they move).
 *
 * Layout (1 unit = 1 m): the plane flies at z = 0; the back wall is at z = BACK; the house is cut away at z = FRONT,
 * where the floor and ceiling slabs show their cross-section. Everything the plane can hit is drawn exactly over its
 * box at z = 0; decor lives on the back wall or at |z| ≥ 0.7 (table legs, stair banister).
 */

const BACK = -2.5;
const FRONT = 2;
const DADO = 1;
const SKIRT = 0.2;
const SLAB = 0.36;
const WELL_BOTTOM = -3.8;
const BAND_LOW = -9;
const BAND_HIGH = 15;
const STAIR_Z = -1.35;
/** Doorways: the lintel reaches from the back wall forward over the lane to here. */
const HEADER_Z = 0.55;

const C = {
  ceiling: hex('#e2d5c0'),
  plaster: hex('#e7dcc8'),
  plasterCut: hex('#d9cbb2'),
  joist: hex('#6f4e34'),
  joistEnd: hex('#946b48'),
  boardEdge: hex('#b9875a'),
  band: hex('#3b2b25'),
  trim: hex('#f4eddf'),
  trimShade: hex('#e4d9c5'),
  lining: hex('#b98d60'),
  threshold: hex('#8a5f3c'),
  wellDeep: hex('#140e0b'),
  wellSide: hex('#33271f'),
  tread: hex('#a8784a'),
  riser: hex('#eadfcb'),
  stringer: hex('#6b4a30'),
  rail: hex('#6e4630'),
  baluster: hex('#efe6d6'),
  walnut: hex('#6e452e'),
  walnutDark: hex('#3f281b'),
  brass: hex('#c9a04a'),
  cord: hex('#3a2f2a'),
  radiator: hex('#efebe3'),
  fanWood: hex('#6a4430'),
  frost: hex('#fbefd2'),
  kettleDark: hex('#2f2b2b'),
  warm: hex('#ffc46e'),
  warmIn: hex('#ffd99a'),
  bulb: hex('#fff3d0'),
  mat: hex('#f3ead8'),
  air: hex('#e8f2ff'),
  leaf: hex('#5f8f4a'),
};

const BOOKS = [
  '#b8433a',
  '#3e6a9a',
  '#d9a93a',
  '#4f8a5a',
  '#7a4a8a',
  '#e6d7b4',
  '#2f4f5f',
  '#c8643a',
  '#8a2f3a',
  '#5f7f3f',
  '#efd6a8',
  '#3a3a4a',
].map(hex);
const SHADES = ['#f2e2bf', '#e9c46a', '#9cc5b8', '#e8a28c', '#f4efe4', '#b7c7e6'].map(hex);
const TABLE_WOODS = ['#8b4a2f', '#a8703f', '#7a4a32', '#9a5f3a', '#b07a48', '#6f4430'].map(hex);
const KETTLES = ['#d24a3a', '#3f8f8a', '#e9b23a', '#4a6fb0', '#f2ede2', '#2f6f4f'].map(hex);
const FRAMES = ['#c9a04a', '#2f2a2a', '#f3ecdc', '#7a5236', '#a8432f'].map(hex);

/** A random entry of `list`. */
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

/** Materials and shared meshes the rooms are built with (one set for the whole game). */
export interface RoomKit {
  device: GraphicsDevice;
  shell: Material;
  props: Material;
  walls: readonly Material[];
  floor: Material;
  art: Material;
  glow: Material;
  stamp: Material;
  stampMeshes: readonly Mesh[];
  /** A soft additive halo behind each stamp. */
  stampHalo: Mesh;
  fanBlades: Mesh;
  shadows: boolean;
  /** False after `trim`: no back-wall decor. */
  decor: boolean;
}

export interface StampView {
  e: Entity;
  s: Stamp;
  phase: number;
}

export interface Emitter {
  kind: ZoneKind;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Where particles start. */
  sx: number;
  sy: number;
  acc: number;
}

export interface RoomView {
  index: number;
  x0: number;
  x1: number;
  root: Entity;
  /** Back-wall decor (dropped by `trim`). */
  decor: Entity[];
  stamps: StampView[];
  fans: Entity[];
  emitters: Emitter[];
  pits: readonly Pit[];
}

function renderEntity(
  parent: Entity,
  name: string,
  mesh: Mesh | null,
  material: Material,
  cast: boolean,
  receive = true,
): Entity | null {
  if (!mesh) return null;
  const e = new Entity(name);
  e.addComponent('render', { castShadows: cast, receiveShadows: receive });
  e.render!.meshInstances = [new MeshInstance(mesh, material)];
  e.render!.castShadows = cast;
  e.render!.receiveShadows = receive;
  parent.addChild(e);
  return e;
}

/** The floor's spans between stairwells. */
function floorSpans(room: Room): [number, number][] {
  const pits = [...room.pits].sort((a, b) => a.x0 - b.x0);
  const spans: [number, number][] = [];
  let x = room.x0;
  for (const p of pits) {
    if (p.x0 > x) spans.push([x, p.x0]);
    x = Math.max(x, p.x1);
  }
  if (room.x1 > x) spans.push([x, room.x1]);
  return spans;
}

// --- the shell ------------------------------------------------------------------------------------------

/** Joist ends along a slab's cut face: a dark band with lighter rectangles every 0.4 m. */
function joists(g: Geo, x0: number, x1: number, y0: number, y1: number) {
  g.color(C.joist).rectZ(x0, y0, x1, y1, FRONT);
  g.color(C.joistEnd);
  for (let x = Math.ceil(x0 / 0.4) * 0.4; x < x1 - 0.08; x += 0.4) g.rectZ(x, y0, x + 0.07, y1, FRONT + 0.002);
}

function shell(g: Geo, room: Room, spans: [number, number][]) {
  const { x0, x1 } = room;
  const theme = THEMES[room.theme]!;
  const panel = hex(theme.panel);

  // Ceiling, its cut-away slab and the dark band above.
  g.color(C.ceiling).rectY(x0, BACK, x1, FRONT, ROOM_H, true);
  g.color(C.plasterCut).rectZ(x0, ROOM_H, x1, ROOM_H + 0.06, FRONT);
  joists(g, x0, x1, ROOM_H + 0.06, ROOM_H + 0.3);
  g.color(C.boardEdge).rectZ(x0, ROOM_H + 0.3, x1, ROOM_H + SLAB, FRONT);
  g.color(C.band).rectZ(x0, ROOM_H + SLAB, x1, BAND_HIGH, FRONT);

  // Floor slab cut faces (the floor itself is textured separately) and the band below.
  for (const [a, b] of spans) {
    g.color(C.boardEdge).rectZ(a, -0.06, b, 0, FRONT);
    joists(g, a, b, -0.3, -0.06);
    g.color(C.plasterCut).rectZ(a, -SLAB, b, -0.3, FRONT);
    g.color(C.band).rectZ(a, BAND_LOW, b, -SLAB, FRONT);
  }

  // Panelling below the dado rail (beadboard), the rail, the skirting.
  g.color(panel).rectZ(x0, 0, x1, DADO, BACK + 0.002);
  g.color(shade(panel, 0.82));
  for (let x = Math.ceil(x0 / 0.16) * 0.16; x < x1; x += 0.16) g.rectZ(x, SKIRT, x + 0.014, DADO, BACK + 0.004);
  g.color(C.trim).box(x0, DADO - 0.03, BACK, x1, DADO + 0.04, BACK + 0.05, NZ, { top: C.trim, bottom: C.trimShade });
  for (const [a, b] of spans) {
    g.color(C.trim).box(a, 0, BACK, b, SKIRT, BACK + 0.06, NZ | NY);
    g.color(C.trimShade).box(a, SKIRT, BACK, b, SKIRT + 0.03, BACK + 0.035, NZ | NY);
  }

  // Crown moulding.
  g.color(C.trim).box(x0, ROOM_H - 0.17, BACK, x1, ROOM_H, BACK + 0.1, NZ | PY, { bottom: C.trimShade });
  g.color(C.trimShade).box(x0, ROOM_H - 0.25, BACK, x1, ROOM_H - 0.17, BACK + 0.05, NZ | PY);
  g.color(C.trim).box(x0, ROOM_H - 0.035, BACK + 0.1, x1, ROOM_H, BACK + 0.2, NZ | PY);

  // A runner rug along the flight lane (it marks z = 0 on the floor), in the spans long enough for one.
  const rug = hex(theme.rug),
    rug2 = hex(theme.rug2);
  for (const [sa, sb] of spans) {
    const a = sa + (sa === x0 ? 1.4 : 0.7),
      b = sb - 0.9;
    if (b - a < 2) continue;
    g.color(rug2).rectY(a - 0.1, -0.6, b + 0.1, 0.6, 0.004);
    g.color(rug).rectY(a, -0.62, b, 0.62, 0.007);
    g.color(rug2).rectY(a + 0.1, -0.5, b - 0.1, 0.5, 0.01);
    g.color(rug).rectY(a + 0.16, -0.44, b - 0.16, 0.44, 0.013);
    g.color(rug2);
    for (let x = a + 0.5; x < b - 0.4; x += 0.9) {
      g.quad(x, 0.016, 0, x + 0.12, 0.016, -0.2, x + 0.24, 0.016, 0, x + 0.12, 0.016, 0.2);
    }
  }

  // The first room's end wall (the house's outside wall), seen from inside: panelling, skirting, rail, crown (its
  // wallpaper is on the wallpaper mesh), and its cut edge at the front.
  if (room.index === 0) {
    g.color(C.band).rectZ(x0 - 0.6, -SLAB, x0, ROOM_H + SLAB, FRONT);
    g.color(C.plasterCut).rectZ(x0 - 0.6, -0.06, x0, ROOM_H + 0.06, FRONT + 0.002);
    g.color(panel).rectX(BACK, 0, FRONT, DADO, x0);
    g.color(C.trim).box(x0, 0, BACK, x0 + 0.06, SKIRT, FRONT, NX | NY);
    g.color(C.trim).box(x0, DADO - 0.03, BACK, x0 + 0.05, DADO + 0.04, FRONT, NX);
    g.color(C.trim).box(x0, ROOM_H - 0.17, BACK, x0 + 0.1, ROOM_H, FRONT, NX | PY, { bottom: C.trimShade });
  }

  // Doorway: the lintel over the lane is furniture (its sides are papered by the rooms either side). Below it nothing
  // stands in the way (a door frame drawn under it reads as a pillar): just a threshold strip across the floor and a
  // bead where the two rooms' wallpapers meet.
  if (room.index > 0) {
    g.color(C.threshold).box(x0 - 0.05, 0, BACK, x0 + WALL_T + 0.05, 0.025, FRONT, NY);
    g.color(C.trim).box(x0 - 0.03, SKIRT, BACK, x0 + 0.03, DOOR_H, BACK + 0.03, NZ | NY);
  }

  for (const p of room.pits) stairwell(g, p, panel);
}

/** The doorway lintel sides facing into a room: its own (x, facing +x) and the next room's (x, facing -x: `neg`). */
function doorFaces(room: Room): [number, boolean][] {
  const faces: [number, boolean][] = [[room.x1, true]];
  if (room.index > 0) faces.push([room.x0 + WALL_T, false]);
  return faces;
}

function stairwell(g: Geo, p: Pit, panel: RGB) {
  const { x0, x1 } = p;
  // The shaft: back wall fading into the dark, side walls, bottom, the band below it at the cut.
  g.gradZ(x0, WELL_BOTTOM, x1, 0, BACK + 0.003, C.wellDeep, shade(panel, 0.55));
  g.color(C.wellSide).rectX(BACK, WELL_BOTTOM, FRONT, -SLAB, x0);
  g.color(C.wellSide).rectX(BACK, WELL_BOTTOM, FRONT, -SLAB, x1, true);
  g.color(C.wellDeep).rectY(x0, BACK, x1, FRONT, WELL_BOTTOM);
  g.color(C.band).rectZ(x0, BAND_LOW, x1, WELL_BOTTOM, FRONT);
  // The floor slab's edges at the opening.
  for (const [x, neg] of [
    [x0, false],
    [x1, true],
  ] as const) {
    g.color(C.boardEdge).rectX(BACK, -0.06, FRONT, 0, x, neg);
    g.color(C.joist).rectX(BACK, -0.3, FRONT, -0.06, x, neg);
    g.color(C.plasterCut).rectX(BACK, -SLAB, FRONT, -0.3, x, neg);
  }
  // Stairs down along the back wall (behind the lane), and their banister.
  const run = 0.3,
    rise = 0.24;
  const n = Math.max(2, Math.min(Math.floor((x1 - x0 - 0.2) / run), Math.floor(-WELL_BOTTOM / rise) - 1));
  for (let k = 0; k < n; k++) {
    const a = x0 + k * run;
    const top = -(k + 1) * rise;
    g.color(C.stringer).box(a, WELL_BOTTOM, BACK, a + run, top, STAIR_Z, NZ | NY, {
      top: C.tread,
      side: C.riser,
    });
  }
  const railZ = STAIR_Z + 0.05;
  const y0 = 0.95;
  const len = n * run;
  const slope = Math.atan2(-rise, run);
  const half = len / 2 / Math.cos(slope);
  g.color(C.rail)
    .push(x0 + len / 2, y0 - (len * rise) / run / 2, railZ, 0, 0, (slope * 180) / Math.PI)
    .box(-half, -0.03, -0.035, half, 0.03, 0.035)
    .pop();
  g.color(C.baluster);
  for (let k = 0; k < n; k++) {
    const x = x0 + (k + 0.5) * run;
    const tread = -(k + 1) * rise;
    const railY = y0 - (x - x0) * (rise / run);
    g.box(x - 0.018, tread, railZ - 0.018, x + 0.018, railY, railZ + 0.018, NY);
  }
  g.color(C.rail).box(x0 + 0.01, 0, railZ - 0.05, x0 + 0.11, y0 + 0.12, railZ + 0.05, NY);
  g.color(C.brass).box(x0 + 0.0, y0 + 0.12, railZ - 0.06, x0 + 0.12, y0 + 0.17, railZ + 0.06, NY);
}

// --- furniture (everything the plane can hit) ------------------------------------------------------------------

function header(g: Geo, o: Obstacle) {
  const { x0, x1, y0 } = o;
  // The lintel's sides are papered by the rooms on either side (their wallpaper meshes).
  g.color(C.plaster).box(x0, y0, BACK, x1, ROOM_H, HEADER_Z, PY | NX | PX, { front: C.plasterCut, bottom: C.lining });
  g.color(C.trim).box(x0 - 0.1, y0, HEADER_Z, x1 + 0.1, y0 + 0.17, HEADER_Z + 0.07, 0, { bottom: C.trimShade });
  g.color(C.trimShade).box(x0 - 0.06, y0 + 0.17, HEADER_Z, x1 + 0.06, y0 + 0.21, HEADER_Z + 0.05, NY);
  g.color(C.trim)
    .box(x0 - 0.1, y0 + 0.17, HEADER_Z, x0, ROOM_H, HEADER_Z + 0.07, NY | PY)
    .box(x1, y0 + 0.17, HEADER_Z, x1 + 0.1, ROOM_H, HEADER_Z + 0.07, NY | PY);
}

function bookshelf(g: Geo, o: Obstacle, r: () => number) {
  const { x0, x1, y1: h } = o;
  const Z0 = -0.42,
    Z1 = 0.32;
  const wood = C.walnut;
  g.color(wood).box(x0, 0, Z0, x0 + 0.06, h - 0.05, Z1, NY);
  g.color(wood).box(x1 - 0.06, 0, Z0, x1, h - 0.05, Z1, NY);
  g.color(shade(wood, 1.1)).box(x0, h - 0.05, Z0, x1, h, Z1 + 0.02, 0, { top: shade(wood, 1.18) });
  g.color(C.walnutDark).box(x0 + 0.06, 0, Z0 + 0.04, x1 - 0.06, 0.1, Z1 - 0.03, NY | PY);
  g.color(C.walnutDark).rectZ(x0 + 0.06, 0.1, x1 - 0.06, h - 0.05, Z0 + 0.04);
  const inner = h - 0.15;
  const rows = Math.max(2, Math.round(inner / 0.68));
  const space = inner / rows;
  for (let row = 0; row < rows; row++) {
    const base = 0.1 + row * space + (row > 0 ? 0.035 : 0);
    if (row > 0) g.color(wood).box(x0 + 0.06, base - 0.035, Z0 + 0.04, x1 - 0.06, base, Z1 - 0.01, NZ);
    const room = space - (row > 0 ? 0.035 : 0) - 0.05;
    const start = x0 + 0.075;
    const end = x1 - 0.075;
    // Sometimes a little stack of books lying flat at one end.
    if (r() < 0.3 && end - start > 0.5) {
      const sw = 0.22 + r() * 0.06;
      let y = base;
      for (let k = 0; k < 2 + Math.floor(r() * 3); k++) {
        const bh = 0.045 + r() * 0.025;
        if (y + bh > base + room) break;
        g.color(pick(r, BOOKS)).box(end - sw, y, Z1 - 0.3, end - 0.01, y + bh, Z1 - 0.07, NZ | NY);
        y += bh;
      }
      bookRow(g, r, start, end - sw - 0.02, base, room, Z1);
    } else {
      bookRow(g, r, start, end, base, room, Z1);
    }
  }
}

function bookRow(g: Geo, r: () => number, x: number, end: number, base: number, room: number, Z1: number) {
  while (x < end - 0.04) {
    const w = Math.min(end - x, 0.045 + r() * 0.05);
    if (r() < 0.06) {
      x += w * 0.6;
      continue;
    }
    const bh = room * (0.62 + r() * 0.34);
    const depth = 0.2 + r() * 0.07;
    const col = pick(r, BOOKS);
    const front = Z1 - 0.06;
    // The last book in a row sometimes leans on its neighbour.
    if (end - x - w < 0.12 && end - x > 0.14 && r() < 0.5) {
      g.push(x + 0.01, base, front - depth / 2, 0, 0, -14)
        .color(col)
        .box(0, 0, -depth / 2, w, bh * 0.95, depth / 2, NZ | NY)
        .pop();
      break;
    }
    g.color(col).box(x, base, front - depth, x + w, base + bh, front, NZ | NY);
    if (w > 0.05)
      g.color(shade(col, 1.45)).rectZ(x + 0.01, base + bh * 0.66, x + w - 0.01, base + bh * 0.76, front + 0.001);
    g.color(shade(col, 0.7)).rectZ(x + 0.004, base + bh * 0.12, x + w - 0.004, base + bh * 0.15, front + 0.001);
    x += w + 0.004;
  }
}

/** A soft vertical trapezoid on the glow mesh (light, warm air, moving air): x0a…x1a at ya, at opacity `alpha`,
 * fading out to x0b…x1b at yb. */
function glowFade(
  glow: Geo,
  color: RGB,
  alpha: number,
  ya: number,
  x0a: number,
  x1a: number,
  yb: number,
  x0b: number,
  x1b: number,
) {
  const [u0, v0, u1, v1] = fxCell(FX_DOT);
  const z = -0.05;
  glow.uvLock((u0 + u1) / 2, (v0 + v1) / 2).color(color);
  const i = glow.vert(x0a, ya, z, 0, 0, 1, 0, 0, alpha);
  glow.vert(x1a, ya, z, 0, 0, 1, 0, 0, alpha);
  glow.vert(x1b, yb, z, 0, 0, 1, 0, 0, 0);
  glow.vert(x0b, yb, z, 0, 0, 1, 0, 0, 0);
  glow
    .tri3(i, i + 1, i + 2)
    .tri3(i, i + 2, i + 3)
    .uvUnlock();
}

function lamp(g: Geo, glow: Geo, o: Obstacle, col: RGB) {
  const cx = (o.x0 + o.x1) / 2;
  const R = (o.x1 - o.x0) / 2;
  const y0 = o.y0;
  const H = 0.52;
  const rTop = R * 0.52;
  g.color(col).prism(cx, 0, y0, y0 + H, R, rTop, 18, { smooth: true });
  g.color(shade(col, 0.72)).prism(cx, 0, y0, y0 + 0.045, R + 0.008, R * 0.985 + 0.008, 18, { smooth: true });
  g.color(shade(col, 0.72)).prism(cx, 0, y0 + H - 0.035, y0 + H, rTop * 1.03 + 0.008, rTop + 0.008, 18, {
    smooth: true,
    top: true,
  });
  g.color(C.brass).prism(cx, 0, y0 + H, y0 + H + 0.1, 0.07, 0.045, 10, { top: true });
  g.color(C.cord).box(cx - 0.014, y0 + H + 0.1, -0.014, cx + 0.014, ROOM_H - 0.04, 0.014, NY | PY);
  g.color(C.trim).prism(cx, 0, ROOM_H - 0.05, ROOM_H, 0.14, 0.11, 14);

  // Light: the lit inside of the shade, the bulb, a halo, a soft cone and a pool on the floor.
  const [du0, dv0, du1, dv1] = fxCell(FX_DOT);
  const cu = (du0 + du1) / 2,
    cv = (dv0 + dv1) / 2;
  glow.uvLock(cu, cv);
  glow.color(C.warmIn, 0.85).prism(cx, 0, y0 + 0.01, y0 + H - 0.01, R - 0.012, rTop - 0.012, 18, { inside: true });
  glow.color(C.bulb, 1).prism(cx, 0, y0 + 0.08, y0 + 0.24, 0.07, 0.09, 8, { bottom: true });
  glow.uvUnlock();
  const coneLen = Math.min(1.7, y0 - 0.1);
  if (coneLen > 0.3)
    glowFade(glow, C.warm, 0.14, y0, cx - R * 0.9, cx + R * 0.9, y0 - coneLen, cx - R * 1.7, cx + R * 1.7);
  glow.color(C.warm, 0.4).rectZ(cx - 1.3, y0 - 1.1, cx + 1.3, y0 + 1.5, -0.5, du0, dv0, du1, dv1);
  glow
    .color(C.warm, Math.min(0.3, 0.75 / Math.max(1, y0)))
    .rectY(cx - 1.4, -1.1, cx + 1.4, 1.1, 0.02, false, du0, dv0, du1, dv1);
}

function table(g: Geo, o: Obstacle, wood: RGB) {
  const { x0, x1, y0, y1 } = o;
  g.color(wood).box(x0, y1 - 0.07, -0.92, x1, y1, 0.92, 0, { top: shade(wood, 1.12) });
  g.color(shade(wood, 0.82)).box(x0 + 0.1, y0, -0.8, x1 - 0.1, y1 - 0.07, 0.8, PY);
  for (const lx of [x0 + 0.17, x1 - 0.17]) {
    for (const lz of [-0.72, 0.72]) {
      g.color(shade(wood, 0.9)).prism(lx, lz, 0, y0, 0.045, 0.068, 4, { phase: Math.PI / 4 });
    }
  }
}

function kettle(g: Geo, o: Obstacle, col: RGB) {
  const { x0, y0 } = o;
  const cx = x0 + 0.225;
  g.color(C.kettleDark).prism(cx, 0, y0, y0 + 0.035, 0.19, 0.205, 16, { smooth: true });
  g.color(col).prism(cx, 0, y0 + 0.035, y0 + 0.3, 0.205, 0.225, 16, { smooth: true });
  g.color(col).prism(cx, 0, y0 + 0.3, y0 + 0.43, 0.225, 0.12, 16, { smooth: true });
  g.color(shade(col, 1.12)).prism(cx, 0, y0 + 0.43, y0 + 0.455, 0.12, 0.105, 16, { smooth: true, top: true });
  g.color(C.kettleDark).prism(cx, 0, y0 + 0.455, y0 + 0.5, 0.032, 0.022, 8, { top: true });
  g.color(col)
    .push(x0 + 0.38, y0 + 0.12, 0, 0, 0, -42)
    .prism(0, 0, 0, 0.19, 0.055, 0.025, 10, { top: true })
    .pop();
  g.color(C.kettleDark)
    .box(cx - 0.13, y0 + 0.38, -0.02, cx - 0.1, y0 + 0.56, 0.02, NY)
    .box(cx + 0.07, y0 + 0.38, -0.02, cx + 0.1, y0 + 0.56, 0.02, NY)
    .box(cx - 0.15, y0 + 0.55, -0.03, cx + 0.12, y0 + 0.6, 0.03);
}

function radiator(g: Geo, glow: Geo, o: Obstacle) {
  const { x0, x1, y1 } = o;
  // A faint warm column of rising air above it.
  glowFade(glow, C.warm, 0.16, y1, x0 + 0.05, x1 - 0.05, 3.6, x0 - 0.1, x1 + 0.1);
  const n = 11;
  const pitch = (x1 - x0 - 0.06) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + 0.03 + i * pitch + 0.012,
      b = a + pitch - 0.024;
    g.color(C.radiator).box(a, 0.09, -0.12, b, y1 - 0.06, 0.12, NY | PY);
    g.color(shade(C.radiator, 1.04)).box(a + 0.008, y1 - 0.06, -0.1, b - 0.008, y1, 0.1, NY);
  }
  g.color(shade(C.radiator, 0.88))
    .box(x0 + 0.02, 0.15, -0.06, x1 - 0.02, 0.21, 0.06)
    .box(x0 + 0.02, y1 - 0.2, -0.06, x1 - 0.02, y1 - 0.14, 0.06);
  g.color(shade(C.radiator, 0.75))
    .box(x0 + 0.08, 0, -0.15, x0 + 0.2, 0.09, 0.15, NY)
    .box(x1 - 0.2, 0, -0.15, x1 - 0.08, 0.09, 0.15, NY);
  g.color(C.brass).prism(x0 + 0.03, 0.08, 0.24, 0.36, 0.035, 0.035, 8, { top: true, bottom: true });
}

function fan(g: Geo, glow: Geo, o: Obstacle, zoneW: number) {
  const cx = (o.x0 + o.x1) / 2;
  // A faint column of moving air under it, as wide as the zone that pushes down.
  glowFade(glow, C.air, 0.12, o.y0, cx - 0.3, cx + 0.3, 1.6, cx - zoneW / 2, cx + zoneW / 2);
  g.color(C.brass).prism(cx, 0, ROOM_H - 0.07, ROOM_H, 0.15, 0.12, 14, { bottom: true });
  g.color(C.brass).box(cx - 0.022, 5.78, -0.022, cx + 0.022, ROOM_H - 0.07, 0.022, NY | PY);
  g.color(C.fanWood).prism(cx, 0, 5.66, 5.78, 0.3, 0.19, 16, { smooth: true, top: true });
  g.color(C.brass).prism(cx, 0, 5.6, 5.66, 0.25, 0.3, 16, { smooth: true });
  g.color(C.frost).prism(cx, 0, o.y0, 5.6, 0.1, 0.24, 16, { smooth: true, bottom: true });
}

/** The fan's blades (shared mesh, spun around y by its entity). */
export function fanBlades(device: GraphicsDevice): Mesh {
  const g = new Geo();
  g.color(C.brass).prism(0, 0, -0.03, 0.03, 0.08, 0.08, 12, { top: true, bottom: true });
  for (let k = 0; k < 4; k++) {
    g.push(0, 0, 0, 0, k * 90, 0);
    g.color(C.cord).box(0.06, -0.012, -0.02, 0.2, 0.012, 0.02);
    g.push(0.32, 0, 0, 9, 0, 0).color(C.fanWood).box(-0.14, -0.009, -0.07, 0.15, 0.009, 0.07).pop();
    g.pop();
  }
  const mesh = g.build(device)!;
  mesh.incRefCount();
  return mesh;
}

// --- decor (back wall only) ---------------------------------------------------------------------------------

function artRect(art: Geo, x0: number, y0: number, x1: number, y1: number, z: number, cell: number) {
  const [u0, vb, u1, vt] = artCell(cell);
  const a = (x1 - x0) / (y1 - y0);
  const su = u1 - u0,
    sv = vb - vt;
  let du = su,
    dv = sv;
  if (a >= 1) dv = su / a;
  else du = sv * a;
  const uc = (u0 + u1) / 2,
    vc = (vb + vt) / 2;
  art.rectZ(x0, y0, x1, y1, z, uc - du / 2, vc + dv / 2, uc + du / 2, vc - dv / 2);
}

function picture(g: Geo, art: Geo, cx: number, cy: number, w: number, h: number, frame: RGB, cell: number) {
  const z = BACK,
    d = 0.05,
    ft = 0.055;
  const l = cx - w / 2,
    r = cx + w / 2,
    b = cy - h / 2,
    t = cy + h / 2;
  g.color(frame)
    .box(l - ft, b - ft, z, r + ft, b, z + d, NZ)
    .box(l - ft, t, z, r + ft, t + ft, z + d, NZ)
    .box(l - ft, b, z, l, t, z + d, NZ)
    .box(r, b, z, r + ft, t, z + d, NZ);
  g.color(C.mat).rectZ(l, b, r, t, z + 0.012);
  const m = Math.min(w, h) * 0.09;
  artRect(art, l + m, b + m, r - m, t - m, z + 0.016, cell);
}

function windowDecor(g: Geo, art: Geo, cx: number, accent: RGB, cell: number) {
  const z = BACK,
    w = 1.3,
    y0 = 1.75,
    y1 = 4.15;
  const l = cx - w / 2,
    r = cx + w / 2;
  artRect(art, l, y0, r, y1, z + 0.01, cell);
  const f = 0.08;
  g.color(C.trim)
    .box(l - f, y0 - f, z, r + f, y0, z + 0.08, NZ)
    .box(l - f, y1, z, r + f, y1 + f, z + 0.08, NZ)
    .box(l - f, y0, z, l, y1, z + 0.08, NZ)
    .box(r, y0, z, r + f, y1, z + 0.08, NZ)
    .box(cx - 0.025, y0, z, cx + 0.025, y1, z + 0.05, NZ)
    .box(l, (y0 * 2 + y1) / 3 - 0.02, z, r, (y0 * 2 + y1) / 3 + 0.02, z + 0.05, NZ)
    .box(l, (y0 + y1 * 2) / 3 - 0.02, z, r, (y0 + y1 * 2) / 3 + 0.02, z + 0.05, NZ);
  g.color(C.trim).box(l - 0.16, y0 - f - 0.07, z, r + 0.16, y0 - f, z + 0.17, NZ, { front: C.trimShade });
  // Curtains, gathered in folds, and their rod.
  for (const side of [-1, 1]) {
    const inner = side < 0 ? l + 0.06 : r - 0.06;
    const outer = inner + side * 0.42;
    const a = Math.min(inner, outer),
      b = Math.max(inner, outer);
    const folds = 5;
    for (let k = 0; k < folds; k++) {
      const fa = a + ((b - a) * k) / folds,
        fb = a + ((b - a) * (k + 1)) / folds;
      g.color(shade(accent, k % 2 ? 0.82 : 1)).box(
        fa,
        y0 - 0.45,
        z + 0.05,
        fb,
        y1 + 0.3,
        z + (k % 2 ? 0.11 : 0.14),
        NZ | PY,
      );
    }
  }
  g.color(C.brass).box(l - 0.5, y1 + 0.3, z + 0.1, r + 0.5, y1 + 0.35, z + 0.15);
  g.prism(l - 0.52, z + 0.125, y1 + 0.29, y1 + 0.36, 0.04, 0.04, 8, { top: true, bottom: true });
  g.prism(r + 0.52, z + 0.125, y1 + 0.29, y1 + 0.36, 0.04, 0.04, 8, { top: true, bottom: true });
}

function clock(g: Geo, art: Geo, cx: number, cy: number) {
  const r = 0.3;
  g.color(C.walnut).ringZ(cx, cy, BACK, BACK + 0.07, r - 0.01, r + 0.05, 24);
  const [u0, vb, u1, vt] = artCell(ART_CLOCK);
  art.discZ(cx, cy, BACK + 0.05, r, 24, u0, vb, u1, vt);
}

function sconce(g: Geo, glow: Geo, cx: number, cy: number, col: RGB) {
  const z = BACK;
  g.color(C.brass)
    .box(cx - 0.05, cy - 0.14, z, cx + 0.05, cy + 0.04, z + 0.03, NZ)
    .box(cx - 0.015, cy - 0.03, z + 0.03, cx + 0.015, cy, z + 0.2, NZ);
  g.color(col).prism(cx, z + 0.22, cy - 0.04, cy + 0.17, 0.13, 0.075, 12, { smooth: true });
  const [u0, v0, u1, v1] = fxCell(FX_DOT);
  glow.color(C.warm, 0.5).rectZ(cx - 0.7, cy - 0.6, cx + 0.7, cy + 0.8, z + 0.06, u0, v0, u1, v1);
  glow.uvLock((u0 + u1) / 2, (v0 + v1) / 2);
  glow.color(C.warmIn, 0.7).prism(cx, z + 0.22, cy - 0.03, cy + 0.16, 0.12, 0.068, 12, { inside: true });
  glow.uvUnlock();
}

function wallShelf(g: Geo, cx: number, cy: number, r: () => number) {
  const z = BACK;
  g.color(C.walnut).box(cx - 0.55, cy - 0.04, z, cx + 0.55, cy, z + 0.24, NZ, { top: shade(C.walnut, 1.15) });
  g.color(C.walnutDark)
    .box(cx - 0.4, cy - 0.2, z, cx - 0.36, cy - 0.04, z + 0.18, NZ)
    .box(cx + 0.36, cy - 0.2, z, cx + 0.4, cy - 0.04, z + 0.18, NZ);
  let x = cx - 0.48;
  while (x < cx + 0.42) {
    const kind = r();
    if (kind < 0.4) {
      // a little pot with a plant
      const pr = 0.07 + r() * 0.03;
      g.color(pick(r, SHADES)).prism(x + pr, z + 0.12, cy, cy + 0.12, pr * 0.8, pr, 10, {
        top: true,
      });
      g.color(C.leaf).prism(x + pr, z + 0.12, cy + 0.12, cy + 0.3, pr * 1.3, 0.01, 6);
      x += pr * 2 + 0.06;
    } else {
      for (let k = 0; k < 3 + Math.floor(r() * 3) && x < cx + 0.45; k++) {
        const w = 0.04 + r() * 0.03;
        g.color(pick(r, BOOKS)).box(x, cy, z + 0.04, x + w, cy + 0.16 + r() * 0.08, z + 0.2, NZ | NY);
        x += w + 0.004;
      }
      x += 0.06;
    }
  }
}

function decorate(room: Room, g: Geo, art: Geo, glow: Geo, r: () => number) {
  const theme = THEMES[room.theme]!;
  const accent = hex(theme.accent);
  const start = room.x0 + (room.index > 0 ? 1.6 : 1.4);
  const end = room.x1 - 1.4;
  let windows = 0,
    clocks = 0;
  let x = start + r() * 0.8;
  while (x < end - 0.6) {
    const roll = r();
    if (roll < 0.16 && windows < 1 && x + 1.2 < end) {
      windowDecor(g, art, x + 0.6, accent, pick(r, ART_WINDOWS));
      windows++;
      x += 1.2 + 2.6 + r();
    } else if (roll < 0.27 && clocks < 1) {
      clock(g, art, x, 4.2 + r() * 0.3);
      clocks++;
      x += 2.4 + r();
    } else if (roll < 0.4) {
      wallShelf(g, x + 0.4, 2.7 + r() * 0.5, r);
      x += 0.8 + 2.2 + r();
    } else if (roll < 0.55 && x + 1.6 < end) {
      // a picture between two sconces
      const w = 0.7 + r() * 0.3,
        h = 0.55 + r() * 0.35;
      const cx = x + 0.8;
      picture(g, art, cx, 3.4, w, h, pick(r, FRAMES), pick(r, ART_PAINTINGS));
      const shadeCol = pick(r, SHADES);
      sconce(g, glow, cx - w / 2 - 0.45, 3.1, shadeCol);
      sconce(g, glow, cx + w / 2 + 0.45, 3.1, shadeCol);
      x += 1.6 + 2.4 + r();
    } else if (roll < 0.72) {
      // a pair of small pictures, one above the other
      const w = 0.45 + r() * 0.2;
      picture(g, art, x, 2.8, w, w * 1.2, pick(r, FRAMES), pick(r, ART_PAINTINGS));
      picture(g, art, x, 3.85 + w * 0.2, w, w * 0.8, pick(r, FRAMES), pick(r, ART_PAINTINGS));
      x += 2.6 + r();
    } else {
      const w = 0.8 + r() * 0.6,
        h = 0.6 + r() * 0.5;
      picture(g, art, x + w / 2, 3.3 + r() * 0.6, w, h, pick(r, FRAMES), pick(r, ART_PAINTINGS));
      x += w + 2.2 + r();
    }
  }
  // A power socket or two just above the skirting.
  for (let k = 0; k < 2; k++) {
    const sx = start + r() * (end - start);
    if (room.pits.some((p) => sx > p.x0 - 0.3 && sx < p.x1 + 0.3)) continue;
    g.color(C.trim).box(sx - 0.07, 0.32, BACK, sx + 0.07, 0.44, BACK + 0.02, NZ);
  }
}

// --- the room -----------------------------------------------------------------------------------------------

export function buildRoom(room: Room, kit: RoomKit, parent: Entity): RoomView {
  const root = new Entity(`room-${room.index}`);
  parent.addChild(root);
  // Decor and book colours: the same for the same room of the same house (x0 differs between houses).
  const r = rng(room.index * 7919 + Math.round(room.x0 * 131) + 17);
  const spans = floorSpans(room);
  const { device } = kit;

  // Shell.
  const sg = new Geo();
  shell(sg, room, spans);
  renderEntity(root, 'shell', sg.build(device), kit.shell, false);

  // Wallpaper above the dado rail (slightly darker toward the ceiling).
  const wg = new Geo();
  const top = hex('#e6ddd2'),
    bottom = hex('#ffffff');
  wg.color(bottom);
  const T = WALLPAPER_TILE;
  {
    const i = wg.vert(room.x0, DADO, BACK, 0, 0, 1, room.x0 / T, -DADO / T);
    wg.vert(room.x1, DADO, BACK, 0, 0, 1, room.x1 / T, -DADO / T);
    wg.color(mix(bottom, top, 0.4));
    wg.vert(room.x1, 4.2, BACK, 0, 0, 1, room.x1 / T, -4.2 / T);
    wg.vert(room.x0, 4.2, BACK, 0, 0, 1, room.x0 / T, -4.2 / T);
    wg.color(top);
    wg.vert(room.x1, ROOM_H, BACK, 0, 0, 1, room.x1 / T, -ROOM_H / T);
    wg.vert(room.x0, ROOM_H, BACK, 0, 0, 1, room.x0 / T, -ROOM_H / T);
    wg.tri3(i, i + 1, i + 2)
      .tri3(i, i + 2, i + 3)
      .tri3(i + 3, i + 2, i + 4)
      .tri3(i + 3, i + 4, i + 5);
  }
  for (const [x, neg] of doorFaces(room)) {
    // The lintel sides looking into this room (normals tilted toward the camera: lit like the wall, not dark).
    const nx = neg ? -1 : 1;
    const face = (z0: number, y0: number, z1: number, y1: number) => {
      const za = neg ? z0 : z1,
        zb = neg ? z1 : z0;
      wg.color(mix(bottom, top, (y0 - DADO) / (ROOM_H - DADO)));
      const i = wg.vert(x, y0, za, nx * 0.6, 0, 0.8, za / T, -y0 / T);
      wg.vert(x, y0, zb, nx * 0.6, 0, 0.8, zb / T, -y0 / T);
      wg.color(mix(bottom, top, (y1 - DADO) / (ROOM_H - DADO)));
      wg.vert(x, y1, zb, nx * 0.6, 0, 0.8, zb / T, -y1 / T);
      wg.vert(x, y1, za, nx * 0.6, 0, 0.8, za / T, -y1 / T);
      wg.tri3(i, i + 1, i + 2).tri3(i, i + 2, i + 3);
    };
    face(BACK, DOOR_H, HEADER_Z, ROOM_H);
  }
  if (room.index === 0) {
    // The end wall's inside face (facing +x, normals tilted toward the camera like the lintel sides).
    const x = room.x0;
    wg.color(bottom);
    const i = wg.vert(x, DADO, FRONT, 0.6, 0, 0.8, FRONT / T, -DADO / T);
    wg.vert(x, DADO, BACK, 0.6, 0, 0.8, BACK / T, -DADO / T);
    wg.color(top);
    wg.vert(x, ROOM_H, BACK, 0.6, 0, 0.8, BACK / T, -ROOM_H / T);
    wg.vert(x, ROOM_H, FRONT, 0.6, 0, 0.8, FRONT / T, -ROOM_H / T);
    wg.tri3(i, i + 1, i + 2).tri3(i, i + 2, i + 3);
  }
  renderEntity(root, 'wallpaper', wg.build(device), kit.walls[room.theme % kit.walls.length]!, false);

  // Floorboards (darker against the back wall: a touch of fake occlusion).
  const fg = new Geo();
  const fx = FLOOR_TILE_X,
    fz = FLOOR_TILE_Z;
  for (const [a, b] of spans) {
    const dark = hex('#b8aa9c'),
      light = hex('#ffffff');
    fg.color(dark);
    const i = fg.vert(a, 0, BACK, 0, 1, 0, a / fx, BACK / fz);
    fg.vert(b, 0, BACK, 0, 1, 0, b / fx, BACK / fz);
    fg.color(light);
    fg.vert(b, 0, BACK + 0.9, 0, 1, 0, b / fx, (BACK + 0.9) / fz);
    fg.vert(a, 0, BACK + 0.9, 0, 1, 0, a / fx, (BACK + 0.9) / fz);
    fg.vert(b, 0, FRONT, 0, 1, 0, b / fx, FRONT / fz);
    fg.vert(a, 0, FRONT, 0, 1, 0, a / fx, FRONT / fz);
    fg.tri3(i, i + 3, i + 2)
      .tri3(i, i + 2, i + 1)
      .tri3(i + 3, i + 5, i + 4)
      .tri3(i + 3, i + 4, i + 2);
  }
  renderEntity(root, 'floor', fg.build(device), kit.floor, false);

  // Furniture.
  const pg = new Geo();
  const glow = new Geo();
  const view: RoomView = {
    index: room.index,
    x0: room.x0,
    x1: room.x1,
    root,
    decor: [],
    stamps: [],
    fans: [],
    emitters: [],
    pits: room.pits,
  };
  for (const o of room.obstacles) {
    switch (o.kind) {
      case 'doorway':
        header(pg, o);
        break;
      case 'shelf':
        bookshelf(pg, o, r);
        break;
      case 'lamp':
        lamp(pg, glow, o, SHADES[(o.id + room.theme) % SHADES.length]!);
        break;
      case 'table':
        table(pg, o, TABLE_WOODS[(o.id + room.theme) % TABLE_WOODS.length]!);
        break;
      case 'kettle':
        kettle(pg, o, KETTLES[(o.id + room.theme) % KETTLES.length]!);
        break;
      case 'radiator':
        radiator(pg, glow, o);
        break;
      case 'fan': {
        const zone = room.zones.find((z) => z.kind === 'fan' && z.x0 <= o.x0 && z.x1 >= o.x1);
        fan(pg, glow, o, zone ? zone.x1 - zone.x0 : 3.2);
        const blades = renderEntity(root, 'fan-blades', kit.fanBlades, kit.props, kit.shadows);
        if (blades) {
          blades.setLocalPosition((o.x0 + o.x1) / 2, 5.64, 0);
          blades.setLocalEulerAngles(0, o.id * 37, 0);
          view.fans.push(blades);
        }
        break;
      }
    }
  }
  renderEntity(root, 'furniture', pg.build(device), kit.props, kit.shadows);

  renderEntity(root, 'glow', glow.build(device), kit.glow, false, false);

  // Back-wall decor: frames and fittings, the pictures in them, the sconces' light.
  if (kit.decor) {
    const dg = new Geo();
    const ag = new Geo();
    const lg = new Geo();
    decorate(room, dg, ag, lg, r);
    for (const e of [
      renderEntity(root, 'decor', dg.build(device), kit.shell, false),
      renderEntity(root, 'art', ag.build(device), kit.art, false),
      renderEntity(root, 'decor-glow', lg.build(device), kit.glow, false, false),
    ])
      if (e) view.decor.push(e);
  }

  // Zones that make particles: steam from kettles, heat over radiators, wind under fans.
  for (const z of room.zones) {
    const sx = z.kind === 'steam' ? z.x0 + 0.55 : (z.x0 + z.x1) / 2;
    view.emitters.push({ kind: z.kind, x0: z.x0, x1: z.x1, y0: z.y0, y1: z.y1, sx, sy: z.y0, acc: 0 });
  }

  // Stamps.
  for (const s of room.stamps) {
    const kind = s.id % kit.stampMeshes.length;
    const e = renderEntity(root, 'stamp', kit.stampMeshes[kind]!, kit.stamp, kit.shadows, false);
    if (!e) continue;
    e.setLocalPosition(s.x, s.y, 0);
    e.enabled = !s.taken;
    const halo = renderEntity(e, 'halo', kit.stampHalo, kit.glow, false, false);
    halo?.setLocalPosition(0, 0, -0.04);
    view.stamps.push({ e, s, phase: (s.id * 2.399) % (Math.PI * 2) });
  }
  return view;
}

/** The soft glow behind every stamp (shared). */
export function stampHalo(device: GraphicsDevice): Mesh {
  const g = new Geo();
  const [u0, v0, u1, v1] = fxCell(FX_DOT);
  g.color(hex('#fff1c4'), 0.45).rectZ(-0.6, -0.6, 0.6, 0.6, 0, u0, v0, u1, v1);
  const mesh = g.build(device)!;
  mesh.incRefCount();
  return mesh;
}

/** A stamp quad (shared, one per design): 0.46 × 0.58 m, centred. */
export function stampMesh(device: GraphicsDevice, uv: readonly [number, number, number, number]): Mesh {
  const g = new Geo();
  g.color([255, 255, 255]).rectZ(-0.23, -0.29, 0.23, 0.29, 0, uv[0], uv[1], uv[2], uv[3]);
  const mesh = g.build(device)!;
  mesh.incRefCount();
  return mesh;
}
